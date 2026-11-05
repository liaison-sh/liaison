// SPDX-License-Identifier: FSL-1.1-ALv2
// The effect ledger core (P3 T8b, S11 / A13): an outside effect keyed in
// Postgres runs once, a repeat gets the stored result, a claim whose runner
// died is unknown (never silently run again), and a thrown effect frees its key.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql } from "~/db"
import { INSTANCE_ID } from "~/infra/instance-id"
import {
  claimEffect,
  completeEffect,
  EffectInFlight,
  effectLedgerStats,
  effectOnce,
  pruneEffectLedger,
  releaseEffect,
} from "~/lib/effect-once"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const key = (label: string) => `test:${label}:${crypto.randomUUID()}`

async function rowOf(k: string) {
  const rows = await sql`SELECT state, result, claimed_by FROM kernel.effect_ledger
    WHERE org_id = ${ORG} AND key = ${k}`
  return rows[0] ?? null
}

/** A pending claim as a process left it, `ageS` seconds ago. */
async function seedPending(k: string, claimedBy: string, ageS: number) {
  await sql`INSERT INTO kernel.effect_ledger (org_id, key, state, claimed_by, claimed_at)
    VALUES (${ORG}, ${k}, 'pending', ${claimedBy}, now() - make_interval(secs => ${ageS}))`
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Effect ledger', ${`effect-ledger-${ORG.slice(0, 8)}`})`
})

afterAll(async () => {
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("effectOnce", () => {
  it("two concurrent calls run fn once", async () => {
    const k = key("concurrent")
    let runs = 0
    const fn = async () => {
      runs++
      await Bun.sleep(150)
      return { sent: true }
    }
    const settled = await Promise.allSettled([effectOnce(ORG, k, fn), effectOnce(ORG, k, fn)])
    expect(runs).toBe(1)
    const ran = settled.filter((s) => s.status === "fulfilled")
    const busy = settled.filter((s) => s.status === "rejected")
    expect(ran.length).toBe(1)
    expect(ran[0]?.status === "fulfilled" && ran[0].value).toEqual({
      status: "ran",
      result: { sent: true },
    })
    // The loser saw a live claimer: in flight, to be retried by its job's backoff.
    expect(busy[0]?.status === "rejected" && busy[0].reason).toBeInstanceOf(EffectInFlight)
    expect(await rowOf(k)).toMatchObject({ state: "done", result: { sent: true } })
  })

  it("a done key returns the stored result", async () => {
    const k = key("done")
    let runs = 0
    const fn = async () => {
      runs++
      return { messageId: "m-1" }
    }
    expect(await effectOnce(ORG, k, fn)).toEqual({ status: "ran", result: { messageId: "m-1" } })
    const before = effectLedgerStats().duplicate
    expect(await effectOnce(ORG, k, fn)).toEqual({
      status: "replayed",
      result: { messageId: "m-1" },
    })
    expect(runs).toBe(1)
    // The prod counter of A13: a duplicate attempt is logged and counted.
    expect(effectLedgerStats().duplicate).toBe(before + 1)
  })

  it("a stale pending key is skipped and counted as unknown", async () => {
    const k = key("stale")
    // Our own instance, so liveness says yes: only the TTL makes it unknown.
    await seedPending(k, INSTANCE_ID, 700)
    const before = effectLedgerStats().unknown
    let runs = 0
    const outcome = await effectOnce(ORG, k, async () => {
      runs++
      return 1
    })
    expect(outcome).toEqual({ status: "unknown" })
    expect(runs).toBe(0)
    expect(effectLedgerStats().unknown).toBe(before + 1)
    expect((await rowOf(k))?.state).toBe("unknown")
    // At most once: a second attempt is unknown again, never run.
    expect(await effectOnce(ORG, k, async () => runs++)).toEqual({ status: "unknown" })
    expect(runs).toBe(0)
  })

  it("a pending claim of a dead instance is unknown immediately", async () => {
    const k = key("dead")
    // Seconds old, far inside the TTL, but its claimer has no instance record.
    await seedPending(k, `dead-${crypto.randomUUID()}`, 2)
    let runs = 0
    expect(await effectOnce(ORG, k, async () => runs++)).toEqual({ status: "unknown" })
    expect(runs).toBe(0)
    expect((await rowOf(k))?.state).toBe("unknown")
  })

  it("a fresh pending claim of a live instance is in flight", async () => {
    const k = key("live")
    await seedPending(k, INSTANCE_ID, 2)
    await expect(effectOnce(ORG, k, async () => 1)).rejects.toBeInstanceOf(EffectInFlight)
    expect((await rowOf(k))?.state).toBe("pending")
  })

  it('onUnknown "query" decides', async () => {
    // The remote side says it happened: done with its result, fn not run.
    const sentKey = key("query-sent")
    await seedPending(sentKey, `dead-${crypto.randomUUID()}`, 2)
    let runs = 0
    const sent = await effectOnce(ORG, sentKey, async () => ({ id: `run-${++runs}` }), {
      onUnknown: async (info) => {
        expect(info.key).toBe(sentKey)
        return { outcome: "done", result: { id: "remote-7" } }
      },
    })
    expect(sent).toEqual({ status: "replayed", result: { id: "remote-7" } })
    expect(runs).toBe(0)
    expect(await rowOf(sentKey)).toMatchObject({ state: "done", result: { id: "remote-7" } })

    // The remote side says it did not: fn runs now, once.
    const notSentKey = key("query-not-sent")
    await seedPending(notSentKey, `dead-${crypto.randomUUID()}`, 2)
    const retried = await effectOnce(ORG, notSentKey, async () => ({ id: `run-${++runs}` }), {
      onUnknown: async () => ({ outcome: "retry" }),
    })
    expect(retried).toEqual({ status: "ran", result: { id: "run-1" } })
    expect(await rowOf(notSentKey)).toMatchObject({ state: "done", claimed_by: INSTANCE_ID })
  })

  it("a thrown fn releases the claim", async () => {
    const k = key("throws")
    await expect(
      effectOnce(ORG, k, async () => {
        throw new Error("smtp 451")
      }),
    ).rejects.toThrow("smtp 451")
    expect(await rowOf(k)).toBeNull()
    expect(await effectOnce(ORG, k, async () => "second try")).toEqual({
      status: "ran",
      result: "second try",
    })
  })

  it("claim / complete / release step by step (the bridge path)", async () => {
    const k = key("steps")
    expect(await claimEffect(ORG, k)).toEqual({ state: "claimed" })
    expect((await claimEffect(ORG, k)).state).toBe("in_flight")
    // Only the claimer completes it.
    expect(await completeEffect(ORG, k, { ok: 1 }, "someone-else")).toBe("lost")
    expect(await completeEffect(ORG, k, { ok: 1 })).toBe("ok")
    expect(await claimEffect(ORG, k)).toEqual({ state: "done", result: { ok: 1 } })

    const r = key("release")
    expect(await claimEffect(ORG, r)).toEqual({ state: "claimed" })
    await releaseEffect(ORG, r)
    expect(await claimEffect(ORG, r)).toEqual({ state: "claimed" })
  })
})

describe("effect-ledger-retention", () => {
  it("prunes done rows past 30 days, keeps unknown rows a year, and turns abandoned pending claims unknown", async () => {
    const oldDone = key("old-done")
    const freshDone = key("fresh-done")
    const monthUnknown = key("month-unknown")
    const yearUnknown = key("year-unknown")
    const oldPending = key("old-pending")
    const freshPending = key("fresh-pending")
    await sql`INSERT INTO kernel.effect_ledger (org_id, key, state, claimed_by, claimed_at, done_at)
      VALUES
        (${ORG}, ${oldDone}, 'done', 'x', now() - interval '40 days', now() - interval '31 days'),
        (${ORG}, ${freshDone}, 'done', 'x', now() - interval '2 days', now() - interval '1 day'),
        (${ORG}, ${monthUnknown}, 'unknown', 'x', now() - interval '31 days', NULL),
        (${ORG}, ${yearUnknown}, 'unknown', 'x', now() - interval '366 days', NULL),
        (${ORG}, ${oldPending}, 'pending', 'x', now() - interval '31 days', NULL),
        (${ORG}, ${freshPending}, 'pending', 'x', now() - interval '1 day', NULL)`
    const { deleted, abandoned } = await pruneEffectLedger()
    expect(deleted).toBeGreaterThanOrEqual(2)
    expect(abandoned).toBeGreaterThanOrEqual(1)
    expect(await rowOf(oldDone)).toBeNull()
    expect(await rowOf(yearUnknown)).toBeNull()
    expect((await rowOf(freshDone))?.state).toBe("done")
    // A month-old unknown still stops a blind retry.
    expect((await rowOf(monthUnknown))?.state).toBe("unknown")
    // An abandoned claim is never freed for a fresh claim: it becomes unknown.
    expect((await rowOf(oldPending))?.state).toBe("unknown")
    expect((await rowOf(freshPending))?.state).toBe("pending")
  })
})
