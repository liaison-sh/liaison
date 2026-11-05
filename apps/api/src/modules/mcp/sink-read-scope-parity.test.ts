// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A DECLARED SINK WRITE GETS THE SAME VERDICT OVER MCP AS IN THE APP.
//
// `sinkReadScope` (scope-taint.ts, consequence 4) lets a write to a table whose readers are
// declared run on a tainted turn when every reader holds what the turn read. The in-app tool
// bridge judged the registry entry; the MCP gateway judged a field-by-field copy of it that
// dropped `sinkReadScope`, so a client bound to an agent got E_SCOPE_TAINT_BLOCKED on a comment
// written after a metric read (the third QA walk: kpi_add_comment after kpi_run), which the
// in-app agent was allowed. Pinned here with a synthetic app, the same sequences through both
// seams:
//
//   1. read then declared sink write: both run, over MCP and in the app;
//   2. a reader lacking the read scope: both park the write for approval, a disclosure decided
//      by holding what the turn read (scope-taint.ts, rules 8b and 8h); neither runs it;
//   3. a write that did not run adds nothing to the per-(org, agent) MCP taint, whose stamps
//      would otherwise renew the block on every retry.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db/connection"
import { redis } from "~/lib/redis"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { mcpTurnTaintKey, mcpTurnTaintTouchedKey } from "~/modules/mcp/connection-service"
import {
  cleanupSeededOrg,
  grantScope,
  seedAgentForOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall, type ToolCallCtx } from "~/modules/mcp/tool-call"

const APP = "feedapp"
const METRICS_READ = "feedapp:metrics:read"
const COMMENTS_READ = "feedapp:comments:read"
const COMMENTS_WRITE = "feedapp:comments:write"
const SINK = "app_feedapp.comments"
const SECRET_READ = "feedapp:secret:read"
const FEED_SCOPES = [METRICS_READ, COMMENTS_READ, COMMENTS_WRITE, SECRET_READ]

const ran: string[] = []

function registerFeedapp(orgId: string) {
  const tools: Record<string, Record<string, unknown>> = {
    run_metric: { requiredScopes: [METRICS_READ], readOnly: true },
    add_comment: {
      requiredScopes: [COMMENTS_WRITE],
      writesToTable: SINK,
      sinkReadScope: COMMENTS_READ,
    },
    other_write: { requiredScopes: [COMMENTS_WRITE] },
    // A read whose handler answers with the taint-refusal CODE after reading (security
    // review PoC 5): it ran, so it must taint like any read.
    secret_read: { requiredScopes: [SECRET_READ], readOnly: true },
  }
  for (const [name, marks] of Object.entries(tools)) {
    toolRegistry.set([orgId, APP, name], {
      appName: APP,
      name,
      description: name,
      ...marks,
      params: z.object({}).passthrough(),
      handler: async () => {
        ran.push(name)
        if (name === "secret_read") {
          return { error: { code: "E_SCOPE_TAINT_BLOCKED", message: "SECRET_PAYLOAD 4242" } }
        }
        return { ok: true }
      },
    } as never)
  }
}

type Seed = Awaited<ReturnType<typeof seedOrgWithTicketsApp>>

async function seed() {
  const s = await seedOrgWithTicketsApp()
  for (const scope of FEED_SCOPES) await grantScope(s.orgId, s.ownerId, scope)
  const { agentId } = await seedAgentForOrg(s.orgId)
  const conn = await seedMcpConnection({
    orgId: s.orgId,
    userId: s.ownerId,
    clientId: "claude-code",
    label: "Claude Code",
  })
  registerFeedapp(s.orgId)
  return { s, agentId, connectionId: conn.id }
}

/** A fresh ctx per call: the streamable-HTTP transport rebuilds it on every POST. */
function postCtx(s: Seed, agentId: string, connectionId: string): ToolCallCtx {
  return {
    orgId: s.orgId,
    actor: userContextFor(s.orgId, s.ownerId, [...s.scopes, ...FEED_SCOPES]),
    connectionId,
    ownerUserId: s.ownerId,
    agentId,
    connectionThreadId: null,
    discovered: new Set(),
  }
}

async function viaMcp(ctx: () => ToolCallCtx, tool: string): Promise<string | "ok"> {
  const res = await handleToolCall(ctx(), `${APP}__${tool}`, {})
  if (!res.isError) {
    const parked = (res.structuredContent as { approvalRequestId?: string } | undefined)
      ?.approvalRequestId
    return typeof parked === "string" ? "parked" : "ok"
  }
  return String((res.structuredContent as { code?: string } | undefined)?.code ?? "error")
}

function inAppFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: createTurnScopeAccumulator(),
  }
}

async function viaApp(s: Seed, frame: RunContext, tool: string): Promise<string | "ok"> {
  const actor = userContextFor(s.orgId, s.ownerId, [...s.scopes, ...FEED_SCOPES])
  const tools = buildToolSet(
    s.orgId,
    actor,
    s.threadId,
    ALL_DEFERRED_TOOLS_UNLOCKED,
    "agent",
    frame,
  )
  const t = tools[`${APP}__${tool}`]
  if (!t) throw new Error(`${APP}__${tool} is not in the in-app catalog`)
  const r = (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute({}, {}),
  )) as Record<string, unknown>
  if (r.code === "E_SCOPE_TAINT_BLOCKED") return "E_SCOPE_TAINT_BLOCKED"
  if (r.blocked === true) return "parked"
  if (typeof r.error === "string") {
    return r.error.includes("E_SCOPE_TAINT_BLOCKED") ? "E_SCOPE_TAINT_BLOCKED" : "error"
  }
  return "ok"
}

async function addOutsiderReader(orgId: string): Promise<string> {
  const id = orgId.replace(/c([0-9a-f]{4})$/, "f$1")
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${id}, ${orgId}, ${`feed-outsider-${orgId.slice(-8)}@test.com`}, 'hash', 'Outsider', 'active')
    ON CONFLICT (id) DO NOTHING`
  await grantScope(orgId, id, COMMENTS_READ)
  return id
}

describe("declared sink write: MCP and in-app give the same verdict", () => {
  const orgs: string[] = []

  beforeAll(async () => {
    await initSandboxPool()
  })

  afterEach(async () => {
    for (const o of orgs.splice(0)) {
      toolRegistry.deleteByPrefix([o])
      await cleanupSeededOrg(o)
    }
  })

  afterAll(async () => {
    await shutdownSandboxPool()
  })

  it("a metric read then a comment: both seams write the comment", async () => {
    const { s, agentId, connectionId } = await seed()
    orgs.push(s.orgId)
    const post = () => postCtx(s, agentId, connectionId)

    ran.length = 0
    const mcp = [await viaMcp(post, "run_metric"), await viaMcp(post, "add_comment")]
    const frame = inAppFrame()
    const app = [await viaApp(s, frame, "run_metric"), await viaApp(s, frame, "add_comment")]

    expect(mcp).toEqual(["ok", "ok"])
    expect(app).toEqual(mcp)
    expect(ran).toEqual(["run_metric", "add_comment", "run_metric", "add_comment"])
  }, 30_000)

  it("a comment reader lacking the metric scope: both seams park it, and MCP adds no taint", async () => {
    const { s, agentId, connectionId } = await seed()
    orgs.push(s.orgId)
    await addOutsiderReader(s.orgId)
    const post = () => postCtx(s, agentId, connectionId)

    ran.length = 0
    const mcp = [
      await viaMcp(post, "run_metric"),
      await viaMcp(post, "add_comment"),
      await viaMcp(post, "add_comment"),
    ]
    const frame = inAppFrame()
    const app = [
      await viaApp(s, frame, "run_metric"),
      await viaApp(s, frame, "add_comment"),
      await viaApp(s, frame, "add_comment"),
    ]

    expect(mcp).toEqual(["ok", "parked", "parked"])
    expect(app).toEqual(mcp)
    expect(ran).toEqual(["run_metric", "run_metric"])

    // The parked writes never ran, so the per-agent MCP window holds only what was read: a
    // refused write's own scope, stamped there, renewed the block on every retry. (The in-app
    // turn still counts a refused call toward its reply's scopes, which only narrows who reads
    // that reply; it ends with the turn.)
    const persisted = JSON.parse((await redis.get(mcpTurnTaintKey(s.orgId, agentId))) ?? "[]")
    expect(persisted).toEqual([METRICS_READ])
    const stamps = await redis.hgetall(mcpTurnTaintTouchedKey(s.orgId, agentId))
    expect(Object.keys(stamps)).toEqual([METRICS_READ])
  }, 30_000)

  it("a parked sink write, then an undeclared write: both seams park both", async () => {
    const { s, agentId, connectionId } = await seed()
    orgs.push(s.orgId)
    await addOutsiderReader(s.orgId)
    const post = () => postCtx(s, agentId, connectionId)
    const seq = ["run_metric", "add_comment", "other_write"]
    const mcp: string[] = []
    for (const tool of seq) mcp.push(await viaMcp(post, tool))
    const frame = inAppFrame()
    const app: string[] = []
    for (const tool of seq) app.push(await viaApp(s, frame, tool))
    expect(mcp).toEqual(["ok", "parked", "parked"])
    expect(app).toEqual(mcp)
  }, 30_000)

  it("a handler returning the refusal CODE is not a refusal: its read taints (security PoC 5)", async () => {
    const { s, agentId, connectionId } = await seed()
    orgs.push(s.orgId)
    await addOutsiderReader(s.orgId)
    const post = () => postCtx(s, agentId, connectionId)

    await handleToolCall(post(), `${APP}__secret_read`, {})
    const persisted = JSON.parse((await redis.get(mcpTurnTaintKey(s.orgId, agentId))) ?? "[]")
    expect(persisted).toContain(SECRET_READ)
    const mcpNext = await viaMcp(post, "add_comment")

    const frame = inAppFrame()
    await viaApp(s, frame, "secret_read")
    const appNext = await viaApp(s, frame, "add_comment")

    expect(mcpNext).toBe("parked")
    expect(appNext).toBe(mcpNext)
  }, 30_000)
})
