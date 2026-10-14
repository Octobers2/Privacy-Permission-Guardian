import { describe, expect, test } from 'bun:test';
import { excerpt, flaggedHeadline, sharingLine, timeAgo } from '../src/ui/format.ts';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

describe('timeAgo', () => {
  test('reads naturally at each scale', () => {
    expect(timeAgo(ago(20_000), NOW)).toBe('just now');
    expect(timeAgo(ago(12 * MIN), NOW)).toBe('12 minutes ago');
    expect(timeAgo(ago(60 * MIN), NOW)).toBe('60 minutes ago');
    expect(timeAgo(ago(3 * 60 * MIN), NOW)).toBe('3 hours ago');
    expect(timeAgo(ago(40 * 60 * MIN), NOW)).toBe('2 days ago');
    expect(timeAgo(ago(24 * 60 * MIN), NOW)).toBe('24 hours ago');
  });
  test('a timestamp in the future is "just now", not negative', () => expect(timeAgo(ago(-5 * MIN), NOW)).toBe('just now'));
});

describe('sharingLine', () => {
  test('says why a result was not shared', () => {
    expect(sharingLine({ status: 'blocked', reasons: ['1 personal email address'] }).text).toContain('personal information (1 personal email address)');
    expect(sharingLine({ status: 'blocked', reasons: [] }).tone).toBe('warn');
    expect(sharingLine({ status: 'not-signed-in' }).tone).toBe('neutral');
    expect(sharingLine({ status: 'failed', message: 'Could not reach the server.' }).text).toContain('Could not reach the server.');
    expect(sharingLine({ status: 'shared', id: 1 }).tone).toBe('good');
  });
});

describe('flaggedHeadline / excerpt', () => {
  test('singular and plural', () => {
    expect(flaggedHeadline(0, 120)).toBe('No potentially unfair clauses found');
    expect(flaggedHeadline(1, 120)).toBe('1 potentially unfair clause in 120 read');
    expect(flaggedHeadline(9, 120)).toBe('9 potentially unfair clauses in 120 read');
  });
  test('excerpt cuts at a word and only when needed', () => {
    expect(excerpt('short text')).toBe('short text');
    const long = 'word '.repeat(100);
    const e = excerpt(long, 50);
    expect(e.endsWith('…')).toBe(true);
    expect(e.length).toBeLessThanOrEqual(51);
    expect(e).not.toMatch(/wor…$/);
  });
});
