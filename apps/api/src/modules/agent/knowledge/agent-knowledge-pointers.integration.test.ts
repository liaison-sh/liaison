// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent page's Knowledge tab lists `kernel.agent_knowledge_pointers`. The
// migration seeds the roster's pointers once; nothing else wrote the table, so
// on any org that did not come through that seed (and for every collection an
// agent started working in afterwards) the tab could never fill.
//
// A knowledge write made by an AGENT records the pointer. Driven through the
// real sandbox bridge, exactly as an agent turn does it: the bridge is built
// inside the turn's frame and the app's callback runs with the frame lost.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import knowledgeManifest from "~/apps/knowledge/app.manifest.json"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { agents } from "~/db/schema/kernel/agents"
import { declaredEmits, initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { type RunContext, runContextStore } from "~/modules/agent/runtime/run-context"
import { createTurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const KNOWLEDGE_SCOPES = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
  "knowledge:collections:manage",
]

/** The create classifies the document, so the actor must hold the grant for it. */
const DIMENSION_GRANTS = { sensitivity: ["internal"] }

let session: minimal.Session
let agentId: string
let collectionId: string

/** A turn frame, the shape every real turn carries. */
function turnFrame(opts: { agentId?: string } = {}): RunContext {
  const runId = crypto.randomUUID()
  const accumulator = createTurnScopeAccumulator()
  accumulator.recordInjected(["kernel:threads:read"])
  return {
    runId,
    parentRunId: null,
    rootRunId: runId,
    nestingDepth: 0,
    turnScopeAccumulator: accumulator,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
  }
}

/** One knowledge_create through the bridge, as `frameAgentId` (or as nobody). */
async function createDocumentThroughBridge(
  title: string,
  frameAgentId: string | null,
): Promise<{ id: string }> {
  return withRlsContext(
    {
      actorType: "user",
      orgId: session.orgId,
      userId: session.userId,
      scopes: KNOWLEDGE_SCOPES,
      dimensionGrants: DIMENSION_GRANTS,
    },
    async (tx) => {
      const bridge = runContextStore.run(
        turnFrame(frameAgentId ? { agentId: frameAgentId } : {}),
        () =>
          createRpcBridge(
            "knowledge",
            session.userId,
            session.orgId,
            tx as never,
            knowledgeManifest as never,
            KNOWLEDGE_SCOPES,
            "user",
            undefined,
            {
              // A connector-origin create skips the collection-placement guard;
              // the pointer under test comes from `collectionIds`.
              callerApp: "calls",
              actor: {
                actorType: "user",
                userId: session.userId,
                orgId: session.orgId,
                scopes: KNOWLEDGE_SCOPES,
                dimensionGrants: DIMENSION_GRANTS,
              } as never,
            },
          ) as Record<string, (p: string) => Promise<string>>,
      )
      return JSON.parse(
        await bridge.knowledge_create!(
          JSON.stringify({
            documentScope: "organization",
            title,
            body: "written during an agent turn",
            collectionIds: [collectionId],
            tagNames: [],
            team: [],
            sensitivity: "internal",
            verifyNow: false,
          }),
        ),
      ) as { id: string }
    },
  )
}

async function pointerCollectionIds(): Promise<string[]> {
  const rows = await sql`SELECT collection_id FROM kernel.agent_knowledge_pointers
    WHERE org_id = ${session.orgId} AND agent_id = ${agentId}`
  return rows.map((r) => (r as { collection_id: string }).collection_id)
}

beforeAll(async () => {
  await acquireTestLock()
  resetEventBus()
  initEventBus()

  session = await minimal.adminSession((await createTestOrg()).id)
  agentId = await withPrivilegedDb(session.orgId, "seed-pointer-agent", async (tx) => {
    const [row] = await tx
      .insert(agents)
      .values({
        orgId: session.orgId,
        kind: "personal",
        handle: `@pointer-${crypto.randomUUID().slice(0, 8)}`,
        displayName: "Liaison",
        ownerUserId: session.userId,
        scopeCeiling: ["kernel:threads:read"],
      })
      .returning({ id: agents.id })
    return row!.id
  })
  const [collection] = await sql`INSERT INTO app_knowledge.collections (org_id, name)
    VALUES (${session.orgId}, 'Agent Pointer Docs') RETURNING id`
  collectionId = collection.id

  // The knowledge app declares its emits when it is installed; this suite calls
  // the bridge method directly, so admit the events it queues.
  for (const key of ["knowledge", `${session.orgId}:knowledge`, "*:knowledge"]) {
    declaredEmits.get(key)?.add("document:create")
    declaredEmits.get(key)?.add("document:update")
  }
})

afterAll(async () => {
  await sql`DELETE FROM kernel.agent_knowledge_pointers WHERE org_id = ${session.orgId}`
  await sql`DELETE FROM app_knowledge.collection_memberships WHERE org_id = ${session.orgId}`
  await sql`DELETE FROM app_knowledge.documents WHERE org_id = ${session.orgId}`
  await sql`DELETE FROM app_knowledge.collections WHERE id = ${collectionId}`
  resetEventBus()
  await releaseTestLock()
})

describe("an agent's knowledge write records its knowledge pointer", () => {
  it("a knowledge_create inside an agent turn writes the pointer row", async () => {
    await createDocumentThroughBridge("Written by the agent", agentId)
    expect(await pointerCollectionIds()).toContain(collectionId)
  })

  it("the agent's knowledge listing returns the collection with its name", async () => {
    await createDocumentThroughBridge("Also written by the agent", agentId)
    const res = await app.request(`/api/agents/${agentId}/knowledge`, {
      headers: { Authorization: `Bearer ${session.bearer}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: Array<{ collectionId: string; collectionName: string | null }>
    }
    const listed = body.data.find((p) => p.collectionId === collectionId)
    expect(listed).toBeDefined()
    expect(listed?.collectionName).toBe("Agent Pointer Docs")
    // One pointer per collection, however many documents the agent writes.
    expect(body.data.filter((p) => p.collectionId === collectionId)).toHaveLength(1)
  })

  it("the same create with no agent behind it records no pointer", async () => {
    await sql`DELETE FROM kernel.agent_knowledge_pointers WHERE org_id = ${session.orgId}`
    await createDocumentThroughBridge("Written by a human", null)
    expect(await pointerCollectionIds()).toEqual([])
  })
})
