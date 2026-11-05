// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN AGENT'S CONTACT EDIT WAITS FOR A PERSON, UNLESS THE ORGANISATION'S AUTO-APPROVE POLICY
// COVERS IT. ITS POST IN THE CONTACT'S DISCUSSION DOES NOT WAIT.
//
// `kernel:contacts_write` is gated: an agent's call parks an approval whose card names the
// contact and lists each field with its new value, and the contact is unchanged until a person
// approves. An admin turns the gate off the way they do for any gated tool, with an auto-approve
// policy on the tool's name: the same call then runs at once. Driven through the real chat seam
// (buildToolSet's execute closure, then executeToolCore) with the real handler.
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

const ORG = "00000000-0000-4000-8000-0000000c9a01"
const ADMIN = "00000000-0000-4000-8000-0000000c9a02"
const DM = "00000000-0000-4000-8000-0000000c9a05"
const CONTACT = "00000000-0000-4000-8000-0000000c9a06"
const AGENT = "00000000-0000-4000-8000-0000000c9a07"

const actor: UserContext = {
  actorType: "user",
  userId: ADMIN,
  orgId: ORG,
  scopes: ["*"],
  dimensionGrants: {},
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

async function agentCall(
  sdkName: string,
  args: Record<string, unknown>,
  frame: RunContext = turnFrame(),
  threadId: string = DM,
): Promise<Record<string, unknown>> {
  const tools = buildToolSet(ORG, actor, threadId, ALL_DEFERRED_TOOLS_UNLOCKED, "agent", frame)
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

async function company(): Promise<string | null> {
  const [row] = await sql<{ company: string | null }[]>`
    SELECT company FROM kernel.contacts WHERE id = ${CONTACT}`
  return row?.company ?? null
}

describe("contacts_write: gated for agents, switched off by an auto-approve policy", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Contacts Gate Org', 'contacts-gate-org') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
      VALUES (${ADMIN}, ${ORG}, 'contacts-gate-admin@test.com', 'Gate Admin', 'active', 'x')
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
      VALUES (${ADMIN}, ${ORG}, '*') ON CONFLICT DO NOTHING`
    // The person's own agent: what an agent post from this turn is attributed to.
    await sql`INSERT INTO kernel.agents (id, org_id, kind, owner_user_id, handle, display_name, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'personal', ${ADMIN}, '@gate-admin', 'Gate Admin agent', '["*"]'::jsonb)
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${DM}, ${ORG}, 'contacts-gate-dm', 'agent_chat', ${ADMIN}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${DM}, ${ADMIN}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.user_thread_state (user_id, thread_id, org_id)
      VALUES (${ADMIN}, ${DM}, ${ORG}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, org_access)
      VALUES (${CONTACT}, ${ORG}, '@contact-gate', 'Felix Moreau', 'felix@example.com', ${ADMIN}, 'editor')
      ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG} AND handle LIKE 'contact-primary:%'`
    await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("by default an agent's edit parks, with a card naming the contact and each new value", async () => {
    const write = await agentCall("kernel__contacts_write", {
      contactId: CONTACT,
      company: "Moreau Audio",
      metadata: { city: "Lyon" },
    })
    expect(write).toMatchObject({ blocked: true, status: "pending_approval" })
    expect(await company()).toBeNull()
    const [req] = await sql<{ summary: { title: string; lines: string[] } }[]>`
      SELECT summary FROM kernel.approval_requests
       WHERE org_id = ${ORG} AND tool_name = 'kernel:contacts_write' AND status = 'pending'`
    expect(req?.summary.title).toBe("Edit the contact Felix Moreau <felix@example.com>")
    expect(req?.summary.lines).toEqual(["Company → Moreau Audio", "city → Lyon"])
  })

  it("a write that names no contact the agent saw is refused before anything parks", async () => {
    const before = await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG}`
    const write = await agentCall("kernel__contacts_write", {
      contactId: crypto.randomUUID(),
      company: "Nowhere",
    })
    expect(JSON.stringify(write)).toContain("Contact not found")
    const after = await sql`SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(after.length).toBe(before.length)
  })

  it("an auto-approve policy on kernel:contacts_write turns the gate off: the edit runs at once", async () => {
    await sql`INSERT INTO kernel.auto_approve_policies (org_id, tool_name, created_by)
      VALUES (${ORG}, 'kernel:contacts_write', ${ADMIN}) ON CONFLICT DO NOTHING`
    const write = await agentCall("kernel__contacts_write", {
      contactId: CONTACT,
      company: "Moreau Audio",
    })
    expect(write.blocked).toBeUndefined()
    expect(await company()).toBe("Moreau Audio")
  })

  it("with the policy, search then edit in one turn still parks, like any gated write on a tainted turn", async () => {
    // The search taints the turn with kernel:contacts:read. A gated write on a tainted turn
    // always waits for a person (scope-taint.ts, rule 8a): the policy does not answer it, even
    // though every account here reads contacts.
    const frame = turnFrame()
    await agentCall("kernel__contacts_search", { query: "Felix" }, frame)
    expect(frame.turnScopeAccumulator?.snapshot()).toContain("kernel:contacts:read")
    const write = await agentCall(
      "kernel__contacts_write",
      { contactId: CONTACT, company: "Moreau Audio SARL" },
      frame,
    )
    expect(write).toMatchObject({ blocked: true, status: "pending_approval" })
    expect(await company()).toBe("Moreau Audio")
  })

  it("an agent writes in the contact's discussion at once, attributed to it, with no approval", async () => {
    const posted = await agentCall("kernel__threads_reply", {
      contactId: CONTACT,
      content: "New prospect: wants a demo next week.",
    })
    expect(posted.blocked).toBeUndefined()
    expect(JSON.stringify(posted)).not.toContain("error")
    const rows = await sql<
      { author_type: string; author_agent_id: string | null; content: string }[]
    >`
      SELECT m.author_type, m.author_agent_id::text, m.content
        FROM kernel.messages m JOIN kernel.threads t ON t.id = m.thread_id
       WHERE t.org_id = ${ORG} AND t.handle = ${`contact-primary:${CONTACT}`}`
    expect(rows.map((r) => [r.author_type, r.content])).toEqual([
      ["agent", "New prospect: wants a demo next week."],
    ])
    expect(rows[0]?.author_agent_id).toBeTruthy()
    const approvals = await sql`
      SELECT id FROM kernel.approval_requests
       WHERE org_id = ${ORG} AND tool_name = 'kernel:threads_reply'`
    expect(approvals.length).toBe(0)
    // A contact the agent's person cannot see has no discussion to write in.
    const hidden = await agentCall("kernel__threads_reply", {
      contactId: crypto.randomUUID(),
      content: "Nowhere",
    })
    expect(JSON.stringify(hidden)).toContain("Contact not found")
  })

  it("asked in the contact's discussion, an agent's contact edit parks an approval in that thread", async () => {
    await sql`DELETE FROM kernel.auto_approve_policies WHERE org_id = ${ORG}`
    const [discussion] = await sql<{ id: string }[]>`
      SELECT id::text FROM kernel.threads
       WHERE org_id = ${ORG} AND handle = ${`contact-primary:${CONTACT}`}`
    expect(discussion?.id).toBeTruthy()
    const write = await agentCall(
      "kernel__contacts_write",
      { contactId: CONTACT, company: "Moreau Studios" },
      turnFrame(),
      discussion!.id,
    )
    expect(write).toMatchObject({ blocked: true, status: "pending_approval" })
    expect(await company()).toBe("Moreau Audio")
    const [req] = await sql<{ originating_thread_id: string }[]>`
      SELECT originating_thread_id::text FROM kernel.approval_requests
       WHERE org_id = ${ORG} AND tool_name = 'kernel:contacts_write' AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`
    // The thread stream draws the card inline where it was asked: the discussion.
    expect(req?.originating_thread_id).toBe(discussion!.id)
  })
})
