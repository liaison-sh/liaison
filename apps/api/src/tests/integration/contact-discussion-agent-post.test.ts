// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A ROUTINE'S AGENT WRITES IN A CONTACT'S DISCUSSION IT HAS NEVER BEEN IN.
//
// An event routine runs for its owner with only the routine's scopes. Its agent finds a contact
// (kernel__contacts_search) and posts a brief in the contact's discussion (kernel__threads_reply
// with contactId): the discussion is created on first use, the post lands at once, attributed to
// the agent, with no approval. A contact the owner cannot see has no discussion: the call is
// refused and no thread is created. Driven through the real chat seam (buildToolSet's execute
// closure, then executeToolCore) with the real handlers.
//
// The turn is tainted as a real tick's is: its own prompt, stamped with the tick's scope, is read
// back as history, and `kernel:threads:write` projects onto `kernel:threads:read`, a scope the
// routine does not hold. The post carries that stamp, so the routine's own context cannot read
// it back: the write must not depend on that (it was refused with 403 under INSERT … RETURNING).
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

const ORG = "00000000-0000-4000-8000-0000000c9b01"
const OWNER = "00000000-0000-4000-8000-0000000c9b02"
const OTHER = "00000000-0000-4000-8000-0000000c9b03"
const RUN_THREAD = "00000000-0000-4000-8000-0000000c9b04"
const CONTACT = "00000000-0000-4000-8000-0000000c9b05"
const PRIVATE_CONTACT = "00000000-0000-4000-8000-0000000c9b06"
const AGENT = "00000000-0000-4000-8000-0000000c9b07"
const ROUTINE = "00000000-0000-4000-8000-0000000c9b08"
const OTHER_THREAD = "00000000-0000-4000-8000-0000000c9b09"

/** The routine's scopes: what the tick runs with, not the owner's whole grant. */
const ROUTINE_SCOPES = ["kernel:threads:write", "kernel:contacts:read"]

const tickActor: UserContext = {
  actorType: "user",
  userId: OWNER,
  orgId: ORG,
  scopes: ROUTINE_SCOPES,
  dimensionGrants: {},
}

function tickFrame(): RunContext {
  const runId = crypto.randomUUID()
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    background: true,
    routineId: ROUTINE,
    turnScopeAccumulator: createTurnScopeAccumulator({ orgId: ORG }),
  }
}

/** A tick's frame after its prompt (stamped with the routine's scopes) was read as history. */
function taintedTickFrame(): RunContext {
  const frame = tickFrame()
  frame.turnScopeAccumulator?.recordInjected(ROUTINE_SCOPES)
  return frame
}

async function agentCall(
  frame: RunContext,
  sdkName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tools = buildToolSet(
    ORG,
    tickActor,
    RUN_THREAD,
    ALL_DEFERRED_TOOLS_UNLOCKED,
    "agent",
    frame,
  )
  const t = tools[sdkName]
  if (!t) throw new Error(`${sdkName} is not in the catalog`)
  return (await runContextStore.run(frame, () =>
    (t as unknown as { execute: (a: unknown, o: unknown) => Promise<unknown> }).execute(args, {}),
  )) as Record<string, unknown>
}

async function discussion(contactId: string) {
  return sql<{ id: string }[]>`
    SELECT id::text FROM kernel.threads
     WHERE org_id = ${ORG} AND handle = ${`contact-primary:${contactId}`}`
}

describe("threads_reply contactId from a routine run", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Discussion Routine Org', 'discussion-routine-org') ON CONFLICT DO NOTHING`
    for (const [id, email, name] of [
      [OWNER, "discussion-routine-owner@test.com", "Routine Owner"],
      [OTHER, "discussion-routine-other@test.com", "Someone Else"],
    ] as const) {
      await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash)
        VALUES (${id}, ${ORG}, ${email}, ${name}, 'active', 'x') ON CONFLICT DO NOTHING`
      await sql`INSERT INTO kernel.user_scope_grants (user_id, org_id, scope)
        VALUES (${id}, ${ORG}, 'kernel:threads:write'), (${id}, ${ORG}, 'kernel:contacts:read')
        ON CONFLICT DO NOTHING`
    }
    // The owner's agent, seated in the routine's run thread (an agent seat), never in the
    // contact's discussion.
    await sql`INSERT INTO kernel.agents (id, org_id, kind, owner_user_id, handle, display_name, scope_ceiling)
      VALUES (${AGENT}, ${ORG}, 'personal', ${OWNER}, '@routine-owner', 'Routine Owner agent', '["*"]'::jsonb)
      ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${RUN_THREAD}, ${ORG}, 'discussion-routine-run', 'thread', ${OWNER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${RUN_THREAD}, ${OWNER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${OTHER_THREAD}, ${ORG}, 'discussion-routine-other', 'thread', ${OWNER}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
      VALUES (${OTHER_THREAD}, ${OWNER}, ${ORG}, 'admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, org_id, role, participant_type, agent_id)
      VALUES (${RUN_THREAD}, ${ORG}, 'member', 'agent', ${AGENT}) ON CONFLICT DO NOTHING`
    // Shared with the organisation (someone else's record), and one private to its creator.
    await sql`INSERT INTO kernel.contacts (id, org_id, handle, name, email, created_by, owner_user_id, org_access)
      VALUES (${CONTACT}, ${ORG}, '@discussion-prospect', 'Ada Prospect', 'ada@example.com', ${OTHER}, ${OTHER}, 'viewer'),
             (${PRIVATE_CONTACT}, ${ORG}, '@discussion-private', 'Private Person', 'private@example.com', ${OTHER}, ${OTHER}, 'none')
      ON CONFLICT DO NOTHING`
    await ensureAppsForOrg(ORG)
  }, 120_000)

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG])
    skillRegistry.deleteByPrefix([ORG])
    agentInstructionsRegistry.deleteByPrefix([ORG])
    initializedOrgRuntimes.delete(ORG)
    await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.timeline_entries WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.contacts WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.agents WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.user_scope_grants WHERE org_id = ${ORG}`
    await releaseTestLock()
  })

  it("the agent finds the contact, then posts in its discussion at once, as itself", async () => {
    const frame = taintedTickFrame()
    expect(frame.turnScopeAccumulator?.snapshot()).toContain("kernel:threads:read")
    const found = await agentCall(frame, "kernel__contacts_search", { query: "Ada" })
    expect(JSON.stringify(found)).toContain(CONTACT)
    const posted = await agentCall(frame, "kernel__threads_reply", {
      contactId: CONTACT,
      content: "Brief: Ada runs a studio, asked for pricing.",
    })
    expect(posted.blocked).toBeUndefined()
    expect(JSON.stringify(posted)).not.toContain("error")
    // A second post in the same turn (its first one taints the turn with kernel:threads:write).
    const again = await agentCall(frame, "kernel__threads_reply", {
      contactId: CONTACT,
      content: "Follow-up: sent the price list.",
    })
    expect(JSON.stringify(again)).not.toContain("error")
    const rows = await sql<
      {
        author_type: string
        author_id: string
        author_agent_id: string | null
        content: string
        required_scopes: string[]
      }[]
    >`
      SELECT m.author_type, m.author_id::text, m.author_agent_id::text, m.content, m.required_scopes
        FROM kernel.messages m JOIN kernel.threads t ON t.id = m.thread_id
       WHERE t.org_id = ${ORG} AND t.handle = ${`contact-primary:${CONTACT}`}
       ORDER BY m.created_at, m.content`
    expect(rows.map((r) => [r.author_type, r.content])).toEqual([
      ["agent", "Brief: Ada runs a studio, asked for pricing."],
      ["agent", "Follow-up: sent the price list."],
    ])
    expect(rows.map((r) => r.author_agent_id)).toEqual([AGENT, AGENT])
    expect(rows.map((r) => r.author_id)).toEqual([OWNER, OWNER])
    // The stamp is the turn's taint, unchanged: who may read the post is not widened.
    expect(rows[0]?.required_scopes).toContain("kernel:threads:read")
    // What the tool returned is the row written.
    const returned = (posted as { message?: { id?: string; createdAt?: unknown } }).message
    const [stored] = await sql<{ id: string; created_at: Date }[]>`
      SELECT id::text, created_at FROM kernel.messages WHERE id = ${returned?.id ?? null}::uuid`
    expect(stored?.id).toBe(returned?.id as string)
    expect(new Date(returned?.createdAt as string | Date).getTime()).toBe(
      new Date(stored?.created_at as Date).getTime(),
    )
    const approvals = await sql`
      SELECT id FROM kernel.approval_requests WHERE org_id = ${ORG}`
    expect(approvals.length).toBe(0)
  })

  it("posts in any thread it sits in the same way, not only a contact's discussion", async () => {
    const posted = await agentCall(taintedTickFrame(), "kernel__threads_reply", {
      threadId: OTHER_THREAD,
      content: "Weekly note.",
    })
    expect(JSON.stringify(posted)).not.toContain("error")
    const rows = await sql<{ author_type: string }[]>`
      SELECT author_type FROM kernel.messages WHERE thread_id = ${OTHER_THREAD}`
    expect(rows.map((r) => r.author_type)).toEqual(["agent"])
  })

  it("a contact its owner cannot see is refused, and no discussion is created", async () => {
    const posted = await agentCall(taintedTickFrame(), "kernel__threads_reply", {
      contactId: PRIVATE_CONTACT,
      content: "Should not land",
    })
    expect(JSON.stringify(posted)).toContain("Contact not found")
    expect((await discussion(PRIVATE_CONTACT)).length).toBe(0)
  })
})
