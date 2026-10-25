import { describe, expect, test } from 'bun:test';
import golden from './fixtures/prompts.golden.json' with { type: 'json' };
import {
  LETTERS_PROMPT_VERSION,
  LETTERS_V2_PROMPT_VERSION,
  PII_PROMPT_VERSION,
  decideCategory,
  letterPrompt,
  letterPromptV2,
  piiPrompt,
  probabilities,
  tosPrompt,
} from '../src/classifier-prompt.ts';

describe('prompts match the Python source of truth byte for byte', () => {
  test('versions', () => {
    expect(LETTERS_PROMPT_VERSION).toBe(golden.letters);
    expect(LETTERS_V2_PROMPT_VERSION).toBe(golden.letters_v2);
    expect(PII_PROMPT_VERSION).toBe(golden.pii);
  });
  golden.tos.forEach((c, i) => test(`terms-of-service case ${i}`, () => expect(letterPrompt(c.passage)).toBe(c.prompt)));
  golden.tos_v2.forEach((c, i) => test(`terms-of-service v2 case ${i}`, () => expect(letterPromptV2(c.passage, c.previous)).toBe(c.prompt)));
  golden.pii_cases.forEach((c, i) => test(`PII case ${i}: ${c.url.slice(0, 48)}`, () => expect(piiPrompt(c.url, c.text)).toBe(c.prompt)));
  test('flag decisions match calibrate.decide', () => {
    for (const c of golden.decisions) expect(decideCategory(c.probs, c.threshold ?? undefined)).toBe(c.category as never);
  });
});

describe('tosPrompt', () => {
  test('picks the builder by version', () => {
    expect(tosPrompt('letters-v1', 'x y z', 'ignored')).toBe(letterPrompt('x y z'));
    expect(tosPrompt('letters-v2', 'x y z', 'before')).toBe(letterPromptV2('x y z', 'before'));
    expect(() => tosPrompt('letters-v9', 'x')).toThrow();
  });
  test('v2 without a previous sentence says so', () => {
    expect(letterPromptV2('x')).toContain('Previous sentence: (none)\n');
  });
});

describe('decideCategory', () => {
  const p = [0.05, 0, 0, 0.3, 0, 0, 0.6, 0.05, 0];
  test('no threshold: most likely class', () => expect(decideCategory(p)).toBe('other'));
  test('below the threshold: the most likely unfair class', () => expect(decideCategory(p, 0.7)).toBe('arbitration'));
  test('at or above the threshold: other', () => expect(decideCategory(p, 0.6)).toBe('other'));
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
