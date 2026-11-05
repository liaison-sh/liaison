// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET /api/agent/stream-state/:threadId is a REPLAY of in-flight stream
// content, so it must be gated exactly like the live chunks it replays.
// T23 filters live message events per connection and T24 gates each
// `agent_stream` chunk on the scopes the turn had accumulated when that chunk
// was emitted. This route bypassed both and served the accumulated snapshot to
// any member who could read the thread, so a room member lacking the scope
// could fetch over HTTP precisely the content the socket had withheld.
//
// The rule here is T24's rule, not a third one: the reader sees the snapshot
// only when their own grants cover the scopes the turn accumulated for that
// content (`isMessageVisible`), the requester of the turn is exempt, and an
// undeterminable set serves nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { env } from "~/lib/env"
import { redis } from "~/lib/redis"
import * as registryModule from "~/modules/agent/runtime/stream-registry"
import {
  AgentStreamRegistryTestAccess,
  LiveTurnRegistry,
  LiveTurnTimeout,
  type RecordedFrame,
  recordAgentStreamEvent,
} from "~/modules/agent/runtime/stream-registry"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-0000000ac001"
// The user whose request started the turn.
const REQUESTER_ID = "00000000-0000-4000-8000-0000000ac002"
// A room member who HOLDS the scope the turn accumulated.
const HOLDER_ID = "00000000-0000-4000-8000-0000000ac003"
// A room member who does NOT hold it. The leak this file pins.
const OUTSIDER_ID = "00000000-0000-4000-8000-0000000ac004"
const THREAD_ID = "00000000-0000-4000-8000-0000000ac005"

// The scope the in-flight turn has accumulated by reading scoped data.
const TURN_SCOPE = "crm:contacts:read"
const REASONING = "checking the contact record"
const CONTENT = "Ada Lovelace is the primary contact"
const TOOL_NAME = "kernel__contacts_read"

async function seedUser(id: string, email: string): Promise<void> {
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${id}, ${ORG_ID}, ${email}, ${email})`
  await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${id}, ${ORG_ID})`
}

function token(userId: string, scopes: string[]): Promise<string> {
  return signAccessToken(
    {
      userId,
      orgId: ORG_ID,
      name: "Stream State User",
      authVersion: 1,
      permissionVersion: 1,
      scopes,
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
}

type RecordFn = typeof recordAgentStreamEvent

/** Drive the registry the way a real in-flight turn does: a start, some
 *  reasoning, a tool call and a text delta, each carrying the scopes the turn
 *  had accumulated at that moment. Resolves with the frames the records
 *  allocated, in order. `record` is another process's registry when given. */
async function driveTurn(
  accumulatedScopes: string[] | undefined,
  record: RecordFn = recordAgentStreamEvent,
): Promise<RecordedFrame[]> {
  const meta = {
    requesterId: REQUESTER_ID,
    ...(accumulatedScopes ? { accumulatedScopes } : {}),
  }
  return [
    await record(THREAD_ID, ORG_ID, "start", {}, meta),
    await record(THREAD_ID, ORG_ID, "reasoning", { delta: REASONING }, meta),
    await record(
      THREAD_ID,
      ORG_ID,
      "tool_call",
      { toolCallId: "tc-1", toolName: TOOL_NAME, args: { id: "c-1" } },
      meta,
    ),
    await record(THREAD_ID, ORG_ID, "delta", { delta: CONTENT }, meta),
  ]
}

async function replayFor(bearer: string): Promise<{ status: number; data: any }> {
  const res = await app.request(`/api/agent/stream-state/${THREAD_ID}`, {
    headers: { Authorization: `Bearer ${bearer}` },
  })
  const body = (await res.json()) as { data: any }
  return { status: res.status, data: body.data }
}

/** Nothing about the withheld turn may reach the reader: not the text, not the
 *  reasoning, not the tool name, and not the fact that a run is in flight. */
function expectNothingServed(payload: any): void {
  expect(payload.active).toBe(false)
  const serialized = JSON.stringify(payload)
  expect(serialized).not.toContain(CONTENT)
  expect(serialized).not.toContain(REASONING)
  expect(serialized).not.toContain(TOOL_NAME)
}

describe("agent stream-state replay honours the turn's accumulated scopes", () => {
  let requesterToken: string
  let holderToken: string
  let outsiderToken: string

  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'StreamOrg', 'stream-org')`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by) VALUES (${THREAD_ID}, ${ORG_ID}, 'stream-state-vis', 'agent_chat', ${REQUESTER_ID})`
    // The thread row references its creator, so the requester lands first.
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${REQUESTER_ID}, ${ORG_ID}, 'requester@test.com', 'Requester')`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id) VALUES (${THREAD_ID}, ${REQUESTER_ID}, ${ORG_ID})`
    await seedUser(HOLDER_ID, "holder@test.com")
    await seedUser(OUTSIDER_ID, "outsider@test.com")

    // All three can read the thread (the route's own requireScope gate); only
    // the holder additionally covers the scope the turn accumulated. The
    // requester deliberately does NOT hold it, so the exemption is what is
    // being measured rather than their grants.
    requesterToken = await token(REQUESTER_ID, ["kernel:threads:read"])
    holderToken = await token(HOLDER_ID, ["kernel:threads:read", TURN_SCOPE])
    outsiderToken = await token(OUTSIDER_ID, ["kernel:threads:read"])
  })

  afterAll(async () => {
    await AgentStreamRegistryTestAccess.reset()
    await releaseTestLock()
  })

  beforeEach(() => AgentStreamRegistryTestAccess.reset())

  it("serves a run recorded by another process, with seq", async () => {
    const instanceId = `other-${crypto.randomUUID()}`
    await redis.set(LIVE_INSTANCE_KEY(instanceId), "{}", "PX", 30_000)
    const other = new LiveTurnRegistry({ instanceId })
    const frames = await driveTurn([TURN_SCOPE], (...args) => other.record(...args))
    const { status, data } = await replayFor(holderToken)
    expect(status).toBe(200)
    expect(data.active).toBe(true)
    expect(data.content).toBe(CONTENT)
    expect(data.seq).toBe(frames.at(-1)?.seq)
    expect(data.streams[0].seq).toBe(frames.at(-1)?.seq)
  })

  it("timeline entries carry itemId and the run's seq equals the last frame's", async () => {
    const frames = await driveTurn([TURN_SCOPE])
    expect(frames.map((f) => f.seq)).toEqual([1, 2, 3, 4])
    const { data } = await replayFor(holderToken)
    expect(data.seq).toBe(4)
    // The ids the frames carried, entry by entry (start carries none).
    expect(data.timeline.map((e: { itemId: string }) => e.itemId)).toEqual(
      frames.slice(1).map((f) => f.itemId),
    )
    expect(frames.slice(1).map((f) => f.itemId)).toEqual(["r0", "tc-1", "t2"])
  })

  it("a registry read Redis does not answer serves no run", async () => {
    await driveTurn([TURN_SCOPE])
    const spy = spyOn(registryModule, "listLiveAgentStreams").mockImplementation(() =>
      Promise.reject(new LiveTurnTimeout("list live turns", 1_000)),
    )
    try {
      const { status, data } = await replayFor(holderToken)
      expect(status).toBe(200)
      expectNothingServed(data)
    } finally {
      spy.mockRestore()
    }
  })

  it("serves the in-flight content to a member whose grants cover the accumulated scopes", async () => {
    await driveTurn([TURN_SCOPE])
    const { status, data } = await replayFor(holderToken)
    expect(status).toBe(200)
    expect(data.active).toBe(true)
    expect(data.content).toBe(CONTENT)
    expect(data.reasoning).toBe(REASONING)
    expect(data.toolCalls[0].toolName).toBe(TOOL_NAME)
  })

  it("serves nothing to a thread member who lacks the accumulated scopes", async () => {
    await driveTurn([TURN_SCOPE])
    const { status, data } = await replayFor(outsiderToken)
    expect(status).toBe(200)
    expectNothingServed(data)
  })

  it("serves the requester their own turn even without the accumulated scopes", async () => {
    await driveTurn([TURN_SCOPE])
    const { status, data } = await replayFor(requesterToken)
    expect(status).toBe(200)
    expect(data.active).toBe(true)
    expect(data.content).toBe(CONTENT)
  })

  it("serves nothing when the accumulated scopes cannot be determined, requester aside", async () => {
    // No emitter tag at all. `[]` would assert the turn read nothing scoped,
    // which is exactly the claim that cannot be made here, so the replay fails
    // closed for everyone but the requester.
    await driveTurn(undefined)
    expectNothingServed((await replayFor(holderToken)).data)
    expectNothingServed((await replayFor(outsiderToken)).data)
    expect((await replayFor(requesterToken)).data.active).toBe(true)
  })

  it("covers an accumulated scope through a wildcard grant, as the chunk gate does", async () => {
    await driveTurn([TURN_SCOPE])
    const wildcard = await token(OUTSIDER_ID, ["kernel:threads:read", "crm:*"])
    const { data } = await replayFor(wildcard)
    expect(data.active).toBe(true)
    expect(data.content).toBe(CONTENT)
  })

  it("keeps serving an untainted turn to every member", async () => {
    // An empty accumulated set is a positive assertion that the turn has read
    // nothing scoped, so the ordinary case is unaffected by the gate.
    await driveTurn([])
    expect((await replayFor(outsiderToken)).data.active).toBe(true)
    expect((await replayFor(holderToken)).data.content).toBe(CONTENT)
  })
})
