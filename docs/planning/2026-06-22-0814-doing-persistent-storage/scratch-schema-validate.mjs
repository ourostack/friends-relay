// Scratch validation: prove the Unit-0 DDL + every adapter SQL shape is accepted by
// pg-mem 3.0.14 + pg 8.22.0. Hermetic, in-process. Run: node scratch-schema-validate.mjs
import { newDb } from "pg-mem"

async function main() {
  // noAstCoverageCheck: pg-mem's default strict mode rejects `create table if not
  // exists (...)` with inline `not null`/`primary key` constraints via the Pool
  // adapter (an AST-coverage limitation, NOT a real SQL incompatibility — real
  // Postgres accepts the DDL natively). Relaxing the check is a test-harness concern.
  const db = newDb({ noAstCoverageCheck: true })
  const { Pool } = db.adapters.createPg()
  const pool = new Pool()

  // ── DDL (the four tables + indexes; idempotent create-if-not-exists) ──
  const DDL = [
    `create table if not exists inbox (
       handle text not null,
       queue_id text primary key,
       message jsonb not null,
       enqueued_at bigint not null,
       expires_at bigint not null,
       size_bytes int not null,
       seq bigserial
     )`,
    `create index if not exists inbox_handle_expires on inbox (handle, expires_at)`,
    `create table if not exists registrations (
       handle text primary key,
       did text not null,
       agent_card jsonb not null,
       key_agreement_pubkey text,
       registered_at bigint not null
     )`,
    `create index if not exists registrations_did on registrations (did)`,
    `create table if not exists invites (
       token text primary key,
       remaining int not null
     )`,
    `create table if not exists credentials (
       handle text primary key,
       inbox_auth text not null,
       send_credential text not null
     )`,
    `create unique index if not exists credentials_inbox_auth on credentials (inbox_auth)`,
    `create unique index if not exists credentials_send_credential on credentials (send_credential)`,
  ]
  for (const stmt of DDL) await pool.query(stmt)
  // idempotency: run again
  for (const stmt of DDL) await pool.query(stmt)
  console.log("DDL: accepted (and idempotent)")

  // ── inbox: enqueue / quota aggregate / FIFO via seq / ack RETURNING / dropExpired ──
  const msg = { v: 1, sealed: { v: 1, ePk: "e", n: "n", ct: "ct" }, recipientDid: "did:key:zB" }
  await pool.query(
    `insert into inbox (handle, queue_id, message, enqueued_at, expires_at, size_bytes)
     values ($1,$2,$3,$4,$5,$6)`,
    ["h", "q1", JSON.stringify(msg), 0, 1000, 100],
  )
  const agg = await pool.query(
    `select count(*)::int as n, coalesce(sum(size_bytes),0)::int as bytes from inbox where handle=$1 and expires_at>$2`,
    ["h", 0],
  )
  console.log("inbox quota agg:", agg.rows[0], "(expect n=1 bytes=100)")
  const listed = await pool.query(`select queue_id, message from inbox where handle=$1 and expires_at>$2 order by seq asc`, ["h", 0])
  console.log("inbox jsonb round-trip:", JSON.stringify(listed.rows[0].message), "typeof:", typeof listed.rows[0].message)
  const acked = await pool.query(`delete from inbox where handle=$1 and queue_id=$2 returning queue_id`, ["h", "q1"])
  console.log("ack RETURNING rowCount:", acked.rowCount, "rows:", JSON.stringify(acked.rows))
  const ackMiss = await pool.query(`delete from inbox where handle=$1 and queue_id=$2 returning queue_id`, ["h", "nope"])
  console.log("ack miss rowCount:", ackMiss.rowCount, "(expect 0)")
  // dropExpired across handles
  await pool.query(`insert into inbox (handle, queue_id, message, enqueued_at, expires_at, size_bytes) values ('h1','qa',$1,0,500,10),('h2','qb',$1,0,2000,10)`, [JSON.stringify(msg)])
  const dropped = await pool.query(`delete from inbox where expires_at<=$1 returning queue_id`, [600])
  console.log("dropExpired rowCount:", dropped.rowCount, "(expect 1)")

  // ── registrations: ON CONFLICT DO UPDATE + getByDid recency ──
  await pool.query(
    `insert into registrations (handle, did, agent_card, key_agreement_pubkey, registered_at)
     values ($1,$2,$3,$4,$5)
     on conflict (handle) do update set did=excluded.did, agent_card=excluded.agent_card, key_agreement_pubkey=excluded.key_agreement_pubkey, registered_at=excluded.registered_at`,
    ["h1", "did:shared", JSON.stringify({ name: "a" }), null, 0],
  )
  await pool.query(
    `insert into registrations (handle, did, agent_card, key_agreement_pubkey, registered_at)
     values ($1,$2,$3,$4,$5)
     on conflict (handle) do update set did=excluded.did, agent_card=excluded.agent_card, key_agreement_pubkey=excluded.key_agreement_pubkey, registered_at=excluded.registered_at`,
    ["h2", "did:shared", JSON.stringify({ name: "b" }), null, 1],
  )
  const byDid = await pool.query(`select handle from registrations where did=$1 order by registered_at desc, handle desc limit 1`, ["did:shared"])
  console.log("getByDid recency (shared DID, h2 newer):", byDid.rows[0], "(expect h2)")
  const removed = await pool.query(`delete from registrations where handle=$1 returning handle`, ["h1"])
  console.log("remove RETURNING rowCount:", removed.rowCount)
  const byDidAfter = await pool.query(`select handle from registrations where did=$1 order by registered_at desc, handle desc limit 1`, ["did:shared"])
  console.log("getByDid after removing h1:", byDidAfter.rows[0], "(expect h2 — not clobbered)")

  // ── invites: decrement-or-delete (SPACED arithmetic) ──
  await pool.query(`insert into invites (token, remaining) values ($1,$2)`, ["inv", 2])
  const dec1 = await pool.query(`update invites set remaining = remaining - 1 where token=$1 and remaining >= 1 returning remaining`, ["inv"])
  console.log("invite decrement (spaced):", dec1.rows[0], "(expect remaining=1)")
  // try UNSPACED to confirm the gotcha
  try {
    await pool.query(`update invites set remaining = remaining-1 where token=$1 returning remaining`, ["inv"])
    console.log("UNSPACED remaining-1: UNEXPECTEDLY accepted")
  } catch (e) {
    console.log("UNSPACED remaining-1 rejected (gotcha confirmed):", String(e.message).slice(0, 60))
  }

  // ── credentials: rotate via ON CONFLICT, reverse lookups, old tokens stop resolving ──
  await pool.query(
    `insert into credentials (handle, inbox_auth, send_credential) values ($1,$2,$3)
     on conflict (handle) do update set inbox_auth=excluded.inbox_auth, send_credential=excluded.send_credential`,
    ["h", "ia1", "sc1"],
  )
  await pool.query(
    `insert into credentials (handle, inbox_auth, send_credential) values ($1,$2,$3)
     on conflict (handle) do update set inbox_auth=excluded.inbox_auth, send_credential=excluded.send_credential`,
    ["h", "ia2", "sc2"],
  )
  const oldResolve = await pool.query(`select handle from credentials where inbox_auth=$1`, ["ia1"])
  const newResolve = await pool.query(`select handle from credentials where inbox_auth=$1`, ["ia2"])
  console.log("rotation: old ia1 rows:", oldResolve.rowCount, "(expect 0); new ia2 rows:", newResolve.rowCount, "(expect 1)")

  // ── simulated restart: fresh pool over the SAME db retains rows ──
  const pool2 = new Pool()
  const survived = await pool2.query(`select handle from credentials where send_credential=$1`, ["sc2"])
  console.log("restart (fresh pool, same db) credentials survived:", survived.rows[0], "(expect h)")

  console.log("\nALL SQL SHAPES VALIDATED under pg-mem 3.0.14 + pg 8.22.0")
}

main().catch((e) => {
  console.error("VALIDATION FAILED:", e)
  process.exit(1)
})
