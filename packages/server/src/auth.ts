/**
 * Who is allowed to use the managed backend.
 *
 * The backend holds the API key and drives a headless browser, so an open port
 * is somebody else's free LLM and somebody else's page fetcher. This is the
 * smallest thing that stops that: a text file of `username:bcrypt-hash` lines,
 * a login that exchanges a password for a bearer token, and a counter that
 * makes guessing slow.
 *
 * Deliberately not a database and not a JWT:
 *
 *   - `Bun.password` does bcrypt natively, so the hashing costs no dependency.
 *   - Tokens live in a `Map` in this process. There is no secret to generate,
 *     distribute or leak, and the only cost is that a restart invalidates them
 *     — which the extension handles by logging in again on the first 401, so
 *     nobody has to retype a password.
 *
 * The file is read again whenever its mtime changes, so `bun run auth add` takes
 * effect without restarting the server.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** `auth.txt` at the repository root — `packages/server/src` is three deep. */
export const DEFAULT_AUTH_FILE = resolve(import.meta.dir, '../../../auth.txt');

const TOKEN_TTL_MS = 12 * 60 * 60 * 1_000;

/** Failed logins tolerated per username before it stops being asked. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1_000;

export const BCRYPT_COST = 10;

/**
 * The hash printed in `auth.txt.example`, refused wherever it appears.
 *
 * Its password is in the example file, in public, in the repository. Copying
 * the example to `auth.txt` and forgetting to replace the line is the obvious
 * mistake, and it would leave the backend open to anybody who has read the
 * repository — so that particular credential never works, whatever it is
 * called.
 */
export const EXAMPLE_HASH = '$2b$10$vS/A4Jds3d3bO1x/a3/lNe5Z0E7ZN1BORvn5EPBtUQbmzUe2YGGj2';

/**
 * Reads the file format.
 *
 * `username:hash`, one per line. Splitting on the *first* colon is what makes
 * this unambiguous: a bcrypt hash contains `$`, `.` and `/`, but never a colon.
 * Blank lines and `#` comments are skipped so the file can explain itself.
 */
export function parseAuthFile(text: string): Map<string, string> {
  const users = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const username = line.slice(0, colon).trim();
    const hash = line.slice(colon + 1).trim();
    if (username && hash) users.set(username, hash);
  }
  return users;
}

/** Serialises back, comment header included, for `scripts/auth.ts`. */
export function formatAuthFile(users: Map<string, string>): string {
  const lines = [
    '# Privacy & Permission Guardian — managed backend credentials.',
    '# One `username:bcrypt-hash` per line. Add users with `bun run auth add <username>`.',
    ...[...users.entries()].map(([username, hash]) => `${username}:${hash}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function isValidUsername(username: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(username);
}

export interface IssuedToken {
  token: string;
  expiresAt: number;
}

export interface AuthStoreOptions {
  /** Where the credentials live. Ignored when `users` is given. */
  file?: string;
  /** In-memory credentials, so tests never touch a real file. */
  users?: Map<string, string>;
}

export class AuthStore {
  private readonly file: string | null;
  private users: Map<string, string>;
  private mtimeMs = -1;

  private readonly tokens = new Map<string, { username: string; expiresAt: number }>();
  private readonly failures = new Map<string, number[]>();

  /**
   * A hash to check a password against when the username does not exist.
   *
   * Without it, an unknown username answers immediately and a known one takes
   * the ~100 ms bcrypt costs, which tells an attacker which names are real.
   * Built on first use so that a server whose logins all succeed never pays for
   * it.
   */
  private decoyHash: string | null = null;

  constructor(options: AuthStoreOptions = {}) {
    if (options.users) {
      this.file = null;
      this.users = new Map(options.users);
    } else {
      this.file = options.file ?? Bun.env.PPG_AUTH_FILE ?? DEFAULT_AUTH_FILE;
      this.users = new Map();
      this.reload();
    }
  }

  /** Re-reads the file when it has changed on disk. Cheap enough per request. */
  private reload(): void {
    if (!this.file) return;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      // No file at all is a legitimate state: zero users, everything 401s, and
      // the startup banner says which command creates it.
      this.users = new Map();
      this.mtimeMs = -1;
      return;
    }
    if (mtimeMs === this.mtimeMs) return;
    this.mtimeMs = mtimeMs;
    try {
      this.users = parseAuthFile(readFileSync(this.file, 'utf8'));
    } catch {
      this.users = new Map();
    }
  }

  /** Usable credentials — the example line is deliberately not one. */
  count(): number {
    this.reload();
    return [...this.users.values()].filter((hash) => hash !== EXAMPLE_HASH).length;
  }

  path(): string {
    return this.file ?? '(in memory)';
  }

  /** Whether this username has spent its guesses for now. */
  isLockedOut(username: string): boolean {
    const recent = (this.failures.get(username) ?? []).filter(
      (at) => Date.now() - at < FAILURE_WINDOW_MS,
    );
    if (recent.length === 0) this.failures.delete(username);
    else this.failures.set(username, recent);
    return recent.length >= MAX_FAILURES;
  }

  private recordFailure(username: string): void {
    const recent = (this.failures.get(username) ?? []).filter(
      (at) => Date.now() - at < FAILURE_WINDOW_MS,
    );
    recent.push(Date.now());
    this.failures.set(username, recent);
  }

  async verify(username: string, password: string): Promise<boolean> {
    this.reload();
    const hash = this.users.get(username);

    if (!hash || hash === EXAMPLE_HASH) {
      this.decoyHash ??= await Bun.password.hash('ppg-no-such-user', {
        algorithm: 'bcrypt',
        cost: BCRYPT_COST,
      });
      await Bun.password.verify(password, this.decoyHash).catch(() => false);
      this.recordFailure(username);
      return false;
    }

    const ok = await Bun.password.verify(password, hash).catch(() => false);
    if (ok) this.failures.delete(username);
    else this.recordFailure(username);
    return ok;
  }

  issue(username: string): IssuedToken {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.tokens.set(token, { username, expiresAt });
    return { token, expiresAt };
  }

  /** The username behind a bearer token, or null if it is unknown or expired. */
  resolve(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return entry.username;
  }

  revoke(token: string): void {
    this.tokens.delete(token);
  }
}
