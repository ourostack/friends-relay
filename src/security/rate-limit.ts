// security/rate-limit — a per-key token-bucket rate limiter. Keys are send
// credentials and recipient handles (p8 §2.3: "per-credential + per-handle rate
// limits"). Refill is clock-driven (injectable clock → deterministic tests, no real
// timers). Denying is always safe (a denied enqueue is a denial, never corruption).

import type { Clock } from "../clock"

/** Token-bucket params. `capacity` tokens max; refills at `refillPerSec` tokens/sec. */
export interface RateLimitConfig {
  capacity: number
  refillPerSec: number
}

interface Bucket {
  tokens: number
  lastRefillMs: number
}

/** A per-key token-bucket limiter. `take(key)` consumes one token; returns false
 * when the bucket is empty (rate exceeded). */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly config: RateLimitConfig,
    private readonly clock: Clock,
  ) {}

  /** Attempt to consume one token for `key`. Returns true if allowed. */
  take(key: string): boolean {
    const now = this.clock.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.config.capacity, lastRefillMs: now }

    // Refill based on elapsed time since the last refill.
    const elapsedSec = (now - bucket.lastRefillMs) / 1000
    if (elapsedSec > 0) {
      bucket.tokens = Math.min(this.config.capacity, bucket.tokens + elapsedSec * this.config.refillPerSec)
      bucket.lastRefillMs = now
    }

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= 1
    this.buckets.set(key, bucket)
    return true
  }
}
