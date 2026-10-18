import { describe, expect, test } from 'bun:test';
import type { EndpointConfig } from '@ppg/shared';
import { AuthStore, EXAMPLE_HASH, formatAuthFile, isValidUsername, parseAuthFile } from '../src/auth.ts';
import { createApp } from '../src/index.ts';
import { ResultStore } from '../src/store.ts';

const CONFIG: EndpointConfig = {
  baseUrl: 'https://model.invalid/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  temperature: 0,
  maxTokens: 500,
  timeoutMs: 2_000,
};

/** Cost 4 rather than the production 10: the tests log in dozens of times. */
const PASSWORD = 'hunter2hunter2';
const hashOf = (password: string) => Bun.password.hash(password, { algorithm: 'bcrypt', cost: 4 });

async function storeWith(username = 'demo', password = PASSWORD): Promise<AuthStore> {
  return new AuthStore({ users: new Map([[username, await hashOf(password)]]) });
}

function appWith(auth: AuthStore) {
  return createApp({ config: CONFIG, store: new ResultStore({ file: ':memory:' }), auth, modelsDir: '/nonexistent' });
}

function login(app: ReturnType<typeof appWith>, body: unknown) {
  return app.request('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('parseAuthFile', () => {
  test('reads username:hash, one per line', () => {
    const users = parseAuthFile('alice:$2b$10$aaa\nbob:$2b$10$bbb\n');
    expect(users.get('alice')).toBe('$2b$10$aaa');
    expect(users.get('bob')).toBe('$2b$10$bbb');
  });

  test('skips comments and blank lines', () => {
    const users = parseAuthFile('# a comment\n\n   \nalice:$2b$10$aaa\n');
    expect(users.size).toBe(1);
  });

  test('splits on the first colon only', () => {
    // Not something bcrypt produces, but the parser must not be the thing that
    // decides a hash is malformed.
    const users = parseAuthFile('alice:$2b$10$a:b:c');
    expect(users.get('alice')).toBe('$2b$10$a:b:c');
  });

  test('ignores a line with no colon rather than inventing a user', () => {
    expect(parseAuthFile('alice\n:orphan\n').size).toBe(0);
  });

  test('round-trips through formatAuthFile', () => {
    const users = new Map([['alice', '$2b$10$aaa']]);
    expect(parseAuthFile(formatAuthFile(users))).toEqual(users);
  });
});

describe('isValidUsername', () => {
  test('refuses anything that would break the file format', () => {
    expect(isValidUsername('alice')).toBe(true);
    expect(isValidUsername('a.b_c-1')).toBe(true);
    expect(isValidUsername('has:colon')).toBe(false);
    expect(isValidUsername('has space')).toBe(false);
    expect(isValidUsername('')).toBe(false);
  });
});

describe('AuthStore', () => {
  test('verifies a correct password and refuses a wrong one', async () => {
    const auth = await storeWith();
    expect(await auth.verify('demo', PASSWORD)).toBe(true);
    expect(await auth.verify('demo', 'wrong-password')).toBe(false);
    expect(await auth.verify('nobody', PASSWORD)).toBe(false);
  });

  test('never accepts the hash printed in auth.txt.example', async () => {
    // Its password is in the repository. Copying the example and forgetting to
    // replace the line must not leave the backend open.
    const auth = new AuthStore({ users: new Map([['demo', EXAMPLE_HASH]]) });
    expect(await auth.verify('demo', 'change-me-please')).toBe(false);
    expect(auth.count()).toBe(0);
  });

  test('resolves a token it issued, and nothing else', async () => {
    const auth = await storeWith();
    const { token } = auth.issue('demo');
    expect(auth.resolve(token)).toBe('demo');
    expect(auth.resolve('made-up')).toBeNull();

    auth.revoke(token);
    expect(auth.resolve(token)).toBeNull();
  });

  test('locks a username out after repeated failures', async () => {
    const auth = await storeWith();
    expect(auth.isLockedOut('demo')).toBe(false);
    for (let attempt = 0; attempt < 10; attempt++) await auth.verify('demo', 'wrong');
    expect(auth.isLockedOut('demo')).toBe(true);
  });

  test('a successful login clears the count', async () => {
    const auth = await storeWith();
    for (let attempt = 0; attempt < 9; attempt++) await auth.verify('demo', 'wrong');
    expect(await auth.verify('demo', PASSWORD)).toBe(true);
    for (let attempt = 0; attempt < 9; attempt++) await auth.verify('demo', 'wrong');
    expect(auth.isLockedOut('demo')).toBe(false);
  });
});

describe('POST /api/login', () => {
  test('exchanges a password for a token', async () => {
    const app = appWith(await storeWith());
    const response = await login(app, { username: 'demo', password: PASSWORD });
    const body = (await response.json()) as { token: string; expiresAt: number };

    expect(response.status).toBe(200);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  test('answers the same way to a wrong password and an unknown user', async () => {
    const app = appWith(await storeWith());
    const wrong = await login(app, { username: 'demo', password: 'nope-nope-nope' });
    const unknown = await login(app, { username: 'ghost', password: 'nope-nope-nope' });

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  test('rejects a malformed body', async () => {
    const app = appWith(await storeWith());
    expect((await login(app, { username: 'demo' })).status).toBe(400);
  });

  test('stops answering a username that keeps guessing', async () => {
    const app = appWith(await storeWith());
    for (let attempt = 0; attempt < 10; attempt++) {
      await login(app, { username: 'demo', password: `guess-${attempt}` });
    }
    const response = await login(app, { username: 'demo', password: PASSWORD });
    expect(response.status).toBe(429);
  });
});

describe('the token gate', () => {
  test('refuses the write and account routes without a token, and leaves the public ones open', async () => {
    const app = appWith(await storeWith());
    for (const [method, path] of [['GET', '/api/status'], ['POST', '/api/results'], ['POST', '/api/form/assess']] as const) {
      const response = await app.request(path, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      expect(response.status).toBe(401);
    }
    for (const path of ['/health', '/api/v1/stats', '/api/v1/recent']) {
      expect((await app.request(path)).status).toBe(200);
    }
  });

  test('lets a token through', async () => {
    const auth = await storeWith();
    const app = appWith(auth);
    const { token } = auth.issue('demo');

    const response = await app.request('/api/status', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { username: string }).username).toBe('demo');
  });

  test('refuses a revoked token', async () => {
    const auth = await storeWith();
    const app = appWith(auth);
    const { token } = auth.issue('demo');
    auth.revoke(token);

    const response = await app.request('/api/status', { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(401);
  });
});
