// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S59: the desktop's local turn re-reads the person's message from the server
// before running it; that read is where the server mints the turn's credential.
// Every case goes through the real routes: the message read (mint), the claim
// (takeover revokes) and the local reply (the turn's end revokes).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { redis } from "~/lib/redis"
import {
  lookupTurnCredential,
  TURN_CREDENTIAL_PATTERN,
  TURN_CREDENTIAL_TTL_MS,
  turnCredentialClock,
} from "~/modules/agent/local-sessions/turn-credential"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { lapseSweepSeam, sweepLapsedLocalClaims } from "./local-claim-lapse"

const HOLDER = "holder-turn-cred-one"
const OTHER_HOLDER = "holder-turn-cred-two"

describe("the turn credential of a desktop local turn (S59)", () => {
  let owner: minimal.Session
  let colleague: minimal.Session
  let agentId: string
  let threadId: string

  const request = (path: string, method: string, body?: unknown, bearer?: string) =>
    app.request(path, {
      method,
      headers: {
        Authorization: `Bearer ${bearer ?? owner.bearer}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  const claim = (holderKey: string, extra: Record<string, unknown> = {}) =>
    request(`/api/agents/${agentId}/local-claims`, "POST", { threadId, holderKey, ...extra })

  /** A message in the conversation; `secondsAgo` orders it against the others. */
  async function message(
    authorType: "user" | "agent",
    secondsAgo: number,
    extra: { authorId?: string; parentMessageId?: string } = {},
  ): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO kernel.messages
        (thread_id, org_id, author_id, author_type, author_agent_id, content, required_scopes,
         parent_message_id, created_at)
      VALUES (${threadId}, ${owner.orgId}, ${extra.authorId ?? owner.userId}, ${authorType},
              ${authorType === "agent" ? agentId : null}, 'stop the flaky-test session', '{}',
              ${extra.parentMessageId ?? null}, now() - make_interval(secs => ${secondsAgo}))
      RETURNING id`
    return row.id
  }

  /** The desktop's re-read of a message: the credential, when one was minted. */
  async function read(
    messageId: string,
    holderKey?: string,
    bearer?: string,
  ): Promise<{ status: number; data: Record<string, unknown> | undefined }> {
    const query = holderKey ? `?holderKey=${encodeURIComponent(holderKey)}` : ""
    const res = await request(
      `/api/agents/${agentId}/local-claims/${threadId}/messages/${messageId}${query}`,
      "GET",
      undefined,
      bearer,
    )
    const body = (await res.json()) as { data?: Record<string, unknown> }
    return { status: res.status, data: body.data }
  }

  beforeAll(async () => {
    await acquireTestLock()
    const org = await createTestOrg()
    owner = await minimal.session(org.id, { role: "admin" })
    colleague = await minimal.session(org.id, { role: "member" })
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO kernel.agents (org_id, kind, handle, display_name, scope_ceiling, owner_user_id)
      VALUES (${owner.orgId}, 'personal', ${`@tc-${crypto.randomUUID().slice(0, 8)}`}, 'Turn Cred',
              '["*"]'::jsonb, ${owner.userId})
      RETURNING id`
    agentId = agent.id
    threadId = await minimal.thread(owner.orgId, owner.userId)
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
              VALUES (${threadId}, ${colleague.userId}, ${owner.orgId}, 'member')`
  })

  afterEach(async () => {
    turnCredentialClock.now = () => Date.now()
    lapseSweepSeam.afterScan = null
    await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.messages WHERE thread_id = ${threadId}`
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.audit_log WHERE org_id = ${owner.orgId}`
    await sql`DELETE FROM kernel.agents WHERE id = ${agentId}`
    await releaseTestLock()
  })

  it("S59: the message read with the holder of the live claim returns a turnCredential; without holderKey, another holder, or an agent-authored message, it returns none", async () => {
    expect((await claim(HOLDER)).status).toBe(200)
    const mine = await message("user", 5)
    const minted = await read(mine, HOLDER)
    expect(minted.status).toBe(200)
    expect(minted.data?.id).toBe(mine)
    expect(minted.data?.text).toBe("stop the flaky-test session")
    expect(String(minted.data?.turnCredential)).toMatch(TURN_CREDENTIAL_PATTERN)
    const record = await lookupTurnCredential(minted.data?.turnCredential as string)
    expect(record).toMatchObject({
      orgId: owner.orgId,
      userId: owner.userId,
      agentId,
      threadId,
      messageId: mine,
      holderKey: HOLDER,
      restricted: false,
    })

    // Today's answer, unchanged, for every other read.
    const noHolder = await read(mine)
    expect(noHolder.status).toBe(200)
    expect(noHolder.data?.id).toBe(mine)
    expect(noHolder.data).not.toHaveProperty("turnCredential")
    expect((await read(mine, OTHER_HOLDER)).data).not.toHaveProperty("turnCredential")
    // A colleague in the room never mints on the owner's claim, nor for the owner's message.
    expect((await read(mine, HOLDER, colleague.bearer)).data ?? {}).not.toHaveProperty(
      "turnCredential",
    )
    const theirs = await message("user", 1, { authorId: colleague.userId })
    expect((await read(theirs, HOLDER)).data).not.toHaveProperty("turnCredential")
    await sql`DELETE FROM kernel.messages WHERE id = ${theirs}`
    const agentWrote = await message("agent", 0)
    expect((await read(agentWrote, HOLDER)).data).not.toHaveProperty("turnCredential")

    // No live claim, no credential.
    await sql`DELETE FROM kernel.agent_local_claims WHERE thread_id = ${threadId}`
    await sql`DELETE FROM kernel.messages WHERE id = ${agentWrote}`
    expect((await read(mine, HOLDER)).data).not.toHaveProperty("turnCredential")
  })

  it("S59: the credential is stored only as its hash", async () => {
    await claim(HOLDER)
    const raw = (await read(await message("user", 1), HOLDER)).data?.turnCredential as string
    expect(raw).toMatch(TURN_CREDENTIAL_PATTERN)
    const keys = await redis.keys("*turncred*")
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(key).not.toContain(raw)
      const type = await redis.type(key.replace(/^.*?turncred/, "turncred"))
      const value =
        type === "string"
          ? await redis.get(key.replace(/^.*?turncred/, "turncred"))
          : (await redis.smembers(key.replace(/^.*?turncred/, "turncred"))).join(",")
      expect(String(value)).not.toContain(raw)
    }
  })

  it("S59: a mint for a message the agent already answered returns none", async () => {
    await claim(HOLDER)
    // Answered by an agent message pointing at it.
    const first = await message("user", 30)
    await message("agent", 29, { parentMessageId: first })
    expect((await read(first, HOLDER)).data).not.toHaveProperty("turnCredential")
    // Answered by the local reply that followed it (no parent link).
    const second = await message("user", 20)
    await message("agent", 19)
    expect((await read(second, HOLDER)).data).not.toHaveProperty("turnCredential")
    // Older than the conversation's current turn: a later message of the person.
    const third = await message("user", 10)
    const current = await message("user", 5)
    expect((await read(third, HOLDER)).data).not.toHaveProperty("turnCredential")
    expect(String((await read(current, HOLDER)).data?.turnCredential)).toMatch(
      TURN_CREDENTIAL_PATTERN,
    )
  })

  it("S59: a re-mint for the same message and holder revokes the first credential", async () => {
    await claim(HOLDER)
    const id = await message("user", 1)
    const first = (await read(id, HOLDER)).data?.turnCredential as string
    const second = (await read(id, HOLDER)).data?.turnCredential as string
    expect(first).toMatch(TURN_CREDENTIAL_PATTERN)
    expect(second).toMatch(TURN_CREDENTIAL_PATTERN)
    expect(second).not.toBe(first)
    expect(await lookupTurnCredential(first)).toBeNull()
    expect((await lookupTurnCredential(second))?.messageId).toBe(id)
  })

  it("S59: a credential older than 30 min is refused", async () => {
    await claim(HOLDER)
    const raw = (await read(await message("user", 1), HOLDER)).data?.turnCredential as string
    const mintedAt = Date.now()
    turnCredentialClock.now = () => mintedAt + TURN_CREDENTIAL_TTL_MS - 60_000
    expect(await lookupTurnCredential(raw)).not.toBeNull()
    turnCredentialClock.now = () => mintedAt + TURN_CREDENTIAL_TTL_MS + 60_000
    expect(await lookupTurnCredential(raw)).toBeNull()
  })

  it("S59: a claim takeover revokes the old holder's credential", async () => {
    await claim(HOLDER)
    const raw = (await read(await message("user", 1), HOLDER)).data?.turnCredential as string
    expect(await lookupTurnCredential(raw)).not.toBeNull()
    // The holder's own heartbeat keeps it.
    expect((await claim(HOLDER)).status).toBe(200)
    expect(await lookupTurnCredential(raw)).not.toBeNull()
    // Another window takes the conversation over.
    expect((await claim(OTHER_HOLDER, { takeOver: true })).status).toBe(200)
    expect(await lookupTurnCredential(raw)).toBeNull()
  })

  it("S59 (D43 F6): releasing the claim revokes the holder's credential", async () => {
    await claim(HOLDER)
    const raw = (await read(await message("user", 1), HOLDER)).data?.turnCredential as string
    expect(await lookupTurnCredential(raw)).not.toBeNull()
    const released = await request(
      `/api/agents/${agentId}/local-claims/${threadId}?holderKey=${HOLDER}`,
      "DELETE",
    )
    expect(released.status).toBe(204)
    expect(await lookupTurnCredential(raw)).toBeNull()
  })

  it("S59 (D43 F6): a lapsed claim, once swept, revokes the holder's credential", async () => {
    await claim(HOLDER)
    const raw = (await read(await message("user", 1), HOLDER)).data?.turnCredential as string
    expect(await lookupTurnCredential(raw)).not.toBeNull()
    await sql`UPDATE kernel.agent_local_claims SET expires_at = now() - interval '5 seconds'
              WHERE thread_id = ${threadId}`
    expect((await sweepLapsedLocalClaims()).swept).toBe(1)
    expect(await lookupTurnCredential(raw)).toBeNull()
  })

  it("S59 (batch-2 F9): a claim renewed after the sweep read it as lapsed is neither removed nor revoked", async () => {
    await claim(HOLDER)
    const raw = (await read(await message("user", 1), HOLDER)).data?.turnCredential as string
    expect(await lookupTurnCredential(raw)).not.toBeNull()
    await sql`UPDATE kernel.agent_local_claims SET expires_at = now() - interval '5 seconds'
              WHERE thread_id = ${threadId}`
    // The holder's heartbeat lands between the sweep's scan and its delete.
    lapseSweepSeam.afterScan = async () => {
      expect((await claim(HOLDER)).status).toBe(200)
    }
    expect(await sweepLapsedLocalClaims()).toEqual({ swept: 0, dispatched: 0 })
    const rows = await sql<{ holder_key: string; live: boolean }[]>`
      SELECT holder_key, expires_at > now() AS live FROM kernel.agent_local_claims
       WHERE thread_id = ${threadId}`
    expect([...rows]).toEqual([{ holder_key: HOLDER, live: true }])
    expect(await lookupTurnCredential(raw)).not.toBeNull()
  })

  it("S59: the reply revokes it", async () => {
    await claim(HOLDER)
    const started = await request(`/api/agents/${agentId}/local-sessions`, "POST", {
      permissionMode: "manual",
      folderHash: "a".repeat(64),
      model: "claude-haiku-5-5",
    })
    expect(started.status).toBe(201)
    const sessionId = ((await started.json()) as { data: { sessionId: string } }).data.sessionId
    const raw = (await read(await message("user", 1), HOLDER)).data?.turnCredential as string
    expect(await lookupTurnCredential(raw)).not.toBeNull()
    const replied = await request(
      `/api/agents/${agentId}/local-sessions/${sessionId}/reply`,
      "POST",
      { threadId, text: "Stopped it.", holderKey: HOLDER },
    )
    expect(replied.status).toBe(201)
    expect(await lookupTurnCredential(raw)).toBeNull()
  })
})
