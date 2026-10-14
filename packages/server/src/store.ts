/**
 * Results and summaries, in SQLite (`bun:sqlite` is built into the runtime: no dependency, no native build).
 *
 * Rules:
 *  - Every accepted upload is kept as its own row ("history"). Reads show the *latest non-expired* row per policy URL.
 *  - A row lives for 30 days from its own upload. Nothing is ever refreshed in place, so a policy that keeps being
 *    re-analysed keeps a current row, and one nobody re-checks disappears after a month.
 *  - Expired rows are invisible to every read at once (the clock is checked in SQL) and physically removed by `purge()`.
 *  - The clock is injectable so tests can move through the TTL without waiting.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  RESULT_TTL_MS,
  UNFAIR_CATEGORIES,
  type Passage,
  type RankingRow,
  type ResultSummaryView,
  type ResultUpload,
  type ResultView,
} from '@ppg/shared';

export const DEFAULT_DB_FILE = resolve(import.meta.dir, '../data/ppg.sqlite');

export interface StoreOptions {
  file?: string;
  now?: () => number;
}

interface ResultRow {
  id: number;
  url: string;
  domain: string;
  text_hash: string;
  model_id: string;
  model_version: string;
  prompt_version: string;
  created_at: number;
  expires_at: number;
  passage_count: number;
  unfair_count: number;
  categories_json: string;
}

/** `id` of the newest unexpired row for each URL: the single definition of "current". */
const CURRENT_IDS = `
  SELECT (SELECT r2.id FROM results r2 WHERE r2.url = r.url AND r2.expires_at > :now
          ORDER BY r2.created_at DESC, r2.id DESC LIMIT 1)
  FROM (SELECT DISTINCT url FROM results WHERE expires_at > :now) r`;

export class ResultStore {
  private readonly db: Database;
  private readonly now: () => number;

  constructor({ file = DEFAULT_DB_FILE, now = Date.now }: StoreOptions = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.now = now;
    this.db = new Database(file, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS results (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        url             TEXT NOT NULL,
        domain          TEXT NOT NULL,
        text_hash       TEXT NOT NULL,
        model_id        TEXT NOT NULL,
        model_version   TEXT NOT NULL,
        prompt_version  TEXT NOT NULL,
        submitted_by    TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        expires_at      INTEGER NOT NULL,
        passage_count   INTEGER NOT NULL,
        unfair_count    INTEGER NOT NULL,
        categories_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS results_url ON results (url, created_at DESC);
      CREATE INDEX IF NOT EXISTS results_domain ON results (domain);
      CREATE INDEX IF NOT EXISTS results_expiry ON results (expires_at);
      CREATE TABLE IF NOT EXISTS passages (
        result_id  INTEGER NOT NULL REFERENCES results (id) ON DELETE CASCADE,
        idx        INTEGER NOT NULL,
        text       TEXT NOT NULL,
        category   TEXT NOT NULL,
        probs_json TEXT NOT NULL,
        PRIMARY KEY (result_id, idx)
      );
      CREATE TABLE IF NOT EXISTS summaries (
        key        TEXT PRIMARY KEY,
        body_json  TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS summaries_expiry ON summaries (expires_at);
    `);
  }

  // ------------------------------------------------------------------ writes

  insert(upload: ResultUpload, submittedBy: string): { id: number; createdAt: number; expiresAt: number } {
    const createdAt = this.now();
    const expiresAt = createdAt + RESULT_TTL_MS;
    const categories: Record<string, number> = {};
    for (const p of upload.passages) categories[p.category] = (categories[p.category] ?? 0) + 1;

    return this.db.transaction(() => {
      const { id } = this.db
        .query<{ id: number }, (string | number)[]>(
          `INSERT INTO results (url, domain, text_hash, model_id, model_version, prompt_version, submitted_by,
                                created_at, expires_at, passage_count, unfair_count, categories_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        )
        .get(
          upload.url, upload.domain.toLowerCase(), upload.textHash, upload.model.id, upload.model.version,
          upload.promptVersion, submittedBy, createdAt, expiresAt, upload.passageCount, upload.passages.length,
          JSON.stringify(categories),
        )!;
      const insertPassage = this.db.prepare('INSERT INTO passages (result_id, idx, text, category, probs_json) VALUES (?, ?, ?, ?, ?)');
      for (const p of upload.passages) insertPassage.run(id, p.index, p.text, p.category, JSON.stringify(p.probs));
      return { id, createdAt, expiresAt };
    })();
  }

  /** Removes everything past its expiry. Reads already ignore it; this just reclaims the space. */
  purge(): { results: number; summaries: number } {
    const now = this.now();
    // Counted explicitly: the driver's change counter also includes the passages removed by ON DELETE CASCADE.
    return this.db.transaction(() => {
      const n = (table: string) => this.db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${table} WHERE expires_at <= ?`).get(now)!.n;
      const counts = { results: n('results'), summaries: n('summaries') };
      this.db.run('DELETE FROM results WHERE expires_at <= ?', [now]);
      this.db.run('DELETE FROM summaries WHERE expires_at <= ?', [now]);
      return counts;
    })();
  }

  // ------------------------------------------------------------------- reads

  /** One result by id, or null if it does not exist or has expired. */
  get(id: number): ResultView | null {
    const now = this.now();
    const row = this.db.query<ResultRow, [number, number]>('SELECT * FROM results WHERE id = ? AND expires_at > ?').get(id, now);
    return row ? this.view(row, this.currentId(row.url) === row.id, true) : null;
  }

  /** The current result for a policy URL. */
  lookup(url: string): ResultView | null {
    const id = this.currentId(url);
    return id === null ? null : this.get(id);
  }

  /** The current result of every policy URL under a domain. */
  site(domain: string): ResultView[] {
    const rows = this.db
      .query<ResultRow, Record<string, string | number>>(`SELECT * FROM results WHERE domain = :domain AND id IN (${CURRENT_IDS}) ORDER BY url`)
      .all({ ':domain': domain.toLowerCase(), ':now': this.now() });
    return rows.map((r) => this.view(r, true, true));
  }

  /** Every unexpired version of a policy URL, newest first. */
  history(url: string): ResultView[] {
    const rows = this.db
      .query<ResultRow, [string, number]>('SELECT * FROM results WHERE url = ? AND expires_at > ? ORDER BY created_at DESC, id DESC')
      .all(url, this.now());
    const current = rows[0]?.id;
    return rows.map((r) => this.view(r, r.id === current, true));
  }

  /** Most recently analysed policies, one row per URL, without passage text. */
  recent(limit: number): ResultSummaryView[] {
    const rows = this.db
      .query<ResultRow, Record<string, string | number>>(`SELECT * FROM results WHERE id IN (${CURRENT_IDS}) ORDER BY created_at DESC, id DESC LIMIT :limit`)
      .all({ ':now': this.now(), ':limit': limit });
    return rows.map((r) => this.view(r, true, false)).map(({ passages: _p, ...rest }) => rest as ResultSummaryView);
  }

  /** Domains ranked by how many potentially unfair clauses their current policies contain. */
  rankings(limit: number, by: 'count' | 'share' = 'count'): RankingRow[] {
    const order = by === 'share' ? 'CAST(SUM(unfair_count) AS REAL) / SUM(passage_count) DESC, SUM(unfair_count) DESC' : 'SUM(unfair_count) DESC, domain';
    return this.db
      .query<{ domain: string; documents: number; unfair: number; passages: number; latest: number }, Record<string, string | number>>(
        `SELECT domain, COUNT(*) AS documents, SUM(unfair_count) AS unfair, SUM(passage_count) AS passages, MAX(created_at) AS latest
         FROM results WHERE id IN (${CURRENT_IDS}) GROUP BY domain HAVING SUM(unfair_count) > 0 ORDER BY ${order} LIMIT :limit`,
      )
      .all({ ':now': this.now(), ':limit': limit })
      .map((r) => ({ ...r, share: r.passages ? r.unfair / r.passages : 0, latest: new Date(r.latest).toISOString() }));
  }

  stats(): { results: number; urls: number; domains: number; summaries: number } {
    const now = this.now();
    const one = <T>(sql: string) => this.db.query<{ n: number }, [number]>(sql).get(now)!.n as T;
    return {
      results: one<number>('SELECT COUNT(*) AS n FROM results WHERE expires_at > ?'),
      urls: one<number>('SELECT COUNT(DISTINCT url) AS n FROM results WHERE expires_at > ?'),
      domains: one<number>('SELECT COUNT(DISTINCT domain) AS n FROM results WHERE expires_at > ?'),
      summaries: one<number>('SELECT COUNT(*) AS n FROM summaries WHERE expires_at > ?'),
    };
  }

  // --------------------------------------------------------------- summaries

  /** Keyed on the policy text hash plus prompt and model, so an edited policy or prompt is a miss, never a stale answer. */
  static summaryKey(textHash: string, promptVersion: string, model: string): string {
    return `${textHash}|${promptVersion}|${model}`;
  }

  summaryGet(key: string): string | null {
    return this.db.query<{ body_json: string }, [string, number]>('SELECT body_json FROM summaries WHERE key = ? AND expires_at > ?').get(key, this.now())?.body_json ?? null;
  }

  summarySet(key: string, body: string): void {
    const now = this.now();
    this.db.run('INSERT OR REPLACE INTO summaries (key, body_json, created_at, expires_at) VALUES (?, ?, ?, ?)', [key, body, now, now + RESULT_TTL_MS]);
  }

  close(): void {
    this.db.close();
  }

  // ----------------------------------------------------------------- helpers

  private currentId(url: string): number | null {
    return this.db
      .query<{ id: number }, [string, number]>('SELECT id FROM results WHERE url = ? AND expires_at > ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(url, this.now())?.id ?? null;
  }

  private view(row: ResultRow, current: boolean, withPassages: boolean): ResultView {
    const passages: Passage[] = withPassages
      ? this.db
          .query<{ idx: number; text: string; category: string; probs_json: string }, [number]>('SELECT idx, text, category, probs_json FROM passages WHERE result_id = ? ORDER BY idx')
          .all(row.id)
          .map((p) => ({ index: p.idx, text: p.text, category: p.category as Passage['category'], probs: JSON.parse(p.probs_json) as number[] }))
      : [];
    const categories = JSON.parse(row.categories_json) as Record<string, number>;
    for (const key of Object.keys(categories)) if (!(UNFAIR_CATEGORIES as readonly string[]).includes(key)) delete categories[key];
    return {
      id: row.id,
      url: row.url,
      domain: row.domain,
      textHash: row.text_hash,
      model: { id: row.model_id, version: row.model_version },
      promptVersion: row.prompt_version,
      createdAt: new Date(row.created_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
      passageCount: row.passage_count,
      unfairCount: row.unfair_count,
      fairCount: row.passage_count - row.unfair_count,
      categories: categories as ResultView['categories'],
      passages,
      current,
    };
  }
}
