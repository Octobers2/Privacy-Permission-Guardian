import { describe, expect, test } from 'bun:test';
import {
  decodePunycodeHostname,
  decodePunycodeLabel,
  levenshtein,
  normaliseHomoglyphs,
} from '../src/lookalike.ts';

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

describe('decodePunycodeLabel', () => {
  test('leaves plain labels alone', () => {
    expect(decodePunycodeLabel('paypal')).toBe('paypal');
    expect(decodePunycodeLabel('secure-login')).toBe('secure-login');
  });

  test('decodes a cyrillic homoglyph domain', () => {
    // "pаypal" with a Cyrillic а (U+0430) — the classic IDN homograph attack.
    expect(decodePunycodeLabel('xn--pypal-4ve')).toBe('pаypal');
  });

  test('decodes a fully non-latin label', () => {
    expect(decodePunycodeLabel('xn--4gq171p')).toBe('一頁');
  });

  test('decodes the apple.com homograph', () => {
    // xn--80ak6aa92e rendered as "apple" in the address bar of every major
    // browser in 2017; every character is Cyrillic.
    expect(decodePunycodeLabel('xn--80ak6aa92e')).toBe('аррӏе');
  });

  test('returns the input unchanged when the encoding is malformed', () => {
    expect(decodePunycodeLabel('xn--!!!')).toBe('xn--!!!');
  });

  test('decodes each label of a hostname independently', () => {
    expect(decodePunycodeHostname('www.xn--pypal-4ve.com')).toBe('www.pаypal.com');
  });
});

describe('normaliseHomoglyphs', () => {
  test('folds case', () => {
    expect(normaliseHomoglyphs('PayPal')).toBe('paypal');
  });

  test('folds digits typed in place of letters', () => {
    expect(normaliseHomoglyphs('paypa1')).toBe('paypal');
    expect(normaliseHomoglyphs('g00gle')).toBe('google');
    expect(normaliseHomoglyphs('micr0s0ft')).toBe('microsoft');
  });

  test('folds cyrillic lookalikes onto latin', () => {
    expect(normaliseHomoglyphs('аррӏе')).toBe('apple');
    expect(normaliseHomoglyphs('pаypal')).toBe('paypal');
  });

  test('folds letter pairs that read as one letter', () => {
    expect(normaliseHomoglyphs('rnicrosoft')).toBe('microsoft');
    expect(normaliseHomoglyphs('vvhatsapp')).toBe('whatsapp');
  });

  test('strips accents', () => {
    expect(normaliseHomoglyphs('pàypal')).toBe('paypal');
  });

  test('leaves an already canonical label untouched', () => {
    for (const label of ['paypal', 'hsbc', 'octopus', 'google']) {
      expect(normaliseHomoglyphs(label)).toBe(label);
    }
  });
});
