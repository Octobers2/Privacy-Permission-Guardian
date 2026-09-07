import { describe, expect, test } from 'bun:test';
import { riskBand, riskScore } from '../src/score.ts';

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

describe('riskBand', () => {
  test('splits at the documented boundaries', () => {
    expect(riskBand(0)).toBe('low');
    expect(riskBand(24)).toBe('low');
    expect(riskBand(25)).toBe('moderate');
    expect(riskBand(59)).toBe('moderate');
    expect(riskBand(60)).toBe('high');
    expect(riskBand(100)).toBe('high');
  });

  test('a single high-severity finding is not on its own a high-risk site', () => {
    // One "shares data with advertisers" is worth flagging, but it does not
    // make a site as bad as one doing four separate things wrong.
    expect(riskBand(riskScore([{ severity: 'high' }]))).toBe('moderate');
  });
});
