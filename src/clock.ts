// clock — an injectable time source. Everything time-dependent (TTL expiry, rate-
// limit refill) reads `clock.now()` so tests can advance time deterministically
// without real timers. The default is `Date.now`.

/** A monotonic-ish wall-clock source in ms epoch. */
export interface Clock {
  now(): number
}

/** The production clock — wall time. */
export const systemClock: Clock = {
  now: () => Date.now(),
}

/** A controllable clock for tests: starts at `start`, advances via `advance`. */
export class ManualClock implements Clock {
  private t: number

  constructor(start = 0) {
    this.t = start
  }

  now(): number {
    return this.t
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    this.t += ms
  }

  /** Set the clock to an absolute ms-epoch value. */
  set(ms: number): void {
    this.t = ms
  }
}
