import { describe, expect, test } from 'bun:test';
import { RateLimiter } from '../src/ratelimit.ts';
import { clock } from './helpers.ts';

describe('RateLimiter', () => {
  test('allows a burst, then refuses, then refills', () => {
    const c = clock();
    const limiter = new RateLimiter({ capacity: 3, perMs: 3_000, now: c.now });
    expect([1, 2, 3].map(() => limiter.take('ip').ok)).toEqual([true, true, true]);
    const refused = limiter.take('ip');
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.retryAfterMs).toBe(1_000);
    c.advance(1_000);
    expect(limiter.take('ip').ok).toBe(true);
    expect(limiter.take('ip').ok).toBe(false);
  });

  test('keeps clients apart', () => {
    const limiter = new RateLimiter({ capacity: 1, perMs: 60_000, now: clock().now });
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
    expect(limiter.take('b').ok).toBe(true);
  });

  test('never holds more keys than its cap', () => {
    const limiter = new RateLimiter({ capacity: 1, perMs: 60_000, now: clock().now, maxKeys: 3 });
    for (let i = 0; i < 10; i++) limiter.take(`ip${i}`);
    // the oldest keys were forgotten, so they start with a full bucket again
    expect(limiter.take('ip0').ok).toBe(true);
  });
});
