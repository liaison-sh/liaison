// SPDX-License-Identifier: FSL-1.1-ALv2
// The turn ledger (P3 T8, S10 / A8): a turn's row and journal, fenced on the
// runner that owns it, claimable for resume by exactly one process, unique per
// durable origin, and out of reach of the request role.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, sql } from "~/db"
import { withRlsContext } from "~/db/rls"
import {
  appendStep,
  claimForResume,
  expireStaleTurns,
  findByOriginRef,
  finishTurn,
  handoff,
  loadTurn,
  openTurn,
  pruneTerminalTurns,
  touch,
} from "~/modules/agent/runtime/turn-ledger"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const USER = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const OTHER_THREAD = crypto.randomUUID()
const RUNNER_A = `runner-a-${crypto.randomUUID()}`
const RUNNER_B = `runner-b-${crypto.randomUUID()}`
const tag = ORG.slice(0, 8)

async function seedOrg(orgId: string, threadId: string, label: string) {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${orgId}, ${`Turn ledger ${label}`}, ${`turn-ledger-${label}-${tag}`})`
  const userId = label === "a" ? USER : crypto.randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, name)
    VALUES (${userId}, ${orgId}, ${`turns-${label}-${tag}@test.example`}, 'Turns')`
  await sql`INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
    VALUES (${threadId}, ${orgId}, ${`turns-${label}-${tag}`}, 'Turns', ${userId})`
}

async function eventCount(turnId: string): Promise<number> {
  const rows =
    await sql`SELECT count(*)::int AS n FROM kernel.agent_turn_events WHERE turn_id = ${turnId}`
  return Number(rows[0]?.n ?? 0)
}

beforeAll(async () => {
  await acquireTestLock()
  await seedOrg(ORG, THREAD, "a")
  await seedOrg(OTHER_ORG, OTHER_THREAD, "b")
})

afterAll(async () => {
  await sql`DELETE FROM kernel.users WHERE org_id IN (${ORG}, ${OTHER_ORG})`
  await sql`DELETE FROM kernel.organizations WHERE id IN (${ORG}, ${OTHER_ORG})`
  await releaseTestLock()
})

describe("turn ledger", () => {
  it("open → journal 2 steps → finish", async () => {
    const { turn, created } = await openTurn({
      orgId: ORG,
      threadId: THREAD,
      origin: "chat",
      runner: RUNNER_A,
      resumeInput: { modelId: "m-1", maxSteps: 8 },
    })
    expect(created).toBe(true)
    expect(turn.state).toBe("running")
    expect(turn.attempt).toBe(0)

    expect(await appendStep(ORG, turn.id, RUNNER_A, { messages: [{ role: "assistant" }] })).toBe(
      "ok",
    )
    expect(await appendStep(ORG, turn.id, RUNNER_A, { messages: [{ role: "tool" }] })).toBe("ok")
    expect(await touch(ORG, turn.id, RUNNER_A)).toBe("ok")

    const loaded = await loadTurn(ORG, turn.id)
    expect(loaded?.turn.stepCount).toBe(2)
    expect(loaded?.turn.resumeInput).toEqual({ modelId: "m-1", maxSteps: 8 })
    expect(loaded?.steps.map((s) => s.seq)).toEqual([1, 2])
    expect(loaded?.steps[1]?.payload).toEqual({ messages: [{ role: "tool" }] })

    const messageId = crypto.randomUUID()
    expect(
      await finishTurn({
        orgId: ORG,
        turnId: turn.id,
        runner: RUNNER_A,
        state: "done",
        failureReason: null,
        agentMessageId: messageId,
      }),
    ).toBe("ok")
    const done = await loadTurn(ORG, turn.id)
    expect(done?.turn.state).toBe("done")
    expect(done?.turn.agentMessageId).toBe(messageId)
    expect(done?.turn.finishedAt).not.toBeNull()
    // finishTurn clears the events: the reply is in kernel.messages now.
    expect(done?.steps).toEqual([])
    // A finished turn takes no more writes.
    expect(await appendStep(ORG, turn.id, RUNNER_A, { messages: [] })).toBe("fenced")
  })

  it("a fenced runner's journal and finish affect 0 rows", async () => {
    const { turn } = await openTurn({
      orgId: ORG,
      threadId: THREAD,
      origin: "thread",
      runner: RUNNER_A,
    })
    expect(await appendStep(ORG, turn.id, RUNNER_B, { messages: ["intruder"] })).toBe("fenced")
    expect(await touch(ORG, turn.id, RUNNER_B)).toBe("fenced")
    expect(await handoff(ORG, turn.id, RUNNER_B)).toBe("fenced")
    expect(
      await finishTurn({
        orgId: ORG,
        turnId: turn.id,
        runner: RUNNER_B,
        state: "done",
        failureReason: null,
      }),
    ).toBe("fenced")
    // The wrong org is fenced too, even for the right runner.
    expect(await appendStep(OTHER_ORG, turn.id, RUNNER_A, { messages: [] })).toBe("fenced")

    const after = await loadTurn(ORG, turn.id)
    expect(after?.turn.state).toBe("running")
    expect(after?.turn.stepCount).toBe(0)
    expect(after?.steps).toEqual([])
  })

  it("claimForResume is won by exactly one of two concurrent claimers", async () => {
    const { turn } = await openTurn({
      orgId: ORG,
      threadId: THREAD,
      origin: "chat",
      runner: RUNNER_A,
    })
    await appendStep(ORG, turn.id, RUNNER_A, { messages: ["step 1"] })
    // A running turn with a fresh heartbeat is not claimable.
    expect(
      await claimForResume({ orgId: ORG, turnId: turn.id, expectedAttempt: 0, runner: RUNNER_B }),
    ).toBeNull()

    expect(await handoff(ORG, turn.id, RUNNER_A)).toBe("ok")
    const claims = await Promise.all([
      claimForResume({ orgId: ORG, turnId: turn.id, expectedAttempt: 0, runner: RUNNER_B }),
      claimForResume({ orgId: ORG, turnId: turn.id, expectedAttempt: 0, runner: `c-${RUNNER_B}` }),
    ])
    const won = claims.filter((c) => c !== null)
    expect(won.length).toBe(1)
    expect(won[0]?.attempt).toBe(1)
    expect(won[0]?.state).toBe("running")
    const winner = won[0]?.runnerInstanceId ?? ""

    // The old runner is fenced; the winner journals on, numbering continues.
    expect(await appendStep(ORG, turn.id, RUNNER_A, { messages: ["late"] })).toBe("fenced")
    expect(await appendStep(ORG, turn.id, winner, { messages: ["step 2"] })).toBe("ok")
    expect((await loadTurn(ORG, turn.id))?.steps.map((s) => s.seq)).toEqual([1, 2])

    // A running turn whose heartbeat stopped is claimable (the SIGKILL path).
    await sql`UPDATE kernel.agent_turns SET heartbeat_at = now() - interval '5 minutes' WHERE id = ${turn.id}`
    const stale = await claimForResume({
      orgId: ORG,
      turnId: turn.id,
      expectedAttempt: 1,
      runner: RUNNER_A,
    })
    expect(stale?.attempt).toBe(2)
    expect(stale?.runnerInstanceId).toBe(RUNNER_A)
  })

  it("origin_ref is unique per org", async () => {
    const ref = `job:agent:42:${Date.now()}`
    const first = await openTurn({
      orgId: ORG,
      threadId: THREAD,
      origin: "job",
      originRef: ref,
      runner: RUNNER_A,
    })
    const again = await openTurn({
      orgId: ORG,
      threadId: THREAD,
      origin: "job",
      originRef: ref,
      runner: RUNNER_B,
    })
    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.turn.id).toBe(first.turn.id)
    expect(again.turn.runnerInstanceId).toBe(RUNNER_A)
    expect((await findByOriginRef(ORG, ref))?.id).toBe(first.turn.id)
    // The index itself refuses a second row in the org.
    await expect(
      sql`INSERT INTO kernel.agent_turns (org_id, thread_id, origin, origin_ref, runner_instance_id)
        VALUES (${ORG}, ${THREAD}, 'job', ${ref}, 'x')`,
    ).rejects.toThrow(/agent_turns_org_origin_ref_idx/)
    // Another org may use the same ref; turns without a ref never collide.
    const other = await openTurn({
      orgId: OTHER_ORG,
      threadId: OTHER_THREAD,
      origin: "job",
      originRef: ref,
      runner: RUNNER_A,
    })
    expect(other.created).toBe(true)
    const a = await openTurn({ orgId: ORG, threadId: THREAD, origin: "chat", runner: RUNNER_A })
    const b = await openTurn({ orgId: ORG, threadId: THREAD, origin: "chat", runner: RUNNER_A })
    expect(a.turn.id).not.toBe(b.turn.id)
  })

  it("RLS: a request-role transaction reads 0 rows", async () => {
    const { turn } = await openTurn({
      orgId: ORG,
      threadId: THREAD,
      origin: "chat",
      runner: RUNNER_A,
    })
    await appendStep(ORG, turn.id, RUNNER_A, { messages: ["secret tool output"] })
    const ctx = {
      actorType: "user" as const,
      userId: USER,
      orgId: ORG,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    for (const table of ["agent_turns", "agent_turn_events"]) {
      const seen = await withRlsContext(ctx, async (tx) => {
        try {
          const rows = await tx.execute(
            drizzleSql.raw(`SELECT count(*)::int AS n FROM kernel.${table}`),
          )
          return Number(extractRows<{ n: number }>(rows)[0]?.n ?? 0)
        } catch (err) {
          // No privilege at all: the request role cannot even name the table.
          expect(String(err)).toMatch(/permission denied/)
          return 0
        }
      }).catch((err) => {
        expect(String(err)).toMatch(/permission denied/)
        return 0
      })
      expect(seen).toBe(0)
    }
  })

  it("deleting the org cascades", async () => {
    const org = crypto.randomUUID()
    const thread = crypto.randomUUID()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${org}, 'Cascade', ${`turn-cascade-${org.slice(0, 8)}`})`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, title, created_by)
      VALUES (${thread}, ${org}, ${`cascade-${org.slice(0, 8)}`}, 'c', ${crypto.randomUUID()})`
    const { turn } = await openTurn({
      orgId: org,
      threadId: thread,
      origin: "chat",
      runner: RUNNER_A,
    })
    await appendStep(org, turn.id, RUNNER_A, { messages: [] })
    await sql`DELETE FROM kernel.organizations WHERE id = ${org}`
    const left = await sql`SELECT count(*)::int AS n FROM kernel.agent_turns WHERE id = ${turn.id}`
    expect(Number(left[0]?.n)).toBe(0)
    expect(await eventCount(turn.id)).toBe(0)
  })

  it("retention deletes terminal rows past 30 days only", async () => {
    const open = async () =>
      (await openTurn({ orgId: ORG, threadId: THREAD, origin: "routine", runner: RUNNER_A })).turn
    const oldDone = await open()
    const recentDone = await open()
    const oldRunning = await open()
    const oldHandoff = await open()
    const oldFailed = await open()
    await finishTurn({
      orgId: ORG,
      turnId: oldDone.id,
      runner: RUNNER_A,
      state: "done",
      failureReason: null,
    })
    await finishTurn({
      orgId: ORG,
      turnId: recentDone.id,
      runner: RUNNER_A,
      state: "done",
      failureReason: null,
    })
    await finishTurn({
      orgId: ORG,
      turnId: oldFailed.id,
      runner: RUNNER_A,
      state: "failed",
      failureReason: "turn",
      errorCode: "x",
    })
    await handoff(ORG, oldHandoff.id, RUNNER_A)
    // A terminal turn that somehow kept events loses them even when recent.
    await sql`INSERT INTO kernel.agent_turn_events (turn_id, org_id, seq, kind, payload)
      VALUES (${recentDone.id}, ${ORG}, 1, 'step', '{}'::jsonb)`
    await sql`UPDATE kernel.agent_turns
      SET finished_at = now() - interval '31 days', updated_at = now() - interval '31 days',
          created_at = now() - interval '31 days', heartbeat_at = now() - interval '31 days'
      WHERE id IN (${oldDone.id}, ${oldRunning.id}, ${oldHandoff.id}, ${oldFailed.id})`

    await pruneTerminalTurns()
    const ids = [oldDone.id, recentDone.id, oldRunning.id, oldHandoff.id, oldFailed.id]
    const rows = await sql`SELECT id FROM kernel.agent_turns WHERE id IN ${sql(ids)}`
    const left = new Set(rows.map((r) => String(r.id)))
    expect(left.has(oldDone.id)).toBe(false)
    expect(left.has(oldFailed.id)).toBe(false)
    expect(left.has(recentDone.id)).toBe(true)
    expect(left.has(oldRunning.id)).toBe(true)
    expect(left.has(oldHandoff.id)).toBe(true)
    expect(await eventCount(recentDone.id)).toBe(0)
  })
  it("M4: a finished turn's write keys go with it, and retention prunes tool keys past the maximum age only", async () => {
    const effectKeys = async (keys: string[]) =>
      (
        await sql<{ key: string }[]>`
        SELECT key FROM kernel.effect_ledger WHERE org_id = ${ORG} AND key IN ${sql(keys)}`
      ).map((r) => r.key)
    const { turn: t } = await openTurn({
      orgId: ORG,
      threadId: THREAD,
      origin: "routine",
      runner: RUNNER_A,
    })
    const mine = `tool:${t.id}:write:h:1`
    const oldTool = `tool:${crypto.randomUUID()}:write:h:1`
    const recentTool = `tool:${crypto.randomUUID()}:write:h:1`
    const oldOther = `job:${crypto.randomUUID()}`
    for (const key of [mine, oldTool, recentTool, oldOther]) {
      await sql`INSERT INTO kernel.effect_ledger (org_id, key, state, claimed_by)
        VALUES (${ORG}, ${key}, 'done', ${RUNNER_A})`
    }
    await finishTurn({
      orgId: ORG,
      turnId: t.id,
      runner: RUNNER_A,
      state: "done",
      failureReason: null,
    })
    expect(await effectKeys([mine])).toEqual([])
    await sql`UPDATE kernel.effect_ledger SET created_at = now() - interval '2 days'
      WHERE org_id = ${ORG} AND key IN (${oldTool}, ${oldOther})`
    await pruneTerminalTurns()
    expect((await effectKeys([oldTool, recentTool, oldOther])).sort()).toEqual(
      [recentTool, oldOther].sort(),
    )
  })

  it("a turn that did not end done records why: its own failure, its caller leaving, or its process", async () => {
    const open = async () =>
      (await openTurn({ orgId: ORG, threadId: THREAD, origin: "chat", runner: RUNNER_A })).turn
    const modelError = await open()
    const clientLeft = await open()
    const orphaned = await open()
    const done = await open()
    await finishTurn({
      orgId: ORG,
      turnId: modelError.id,
      runner: RUNNER_A,
      state: "failed",
      failureReason: "turn",
      errorCode: "model_error",
    })
    await finishTurn({
      orgId: ORG,
      turnId: clientLeft.id,
      runner: RUNNER_A,
      state: "interrupted",
      failureReason: "client",
    })
    await finishTurn({
      orgId: ORG,
      turnId: done.id,
      runner: RUNNER_A,
      state: "done",
      failureReason: null,
    })
    // Its process died and nothing resumed it before the maximum age.
    await sql`UPDATE kernel.agent_turns SET created_at = now() - interval '2 hours'
      WHERE id = ${orphaned.id}`
    expect(await expireStaleTurns()).toContain(orphaned.id)
    const rows = await sql<{ id: string; state: string; failure_reason: string | null }[]>`
      SELECT id, state, failure_reason FROM kernel.agent_turns
       WHERE id IN (${modelError.id}, ${clientLeft.id}, ${orphaned.id}, ${done.id})`
    const byId = new Map(rows.map((r) => [r.id, [r.state, r.failure_reason]]))
    expect(byId.get(modelError.id)).toEqual(["failed", "turn"])
    expect(byId.get(clientLeft.id)).toEqual(["interrupted", "client"])
    expect(byId.get(orphaned.id)).toEqual(["interrupted", "process"])
    expect(byId.get(done.id)).toEqual(["done", null])
  })
})
