import { describe, expect, test } from 'bun:test';
import { activeAccount, DEFAULT_PREFS, parsePrefs } from '../src/prefs.ts';

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
