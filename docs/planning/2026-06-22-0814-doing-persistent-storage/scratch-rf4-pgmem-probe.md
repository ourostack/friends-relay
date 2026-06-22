# RF4 pg-mem probe findings (concurrent-enqueue atomicity)

Goal: pick an atomic enqueue shape that enforces BOTH the per-handle count bound AND
the byte-sum bound in one atomic step, preserving the memory store's distinct
`quota_count` / `quota_bytes` reasons (count checked first), and that runs under the
hermetic `pg-mem` harness.

## Option 1 — single `INSERT … SELECT … WHERE (count) AND (byte)`  → REJECTED by pg-mem

Both forms tried (untyped projection, and explicit `::text/::jsonb/::bigint/::int`
casts, and `FROM (VALUES (...)) v(...)`) fail under pg-mem 3.0.14 with:

    cannot cast type integer to list

i.e. pg-mem mis-parses the `INSERT … SELECT <multi-col projection> WHERE …` form. The
**bare** scalar-subquery comparison works fine in a plain SELECT:

    select (select count(*) from inbox where handle=$1 and expires_at>$2) < $3::int as cnt_ok,
           (select coalesce(sum(size_bytes),0) from inbox where handle=$1 and expires_at>$2) + $4::int <= $5::int as byte_ok
    -> { cnt_ok: true, byte_ok: false }   (160 > 150)

So the cap predicates are expressible; only the `INSERT…SELECT…WHERE` wrapper is the
pg-mem limitation (not real SQL — production Postgres accepts it). Unusable hermetically.

## Option 2 — SERIALIZABLE transaction  → WORKS under pg-mem, chosen

pg-mem supports everything the transaction path needs:
- `pool.connect()` returns a client whose `query` + `release` are functions (matches real `pg`).
- `BEGIN ISOLATION LEVEL SERIALIZABLE` parses + runs.
- `... FOR UPDATE` parses.
- `rollback` works; `pool.query` continues to work after a rollback.
- `bigserial seq` auto-assigns under a txn INSERT — FIFO `order by seq` preserved
  (`qa`→seq 1, `qb`→seq 2 after a txn that inserts both).

Validated flow (exact-cap behavior, count-first precedence, distinct reasons):

    begin isolation level serializable
    delete from inbox where handle=$h and expires_at <= $now           -- prune (drop-on-enqueue)
    select count(*)::int as n, coalesce(sum(size_bytes),0)::int as bytes
      from inbox where handle=$h and expires_at > $now [for update]
    -- n >= maxMessages           -> commit; { ok:false, reason:'quota_count' }
    -- bytes + size > maxBytes     -> commit; { ok:false, reason:'quota_bytes' }
    insert into inbox (...) values (...)
    commit                                                              -- { ok:true, queueId }

Probe result: byte-reject → no insert; byte-pass → insert; count-reject → no insert;
final state exactly `n=3 bytes=145` (no overshoot). Matches MemoryInboxStore semantics.

## Why SERIALIZABLE (not bare FOR UPDATE)

The empty-handle race is a **phantom**: two concurrent enqueues to a handle with zero
live rows both `FOR UPDATE`-lock nothing → both can insert → overshoot. SERIALIZABLE
detects the read/write skew and aborts one with SQLSTATE `40001`; the adapter retries a
bounded number of times. pg-mem is single-threaded so it never raises 40001 — the retry
branch is covered by a fake-pool unit test that throws a `{ code: '40001' }` error once
then succeeds.

## Interface impact

`PgPool` structural interface gains `connect(): Promise<PgPoolClient>` where
`PgPoolClient = { query(...): Promise<{rows; rowCount}>; release(): void }`. Real
`pg.Pool` and the pg-mem Pool both satisfy it.
