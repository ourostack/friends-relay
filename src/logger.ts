// logger — a structured, METADATA-ONLY logger. The relay logs handle, size,
// timing, and decisions; it NEVER logs a payload (it can't read one). `no-console`
// in eslint makes the "never console.log a blob" rule structural; this interface is
// the only sanctioned sink, and it takes a typed metadata object, not free text +
// a body, so there's no place to slip a ciphertext or a decrypted field in.

/** A log severity. */
export type LogLevel = "info" | "warn" | "error"

/** Metadata-only structured fields. Deliberately NOT `unknown`-valued for a
 * payload: only routing/operational scalars belong here. */
export interface LogFields {
  /** The recipient handle involved (routing metadata — legitimately visible). */
  handle?: string
  /** Message size in bytes (quota/rate metadata). */
  sizeBytes?: number
  /** A decision/outcome code (e.g. "enqueued", "dropped_quota", "auth_failed"). */
  decision?: string
  /** A reason code for a rejection. */
  reason?: string
  /** A count (queue depth, drops). */
  count?: number
}

/** The structured logger the relay logs through. */
export interface Logger {
  log(level: LogLevel, event: string, fields?: LogFields): void
}

/** A no-op logger (the test/default-quiet sink). */
export const silentLogger: Logger = {
  log: () => {
    /* intentionally silent */
  },
}

/** A logger that collects entries in memory — used by tests to assert that ONLY
 * metadata is ever logged (never a payload). */
export class MemoryLogger implements Logger {
  readonly entries: { level: LogLevel; event: string; fields: LogFields }[] = []

  log(level: LogLevel, event: string, fields: LogFields = {}): void {
    this.entries.push({ level, event, fields })
  }
}
