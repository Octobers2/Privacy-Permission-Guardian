/**
 * Shared summary cache.
 *
 * `bun:sqlite` is built into the runtime, so this costs no dependency and no
 * native build step. The table is deliberately tiny: the point of the managed
 * mode is that several people testing the extension on the same site spend one
 * model call between them rather than one each.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface CachedSummary {
  json: string;
  createdAt: number;
}

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export class SummaryCache {
  private readonly db: Database;

  constructor(file = resolve(import.meta.dir, '../data/summaries.sqlite')) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true });
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS summaries (
        key        TEXT PRIMARY KEY,
        domain     TEXT NOT NULL,
        json       TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  /**
   * Keyed on the document hash and prompt version as well as the domain, so a
   * site editing its policy or us editing a prompt produces a miss rather than
   * a stale answer served with confidence.
   */
  static keyFor(domain: string, contentHash: string, promptVersion: string): string {
    return `${domain}|${contentHash}|${promptVersion}`;
  }

  get(key: string): string | null {
    const row = this.db
      .query<CachedSummary, [string]>('SELECT json, created_at AS createdAt FROM summaries WHERE key = ?')
      .get(key);
    if (!row) return null;
    if (Date.now() - row.createdAt > MAX_AGE_MS) {
      this.db.run('DELETE FROM summaries WHERE key = ?', [key]);
      return null;
    }
    return row.json;
  }

  set(key: string, domain: string, json: string): void {
    this.db.run(
      'INSERT OR REPLACE INTO summaries (key, domain, json, created_at) VALUES (?, ?, ?, ?)',
      [key, domain, json, Date.now()],
    );
  }

  count(): number {
    return this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM summaries').get()?.n ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
