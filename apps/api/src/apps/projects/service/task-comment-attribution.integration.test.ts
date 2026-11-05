// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A task comment an agent posts during its turn is the AGENT's: attributed
// ("{User}'s agent", or a named agent under its own name), never stored as
// written by the person. The agent's call reaches `projects_addComment`
// through the sandbox bridge, in a callback that has lost the turn's frame and
// on a per-call bridge rebuild made outside it, so both the acting agent and
// the request the turn answers come from the frame captured when the bridge
// was built. The create event carries that request (`metadata.turnMessageId`),
// which is what a guided tour's `causedBy` beat (the projects scenario's
// `reply`) completes on.
//
// The same path called with no agent behind it (a person in the app UI, a
// webhook) and the demo world's teammate comment stay the person's own.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { findTour, type Tour, type TourEventBinding } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import projectsManifest from "~/apps/projects/app.manifest.json"
import { createProject } from "~/apps/projects/service/create-project"
import { postTaskComment } from "~/apps/projects/service/task-comment"
import { createTask } from "~/apps/projects/service/tasks"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { createRlsSession, type UserContext, withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import type { AppEvent } from "~/infra/events/event-bus"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { createSessionRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { actorSatisfies, bindingMatches } from "~/modules/tours/consumer"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SCOPES = [
  "projects:projects:read",
  "projects:projects:write",
  "projects:tasks:read",
  "projects:tasks:write",
  "kernel:threads:write",
  "kernel:threads:read",
]

let orgId: string
let userId: string
let teammateId: string
let personalAgentId: string
let roleAgentId: string
let actor: UserContext
let taskId: string

async function insertUser(name: string): Promise<string> {
  return extractRows<{ id: string }>(
    await withPrivilegedDb(orgId, "tca-seed-user", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`tca-${crypto.randomUUID()}@test.com`}, ${name}, 'active', 'hash', 1, 1)
        RETURNING id
      `),
    ),
  )[0]!.id
}

async function seedAgent(kind: "personal" | "role", displayName: string): Promise<string> {
  return withPrivilegedDb(orgId, "tca-seed-agent", async (tx) => {
    const [a] = await tx
      .insert(agents)
      .values({
        orgId,
        kind,
        handle: `@tca-${kind}-${crypto.randomUUID().slice(0, 8)}`,
        displayName,
        ...(kind === "personal" ? { ownerUserId: userId } : {}),
        scopeCeiling: SCOPES,
      })
      .returning({ id: agents.id })
    return a!.id
  })
}

/** A turn frame as a real agent turn carries it. */
function turnFrame(agentId: string, turnMessageId: string): RunContext {
  const runId = crypto.randomUUID()
  const accumulator = createTurnScopeAccumulator()
  accumulator.recordInjected(["projects:tasks:read"])
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: accumulator,
    agentId,
    turnMessageId,
  }
}

type Bridge = Record<string, (p: string) => Promise<string>>

/**
 * The production shape: the session bridge is built where execute-tool builds
 * it (inside the turn's frame when there is one), and the method runs later,
 * outside it, on a per-call rebuild.
 */
function buildBridge(frame: RunContext | null, origin?: "human-ui" | "in-app-agent"): Bridge {
  const build = () =>
    createSessionRpcBridge(
      "projects",
      userId,
      orgId,
      createRlsSession(actor),
      projectsManifest as never,
      SCOPES,
      "user",
      undefined,
      { actor, ...(origin ? { origin } : {}) } as never,
    ) as Bridge
  return frame ? runContextStore.run(frame, build) : build()
}

async function comment(bridge: Bridge, body: string): Promise<string> {
  expect(runContextStore.getStore()).toBeUndefined()
  const out = JSON.parse(await bridge.projects_addComment!(JSON.stringify({ taskId, body }))) as {
    messageId: string | null
  }
  expect(out.messageId).toBeTruthy()
  return out.messageId!
}

async function messageRow(id: string) {
  const [row] = await sql`SELECT author_type, author_id, author_agent_id, metadata
    FROM kernel.messages WHERE id = ${id}`
  return row as {
    author_type: string
    author_id: string
    author_agent_id: string | null
    metadata: Record<string, unknown> | null
  }
}

async function createEvent(messageId: string): Promise<AppEvent> {
  const rows = await sql`SELECT payload FROM kernel.pending_events
    WHERE org_id = ${orgId} AND payload->>'entity' = 'message'
      AND payload->>'action' = 'create' AND payload->>'entityId' = ${messageId}`
  expect(rows).toHaveLength(1)
  return (rows[0] as { payload: AppEvent }).payload
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  userId = await insertUser("Ada Visitor")
  teammateId = await insertUser("Tobias Teammate")
  personalAgentId = await seedAgent("personal", "Personal agent")
  roleAgentId = await seedAgent("role", "Launch Desk")
  actor = { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: { "*": ["*"] } }
  taskId = await withRlsContext(actor, async (tx) => {
    const p = await createProject({
      tx,
      orgId,
      actor,
      input: {
        name: `tca-${crypto.randomUUID().slice(0, 8)}`,
        key: `T${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      },
    })
    const t = await createTask({
      tx,
      orgId,
      actor,
      input: { projectId: p.id, statusId: p.statuses[0]!.id, title: "Prepare the demo" },
    })
    return t.id
  })
})

afterAll(async () => {
  await releaseTestLock()
})

describe("projects_addComment during an agent turn", () => {
  it("stores the agent as the author, labelled as the person's agent, never the person", async () => {
    const turnMessageId = crypto.randomUUID()
    const bridge = buildBridge(turnFrame(personalAgentId, turnMessageId), "in-app-agent")
    const id = await comment(bridge, "Ada's agent here: the units are charged.")

    const row = await messageRow(id)
    expect(row.author_type).toBe("agent")
    expect(row.author_agent_id).toBe(personalAgentId)
    // RLS actor unchanged: the row still belongs to the person who asked.
    expect(row.author_id).toBe(userId)
    expect(row.metadata?.agentAuthorLabel).toBe("Ada Visitor's agent")

    const event = await createEvent(id)
    expect(event.actorType).toBe("agent")
    expect(event.agentId).toBe(personalAgentId)
    expect((event.metadata as Record<string, unknown>).turnMessageId).toBe(turnMessageId)
    expect((event.data as Record<string, unknown>).authorAgentId).toBe(personalAgentId)
  })

  it("a named agent posts under its own name", async () => {
    const bridge = buildBridge(turnFrame(roleAgentId, crypto.randomUUID()), "in-app-agent")
    const id = await comment(bridge, "Launch Desk: booked.")
    const row = await messageRow(id)
    expect(row.author_type).toBe("agent")
    expect(row.author_agent_id).toBe(roleAgentId)
    expect(row.metadata?.agentAuthorLabel).toBe("Launch Desk")
  })

  it("completes the projects tour's reply beat, which is bound to the asking turn", async () => {
    const turnMessageId = crypto.randomUUID()
    const bridge = buildBridge(turnFrame(personalAgentId, turnMessageId), "in-app-agent")
    const event = await createEvent(await comment(bridge, "Done."))

    const tour = findTour("kernel.scenario-projects") as Tour
    const reply = tour.beats.find((b) => b.id === "reply") as { event: TourEventBinding }
    expect(reply.event.causedBy).toBe("ask-agent")
    expect(actorSatisfies(reply.event, event, userId)).toBe(true)
    expect(bindingMatches(reply.event, event, { "ask-agent": turnMessageId })).toBe(true)
    // Another request's comment does not complete it.
    expect(bindingMatches(reply.event, event, { "ask-agent": crypto.randomUUID() })).toBe(false)
  })
})

describe("the same comment with no agent behind it stays the person's", () => {
  it("a person in the app UI", async () => {
    const id = await comment(buildBridge(null, "human-ui"), "Thanks!")
    const row = await messageRow(id)
    expect(row.author_type).toBe("user")
    expect(row.author_id).toBe(userId)
    expect(row.author_agent_id).toBeNull()
    const event = await createEvent(id)
    expect(event.actorType).toBe("user")
    expect((event.metadata as Record<string, unknown> | undefined)?.turnMessageId).toBeUndefined()
  })

  it("a call from no turn at all (a job, a webhook)", async () => {
    const id = await comment(buildBridge(null), "Automated note")
    const row = await messageRow(id)
    expect(row.author_type).toBe("user")
    expect(row.author_agent_id).toBeNull()
  })

  it("the demo world's teammate comment (the injector's call shape)", async () => {
    const teammate: UserContext = { ...actor, userId: teammateId }
    const posted = await withRlsContext(teammate, (tx) =>
      postTaskComment(tx, {
        orgId,
        userId: teammateId,
        taskId,
        body: "The booth is confirmed.",
        requiredScopes: [],
      }),
    )
    const row = await messageRow(posted.messageId!)
    expect(row.author_type).toBe("user")
    expect(row.author_id).toBe(teammateId)
    expect(row.author_agent_id).toBeNull()
  })
})
