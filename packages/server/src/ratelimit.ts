/**
 * A token bucket per key (per client IP). In memory on purpose: a restart gives everyone a full bucket, which is
 * harmless, and it means no shared state to run or secure. Old keys are evicted so a scan from many addresses cannot
 * grow the map without bound.
 */
export interface LimiterOptions {
  /** Burst size, and the number of requests allowed per `perMs`. */
  capacity: number;
  perMs: number;
  now?: () => number;
  maxKeys?: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: LimiterOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  /** Spends one token for `key`; when there are none, says how long until one is available. */
  take(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const { capacity, perMs } = this.options;
    const rate = capacity / perMs;
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, at: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * rate);
    bucket.at = now;

    // Re-insert so Map order is least-recently-used first.
    this.buckets.delete(key);
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      this.evict();
      return { ok: false, retryAfterMs: Math.ceil((1 - bucket.tokens) / rate) };
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    this.evict();
    return { ok: true };
  }

  private evict(): void {
    while (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
  }
}
