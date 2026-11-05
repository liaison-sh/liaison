// SPDX-License-Identifier: FSL-1.1-ALv2
//
// READING THE CONVERSATION YOU ARE ANSWERING TAINTS NOTHING NEW (live demo walk, 2026-10-24).
//
// In a fresh 1:1 chat with its agent, the visitor asked for research with sources. The agent
// first read its own conversation (kernel__threads_read on the thread it was answering): that
// recorded the blanket `kernel:threads:read`, the turn counted as tainted, and its web search,
// an egress that counts as a write, parked as an approval ("Drafted after reading threads
// data ..."). The conversation's messages are the turn's own history: they bring in nothing its
// context does not hold, and their requiredScopes stamps taint the turn as history does. Then,
// to remove a duplicate search request, the agent withdrew it with a reason, and the withdraw
// itself parked: a third approval for an undo that sends nothing out.
//
// Through the real chat seam (buildToolSet's execute closure, then executeToolCore):
//   1. reading the answering conversation records only its messages' stamps;
//   2. an egress after it runs, while the same egress after reading ANOTHER thread still parks;
//   3. a withdraw with a reason on a tainted turn runs, and its reason is posted stamped.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import {
  agentInstructionsRegistry,
  initializedOrgRuntimes,
  skillRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000d8a01"
const USER = "00000000-0000-4000-8000-0000000d8a02"
const DM = "00000000-0000-4000-8000-0000000d8a03"
const CHANNEL = "00000000-0000-4000-8000-0000000d8a04"
const STAMPED_DM = "00000000-0000-4000-8000-0000000d8a05"

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

const ran: string[] = []

function turnFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

async function call(
  frame: RunContext,
  threadId: string,
  sdkName: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tools = buildToolSet(ORG, actor, threadId, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

describe("reading the answering conversation, and withdrawing on a tainted turn", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Answering Thread Taint Org', 'answering-thread-taint') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${USER}, ${ORG}, 'answering-thread@test.com', 'Visitor', 'active', 'x')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, '*') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${DM}, ${ORG}, 'answering-dm', 'agent_chat', ${USER}),
             (${STAMPED_DM}, ${ORG}, 'answering-dm-stamped', 'agent_chat', ${USER}),
             (${CHANNEL}, ${ORG}, 'answering-channel', 'thread', ${USER})
      ON CONFLICT DO NOTHING`
    for (const t of [DM, STAMPED_DM, CHANNEL]) {
      await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
        VALUES (${t}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
        VALUES (${USER}, ${t}, ${ORG}) ON CONFLICT DO NOTHING`
    }
    await sql`INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, content, required_scopes)
      VALUES (${ORG}, ${DM}, ${USER}, 'user', 'Which EU battery passport rules apply from 2027?', '{}'),
             (${ORG}, ${STAMPED_DM}, ${USER}, 'user', 'What did the ticket say?', '{tickets:tickets:read}'),
             (${ORG}, ${CHANNEL}, ${USER}, 'user', 'Battery passport: we need a plan', '{}')`

    await ensureAppsForOrg(ORG)
    // An egress with web_search's marks: not readOnly, no declared table (it counts as a write).
    toolRegistry.set([ORG, "kernel", "test_egress"], {
      appName: "kernel",
      name: "test_egress",
      description: "an outward search",
      requiredScopes: ["kernel:threads:read"],
      params: z.object({ query: z.string() }),
      handler: async () => {
        ran.push("egress")
        return { results: [] }
      },
    } as never)
    // A gated proposal the agent raises and later withdraws.
    toolRegistry.set([ORG, "aud", "propose"], {
      appName: "aud",
      name: "propose",
      description: "gated proposal",
      requiredScopes: ["aud:items:write"],
      gated: true,
      params: z.object({ note: z.string() }),
      handler: async () => ({ ok: true }),
    } as never)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_thread_state WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`.catch(() => undefined)
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`.catch(() => undefined)
    await releaseTestLock()
  })

  it("reading the conversation the turn answers records no blanket thread-read scope", async () => {
    const frame = turnFrame()
    const read = await call(frame, DM, "kernel__threads_read", { threadId: DM })
    expect(JSON.stringify(read)).toContain("battery passport")
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual([])
  })

  it("its messages' own stamps still taint the turn, as history does", async () => {
    const frame = turnFrame()
    await call(frame, STAMPED_DM, "kernel__threads_read", { threadId: STAMPED_DM })
    expect(frame.turnScopeAccumulator?.snapshot()).toEqual(["tickets:tickets:read"])
  })

  it("an egress after reading the answering conversation runs; after reading another thread it parks", async () => {
    ran.length = 0
    const own = turnFrame()
    await call(own, DM, "kernel__threads_read", { threadId: DM })
    const ranOwn = await call(own, DM, "kernel__test_egress", { query: "EU battery passport" })
    expect(ranOwn.blocked).toBeUndefined()
    expect(ran).toEqual(["egress"])

    // The gate itself is unchanged: another conversation's messages are new to the turn.
    const other = turnFrame()
    await call(other, DM, "kernel__threads_read", { threadId: CHANNEL })
    expect(other.turnScopeAccumulator?.snapshot()).toEqual(["kernel:threads:read"])
    const parked = await call(other, DM, "kernel__test_egress", { query: "EU battery passport" })
    expect(parked.blocked).toBe(true)
    expect(ran).toEqual(["egress"])
  })

  it("withdrawing its own duplicate request with a reason runs on a tainted turn", async () => {
    const raise = turnFrame()
    const proposed = await call(raise, DM, "aud__propose", { note: "search once" })
    const requestId = String(proposed.approvalRequestId ?? "")
    expect(requestId).not.toBe("")

    const frame = turnFrame()
    await call(frame, DM, "kernel__threads_read", { threadId: CHANNEL })
    const reason = "Duplicate of the search already waiting for approval"
    const res = await call(frame, DM, "kernel__approval_withdraw", { requestId, reason })
    expect(res.blocked).toBeUndefined()
    expect(JSON.stringify(res)).toContain("withdrawn")
    const [row] = await sql<{ status: string; reason: string | null }[]>`
      SELECT status, reason FROM kernel.approval_requests WHERE id = ${requestId}`
    expect(row).toEqual({ status: "withdrawn", reason: null })
    const notes = await sql<{ required_scopes: string[] }[]>`
      SELECT required_scopes FROM kernel.messages
      WHERE org_id = ${ORG} AND content LIKE ${`%${reason}%`}`
    expect(notes.length).toBeGreaterThan(0)
    for (const note of notes) expect(note.required_scopes).toContain("kernel:threads:read")
    const pending = await sql`SELECT id FROM kernel.approval_requests
      WHERE org_id = ${ORG} AND tool_name = 'kernel:approval_withdraw'`
    expect(pending).toHaveLength(0)
  })
})
