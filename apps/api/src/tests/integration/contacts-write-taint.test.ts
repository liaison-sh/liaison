// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CONTACTS WRITE ON A TAINTED TURN FOLLOWS THE GLOBAL RULE OF EVERY GATED WRITE (scope-taint.ts,
// rule 8a): it parks for a person, and an auto-approve policy on the tool does not answer it.
//
// `kernel:contacts_write` is gated. An admin's auto-approve policy turns that gate off for a
// turn that read nothing scoped (contacts-write-gate.test.ts). Once the turn read scoped data,
// even a contacts search, the edit waits for a person, whoever in the org may read contacts:
// no reader set of the contact registry exempts it.
//
// Driven through the real chat seam (buildToolSet's execute closure, then executeToolCore), with
// the contacts handlers replaced by spies so only the taint decision is under test.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
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

const ORG = "00000000-0000-4000-8000-0000000c7a01"
const ADMIN = "00000000-0000-4000-8000-0000000c7a02"
const MEMBER = "00000000-0000-4000-8000-0000000c7a03"
const TICKETS_ONLY = "00000000-0000-4000-8000-0000000c7a04"
const DM = "00000000-0000-4000-8000-0000000c7a05"

const CONTACTS_READ = "kernel:contacts:read"
const MAIL_READ = "mail:conversations:read"

const actor: UserContext = {
  actorType: "user",
  userId: ADMIN,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
}

const ran: string[] = []

function spyOn(name: string) {
  const entry = toolRegistry.get([ORG, "kernel", name])
  if (!entry) throw new Error(`kernel:${name} is not registered`)
  toolRegistry.set([ORG, "kernel", name], {
    ...entry,
    // The spies stand for any contact; there is none to preflight.
    preflight: undefined,
    handler: async () => {
      ran.push(name)
      return name === "contacts_search" ? { items: [{ id: "c-1" }], totalCount: 1 } : { id: "c-1" }
    },
  } as never)
}

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

function refusalText(r: Record<string, unknown>): string | null {
  if (r.code === "E_SCOPE_TAINT_BLOCKED") return String(r.message ?? "")
  if (typeof r.error === "string" && r.error.includes("E_SCOPE_TAINT_BLOCKED")) return r.error
  const err = r.error as { code?: string; message?: string } | undefined
  if (err?.code === "E_SCOPE_TAINT_BLOCKED") return err.message ?? ""
  return null
}

async function setGrants(userId: string, scopes: string[]) {
  await sql`DELETE FROM kernel.user_scope_grants WHERE user_id = ${userId}`
  for (const scope of scopes) {
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${userId}, ${ORG}, ${scope}) ON CONFLICT DO NOTHING`
  }
}

describe("scope taint: contacts_write parks on a tainted turn, like any gated write", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Contacts Readers Taint Org', 'contacts-readers-taint-org') ON CONFLICT DO NOTHING`
    for (const [id, email] of [
      [ADMIN, "contacts-readers-admin@test.com"],
      [MEMBER, "contacts-readers-member@test.com"],
      [TICKETS_ONLY, "contacts-readers-tickets@test.com"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${email}, 'active', 'x') ON CONFLICT DO NOTHING`
    }
    await setGrants(ADMIN, ["*"])
    await setGrants(MEMBER, [CONTACTS_READ, "kernel:contacts:write"])
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${DM}, ${ORG}, 'contacts-readers-dm', 'agent_chat', ${ADMIN}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${DM}, ${ADMIN}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${ADMIN}, ${DM}, ${ORG}) ON CONFLICT DO NOTHING`
    // An agent's contact write is gated; the admin's auto-approve policy turns that off, so
    // only the scope taint decides here.
    await sql`INSERT INTO kernel.auto_approve_policies (org_id, tool_name)
      VALUES (${ORG}, 'kernel:contacts_write') ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG)
    spyOn("contacts_search")
    spyOn("contacts_write")
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("a contacts search then a contacts write parks, even with the policy and every account reading contacts", async () => {
    await setGrants(TICKETS_ONLY, ["tickets:tickets:read", CONTACTS_READ])
    ran.length = 0
    const frame = turnFrame()
    await call(frame, "kernel__contacts_search", { query: "Felix" })
    expect(frame.turnScopeAccumulator?.snapshot()).toContain(CONTACTS_READ)
    const write = await call(frame, "kernel__contacts_write", { contactId: crypto.randomUUID() })
    expect(refusalText(write)).toBeNull()
    expect(write).toMatchObject({ blocked: true, status: "pending_approval" })
    expect(ran).toEqual(["contacts_search"])
  })

  it("parks the same way when an account cannot read contacts", async () => {
    await setGrants(TICKETS_ONLY, ["tickets:tickets:read"])
    ran.length = 0
    const frame = turnFrame()
    await call(frame, "kernel__contacts_search", { query: "Felix" })
    const write = await call(frame, "kernel__contacts_write", { contactId: crypto.randomUUID() })
    expect(refusalText(write)).toBeNull()
    expect(write).toMatchObject({ blocked: true, status: "pending_approval" })
    expect(ran).toEqual(["contacts_search"])
  })

  it("mail read into the turn parks a contacts write too", async () => {
    await setGrants(TICKETS_ONLY, ["tickets:tickets:read", CONTACTS_READ])
    ran.length = 0
    const frame = turnFrame()
    frame.turnScopeAccumulator?.recordInjected([MAIL_READ])
    const write = await call(frame, "kernel__contacts_write", { contactId: crypto.randomUUID() })
    expect(refusalText(write)).toBeNull()
    expect(write).toMatchObject({ blocked: true, status: "pending_approval" })
    expect(ran).toEqual([])
  })
})
