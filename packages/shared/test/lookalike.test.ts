import { describe, expect, test } from 'bun:test';
import {
  decodePunycodeHostname,
  decodePunycodeLabel,
  detectLookalike,
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

describe('detectLookalike', () => {
  test('does not flag the real brand or its subdomains', () => {
    for (const host of ['paypal.com', 'www.paypal.com', 'mail.google.com', 'support.microsoft.com', 'hsbc.com.hk']) {
      expect(detectLookalike(host)).toBeNull();
    }
  });

  test('catches a digit swapped for a letter', () => {
    const match = detectLookalike('paypa1.com');
    expect(match?.kind).toBe('homoglyph');
    expect(match?.brand.domain).toBe('paypal.com');
  });

  test('catches a punycode-encoded cyrillic homograph', () => {
    const match = detectLookalike('xn--pypal-4ve.com');
    expect(match?.kind).toBe('homoglyph');
    expect(match?.brand.domain).toBe('paypal.com');
  });

  test('catches a one-character typo on a long label', () => {
    const match = detectLookalike('payppal.com');
    expect(match?.kind).toBe('typo');
    expect(match?.distance).toBe(1);
  });

  test('catches the brand sitting in a subdomain of somebody else', () => {
    const match = detectLookalike('paypal.secure-login.xyz');
    expect(match?.kind).toBe('impersonation');
    expect(match?.brand.domain).toBe('paypal.com');
  });

  test('catches the brand as a word inside the registrable label', () => {
    expect(detectLookalike('hsbc-verify.top')?.brand.name).toBe('HSBC');
    expect(detectLookalike('dhl-tracking.xyz')?.brand.name).toBe('DHL');
    expect(detectLookalike('ird-gov.hk')?.brand.domain).toBe('ird.gov.hk');
  });

  test('names the bank rather than one of its products', () => {
    // hsbc.com.hk and payme.hsbc.com.hk both reduce to the label "hsbc"; the
    // banner has to say HSBC, not PayMe.
    expect(detectLookalike('hsbc-verify.top')?.brand.domain).toBe('hsbc.com.hk');
  });

  test('does not flag a brand name that is merely a substring', () => {
    expect(detectLookalike('amazonaws.com')).toBeNull();
    expect(detectLookalike('my.backups.example.com')).toBeNull();
  });

  test('does not flag ordinary words that happen to be brand labels', () => {
    for (const host of ['max.example.com', 'line.example.com', 'box.internal.example.com']) {
      expect(detectLookalike(host)).toBeNull();
    }
  });

  test('does not flag short labels one edit from a brand', () => {
    // "vista" is one insertion from "visa"; a flat edit budget would warn here.
    expect(detectLookalike('vista.com')).toBeNull();
  });

  test('returns null for hostnames with no registrable domain', () => {
    expect(detectLookalike('localhost')).toBeNull();
    expect(detectLookalike('127.0.0.1')).toBeNull();
  });
});
