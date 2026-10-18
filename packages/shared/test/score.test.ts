import { describe, expect, test } from 'bun:test';
import { riskScore } from '../src/score.ts';

describe('riskScore', () => {
  test('is zero with nothing to report', () => {
    expect(riskScore([])).toBe(0);
  });

  test('adds up severities', () => {
    expect(riskScore([{ severity: 'high' }, { severity: 'medium' }, { severity: 'low' }])).toBe(41);
  });

  test('is capped at 100', () => {
    expect(riskScore(Array.from({ length: 8 }, () => ({ severity: 'high' as const })))).toBe(100);
  });

  test('is deterministic for the same findings', () => {
    const points = [{ severity: 'high' as const }, { severity: 'low' as const }];
    expect(riskScore(points)).toBe(riskScore([...points].reverse()));
  });
});
