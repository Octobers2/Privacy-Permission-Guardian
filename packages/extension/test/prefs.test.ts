import { describe, expect, test } from 'bun:test';
import { activeAccount, DEFAULT_PREFS, isReady, parsePrefs } from '../src/prefs.ts';

describe('parsePrefs', () => {
  test('nothing stored -> defaults, with the summary off', () => {
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS.summary).toBe('off');
    expect(DEFAULT_PREFS.setupDone).toBe(false);
  });
  test('keeps valid fields and drops only the broken one', () => {
    const p = parsePrefs({ setupDone: true, modelId: 'ppg-fast', serverUrl: 'not a url', summary: 'sometimes' });
    expect(p).toMatchObject({ setupDone: true, modelId: 'ppg-fast', summary: 'off' });
    expect(p.serverUrl).toBe(DEFAULT_PREFS.serverUrl);
  });
  test('unknown keys do not survive', () => {
    expect('stray' in parsePrefs({ setupDone: true, stray: 1 })).toBe(false);
  });
});

describe('activeAccount', () => {
  const account = { username: 'a', token: 't', expiresAt: 1_000 };
  test('is the account until its token expires', () => {
    expect(activeAccount({ ...DEFAULT_PREFS, account }, 999)).toEqual(account);
    expect(activeAccount({ ...DEFAULT_PREFS, account }, 1_000)).toBeNull();
    expect(activeAccount(DEFAULT_PREFS)).toBeNull();
  });
});

describe('shared-only mode', () => {
  test('is off by default and a model is then required to be ready', () => {
    expect(parsePrefs({}).mode).toBe('device');
    expect(isReady(parsePrefs({ setupDone: true }))).toBe(false);
    expect(isReady(parsePrefs({ setupDone: true, modelId: 'ppg-fast-0.8b-q4f32' }))).toBe(true);
  });

  test('shared mode is ready without a model, but not before setup finished', () => {
    expect(isReady(parsePrefs({ setupDone: true, mode: 'shared' }))).toBe(true);
    expect(isReady(parsePrefs({ setupDone: false, mode: 'shared' }))).toBe(false);
  });

  test('an unknown mode falls back to the default instead of locking the user out', () => {
    expect(parsePrefs({ setupDone: true, modelId: 'x', mode: 'cloud' }).mode).toBe('device');
  });
});
