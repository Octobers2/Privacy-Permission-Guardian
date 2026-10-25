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
  REPORT_TTL_MS,
  RESULT_TTL_MS,
  type MissingTermsView,
  jaccard,
  MAX_SIMILAR_EXAMPLES,
  significantWords,
  SIMILAR_THRESHOLD,
  type SimilarItem,
  type UnfairCategory,
  UNFAIR_CATEGORIES,
  type MoneyClause,
  type Passage,
  type RankingRow,
  type ResultSummaryView,
  type ResultUpload,
  type ResultView,
} from '@ppg/shared';

export const DEFAULT_DB_FILE = resolve(import.meta.dir, '../../../data/ppg.sqlite');

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
      CREATE VIRTUAL TABLE IF NOT EXISTS passages_fts USING fts5(text, result_id UNINDEXED, category UNINDEXED, tokenize = 'porter unicode61');
      CREATE TABLE IF NOT EXISTS money_clauses (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        result_id INTEGER NOT NULL REFERENCES results (id) ON DELETE CASCADE,
        idx       INTEGER NOT NULL,
        kind      TEXT NOT NULL,
        text      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS money_result ON money_clauses (result_id, idx);
      CREATE TABLE IF NOT EXISTS missing_terms (
        domain     TEXT PRIMARY KEY,
        url        TEXT NOT NULL,
        tried_json TEXT NOT NULL,
        reports    INTEGER NOT NULL,
        first_at   INTEGER NOT NULL,
        last_at    INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS missing_expiry ON missing_terms (expires_at);
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
      const insertFts = this.db.prepare('INSERT INTO passages_fts (text, result_id, category) VALUES (?, ?, ?)');
      for (const p of upload.passages) {
        insertPassage.run(id, p.index, p.text, p.category, JSON.stringify(p.probs));
        insertFts.run(p.text, id, p.category);
      }
      const insertMoney = this.db.prepare('INSERT INTO money_clauses (result_id, idx, kind, text) VALUES (?, ?, ?, ?)');
      for (const m of upload.money) insertMoney.run(id, m.index, m.kind, m.text);
      return { id, createdAt, expiresAt };
    })();
  }

  /** Removes everything past its expiry. Reads already ignore it; this just reclaims the space. */
  purge(): { results: number; summaries: number; reports: number } {
    const now = this.now();
    // Counted explicitly: the driver's change counter also includes the passages removed by ON DELETE CASCADE.
    return this.db.transaction(() => {
      const n = (table: string) => this.db.query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${table} WHERE expires_at <= ?`).get(now)!.n;
      const counts = { results: n('results'), summaries: n('summaries'), reports: n('missing_terms') };
      this.db.run('DELETE FROM missing_terms WHERE expires_at <= ?', [now]);
      this.db.run('DELETE FROM results WHERE expires_at <= ?', [now]);
      this.db.run('DELETE FROM passages_fts WHERE CAST(result_id AS INTEGER) NOT IN (SELECT id FROM results)');
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
    return rows.map((r) => this.view(r, true, false)).map(({ passages: _p, money: _m, ...rest }) => rest as ResultSummaryView);
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

  // ------------------------------------------------------- similar cases

  /**
   * Current stored clauses of the same type on *other* sites that share most of their words with `text`, grouped by site.
   * Full-text search finds the candidates (ranked by BM25); the Jaccard score on the words decides which count as similar.
   */
  similar(text: string, category: UnfairCategory, excludeDomain: string): Omit<SimilarItem, 'index'> | null {
    const words = significantWords(text);
    if (words.length < 3) return null;
    // The longest words first: they are the rarer ones, so they pick out the candidates; a dozen is plenty.
    const query = [...words].sort((a, b) => b.length - a.length).slice(0, 12).map((w) => `"${w}"`).join(' OR ');
    const rows = this.db
      .query<{ text: string; domain: string; url: string }, Record<string, string | number>>(
        `SELECT f.text AS text, r.domain AS domain, r.url AS url
         FROM passages_fts f JOIN results r ON r.id = CAST(f.result_id AS INTEGER)
         WHERE passages_fts MATCH :query AND f.category = :category AND r.domain != :domain AND r.id IN (${CURRENT_IDS})
         ORDER BY bm25(passages_fts) LIMIT 80`,
      )
      .all({ ':query': query, ':category': category, ':domain': excludeDomain.toLowerCase(), ':now': this.now() });
    const perSite = new Map<string, { domain: string; url: string; text: string; score: number }>();
    for (const row of rows) {
      const score = jaccard(words, significantWords(row.text));
      if (score < SIMILAR_THRESHOLD) continue;
      const best = perSite.get(row.domain);
      if (!best || score > best.score) perSite.set(row.domain, { ...row, score });
    }
    if (perSite.size === 0) return null;
    const examples = [...perSite.values()].sort((a, b) => b.score - a.score).slice(0, MAX_SIMILAR_EXAMPLES).map(({ domain, url, text }) => ({ domain, url, text }));
    return { sites: perSite.size, examples };
  }

  /** `similar` for each flagged clause of a stored result. */
  similarToResult(id: number): SimilarItem[] | null {
    const result = this.get(id);
    return result ? this.similarToPassages(result.passages, result.domain) : null;
  }

  similarToPassages(passages: { index: number; category: UnfairCategory; text: string }[], excludeDomain: string): SimilarItem[] {
    return passages.flatMap((p) => {
      const found = this.similar(p.text, p.category, excludeDomain);
      return found ? [{ index: p.index, ...found }] : [];
    });
  }

  // ------------------------------------------------------- missing terms

  /** Counts one more report that `domain` has no terms. One row per site: the count goes up, the clock restarts. */
  reportMissing(domain: string, url: string, tried: string[]): MissingTermsView {
    const now = this.now();
    const key = domain.toLowerCase();
    this.db.transaction(() => {
      const live = this.db
        .query<{ reports: number; first_at: number }, [string, number]>('SELECT reports, first_at FROM missing_terms WHERE domain = ? AND expires_at > ?')
        .get(key, now);
      this.db.run('INSERT OR REPLACE INTO missing_terms (domain, url, tried_json, reports, first_at, last_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        key, url, JSON.stringify(tried), (live?.reports ?? 0) + 1, live?.first_at ?? now, now, now + REPORT_TTL_MS,
      ]);
    })();
    return this.missing(key)!;
  }

  missing(domain: string): MissingTermsView | null {
    const row = this.db
      .query<{ domain: string; reports: number; first_at: number; last_at: number }, [string, number]>('SELECT domain, reports, first_at, last_at FROM missing_terms WHERE domain = ? AND expires_at > ?')
      .get(domain.toLowerCase(), this.now());
    return row ? { domain: row.domain, reports: row.reports, firstReportedAt: new Date(row.first_at).toISOString(), lastReportedAt: new Date(row.last_at).toISOString() } : null;
  }

  /** Sites reported most often, then most recently. */
  missingList(limit: number): MissingTermsView[] {
    return this.db
      .query<{ domain: string; reports: number; first_at: number; last_at: number }, [number, number]>(
        'SELECT domain, reports, first_at, last_at FROM missing_terms WHERE expires_at > ? ORDER BY reports DESC, last_at DESC LIMIT ?',
      )
      .all(this.now(), limit)
      .map((row) => ({ domain: row.domain, reports: row.reports, firstReportedAt: new Date(row.first_at).toISOString(), lastReportedAt: new Date(row.last_at).toISOString() }));
  }

  /** Whether any unexpired result exists for the domain: such a site plainly has terms, so reports against it are refused. */
  hasResults(domain: string): boolean {
    return !!this.db.query<{ n: number }, [string, number]>('SELECT 1 AS n FROM results WHERE domain = ? AND expires_at > ? LIMIT 1').get(domain.toLowerCase(), this.now());
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
    const money: MoneyClause[] = withPassages
      ? this.db
          .query<{ idx: number; kind: string; text: string }, [number]>('SELECT idx, kind, text FROM money_clauses WHERE result_id = ? ORDER BY idx, id')
          .all(row.id)
          .map((m) => ({ index: m.idx, kind: m.kind as MoneyClause['kind'], text: m.text }))
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
      money,
      current,
    };
  }
}
