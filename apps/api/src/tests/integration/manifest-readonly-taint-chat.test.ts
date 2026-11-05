// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A chat turn's tool calls go through buildToolSet's execute closure, which records each
// call's scopes into the turn accumulator and then applies scope taint: once any scoped call
// ran, a tool is refused unless it is readOnly or writes an enforcing sink. Taint is about
// writes, so the manifest READ tools must keep running for the rest of the turn while the
// manifest writes stay refused.
//
// The apps are the real in-tree registrations (ensureAppsForOrg reads the real manifests
// through the real trust rule); only each handler is swapped for a spy, so the test asserts
// what actually ran without touching tickets, knowledge or GitLab data.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { sql } from "~/db/connection"
import type { UserContext } from "~/db/rls"
import type { RunContext } from "~/modules/agent/runtime/run-context"
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

/** The refusal shape, whatever scopes the turn happened to carry (the message names them). */
/** Rule 8 (scope-taint.ts): a write the taint would refuse parks for approval, unrun. */
function parked(r: unknown): boolean {
  const o = (r ?? {}) as { blocked?: unknown; status?: unknown }
  return (
    !JSON.stringify(r).includes("E_SCOPE_TAINT_BLOCKED") &&
    o.blocked === true &&
    o.status === "pending_approval"
  )
}

const ORG = "00000000-0000-0000-0000-0000000fb101"
const USER = "00000000-0000-0000-0000-0000000fb102"

const actor: UserContext = {
  actorType: "user",
  userId: USER,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

const ran: string[] = []

/** The one table every per-ticket tickets write declares (A46). */

/** Keep the real registration's scope and taint metadata, swap only the handler. */
function spyOn(app: string, name: string) {
  const real = toolRegistry.get([ORG, app, name])
  if (!real) throw new Error(`${app}:${name} is not registered`)
  toolRegistry.set([ORG, app, name], {
    ...real,
    params: z.object({}).passthrough(),
    handler: async () => {
      ran.push(`${app}:${name}`)
      return { ok: true }
    },
  })
}

function chatTurnFrame(history: string[] = []): RunContext {
  const runId = crypto.randomUUID()
  const turnScopeAccumulator = createTurnScopeAccumulator()
  // What context assembly does with an earlier message of the thread read as history.
  turnScopeAccumulator.recordInjected(history)
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator,
  } as RunContext
}

function call(frame: RunContext, sdkName: string): Promise<unknown> {
  const tools = buildToolSet(ORG, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (t as unknown as { execute: (a: unknown) => Promise<unknown> }).execute({})
}

describe("chat turn: manifest reads survive scope taint, manifest writes do not", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'ReadOnlyTaintOrg', 'readonly-taint-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash)
      VALUES (${USER}, ${ORG}, 'readonly-taint@test.com', 'ReadOnly Taint', 'x')
      ON CONFLICT DO NOTHING`
    // A ticket reader: the tickets table is judged by its readers (scope-taint.ts, rule 6a),
    // so the refusal below needs one who lacks something the turn read.
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${USER}, ${ORG}, 'tickets:tickets:read') ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG)
    spyOn("tickets", "search")
    spyOn("tickets", "setStatus")
    spyOn("tickets", "markRead")
    spyOn("knowledge", "search")
    spyOn("gitlab", "gitlab_list_projects")
    // A tool with neither a write target nor a readOnly mark, so the undeclared
    // refusal keeps a case of its own. Registered here because every real tickets
    // tool now declares one.
    toolRegistry.set([ORG, "tickets", "unmarked_probe"], {
      appName: "tickets",
      name: "unmarked_probe",
      description: "unmarked probe",
      requiredScopes: ["tickets:tickets:write"],
      params: z.object({}).passthrough(),
      handler: async () => {
        ran.push("tickets:unmarked_probe")
        return { ok: true }
      },
    } as never)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
    await releaseTestLock()
  })

  it("a tickets list read keeps running after an earlier read tainted the turn", async () => {
    ran.length = 0
    const frame = chatTurnFrame()
    const first = await call(frame, "tickets__search")
    // The first read taints the turn with its own scope.
    expect(frame.turnScopeAccumulator?.snapshot()).toContain("tickets:tickets:read")
    const second = await call(frame, "tickets__search")
    const third = await call(frame, "knowledge__search")
    for (const r of [first, second, third]) {
      expect((r as { code?: string }).code).not.toBe("E_SCOPE_TAINT_BLOCKED")
    }
    expect(ran).toEqual(["tickets:search", "tickets:search", "knowledge:search"])
  })

  it("a first-party sandboxed read (gitlab) runs on a tainted turn", async () => {
    ran.length = 0
    const frame = chatTurnFrame()
    await call(frame, "tickets__search")
    const result = await call(frame, "gitlab__gitlab_list_projects")
    expect((result as { code?: string }).code).not.toBe("E_SCOPE_TAINT_BLOCKED")
    expect(ran).toEqual(["tickets:search", "gitlab:gitlab_list_projects"])
  })

  it("a ticket update never runs inline after a read tainted the turn: it parks for approval", async () => {
    ran.length = 0
    // The thread's history carries audit data, which the ticket reader does not hold.
    const frame = chatTurnFrame(["kernel:audit:read"])
    // A46: search reads many rows and names none, so the turn holds no origin row and
    // the write is judged; its readers lack the audit scope, so it parks (rule 8).
    await call(frame, "tickets__search")
    expect(frame.turnScopeAccumulator?.originRows()).toEqual({})
    const update = await call(frame, "tickets__setStatus")
    // A read-scoped tool that writes (the read-state upsert) parks as well.
    const markRead = await call(frame, "tickets__markRead")
    expect(parked(update)).toBe(true)
    expect(parked(markRead)).toBe(true)
    expect(ran).toEqual(["tickets:search"])
  })

  it("an unmarked tool never runs inline either: a write to an unknown table parks", async () => {
    // A tool that declares neither a write target nor readOnly is still a write to an
    // unknown table: its readers cannot be derived, so it parks for approval (rule 8).
    ran.length = 0
    const frame = chatTurnFrame()
    await call(frame, "tickets__search")
    const unmarked = await call(frame, "tickets__unmarked_probe")
    expect(parked(unmarked)).toBe(true)
    expect(ran).toEqual(["tickets:search"])
  })
})
