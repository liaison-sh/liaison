// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A WRITE TO A SINK WHOSE READERS ARE DECLARED (scope-taint.ts, consequence 4).
//
// What the rule is for (scope-taint.ts header): data read under S must not reach a sink readable
// by someone lacking S. A tool may declare, next to `writesToTable`, the `sinkReadScope` every
// reader of that table holds. The dispatch then judges that sink's AUDIENCE instead of refusing
// outright: the write runs when every user of the org who can read the table (hasScope on the
// read scope or its write sibling, any account status) also holds every scope the turn read, and
// otherwise parks for approval by someone holding them (rule 8, 2026-10-20; it was refused).
//
// Found on a deployment where an app's comment feed (read under <app>:comments:read) refused
// every comment written after a metric read. This file pins the platform mechanism with a
// synthetic app; a deployment carrying a real app with such a sink pins its manifest separately.
//
// Driven through the real chat seam (buildToolSet's execute closure, then executeToolCore).

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { runContextStore } from "~/modules/agent/runtime/run-context"
import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
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

const ORG = "00000000-0000-4000-8000-0000000c5a01"
const USER = "00000000-0000-4000-8000-0000000c5a02"
const MEMBER = "00000000-0000-4000-8000-0000000c5a03"
const OUTSIDER = "00000000-0000-4000-8000-0000000c5a04"
const DM = "00000000-0000-4000-8000-0000000c5a05"

const METRICS_READ = "feedapp:metrics:read"
const COMMENTS_READ = "feedapp:comments:read"

type ToolMarks = {
  scope: string
  readOnly?: boolean
  gated?: boolean
  writesToTable?: string
  sinkReadScope?: string
}

const APP = "feedapp"
const SINK = "app_feedapp.comments"
const SINK_WRITE = {
  scope: "feedapp:comments:write",
  writesToTable: SINK,
  sinkReadScope: "feedapp:comments:read",
}

/** A synthetic app shaped like a metrics app with a discussion feed. */
const MARKS: Record<string, ToolMarks> = {
  run_metric: { scope: "feedapp:metrics:read", readOnly: true },
  list_comments: { scope: "feedapp:comments:read", readOnly: true },
  add_comment: SINK_WRITE,
  edit_comment: SINK_WRITE,
  delete_comment: SINK_WRITE,
  // Same table, no declared readers: the plain rule still refuses it.
  add_undeclared: { scope: "feedapp:comments:write", writesToTable: SINK },
}

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

const ran: string[] = []

/** A feedapp tool carrying exactly its declared scope and taint marks. */
function appTool(name: string) {
  const m = MARKS[name]
  if (!m) throw new Error(`feedapp has no ${name}`)
  toolRegistry.set([ORG, APP, name], {
    appName: APP,
    name,
    description: name,
    requiredScopes: [m.scope],
    ...(m.readOnly === true ? { readOnly: true } : {}),
    ...(m.gated === true ? { gated: true } : {}),
    ...(typeof m.writesToTable === "string" ? { writesToTable: m.writesToTable } : {}),
    ...(typeof m.sinkReadScope === "string" ? { sinkReadScope: m.sinkReadScope } : {}),
    params: z.object({}).passthrough(),
    handler: async () => {
      ran.push(`${APP}:${name}`)
      return { ok: true }
    },
  } as never)
}

function turnFrame(injected: string[] = []): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  turnScopeAccumulator.recordInjected(injected)
  return { runId, parentRunId: null, rootRunId: runId, nestingDepth: 0, turnScopeAccumulator }
}

async function call(
  frame: RunContext,
  sdkName: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const tools = buildToolSet(ORG, actor, DM, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

function refused(r: Record<string, unknown>): boolean {
  if (r.code === "E_SCOPE_TAINT_BLOCKED") return true
  return typeof r.error === "string" && r.error.includes("E_SCOPE_TAINT_BLOCKED")
}

/** Rule 8 (scope-taint.ts): a write its readers do not all vouch for parks for approval, unrun. */
function parked(r: Record<string, unknown>): boolean {
  return !refused(r) && r.blocked === true && r.status === "pending_approval"
}

async function grant(userId: string, scopes: string[]) {
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

describe("scope taint: a write to a declared sink is judged by that sink's readers", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Sink Readers Taint Org', 'sink-readers-taint-org') ON CONFLICT DO NOTHING`
    for (const [id, email] of [
      [USER, "sink-readers-taint-user@test.com"],
      [MEMBER, "sink-readers-taint-member@test.com"],
      [OUTSIDER, "sink-readers-taint-outsider@test.com"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${email}, 'active', 'x') ON CONFLICT DO NOTHING`
    }
    // An admin, and an app member who reads both metrics and comments.
    // The outsider reads nothing of feedapp until a case grants them the comment feed alone.
    await grant(USER, ["*"])
    await grant(MEMBER, [METRICS_READ, COMMENTS_READ, "feedapp:comments:write"])
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${DM}, ${ORG}, 'sink-readers-taint-dm', 'agent_chat', ${USER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${DM}, ${USER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${USER}, ${DM}, ${ORG}) ON CONFLICT DO NOTHING`

    await ensureAppsForOrg(ORG)
    for (const name of Object.keys(MARKS)) appTool(name)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("a metric read then a comment in one turn: the comment is written", async () => {
    ran.length = 0
    const frame = turnFrame()
    const run = await call(frame, "feedapp__run_metric")
    expect(frame.turnScopeAccumulator?.snapshot()).toContain(METRICS_READ)
    const comment = await call(frame, "feedapp__add_comment", {
      metricId: "inscrits_periode",
      body: "Le filtre marque blanche exclut les inscrits API.",
    })
    expect(refused(run)).toBe(false)
    expect(refused(comment)).toBe(false)
    expect(ran).toEqual(["feedapp:run_metric", "feedapp:add_comment"])
  })

  it("reading the feed, a metric, then editing and deleting one's comment in one turn all run", async () => {
    ran.length = 0
    const frame = turnFrame()
    await call(frame, "feedapp__list_comments", { metricId: "inscrits_periode" })
    await call(frame, "feedapp__run_metric")
    const edit = await call(frame, "feedapp__edit_comment", { commentId: "c1", body: "v2" })
    const del = await call(frame, "feedapp__delete_comment", { commentId: "c1" })
    expect(refused(edit)).toBe(false)
    expect(refused(del)).toBe(false)
    expect(ran).toEqual([
      "feedapp:list_comments",
      "feedapp:run_metric",
      "feedapp:edit_comment",
      "feedapp:delete_comment",
    ])
  })

  it("a comment reader who lacks feedapp:metrics:read makes the same comment park for approval", async () => {
    ran.length = 0
    await grant(OUTSIDER, [COMMENTS_READ])
    try {
      const frame = turnFrame()
      await call(frame, "feedapp__run_metric")
      const comment = await call(frame, "feedapp__add_comment", {
        metricId: "inscrits_periode",
        body: "x",
      })
      expect(parked(comment)).toBe(true)
      // The card says readers of the feed would see what the turn read once approved.
      const text = JSON.stringify(comment)
      expect(text).toContain(`some people who can read ${SINK} cannot see`)
      expect(ran).toEqual(["feedapp:run_metric"])
    } finally {
      await sql`DELETE FROM kernel.user_scope_grants
        WHERE org_id = ${ORG} AND user_id = ${OUTSIDER}`
    }
  })

  it("a scope no comment reader holds (another app's data) parks the comment for approval", async () => {
    ran.length = 0
    const frame = turnFrame(["tickets:tickets:read"])
    const comment = await call(frame, "feedapp__add_comment", { metricId: "m", body: "x" })
    expect(parked(comment)).toBe(true)
    expect(ran).toEqual([])
  })

  // Security verifier PoC (2026-09-23), adopted: a turn that read metrics AND tickets writes a
  // comment. Everyone who can read the feed must hold both, whatever form their grant takes.
  const TICKETS_READ = "tickets:tickets:read"
  async function withOutsider(scopes: string[], status: string, fn: () => Promise<void>) {
    await grant(MEMBER, [TICKETS_READ])
    await grant(OUTSIDER, scopes)
    await sql`UPDATE kernel.users SET status = ${status} WHERE id = ${OUTSIDER}`
    try {
      await fn()
    } finally {
      await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG} AND user_id = ${OUTSIDER}`
      await sql`DELETE FROM kernel.user_scope_grants
        WHERE org_id = ${ORG} AND user_id = ${MEMBER} AND scope = ${TICKETS_READ}`
      await sql`UPDATE kernel.users SET status = 'active' WHERE id = ${OUTSIDER}`
    }
  }

  it("control: with every reader holding both scopes, the comment runs", async () => {
    await withOutsider([], "active", async () => {
      ran.length = 0
      const frame = turnFrame([METRICS_READ, TICKETS_READ])
      const c = await call(frame, "feedapp__add_comment", { metricId: "m", body: "x" })
      expect(refused(c)).toBe(false)
      expect(ran).toEqual(["feedapp:add_comment"])
    })
  })

  const cases: Array<[string, string[], string]> = [
    ["an exact feedapp:comments:read reader", [COMMENTS_READ], "active"],
    ["a reader granted feedapp:*", ["feedapp:*"], "active"],
    ["a reader granted feedapp:comments:*", ["feedapp:comments:*"], "active"],
    ["a reader granted the bare feedapp app scope", ["feedapp"], "active"],
    // The table's RLS lets a comments:write holder SELECT (write implies read in the
    // generated policies), so a writer is a reader.
    ["a feedapp:comments:write holder (RLS reader)", ["feedapp:comments:write"], "active"],
    // Point-in-time is not enough for someone who only needs reactivating.
    ["a suspended reader", [COMMENTS_READ], "suspended"],
    ["a deactivated reader", [COMMENTS_READ], "deactivated"],
  ]
  for (const [who, scopes, status] of cases) {
    it(`${who} lacking tickets:tickets:read makes the comment park for approval`, async () => {
      await withOutsider(scopes, status, async () => {
        ran.length = 0
        const frame = turnFrame([METRICS_READ, TICKETS_READ])
        const c = await call(frame, "feedapp__add_comment", { metricId: "m", body: "ticket data" })
        expect(parked(c)).toBe(true)
        expect(ran).toEqual([])
      })
    })
  }

  it("an unknown taint is refused", async () => {
    ran.length = 0
    const frame = turnFrame([...UNKNOWN_TURN_TAINT])
    const comment = await call(frame, "feedapp__add_comment", { metricId: "m", body: "x" })
    expect(refused(comment)).toBe(true)
    expect(ran).toEqual([])
  })

  it("the same table without declared readers is never written inline: it parks", async () => {
    ran.length = 0
    const frame = turnFrame()
    await call(frame, "feedapp__run_metric")
    const c = await call(frame, "feedapp__add_undeclared", { metricId: "m", body: "x" })
    expect(parked(c)).toBe(true)
    expect(ran).toEqual(["feedapp:run_metric"])
  })
})
