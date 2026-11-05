// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A LOCAL OR NODE REPLY IS STAMPED WITH WHAT THE TURN COULD READ, NOT WITH THE ADMIN'S `*`.
//
// The stamp of a reply produced on someone's machine used to be the turn's whole effective
// scope (room floor intersected with the agent's ceiling). For an admin talking to an agent whose
// ceiling is `*`, that is `*`: the reply required `*`, the next cloud turn of the same DM read it
// back as history, and every write a non-admin could read was refused from then on. The stamp is
// now what Liaison handed the turn: its tool calls (the MCP taint), the agent's definition and
// the conversation (local-context-scopes.ts), projected onto read scopes.
//
//   1. a local turn by an admin that read nothing scoped: no `*`, and a later cloud contacts
//      write in that DM runs (every account reads contacts);
//   2. the conversation it was handed still counts: a scoped message of the thread is in the
//      stamp;
//   3. a genuinely tainted local turn (a mail read through its MCP connection) stamps that read,
//      and the later cloud contacts write is refused while an account lacks mail read;
//   4. a recall block handed on a cold resume (recorded by the turn-context route) counts;
//   5. a local turn longer than the 15 minute window keeps what it read (the day-long ledger);
//   6. a node job of the same admin, bound to its connection, with no read: no `*` either.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { eq } from "drizzle-orm"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { nodeJobs, nodes } from "~/db/schema/kernel"
import { redis } from "~/lib/redis"
import { recordLocalRecallScopes } from "~/modules/agent/local-sessions/local-context-scopes"
import { localReplyScope } from "~/modules/agent/local-sessions/local-session-routes"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  mcpTurnTaintKey,
  mcpTurnTaintLedgerKey,
  mcpTurnTaintMarksKey,
  mcpTurnTaintTouchedKey,
  openConnectionTurnTaint,
  recordConnectionTaintLedger,
  recordConnectionTaintMarks,
  saveConnectionTurnTaint,
} from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
} from "~/modules/mcp/test-helpers"
import { nodeJobReplyScope } from "~/modules/nodes/job-taint"
import { bindNodeJobConnection } from "~/modules/nodes/jobs"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MAIL_READ = "mail:conversations:read"
const KPI_READ = "kpi:metrics:read"

let orgId: string
let ownerId: string
let threadId: string
let agentId: string
let memberId: string
const ran: string[] = []

const admin = (): UserContext => ({
  actorType: "user",
  userId: ownerId,
  orgId,
  scopes: ["*"],
  dimensionGrants: {},
})

async function clearWindow() {
  await redis.del(
    mcpTurnTaintKey(orgId, agentId),
    mcpTurnTaintMarksKey(orgId, agentId),
    mcpTurnTaintTouchedKey(orgId, agentId),
  )
}

/** A fresh turn, as the session's turn event opens it (fix8 M2). */
async function openTurn() {
  await clearWindow()
  await openConnectionTurnTaint(orgId, agentId)
}

/** The next CLOUD turn of the DM: the earlier reply comes back as history. */
async function cloudContactsWrite(historyStamp: string[]): Promise<Record<string, unknown>> {
  const runId = crypto.randomUUID()
  const frame: RunContext = {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId }),
  }
  frame.turnScopeAccumulator?.recordInjected(historyStamp)
  const tools = buildToolSet(orgId, admin(), threadId, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools.kernel__contacts_write
  if (!t) throw new Error("kernel__contacts_write is not in the catalog")
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(
      { contactId: crypto.randomUUID(), name: "Felix" },
      {},
    ),
  )) as Record<string, unknown>
}

function refused(r: Record<string, unknown>): boolean {
  if (r.code === "E_SCOPE_TAINT_BLOCKED") return true
  if (typeof r.error === "string") return r.error.includes("E_SCOPE_TAINT_BLOCKED")
  return (r.error as { code?: string } | undefined)?.code === "E_SCOPE_TAINT_BLOCKED"
}

beforeAll(async () => {
  await acquireTestLock()
  const s = await seedOrgWithTicketsApp()
  orgId = s.orgId
  ownerId = s.ownerId
  threadId = s.threadId
  await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
    VALUES (${ownerId}, ${orgId}, '*') ON CONFLICT DO NOTHING`
  memberId = crypto.randomUUID()
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${memberId}, ${orgId}, ${`member-${memberId}@test.com`}, 'hash', 'Member', 'active')`
  for (const scope of ["kernel:contacts:read", "kernel:contacts:write"]) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${memberId}, ${orgId}, ${scope}) ON CONFLICT DO NOTHING`
  }
  ;({ agentId } = await seedAgentForOrg(orgId, { scopeCeiling: ["*"] }))
  const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
  await registerKernelAgentTools(orgId)
  // The write here stands for any cloud write every account reads; its approval gate is not
  // what this file judges. The org's auto-approve policy turns that gate off (as an admin
  // would), so only the scope taint decides; the stub has no contact to preflight.
  await sql`INSERT INTO kernel.auto_approve_policies (org_id, tool_name)
    VALUES (${orgId}, 'kernel:contacts_write') ON CONFLICT DO NOTHING`
  const entry = toolRegistry.get([orgId, "kernel", "contacts_write"])
  toolRegistry.set([orgId, "kernel", "contacts_write"], {
    ...entry,
    preflight: undefined,
    handler: async () => {
      ran.push("contacts_write")
      return { id: "c-1" }
    },
  } as never)
}, 120_000)

afterAll(async () => {
  await clearWindow()
  toolRegistry.deleteByPrefix([orgId])
  await sql`DELETE FROM kernel.node_jobs WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.nodes WHERE org_id = ${orgId}`
  await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${orgId}`
  await cleanupSeededOrg(orgId)
  await releaseTestLock()
})

describe("a local or node reply is stamped with what the turn could read", () => {
  it("an admin's local turn that read nothing scoped is not stamped `*`, and the next cloud write runs", async () => {
    await openTurn()
    const stamp = await localReplyScope(orgId, threadId, ownerId, ["*"], agentId, new Date())
    expect(stamp).not.toContain("*")
    ran.length = 0
    const write = await cloudContactsWrite(stamp)
    expect(refused(write)).toBe(false)
    expect(ran).toEqual(["contacts_write"])
  })

  it("the conversation the turn was handed still counts", async () => {
    await openTurn()
    await sql`INSERT INTO kernel.messages (org_id, thread_id, author_type, author_id, content, required_scopes)
      VALUES (${orgId}, ${threadId}, 'user', ${ownerId}, 'the KPI figures', ${[KPI_READ]})`
    const stamp = await localReplyScope(orgId, threadId, ownerId, ["*"], agentId, new Date())
    expect(stamp).toContain(KPI_READ)
    expect(stamp).not.toContain("*")
  })

  it("a recall block handed on a cold resume of the conversation counts", async () => {
    await openTurn()
    const recalled = "knowledge:documents:read"
    await recordLocalRecallScopes({
      orgId,
      threadId,
      agentId,
      userId: ownerId,
      injectedScopes: [[recalled], []],
    })
    const stamp = await localReplyScope(orgId, threadId, ownerId, ["*"], agentId, new Date())
    expect(stamp).toContain(recalled)
  })

  it("the agent's checkpoint summary of the conversation counts (mutation 7)", async () => {
    await openTurn()
    const summarised = "projects:tasks:read"
    await sql`INSERT INTO kernel.agent_thread_checkpoints
      (org_id, agent_id, thread_id, summary, required_scopes, token_estimate, version)
      VALUES (${orgId}, ${agentId}, ${threadId}, 'the task list so far', ${[summarised]}, 10, 1)`
    const stamp = await localReplyScope(orgId, threadId, ownerId, ["*"], agentId, new Date())
    expect(stamp).toContain(summarised)
    expect(stamp).not.toContain("*")
    await sql`DELETE FROM kernel.agent_thread_checkpoints WHERE thread_id = ${threadId}`
  })

  it("a taint set LOST mid-turn falls back to the conservative bound, never an empty stamp (fix8 M2)", async () => {
    await openTurn()
    await redis.del(mcpTurnTaintLedgerKey(orgId, agentId))
    const turnStartedAt = new Date(Date.now() - 1000)
    // A read in this turn, then the set and its ledger are gone (eviction, a flush).
    await saveConnectionTurnTaint(orgId, agentId, [MAIL_READ])
    await recordConnectionTaintMarks(orgId, agentId, [MAIL_READ])
    await redis.del(mcpTurnTaintKey(orgId, agentId), mcpTurnTaintMarksKey(orgId, agentId))
    const stamp = await localReplyScope(orgId, threadId, ownerId, ["*"], agentId, turnStartedAt)
    // The admin's effective scope in its own DM: everything, which covers the lost read.
    expect(stamp).toContain("*")
  })

  it("a taint set that expired under the turn: the day-long ledger answers exactly (fix8 M2)", async () => {
    await clearWindow()
    await redis.del(mcpTurnTaintLedgerKey(orgId, agentId))
    const turnStartedAt = new Date(Date.now() - 60_000)
    await redis.hset(mcpTurnTaintLedgerKey(orgId, agentId), MAIL_READ, String(Date.now() - 30_000))
    await redis.hset(
      mcpTurnTaintLedgerKey(orgId, agentId),
      KPI_READ,
      String(Date.now() - 20 * 60_000),
    )
    const stamp = await localReplyScope(orgId, threadId, ownerId, ["*"], agentId, turnStartedAt)
    expect(stamp).toContain(MAIL_READ)
    expect(stamp).not.toContain("*")
    await redis.del(mcpTurnTaintLedgerKey(orgId, agentId))
  })

  it("a local turn that read mail is stamped with it, and the next cloud contacts write does not run inline", async () => {
    await clearWindow()
    const turnStartedAt = new Date(Date.now() - 1000)
    await saveConnectionTurnTaint(orgId, agentId, [MAIL_READ])
    await recordConnectionTaintMarks(orgId, agentId, [MAIL_READ])
    const stamp = await localReplyScope(orgId, threadId, ownerId, ["*"], agentId, turnStartedAt)
    expect(stamp).toContain(MAIL_READ)
    expect(stamp).not.toContain("*")
    ran.length = 0
    const write = await cloudContactsWrite(stamp)
    // Rule 8 (scope-taint.ts): refused when nobody may approve it, else parked for approval.
    expect(refused(write) || write.blocked === true).toBe(true)
    expect(ran).toEqual([])
  })

  it("a long local turn keeps what it read after the 15 minute window dropped it", async () => {
    await clearWindow()
    await redis.del(mcpTurnTaintLedgerKey(orgId, agentId))
    const turnStartedAt = new Date(Date.now() - 40 * 60_000)
    // Read 35 minutes ago, through the gateway's own ledger write; the window has expired.
    await recordConnectionTaintLedger(orgId, agentId, [MAIL_READ])
    await redis.hset(
      mcpTurnTaintLedgerKey(orgId, agentId),
      MAIL_READ,
      String(Date.now() - 35 * 60_000),
    )
    // Read before this turn began: not this turn's.
    await redis.hset(
      mcpTurnTaintLedgerKey(orgId, agentId),
      KPI_READ,
      String(Date.now() - 50 * 60_000),
    )
    const stamp = await localReplyScope(orgId, threadId, ownerId, ["*"], agentId, turnStartedAt)
    expect(stamp).toContain(MAIL_READ)
    expect(stamp).not.toContain("*")
    await redis.del(mcpTurnTaintLedgerKey(orgId, agentId))
  })

  it("an admin's node job bound to its connection, with no read, is not stamped `*`", async () => {
    await clearWindow()
    // The job's own conversation (the earlier cases put a scoped message in the first DM).
    const nodeThread = crypto.randomUUID()
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${nodeThread}, ${orgId}, ${`node-dm-${nodeThread.slice(-8)}`}, 'agent_chat', ${ownerId})`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${nodeThread}, ${ownerId}, ${orgId}, 'admin')`
    const conn = await seedMcpConnection({
      orgId,
      userId: ownerId,
      clientId: "liaison-node",
      label: "Node job",
      agentId,
    })
    const [node] = await withSystemDb("test", (db) =>
      db
        .insert(nodes)
        .values({ orgId, ownerUserId: ownerId, deviceId: `d.${crypto.randomUUID()}`, name: "Mac" })
        .returning(),
    )
    const [jobRow] = await sql<{ id: string }[]>`
      INSERT INTO kernel.node_jobs (org_id, owner_user_id, agent_id, thread_id, source, prompt,
                                    status, node_id, lease_holder, lease_generation,
                                    lease_expires_at, claimed_at, started_at)
      VALUES (${orgId}, ${ownerId}, ${agentId}, ${nodeThread}, 'chat', 'p', 'running',
              ${node.id}, ${node.id}, 1, now() + interval '2 minutes', now(), now())
      RETURNING id`
    expect(await bindNodeJobConnection(node, jobRow.id, conn.id)).toBe("bound")
    const [job] = await withSystemDb("test", (db) =>
      db.select().from(nodeJobs).where(eq(nodeJobs.id, jobRow.id)),
    )
    const stamp = await nodeJobReplyScope(job, ["*"])
    expect(stamp).not.toContain("*")
    const write = await cloudContactsWrite(stamp)
    expect(refused(write)).toBe(false)
  })
})
