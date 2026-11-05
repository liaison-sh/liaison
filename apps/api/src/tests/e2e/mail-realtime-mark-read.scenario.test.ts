// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real-time mark-read through the real pipeline: GET of an unread conversation
// flips it read and queues mail:conversation:update -> outbox -> durable
// ws-fanout -> a real WebSocket client on a real spawned server.
//
// The server runs under a worker schema prefix, the same shape the Playwright
// server uses. The fan-out resolves the conversation's owner before deciding
// who may see the frame; when that lookup read a fixed `app_mail` schema it
// missed the row, the owner check fell back to the `mail:inbox` grant, and the
// mailbox owner never received the frame, so the inbox list kept its unread dot
// until the next page load.
//
// Covered: a personal mailbox under paused encryption (content is stripped at
// emit, the frame itself must still arrive), a personal mailbox in its default
// state, and a second user who must NOT receive the owner's frame.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import type { TestWorld } from "@liaison/test-helpers"
import { api, connectWs, type WorkerEnv } from "@liaison/test-helpers"
import { seedConversation } from "./helpers/mail-seed"
import { setupScenario, teardownScenario } from "./setup"

const FRAME_TIMEOUT_MS = 15_000

let env: WorkerEnv
let world: TestWorld
let url: string

function ks(e: WorkerEnv): string {
  return e.schemaPrefix ? `"${e.schemaPrefix}kernel"` : "kernel"
}

function ms(e: WorkerEnv): string {
  return e.schemaPrefix ? `"${e.schemaPrefix}app_mail"` : "app_mail"
}

async function seedPersonalAccount(
  orgId: string,
  userId: string,
  opts: { paused: boolean },
): Promise<string> {
  const connectedAccountId = randomUUID()
  const accountId = randomUUID()
  const email = `rt-${accountId.slice(0, 8)}@mail-realtime.e2e.test`
  await env.db.sql.unsafe(
    `INSERT INTO ${ks(env)}.connected_accounts
      (id, org_id, app_name, connection_name, owner_type, owner_id, provider_type, identifier, display_name, status, created_by)
     VALUES ($1, $2, 'mail', 'gmail', 'user', $3, 'oauth2', $4, $4, 'active', $3)`,
    [connectedAccountId, orgId, userId, email],
  )
  await env.db.sql.unsafe(
    `INSERT INTO ${ms(env)}.accounts
      (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, display_name, sync_status)
     VALUES ($1, $2, $3, 'user', $4, 'gmail', $5, $5, 'active')`,
    [accountId, orgId, connectedAccountId, userId, email],
  )
  if (opts.paused) {
    await env.db.sql.unsafe(
      `UPDATE ${ms(env)}.accounts SET encryption_state = 'paused' WHERE id = $1`,
      [accountId],
    )
  }
  return accountId
}

function isMarkReadFrame(conversationId: string) {
  return (m: any) =>
    m.payload?.app === "mail" &&
    m.payload?.entity === "conversation" &&
    m.payload?.action === "update" &&
    m.payload?.data?.id === conversationId &&
    m.payload?.data?.isRead === true
}

async function markReadAndExpectFrame(accountId: string, subject: string): Promise<any> {
  const { id: conversationId } = await seedConversation(env, {
    orgId: world.org.id,
    accountId,
    ownerType: "user",
    ownerId: world.admin.id,
    subject,
    isRead: false,
  })

  const ws = await connectWs(url, world.admin.token)
  try {
    const res = await api(url, `/api/mail/conversations/${conversationId}`, {
      token: world.admin.token,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.conversation.isRead).toBe(true)

    return await ws.waitFor("event", isMarkReadFrame(conversationId), FRAME_TIMEOUT_MS)
  } finally {
    ws.close()
  }
}

describe("Mail realtime mark-read", () => {
  beforeAll(async () => {
    const scenario = await setupScenario({ org: { name: "Mail Realtime Mark Read" } })
    env = scenario.env
    world = scenario.world
    url = env.serverUrl
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  it("paused-encryption personal mailbox: owner socket receives mail conversation update on mark-read", async () => {
    const accountId = await seedPersonalAccount(world.org.id, world.admin.id, { paused: true })
    const frame = await markReadAndExpectFrame(accountId, "Realtime paused mailbox")
    expect(frame.payload.data.accountId).toBe(accountId)
    // Content never rides a frame for an encrypted personal mailbox.
    expect(frame.payload.data.subject).toBeUndefined()
  }, 60_000)

  it("default personal mailbox: owner socket receives mail conversation update on mark-read", async () => {
    const accountId = await seedPersonalAccount(world.org.id, world.admin.id, { paused: false })
    const frame = await markReadAndExpectFrame(accountId, "Realtime default mailbox")
    expect(frame.payload.data.accountId).toBe(accountId)
  }, 60_000)

  it("another user without an inbox grant never receives the owner's mark-read frame", async () => {
    const [other] = await world.addUsers([{ name: "RT-Other" }])
    const accountId = await seedPersonalAccount(world.org.id, world.admin.id, { paused: false })
    const { id: conversationId } = await seedConversation(env, {
      orgId: world.org.id,
      accountId,
      ownerType: "user",
      ownerId: world.admin.id,
      subject: "Realtime not yours",
      isRead: false,
    })

    const ownerWs = await connectWs(url, world.admin.token)
    const otherWs = await connectWs(url, other.token)
    try {
      const res = await api(url, `/api/mail/conversations/${conversationId}`, {
        token: world.admin.token,
      })
      expect(res.status).toBe(200)

      // The owner's frame is the completion signal: once it has been fanned
      // out, the other socket has had the same broadcast pass over it.
      await ownerWs.waitFor("event", isMarkReadFrame(conversationId), FRAME_TIMEOUT_MS)
      expect(otherWs.messages.filter(isMarkReadFrame(conversationId))).toEqual([])
    } finally {
      ownerWs.close()
      otherWs.close()
    }
  }, 60_000)
})
