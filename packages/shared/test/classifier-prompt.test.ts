import { describe, expect, test } from 'bun:test';
import golden from './fixtures/prompts.golden.json' with { type: 'json' };
import { LETTERS_PROMPT_VERSION, PII_PROMPT_VERSION, letterPrompt, piiPrompt, probabilities } from '../src/classifier-prompt.ts';

describe('prompts match the Python source of truth byte for byte', () => {
  test('versions', () => {
    expect(LETTERS_PROMPT_VERSION).toBe(golden.letters);
    expect(PII_PROMPT_VERSION).toBe(golden.pii);
  });
  golden.tos.forEach((c, i) => test(`terms-of-service case ${i}`, () => expect(letterPrompt(c.passage)).toBe(c.prompt)));
  golden.pii_cases.forEach((c, i) => test(`PII case ${i}: ${c.url.slice(0, 48)}`, () => expect(piiPrompt(c.url, c.text)).toBe(c.prompt)));
});

describe('piiPrompt', () => {
  test('never includes the query string or fragment', () => {
    const p = piiPrompt('https://x.example/account?session=SECRET#frag', 'text');
    expect(p).not.toContain('SECRET');
    expect(p).not.toContain('frag');
  });
});

describe('probabilities', () => {
  test('sums to one and orders like the logits', () => {
    const p = probabilities([2, 0, -1], 1);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(p[0]).toBeGreaterThan(p[1]!);
  });
  test('a higher temperature flattens, a lower one sharpens', () => {
    expect(probabilities([2, 0], 4)[0]!).toBeLessThan(probabilities([2, 0], 1)[0]!);
    expect(probabilities([2, 0], 0.5)[0]!).toBeGreaterThan(probabilities([2, 0], 1)[0]!);
  });
  test('survives large logits', () => {
    expect(probabilities([1000, 999])[0]).toBeCloseTo(0.731, 3);
  });
});
