import { describe, expect, test } from 'bun:test';
import { sha256Hex } from '../src/policy.ts';

describe('sha256Hex', () => {
  test('matches the known digest of the empty string', () => {
    expect(sha256Hex('')).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('changes when the text changes', async () => {
    expect(await sha256Hex('a')).not.toBe(await sha256Hex('b'));
  });
});
