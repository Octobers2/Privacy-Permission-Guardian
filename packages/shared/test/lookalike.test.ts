import { describe, expect, test } from 'bun:test';
import { levenshtein } from '../src/lookalike.ts';

describe('levenshtein', () => {
  test('is zero for identical strings', () => {
    expect(levenshtein('paypal', 'paypal')).toBe(0);
  });

  test('counts a single substitution', () => {
    expect(levenshtein('paypa1', 'paypal')).toBe(1);
  });

  test('counts insertions and deletions', () => {
    expect(levenshtein('payppal', 'paypal')).toBe(1);
    expect(levenshtein('papal', 'paypal')).toBe(1);
  });

  test('handles empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', '')).toBe(0);
  });

  test('is symmetric', () => {
    expect(levenshtein('microsoft', 'micr0soft')).toBe(levenshtein('micr0soft', 'microsoft'));
  });

  test('reports max + 1 instead of the true distance once past the budget', () => {
    // The caller only ever asks "is this within 2 edits?", so anything further
    // away just needs to be recognisably out of range.
    expect(levenshtein('paypal', 'wikipedia', 2)).toBe(3);
    expect(levenshtein('paypal', 'paypa1', 2)).toBe(1);
  });

  test('bails out early on a hopeless length difference', () => {
    expect(levenshtein('ab', 'abcdefghijklmnop', 2)).toBe(3);
  });
});
