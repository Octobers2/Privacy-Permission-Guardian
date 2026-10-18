import { describe, expect, test } from 'bun:test';
import golden from './fixtures/normalize.golden.json' with { type: 'json' };
import { normalizeForModel, segmentDocument, splitSentences } from '../src/classifier-text.ts';

describe('normalizeForModel matches the Python reference (NLTK Treebank + address protection)', () => {
  test(`all ${golden.length} golden sentences`, () => {
    const wrong = golden.filter((g) => normalizeForModel(g.text) !== g.normalized);
    expect(wrong.map((g) => ({ in: g.text, want: g.normalized, got: normalizeForModel(g.text) })).slice(0, 3)).toEqual([]);
  });
});

describe('normalizeForModel', () => {
  test('puts prose into the corpus style', () => {
    expect(normalizeForModel('We may terminate your account, at any time.')).toBe('we may terminate your account , at any time .');
    expect(normalizeForModel("Users' rights (see section 5.4) don't change.")).toBe("users ' rights ( see section 5.4 ) do n't change .");
    expect(normalizeForModel('He said "stop" now.')).toBe("he said `` stop '' now .");
  });
  test('keeps web and email addresses whole', () => {
    expect(normalizeForModel('See https://example.com/a-b, or mail Legal@Example.com.')).toBe('see https://example.com/a-b , or mail legal@example.com .');
  });
  test('is idempotent on text that is already in the corpus style', () => {
    const s = 'you can control most communications from the services .';
    expect(normalizeForModel(s)).toBe(s);
  });
});

describe('splitSentences', () => {
  test('splits at sentence ends but not at abbreviations, initials or numbering', () => {
    expect(splitSentences('We may stop. You agree to this. Acme Inc. owns it. See e.g. section 5. Fine.')).toEqual([
      'We may stop.',
      'You agree to this.',
      'Acme Inc. owns it.',
      'See e.g. section 5.',
      'Fine.',
    ]);
    expect(splitSentences('Governed by U.S. law. J. Smith agrees.')).toEqual(['Governed by U.S. law.', 'J. Smith agrees.']);
  });
  test('keeps a quotation and the sentence that follows apart', () => {
    expect(splitSentences('He said "no." Then he left.')).toEqual(['He said "no."', 'Then he left.']);
  });
});

describe('segmentDocument', () => {
  const doc = `Terms of Service
Home | Contact | Help

1. Your account
You are responsible for your account. We may suspend it at any time, with or without notice.
• Do not share your password with anybody else.
• Short.

Disputes will be resolved by binding arbitration; you waive any class action.`;

  test('keeps clauses in reading order and drops headings and menu debris', () => {
    expect(segmentDocument(doc)).toEqual([
      'You are responsible for your account.',
      'We may suspend it at any time, with or without notice.',
      '• Do not share your password with anybody else.',
      'Disputes will be resolved by binding arbitration; you waive any class action.',
    ]);
  });
  test('cuts a very long run-on sentence at a boundary rather than mid-word', () => {
    const long = Array.from({ length: 90 }, (_, i) => `clause number ${i} applies here`).join('; ') + '.';
    const parts = segmentDocument(long, { maxChars: 400 });
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.length <= 400)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
  });
});
