// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, connectWs } from "@liaison/test-helpers"
import { setupScenario, teardownScenario } from "./setup"

const WS_TEST_TIMEOUT = 30_000

describe("Threads Scenario", () => {
  let env: WorkerEnv
  let world: TestWorld
  let url: string

  // Shared state across sequential tests
  let adminUserId: string

  beforeAll(async () => {
    const result = await setupScenario({
      seed: 42,
      org: { name: "Threads Test Org" },
      populate: {
        users: { count: 12 },
        threads: { count: 25, participants: "random(2-5)", messages: "random(2-8)" },
      },
    })
    env = result.env
    world = result.world
    url = env.serverUrl
    adminUserId = world.admin.id
  }, 120_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 15_000)

  // ═══════════════════════════════════════════════════════════
  //  SMOKE TEST
  // ═══════════════════════════════════════════════════════════

  it("smoke — creates users and a thread round-trip", async () => {
    const [userA] = await world.addUsers([{ name: "Smoke-A" }])
    const [userB] = await world.addUsers([{ name: "Smoke-B" }])

    const res = await api(url, "/api/threads", {
      token: userA.token,
      body: {
        forceCreate: true,
        participantIds: [userB.id],
        initialMessage: { content: "hello" },
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBeDefined()
    expect(res.body.data.handle).toMatch(/^thread-\d+$/)
    expect(res.body.data.deduplicated).toBe(false)

    // User B should see thread with unread
    const list = await api(url, "/api/threads", { token: userB.token })
    expect(list.status).toBe(200)
    expect(list.body.data.length).toBeGreaterThanOrEqual(1)
    const found = list.body.data.find((t: any) => t.id === res.body.data.id)
    expect(found.unreadCount).toBe(1)
  })

  // ═══════════════════════════════════════════════════════════
  //  B01: Thread Creation and Listing
  // ═══════════════════════════════════════════════════════════

  let b01UserA: { id: string; token: string }
  let b01UserB: { id: string; token: string }
  let b01ThreadId: string

  it("B01 — creates a thread with title, participants, and initial message", async () => {
    const [uA] = await world.addUsers([{ name: "B01-A" }])
    const [uB] = await world.addUsers([{ name: "B01-B" }])
    b01UserA = uA
    b01UserB = uB

    const res = await api(url, "/api/threads", {
      token: b01UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b01UserB.id],
        title: "Project Update",
        initialMessage: { content: "Hello team" },
      },
    })
    expect(res.status).toBe(200)
    const data = res.body.data
    expect(data.id).toBeDefined()
    expect(data.handle).toMatch(/^project-update(-\d+)?$/)
    expect(data.title).toBe("Project Update")
    expect(data.participants.length).toBe(2)
    expect(data.initialMessageId).toBeDefined()
    expect(data.deduplicated).toBe(false)
    b01ThreadId = data.id
  })

  it("B01 — User A lists threads — thread appears, unreadCount is number", async () => {
    const res = await api(url, "/api/threads", { token: b01UserA.token })
    expect(res.status).toBe(200)
    const t = res.body.data.find((t: any) => t.id === b01ThreadId)
    expect(t).toBeDefined()
    expect(t.lastMessage.content).toBe("Hello team")
    expect(typeof t.unreadCount).toBe("number")
  })

  it("B01 — User B lists threads — thread appears with unread", async () => {
    const res = await api(url, "/api/threads", { token: b01UserB.token })
    expect(res.status).toBe(200)
    const t = res.body.data.find((t: any) => t.id === b01ThreadId)
    expect(t).toBeDefined()
    expect(t.unreadCount).toBeGreaterThanOrEqual(1)
  })

  it("B01 — verifies DB state directly", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    const threads = await env.db.sql.unsafe(`SELECT * FROM ${ks}.threads WHERE id = $1`, [
      b01ThreadId,
    ])
    expect(threads.length).toBe(1)

    const parts = await env.db.sql.unsafe(
      `SELECT * FROM ${ks}.thread_participants WHERE thread_id = $1`,
      [b01ThreadId],
    )
    expect(parts.length).toBe(2)

    const msgs = await env.db.sql.unsafe(`SELECT * FROM ${ks}.messages WHERE thread_id = $1`, [
      b01ThreadId,
    ])
    expect(msgs.length).toBe(1)

    const states = await env.db.sql.unsafe(
      `SELECT * FROM ${ks}.user_thread_state WHERE thread_id = $1`,
      [b01ThreadId],
    )
    expect(states.length).toBe(2)
  })

  // ═══════════════════════════════════════════════════════════
  //  B02: DM Deduplication
  // ═══════════════════════════════════════════════════════════

  let b02UserA: { id: string; token: string }
  let b02UserB: { id: string; token: string }
  let b02FirstDmId: string

  it("B02 — first DM: creates new thread", async () => {
    const [uA] = await world.addUsers([{ name: "B02-A" }])
    const [uB] = await world.addUsers([{ name: "B02-B" }])
    b02UserA = uA
    b02UserB = uB

    const res = await api(url, "/api/threads", {
      token: b02UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b02UserB.id],
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.deduplicated).toBe(false)
    b02FirstDmId = res.body.data.id
  })

  it("B02 — second DM same direction: returns same thread, deduplicated=true", async () => {
    const res = await api(url, "/api/threads", {
      token: b02UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b02UserB.id],
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(b02FirstDmId)
    expect(res.body.data.deduplicated).toBe(true)
  })

  it("B02 — reversed direction: returns same thread", async () => {
    const res = await api(url, "/api/threads", {
      token: b02UserB.token,
      body: {
        forceCreate: true,
        participantIds: [b02UserA.id],
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(b02FirstDmId)
    expect(res.body.data.deduplicated).toBe(true)
  })

  it("B02 — User A sees exactly 1 untitled DM", async () => {
    const res = await api(url, "/api/threads", { token: b02UserA.token })
    expect(res.status).toBe(200)
    const threads = res.body.data.filter((t: any) =>
      t.participants.some((p: any) => p.id === b02UserB.id),
    )
    const untitled = threads.filter((t: any) => !t.title)
    expect(untitled.length).toBe(1)
  })

  it("B02 — DM with title: creates new thread (bypasses dedup)", async () => {
    const res = await api(url, "/api/threads", {
      token: b02UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b02UserB.id],
        title: "Named DM",
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.id).not.toBe(b02FirstDmId)
    expect(res.body.data.deduplicated).toBe(false)
  })

  it("B02 — DM with createdFrom: creates new thread (bypasses dedup)", async () => {
    const res = await api(url, "/api/threads", {
      token: b02UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b02UserB.id],
        // An entity A may see (their own DM): a createdFrom must be visible to its creator.
        createdFrom: { app: "kernel", entityType: "thread", entityId: b02FirstDmId },
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.id).not.toBe(b02FirstDmId)
    expect(res.body.data.deduplicated).toBe(false)
  })

  // ═══════════════════════════════════════════════════════════
  //  B03: Message CRUD and Pagination
  // ═══════════════════════════════════════════════════════════

  let b03UserA: { id: string; token: string }
  let b03UserB: { id: string; token: string }
  let b03ThreadId: string
  const b03MessageIds: string[] = []

  it("B03 — sends 8 messages (5 from A, 3 from B)", async () => {
    const [uA] = await world.addUsers([{ name: "B03-A" }])
    const [uB] = await world.addUsers([{ name: "B03-B" }])
    b03UserA = uA
    b03UserB = uB

    const t = await world.threads.create(b03UserA, {
      participantIds: [b03UserB.id],
      title: "B03 Thread",
    })
    b03ThreadId = t.id

    for (let i = 1; i <= 5; i++) {
      const res = await api(url, `/api/threads/${b03ThreadId}/messages`, {
        token: b03UserA.token,
        body: { content: `A-msg-${i}` },
      })
      expect(res.status).toBe(200)
      b03MessageIds.push(res.body.data.id)
    }
    for (let i = 1; i <= 3; i++) {
      const res = await api(url, `/api/threads/${b03ThreadId}/messages`, {
        token: b03UserB.token,
        body: { content: `B-msg-${i}` },
      })
      expect(res.status).toBe(200)
      b03MessageIds.push(res.body.data.id)
    }
    expect(b03MessageIds.length).toBe(8)
  })

  it("B03 — paginates messages with limit=3", async () => {
    const p1 = await api(url, `/api/threads/${b03ThreadId}/messages?limit=3`, {
      token: b03UserA.token,
    })
    expect(p1.status).toBe(200)
    expect(p1.body.data.length).toBe(3)
    expect(p1.body.meta.hasMore).toBe(true)
    expect(p1.body.meta.cursor).toBeDefined()

    const p2 = await api(
      url,
      `/api/threads/${b03ThreadId}/messages?limit=3&before=${p1.body.meta.cursor}`,
      { token: b03UserA.token },
    )
    expect(p2.status).toBe(200)
    expect(p2.body.data.length).toBe(3)

    const p3 = await api(
      url,
      `/api/threads/${b03ThreadId}/messages?limit=3&before=${p2.body.meta.cursor}`,
      { token: b03UserA.token },
    )
    expect(p3.status).toBe(200)
    expect(p3.body.data.length).toBe(2)
    expect(p3.body.meta.hasMore).toBe(false)
  })

  it("B03 — User A edits own message", async () => {
    const res = await api(url, `/api/threads/${b03ThreadId}/messages/${b03MessageIds[0]}`, {
      method: "PATCH",
      token: b03UserA.token,
      body: { content: "A-msg-1-edited" },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.editedAt).toBeDefined()
    expect(res.body.data.content).toBe("A-msg-1-edited")
  })

  it("B03 — User B cannot edit User A's message (403 or 404)", async () => {
    const res = await api(url, `/api/threads/${b03ThreadId}/messages/${b03MessageIds[0]}`, {
      method: "PATCH",
      token: b03UserB.token,
      body: { content: "hacked" },
    })
    expect([403, 404]).toContain(res.status)
  })

  it("B03 — User A deletes own message", async () => {
    const res = await api(url, `/api/threads/${b03ThreadId}/messages/${b03MessageIds[1]}`, {
      method: "DELETE",
      token: b03UserA.token,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.deletedAt).toBeDefined()
  })

  it("B03 — deleted message has content: null in listing", async () => {
    const list = await api(url, `/api/threads/${b03ThreadId}/messages?limit=50`, {
      token: b03UserA.token,
    })
    expect(list.status).toBe(200)
    const deleted = list.body.data.find((m: any) => m.id === b03MessageIds[1])
    expect(deleted).toBeDefined()
    expect(deleted.content).toBeNull()
  })

  // Deletion is author-only EXCEPT for an org admin (kernel:threads:admin): the
  // moderation override in modules/threads/message.ts `deleteMessage`, mirrored by
  // the messages_delete RLS policy. A plain participant still cannot delete
  // someone else's message.
  it("B03 — a non-admin participant cannot delete another user's message", async () => {
    const res = await api(url, `/api/threads/${b03ThreadId}/messages/${b03MessageIds[2]}`, {
      method: "DELETE",
      token: b03UserB.token,
    })
    expect(res.status).toBe(404)
  })

  it("B03 — an admin participant can delete another user's message (moderation)", async () => {
    const [adminUser] = await world.addUsers([
      {
        name: "B03-Admin",
        scopes: ["kernel:threads:read", "kernel:threads:write", "kernel:threads:admin"],
      },
    ])
    // Add admin to thread first
    const addRes = await api(url, `/api/threads/${b03ThreadId}/participants`, {
      token: b03UserA.token,
      body: { userId: adminUser.id },
    })
    expect(addRes.status).toBe(200)

    const res = await api(url, `/api/threads/${b03ThreadId}/messages/${b03MessageIds[2]}`, {
      method: "DELETE",
      token: adminUser.token,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.deletedAt).toBeDefined()
  })

  // ═══════════════════════════════════════════════════════════
  //  B04: Reactions
  // ═══════════════════════════════════════════════════════════

  let b04UserA: { id: string; token: string }
  let b04UserB: { id: string; token: string }
  let b04ThreadId: string
  let b04MessageId: string

  it("B04 — setup: create thread with initial message", async () => {
    const [uA] = await world.addUsers([{ name: "B04-A" }])
    const [uB] = await world.addUsers([{ name: "B04-B" }])
    b04UserA = uA
    b04UserB = uB

    const t = await world.threads.create(b04UserA, {
      participantIds: [b04UserB.id],
      title: "B04",
      initialMessage: { content: "React to this" },
    })
    b04ThreadId = t.id

    // Get message ID
    const msgs = await api(url, `/api/threads/${b04ThreadId}/messages`, {
      token: b04UserA.token,
    })
    b04MessageId = msgs.body.data[0].id
  })

  it("B04 — User A adds thumbsup — added: true", async () => {
    const res = await api(url, `/api/threads/${b04ThreadId}/messages/${b04MessageId}/reactions`, {
      token: b04UserA.token,
      body: { emoji: "\u{1F44D}" },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.added).toBe(true)
  })

  it("B04 — User A adds thumbsup again — added: false (idempotent)", async () => {
    const res = await api(url, `/api/threads/${b04ThreadId}/messages/${b04MessageId}/reactions`, {
      token: b04UserA.token,
      body: { emoji: "\u{1F44D}" },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.added).toBe(false)
  })

  it("B04 — User B adds thumbsup and party", async () => {
    await api(url, `/api/threads/${b04ThreadId}/messages/${b04MessageId}/reactions`, {
      token: b04UserB.token,
      body: { emoji: "\u{1F44D}" },
    })
    await api(url, `/api/threads/${b04ThreadId}/messages/${b04MessageId}/reactions`, {
      token: b04UserB.token,
      body: { emoji: "\u{1F389}" },
    })
  })

  it("B04 — message listing shows aggregated reactions with reacted flag", async () => {
    const list = await api(url, `/api/threads/${b04ThreadId}/messages`, {
      token: b04UserA.token,
    })
    expect(list.status).toBe(200)
    const msg = list.body.data.find((m: any) => m.id === b04MessageId)
    expect(msg.reactions).toBeDefined()
    const thumbs = msg.reactions.find((r: any) => r.emoji === "\u{1F44D}")
    expect(thumbs.count).toBe(2)
    expect(thumbs.reacted).toBe(true) // User A reacted
    const party = msg.reactions.find((r: any) => r.emoji === "\u{1F389}")
    expect(party.count).toBe(1)
    expect(party.reacted).toBe(false) // User A did not react with party
  })

  it("B04 — User A removes thumbsup — count decreases", async () => {
    const res = await api(
      url,
      `/api/threads/${b04ThreadId}/messages/${b04MessageId}/reactions/${encodeURIComponent("\u{1F44D}")}`,
      { method: "DELETE", token: b04UserA.token },
    )
    expect(res.status).toBe(200)
    expect(res.body.data.removed).toBe(true)

    const list = await api(url, `/api/threads/${b04ThreadId}/messages`, {
      token: b04UserA.token,
    })
    const msg = list.body.data.find((m: any) => m.id === b04MessageId)
    const thumbs = msg.reactions.find((r: any) => r.emoji === "\u{1F44D}")
    expect(thumbs.count).toBe(1)
    expect(thumbs.reacted).toBe(false)
  })

  it("B04 — non-participant cannot react", async () => {
    const [outsider] = await world.addUsers([{ name: "B04-Outsider" }])
    const res = await api(url, `/api/threads/${b04ThreadId}/messages/${b04MessageId}/reactions`, {
      token: outsider.token,
      body: { emoji: "\u{1F44D}" },
    })
    expect([403, 404]).toContain(res.status)
  })

  // ═══════════════════════════════════════════════════════════
  //  B05: Participants
  // ═══════════════════════════════════════════════════════════

  let b05UserA: { id: string; token: string }
  let b05UserB: { id: string; token: string }
  let b05UserC: { id: string; token: string }
  let b05ThreadId: string

  it("B05 — setup: create thread with A and B", async () => {
    const [uA] = await world.addUsers([{ name: "B05-A" }])
    const [uB] = await world.addUsers([{ name: "B05-B" }])
    const [uC] = await world.addUsers([{ name: "B05-C" }])
    b05UserA = uA
    b05UserB = uB
    b05UserC = uC

    const t = await world.threads.create(b05UserA, {
      participantIds: [b05UserB.id],
      title: "B05",
    })
    b05ThreadId = t.id
  })

  it("B05 — User A adds User C — added: true", async () => {
    const res = await api(url, `/api/threads/${b05ThreadId}/participants`, {
      token: b05UserA.token,
      body: { userId: b05UserC.id },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.added).toBe(true)
  })

  it("B05 — User C sees thread in list", async () => {
    const res = await api(url, "/api/threads", { token: b05UserC.token })
    expect(res.status).toBe(200)
    expect(res.body.data.some((t: any) => t.id === b05ThreadId)).toBe(true)
  })

  it("B05 — User C can send a message", async () => {
    const res = await api(url, `/api/threads/${b05ThreadId}/messages`, {
      token: b05UserC.token,
      body: { content: "C is here" },
    })
    expect(res.status).toBe(200)
  })

  it("B05 — User C leaves (self-remove)", async () => {
    const res = await api(url, `/api/threads/${b05ThreadId}/participants/${b05UserC.id}`, {
      method: "DELETE",
      token: b05UserC.token,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.removed).toBe(true)
  })

  it("B05 — User C no longer sees thread", async () => {
    const res = await api(url, "/api/threads", { token: b05UserC.token })
    expect(res.body.data.some((t: any) => t.id === b05ThreadId)).toBe(false)
  })

  it("B05 — User C cannot send message after leaving", async () => {
    const res = await api(url, `/api/threads/${b05ThreadId}/messages`, {
      token: b05UserC.token,
      body: { content: "ghost" },
    })
    expect([403, 404]).toContain(res.status)
  })

  it("B05 — non-admin cannot remove others", async () => {
    const res = await api(url, `/api/threads/${b05ThreadId}/participants/${b05UserA.id}`, {
      method: "DELETE",
      token: b05UserB.token,
    })
    expect([403, 404]).toContain(res.status)
  })

  it("B05 — admin can remove others", async () => {
    const [adminUser] = await world.addUsers([
      {
        name: "B05-Admin",
        scopes: ["kernel:threads:read", "kernel:threads:write", "kernel:threads:admin"],
      },
    ])
    // Add admin to thread
    await api(url, `/api/threads/${b05ThreadId}/participants`, {
      token: b05UserA.token,
      body: { userId: adminUser.id },
    })
    // Admin removes User B
    const res = await api(url, `/api/threads/${b05ThreadId}/participants/${b05UserB.id}`, {
      method: "DELETE",
      token: adminUser.token,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.removed).toBe(true)
  })

  // ═══════════════════════════════════════════════════════════
  //  B06: Thread State (Archive, Mute, Read Tracking)
  // ═══════════════════════════════════════════════════════════

  let b06UserA: { id: string; token: string }
  let b06UserB: { id: string; token: string }
  let b06ThreadId: string

  it("B06 — setup: create thread with initial message", async () => {
    const [uA] = await world.addUsers([{ name: "B06-A" }])
    const [uB] = await world.addUsers([{ name: "B06-B" }])
    b06UserA = uA
    b06UserB = uB

    const t = await world.threads.create(b06UserA, {
      participantIds: [b06UserB.id],
      title: "B06",
      initialMessage: { content: "init" },
    })
    b06ThreadId = t.id
  })

  it("B06 — archive: removes from default list, shows in archived", async () => {
    // Archive
    const archRes = await api(url, `/api/threads/${b06ThreadId}/state`, {
      method: "PATCH",
      token: b06UserA.token,
      body: { isArchived: true },
    })
    expect(archRes.status).toBe(200)

    // Not in default list
    const def = await api(url, "/api/threads", { token: b06UserA.token })
    expect(def.body.data.some((t: any) => t.id === b06ThreadId)).toBe(false)

    // In archived list
    const arch = await api(url, "/api/threads?archived=true", { token: b06UserA.token })
    expect(arch.body.data.some((t: any) => t.id === b06ThreadId)).toBe(true)

    // Unarchive
    await api(url, `/api/threads/${b06ThreadId}/state`, {
      method: "PATCH",
      token: b06UserA.token,
      body: { isArchived: false },
    })

    // Back in default list
    const unarch = await api(url, "/api/threads", { token: b06UserA.token })
    expect(unarch.body.data.some((t: any) => t.id === b06ThreadId)).toBe(true)
  })

  it("B06 — mute: persists in DB", async () => {
    const ks = env.schemaPrefix ? `"${env.schemaPrefix}kernel"` : "kernel"

    await api(url, `/api/threads/${b06ThreadId}/state`, {
      method: "PATCH",
      token: b06UserA.token,
      body: { isMuted: true },
    })
    const [row] = await env.db.sql.unsafe(
      `SELECT is_muted FROM ${ks}.user_thread_state
       WHERE user_id = $1 AND thread_id = $2`,
      [b06UserA.id, b06ThreadId],
    )
    expect(row.is_muted).toBe(true)
  })

  it("B06 — read tracking: mark read then new messages increment", async () => {
    // User B sends 3 messages
    for (let i = 0; i < 3; i++) {
      await api(url, `/api/threads/${b06ThreadId}/messages`, {
        token: b06UserB.token,
        body: { content: `state-msg-${i}` },
      })
    }

    // Get the latest message ID
    const msgs = await api(url, `/api/threads/${b06ThreadId}/messages?limit=1`, {
      token: b06UserA.token,
    })
    const latestMsgId = msgs.body.data[0].id

    // Mark read
    await api(url, `/api/threads/${b06ThreadId}/read`, {
      method: "PATCH",
      token: b06UserA.token,
      body: { lastReadMessageId: latestMsgId },
    })

    // Unread should be 0
    const list1 = await api(url, "/api/threads", { token: b06UserA.token })
    const t1 = list1.body.data.find((t: any) => t.id === b06ThreadId)
    expect(t1.unreadCount).toBe(0)

    // User B sends 1 more
    await api(url, `/api/threads/${b06ThreadId}/messages`, {
      token: b06UserB.token,
      body: { content: "new after read" },
    })

    // Unread should be 1
    const list2 = await api(url, "/api/threads", { token: b06UserA.token })
    const t2 = list2.body.data.find((t: any) => t.id === b06ThreadId)
    expect(t2.unreadCount).toBe(1)
  })

  // ═══════════════════════════════════════════════════════════
  //  B07: References and Backlinks
  // ═══════════════════════════════════════════════════════════

  let b07UserA: { id: string; token: string }
  let b07ThreadId: string

  it("B07 — setup: create thread", async () => {
    const [uA] = await world.addUsers([
      {
        name: "B07-A",
        scopes: ["kernel:threads:read", "kernel:threads:write", "tickets:tickets:read"],
      },
    ])
    const [uB] = await world.addUsers([{ name: "B07-B" }])
    b07UserA = uA

    const t = await world.threads.create(b07UserA, {
      participantIds: [uB.id],
      title: "B07",
    })
    b07ThreadId = t.id
  })

  it("B07 — adds reference — added: true", async () => {
    const res = await api(url, `/api/threads/${b07ThreadId}/references`, {
      token: b07UserA.token,
      body: { app: "tickets", entityType: "ticket", entityId: "T-42" },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.added).toBe(true)
  })

  it("B07 — adding same reference again — added: false (idempotent)", async () => {
    const res = await api(url, `/api/threads/${b07ThreadId}/references`, {
      token: b07UserA.token,
      body: { app: "tickets", entityType: "ticket", entityId: "T-42" },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.added).toBe(false)
  })

  it("B07 — thread detail shows reference", async () => {
    const res = await api(url, `/api/threads/${b07ThreadId}`, { token: b07UserA.token })
    expect(res.status).toBe(200)
    expect(res.body.data.references.length).toBeGreaterThanOrEqual(1)
    const ref = res.body.data.references.find((r: any) => r.entityId === "T-42")
    expect(ref).toBeDefined()
    expect(ref.app).toBe("tickets")
  })

  it("B07 — backlinks API returns thread", async () => {
    const res = await api(url, "/api/references?app=tickets&entityType=ticket&entityId=T-42", {
      token: b07UserA.token,
    })
    expect(res.status).toBe(200)
    const links = res.body.data
    expect(links.some((l: any) => l.threadId === b07ThreadId)).toBe(true)
  })

  it("B07 — non-participant gets empty backlinks (RLS)", async () => {
    const [outsider] = await world.addUsers([
      { name: "B07-Outsider", scopes: ["kernel:threads:read", "tickets:tickets:read"] },
    ])
    const res = await api(url, "/api/references?app=tickets&entityType=ticket&entityId=T-42", {
      token: outsider.token,
    })
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBe(0)
  })

  // ═══════════════════════════════════════════════════════════
  //  B08: Search and Mention Autocomplete
  //  Phase 10 Task 12: Meili indexer is wired in Task 31. Until the boot
  //  drift gate is connected to this E2E harness these checks need a live
  //  Meili + reindex, so they're skipped here and reactivated in Task 32.
  // ═══════════════════════════════════════════════════════════

  let b08UserA: { id: string; token: string }

  it.skip("B08 — setup: create search test threads", async () => {
    const [uA] = await world.addUsers([{ name: "B08-A" }])
    const [uB] = await world.addUsers([{ name: "B08-B" }])
    b08UserA = uA

    await world.threads.create(b08UserA, {
      participantIds: [uB.id],
      title: "Design Review",
    })
    await world.threads.create(b08UserA, {
      participantIds: [uB.id],
      title: "Budget Planning",
    })
    await world.threads.create(b08UserA, {
      participantIds: [uB.id],
      title: "Design Sprint",
    })
  })

  it.skip("B08 — search q=Design returns 2 threads", async () => {
    const res = await api(url, "/api/search?q=Design", { token: b08UserA.token })
    expect(res.status).toBe(200)
    expect(res.body.data.threads.length).toBe(2)
  })

  it.skip("B08 — search q=nonexistent returns empty", async () => {
    const res = await api(url, "/api/search?q=nonexistent", { token: b08UserA.token })
    expect(res.status).toBe(200)
    expect(res.body.data.threads.length).toBe(0)
  })

  it.skip("B08 — search q=admin returns admin user", async () => {
    const res = await api(url, "/api/search?q=admin", { token: b08UserA.token })
    expect(res.status).toBe(200)
    expect(res.body.data.users.length).toBeGreaterThanOrEqual(1)
  })

  it.skip("B08 — mention search q=Des returns threads", async () => {
    const res = await api(url, "/api/mentions?q=Des", { token: b08UserA.token })
    expect(res.status).toBe(200)
    const results = res.body.data
    const threadResults = results.filter((r: any) => r.type === "thread")
    expect(threadResults.length).toBeGreaterThanOrEqual(1)
  })

  it.skip("B08 — mention search q=admin returns user", async () => {
    const res = await api(url, "/api/mentions?q=admin", { token: b08UserA.token })
    expect(res.status).toBe(200)
    const userResults = res.body.data.filter((r: any) => r.type === "user")
    expect(userResults.length).toBeGreaterThanOrEqual(1)
  })

  it.skip("B08 — user without threads:read scope gets empty thread results", async () => {
    const [noScope] = await world.addUsers([{ name: "B08-NoScope", scopes: [] }])
    const res = await api(url, "/api/search?q=Design", { token: noScope.token })
    expect(res.status).toBe(200)
    expect(res.body.data.threads.length).toBe(0)
  })

  // ═══════════════════════════════════════════════════════════
  //  B09: Scope Enforcement
  // ═══════════════════════════════════════════════════════════

  it("B09 — no thread scopes — GET /api/threads returns 403", async () => {
    const [noScope] = await world.addUsers([{ name: "B09-None", scopes: [] }])
    const res = await api(url, "/api/threads", { token: noScope.token })
    expect(res.status).toBe(403)
  })

  it("B09 — threads:read only — GET threads 200, POST threads 403", async () => {
    const [readOnly] = await world.addUsers([
      {
        name: "B09-Read",
        scopes: ["kernel:threads:read"],
      },
    ])
    const get = await api(url, "/api/threads", { token: readOnly.token })
    expect(get.status).toBe(200)

    const post = await api(url, "/api/threads", {
      token: readOnly.token,
      body: {
        forceCreate: true,
        participantIds: [adminUserId],
      },
    })
    expect(post.status).toBe(403)
  })

  it("B09 — threads:read+write — can create but non-creator cannot pin", async () => {
    const [readWrite] = await world.addUsers([
      {
        name: "B09-RW",
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
    ])
    const [other] = await world.addUsers([
      {
        name: "B09-RW-Other",
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
    ])
    // Create works
    const create = await api(url, "/api/threads", {
      token: readWrite.token,
      body: {
        forceCreate: true,
        participantIds: [other.id],
        title: "scope test",
      },
    })
    expect(create.status).toBe(200)

    // Non-admin creator CANNOT org-pin (isPinned requires kernel:threads:admin)
    const pin = await api(url, `/api/threads/${create.body.data.id}`, {
      method: "PATCH",
      token: readWrite.token,
      body: { isPinned: true },
    })
    expect(pin.status).toBe(403)

    // Other participant (non-creator, non-admin) also CANNOT pin
    const otherPin = await api(url, `/api/threads/${create.body.data.id}`, {
      method: "PATCH",
      token: other.token,
      body: { isPinned: true },
    })
    expect(otherPin.status).toBe(403)

    // User-level pin via /state endpoint works for any participant (no admin scope needed)
    const userPin = await api(url, `/api/threads/${create.body.data.id}/state`, {
      method: "PATCH",
      token: readWrite.token,
      body: { isPinned: true },
    })
    expect(userPin.status).toBe(200)
  })

  it("B09 — non-participant with threads:read — GET thread detail returns 404 (zero-knowledge)", async () => {
    const [a] = await world.addUsers([
      {
        name: "B09-ZK-A",
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
    ])
    const [b] = await world.addUsers([
      {
        name: "B09-ZK-B",
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
    ])
    const [outsider] = await world.addUsers([
      {
        name: "B09-ZK-Out",
        scopes: ["kernel:threads:read"],
      },
    ])
    const t = await world.threads.create(a, {
      participantIds: [b.id],
      title: "private",
    })

    const res = await api(url, `/api/threads/${t.id}`, { token: outsider.token })
    expect(res.status).toBe(404)
  })

  it("B09 — non-participant with threads:write — POST message returns 403/404", async () => {
    const [a] = await world.addUsers([
      {
        name: "B09-Msg-A",
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
    ])
    const [b] = await world.addUsers([
      {
        name: "B09-Msg-B",
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
    ])
    const [outsider] = await world.addUsers([
      {
        name: "B09-Msg-Out",
        scopes: ["kernel:threads:read", "kernel:threads:write"],
      },
    ])
    const t = await world.threads.create(a, {
      participantIds: [b.id],
      title: "private msg",
    })

    const res = await api(url, `/api/threads/${t.id}/messages`, {
      token: outsider.token,
      body: { content: "should fail" },
    })
    expect([403, 404]).toContain(res.status)
  })

  // ═══════════════════════════════════════════════════════════
  //  B13: Thread Update and Pin
  // ═══════════════════════════════════════════════════════════

  let b13UserA: { id: string; token: string }
  let b13UserB: { id: string; token: string }
  let b13ThreadId: string

  it("B13 — setup: create thread", async () => {
    const [uA] = await world.addUsers([{ name: "B13-A" }])
    const [uB] = await world.addUsers([{ name: "B13-B" }])
    b13UserA = uA
    b13UserB = uB

    const t = await world.threads.create(b13UserA, {
      participantIds: [b13UserB.id],
      title: "Original Title",
    })
    b13ThreadId = t.id
  })

  it("B13 — User A updates title", async () => {
    const res = await api(url, `/api/threads/${b13ThreadId}`, {
      method: "PATCH",
      token: b13UserA.token,
      body: { title: "Renamed Thread" },
    })
    expect(res.status).toBe(200)

    const detail = await api(url, `/api/threads/${b13ThreadId}`, { token: b13UserA.token })
    expect(detail.body.data.title).toBe("Renamed Thread")
  })

  it("B13 — non-admin, non-creator cannot pin", async () => {
    const res = await api(url, `/api/threads/${b13ThreadId}`, {
      method: "PATCH",
      token: b13UserB.token,
      body: { isPinned: true },
    })
    expect(res.status).toBe(403)
  })

  it("B13 — admin can pin", async () => {
    const [adminUser] = await world.addUsers([
      {
        name: "B13-Admin",
        scopes: ["kernel:threads:read", "kernel:threads:write", "kernel:threads:admin"],
      },
    ])
    // Add admin to thread
    await api(url, `/api/threads/${b13ThreadId}/participants`, {
      token: b13UserA.token,
      body: { userId: adminUser.id },
    })
    const res = await api(url, `/api/threads/${b13ThreadId}`, {
      method: "PATCH",
      token: adminUser.token,
      body: { isPinned: true },
    })
    expect(res.status).toBe(200)

    const list = await api(url, "/api/threads", { token: adminUser.token })
    const t = list.body.data.find((t: any) => t.id === b13ThreadId)
    expect(t.isPinned).toBe(true)
  })

  it("B13 — admin can unpin", async () => {
    // Add Taylor (org admin with * scope) to the thread, then unpin
    await api(url, `/api/threads/${b13ThreadId}/participants`, {
      token: b13UserA.token,
      body: { userId: world.admin.id },
    })
    const res = await api(url, `/api/threads/${b13ThreadId}`, {
      method: "PATCH",
      token: world.admin.token,
      body: { isPinned: false },
    })
    expect(res.status).toBe(200)
  })

  // ═══════════════════════════════════════════════════════════
  //  B14: Contextual Threads (createdFrom)
  // ═══════════════════════════════════════════════════════════

  let b14UserA: { id: string; token: string }
  let b14UserB: { id: string; token: string }
  let b14Anchor = ""

  it("B14 — setup: create users", async () => {
    const [uA] = await world.addUsers([{ name: "B14-A" }])
    const [uB] = await world.addUsers([{ name: "B14-B" }])
    b14UserA = uA
    b14UserB = uB
    // The entity the contextual threads below belong to: one A may see.
    const anchor = await api(url, "/api/threads", {
      token: b14UserA.token,
      body: { forceCreate: true, participantIds: [b14UserB.id], title: "B14 anchor" },
    })
    expect(anchor.status).toBe(200)
    b14Anchor = anchor.body.data.id
  })

  it("B14 — refuses a createdFrom its creator may not see", async () => {
    const res = await api(url, "/api/threads", {
      token: b14UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b14UserB.id],
        createdFrom: { app: "tickets", entityType: "ticket", entityId: "T-99" },
      },
    })
    expect(res.status).toBe(403)
    expect(res.body.error.code).toBe("created_from_not_visible")
  })

  it("B14 — creates thread with createdFrom", async () => {
    const res = await api(url, "/api/threads", {
      token: b14UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b14UserB.id],
        createdFrom: { app: "kernel", entityType: "thread", entityId: b14Anchor },
      },
    })
    expect(res.status).toBe(200)
    expect(res.body.data.createdFrom).toEqual({
      app: "kernel",
      entityType: "thread",
      entityId: b14Anchor,
    })
  })

  it("B14 — same createdFrom — creates NEW thread (no dedup)", async () => {
    const first = await api(url, "/api/threads", {
      token: b14UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b14UserB.id],
        createdFrom: { app: "kernel", entityType: "thread", entityId: b14Anchor },
      },
    })
    const second = await api(url, "/api/threads", {
      token: b14UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b14UserB.id],
        createdFrom: { app: "kernel", entityType: "thread", entityId: b14Anchor },
      },
    })
    expect(first.body.data.id).not.toBe(second.body.data.id)
    expect(second.body.data.deduplicated).toBe(false)
  })

  it("B14 — organic DM — creates yet another thread", async () => {
    const dm = await api(url, "/api/threads", {
      token: b14UserA.token,
      body: {
        forceCreate: true,
        participantIds: [b14UserB.id],
      },
    })
    expect(dm.status).toBe(200)
    expect(dm.body.data.deduplicated).toBe(false)
  })

  it("B14 — thread detail shows createdFrom", async () => {
    const t = await world.threads.create(b14UserA, {
      participantIds: [b14UserB.id],
      createdFrom: { app: "kernel", entityType: "thread", entityId: b14Anchor },
    })
    const detail = await api(url, `/api/threads/${t.id}`, { token: b14UserA.token })
    expect(detail.body.data.createdFrom).toEqual({
      app: "kernel",
      entityType: "thread",
      entityId: b14Anchor,
    })
  })

  // ═══════════════════════════════════════════════════════════
  //  B10: Real-Time WebSocket — Message Delivery
  // ═══════════════════════════════════════════════════════════

  let b10UserA: { id: string; token: string }
  let b10UserB: { id: string; token: string }
  let b10UserC: { id: string; token: string }
  let b10ThreadId: string

  it("B10 — setup: create users and thread for WS tests", async () => {
    const [uA] = await world.addUsers([{ name: "B10-A" }])
    const [uB] = await world.addUsers([{ name: "B10-B" }])
    const [uC] = await world.addUsers([{ name: "B10-C" }])
    b10UserA = uA
    b10UserB = uB
    b10UserC = uC

    const t = await world.threads.create(b10UserA, {
      participantIds: [b10UserB.id],
      title: "B10 WS",
    })
    b10ThreadId = t.id
  })

  it(
    "B10 — User B receives message event from User A",
    async () => {
      const wsB = await connectWs(url, b10UserB.token)

      try {
        await api(url, `/api/threads/${b10ThreadId}/messages`, {
          token: b10UserA.token,
          body: { content: "ws-test-msg" },
        })

        const event = await wsB.waitFor(
          "event",
          (m) =>
            m.payload?.entity === "message" &&
            m.payload?.action === "create" &&
            m.payload?.data?.content === "ws-test-msg",
          10_000,
        )
        expect(event.payload.data.threadId).toBe(b10ThreadId)
        expect(event.payload.data.authorId).toBe(b10UserA.id)
      } finally {
        wsB.close()
      }
    },
    WS_TEST_TIMEOUT,
  )

  it(
    "B10 — non-participant does NOT receive message event",
    async () => {
      const wsC = await connectWs(url, b10UserC.token)
      // A participant on the same server: once B has the event, the fan-out
      // for it has run, so C's silence afterwards is a real "not delivered".
      const wsB = await connectWs(url, b10UserB.token)

      try {
        const startIdx = wsC.messages.length

        await api(url, `/api/threads/${b10ThreadId}/messages`, {
          token: b10UserA.token,
          body: { content: "private-msg" },
        })

        await wsB.waitFor(
          "event",
          (m: any) =>
            m.payload?.entity === "message" &&
            m.payload?.action === "create" &&
            m.payload?.data?.content === "private-msg",
          10_000,
        )
        // Same broadcast pass; a short grace covers C's frame still in flight.
        await new Promise((r) => setTimeout(r, 150))

        const newMsgs = wsC.messages.slice(startIdx)
        const threadMsgs = newMsgs.filter(
          (m: any) =>
            m.type === "event" &&
            m.payload?.entity === "message" &&
            m.payload?.data?.threadId === b10ThreadId,
        )
        expect(threadMsgs.length).toBe(0)
      } finally {
        wsC.close()
        wsB.close()
      }
    },
    WS_TEST_TIMEOUT,
  )

  it(
    "B10 — after adding User C as participant, they receive events",
    async () => {
      await api(url, `/api/threads/${b10ThreadId}/participants`, {
        token: b10UserA.token,
        body: { userId: b10UserC.id },
      })

      // Connect User C AFTER being added (so membership is loaded on hello)
      const wsC = await connectWs(url, b10UserC.token)

      try {
        await api(url, `/api/threads/${b10ThreadId}/messages`, {
          token: b10UserA.token,
          body: { content: "now-c-sees" },
        })

        const event = await wsC.waitFor(
          "event",
          (m) => m.payload?.entity === "message" && m.payload?.data?.content === "now-c-sees",
          10_000,
        )
        expect(event).toBeDefined()
      } finally {
        wsC.close()
      }
    },
    WS_TEST_TIMEOUT,
  )

  // ═══════════════════════════════════════════════════════════
  //  B11: Real-Time WebSocket — Typing and Presence
  // ═══════════════════════════════════════════════════════════

  let b11UserA: { id: string; token: string }
  let b11UserB: { id: string; token: string }
  let b11ThreadId: string

  it("B11 — setup: create users and thread for typing/presence tests", async () => {
    const [uA] = await world.addUsers([{ name: "B11-A" }])
    const [uB] = await world.addUsers([{ name: "B11-B" }])
    b11UserA = uA
    b11UserB = uB

    const t = await world.threads.create(b11UserA, {
      participantIds: [b11UserB.id],
      title: "B11 WS",
    })
    b11ThreadId = t.id
  })

  it(
    "B11 — typing event delivered to participant",
    async () => {
      const wsA = await connectWs(url, b11UserA.token)
      const wsB = await connectWs(url, b11UserB.token)

      try {
        wsA.ws.send(JSON.stringify({ type: "typing", threadId: b11ThreadId }))

        const event = await wsB.waitFor(
          "event",
          (m) =>
            m.payload?.entity === "typing" &&
            m.payload?.action === "start" &&
            m.payload?.data?.threadId === b11ThreadId,
          10_000,
        )
        expect(event.payload.data.userId).toBe(b11UserA.id)
      } finally {
        wsA.close()
        wsB.close()
      }
    },
    WS_TEST_TIMEOUT,
  )

  it(
    "B11 — status change broadcasts presence:update",
    async () => {
      const wsA = await connectWs(url, b11UserA.token)
      const wsB = await connectWs(url, b11UserB.token)

      try {
        wsA.ws.send(JSON.stringify({ type: "status", status: "away" }))

        const event = await wsB.waitFor(
          "event",
          (m) =>
            m.payload?.entity === "presence" &&
            m.payload?.data?.userId === b11UserA.id &&
            m.payload?.data?.status === "away",
          10_000,
        )
        expect(event).toBeDefined()

        const presenceKey = `${env.redisPrefix}presence:${world.org.id}:${b11UserA.id}`
        const status = await env.redis.redis.get(presenceKey)
        expect(status).toBe("away")

        const ttl = await env.redis.redis.ttl(presenceKey)
        expect(ttl).toBeGreaterThan(0)
        expect(ttl).toBeLessThanOrEqual(60)
      } finally {
        wsA.close()
        wsB.close()
      }
    },
    WS_TEST_TIMEOUT,
  )

  it(
    "B11 — ephemeral events are NOT replayed on reconnect",
    async () => {
      // A thread of its own: the typing throttle (4 s, per user and thread)
      // from the previous test would otherwise swallow this typing event.
      const t = await world.threads.create(b11UserA, {
        participantIds: [b11UserB.id],
        title: "B11 WS replay",
      })
      const replayThreadId = t.id

      const wsA = await connectWs(url, b11UserA.token)
      const wsB = await connectWs(url, b11UserB.token)

      try {
        wsA.ws.send(JSON.stringify({ type: "typing", threadId: replayThreadId }))

        await wsB.waitFor("event", (m) => m.payload?.entity === "typing", 5000)
      } finally {
        wsA.close()
        wsB.close()
      }

      await new Promise((r) => setTimeout(r, 500))
      const wsB2 = await connectWs(url, b11UserB.token, 0)

      try {
        await new Promise((r) => setTimeout(r, 500))

        const typingEvents = wsB2.messages.filter(
          (m: any) => m.type === "event" && m.payload?.entity === "typing",
        )
        expect(typingEvents.length).toBe(0)
      } finally {
        wsB2.close()
      }
    },
    WS_TEST_TIMEOUT,
  )

  // ═══════════════════════════════════════════════════════════
  //  B12: WebSocket Reconnection and Event Replay
  // ═══════════════════════════════════════════════════════════

  let b12UserA: { id: string; token: string }
  let b12UserB: { id: string; token: string }
  let b12ThreadId: string

  it("B12 — setup: create users and thread for reconnect tests", async () => {
    const [uA] = await world.addUsers([{ name: "B12-A" }])
    const [uB] = await world.addUsers([{ name: "B12-B" }])
    b12UserA = uA
    b12UserB = uB

    const t = await world.threads.create(b12UserA, {
      participantIds: [b12UserB.id],
      title: "B12 WS",
    })
    b12ThreadId = t.id
  })

  it(
    "B12 — replays stored events on reconnect with lastEventId",
    async () => {
      const isB12Message = (m: any) =>
        m.type === "event" &&
        m.payload?.entity === "message" &&
        m.payload?.action === "create" &&
        m.payload?.data?.threadId === b12ThreadId

      // A real cursor: the eventId of an event this socket actually received.
      // A cursor of 0 means a fresh connection, which the server never replays
      // to (the client hydrates over REST), so the test must not rely on one.
      const wsA = await connectWs(url, b12UserA.token)
      await api(url, `/api/threads/${b12ThreadId}/messages`, {
        token: b12UserB.token,
        body: { content: "replay-cursor" },
      })
      const cursorEvent = await wsA.waitFor(
        "event",
        (m: any) => isB12Message(m) && typeof m.eventId === "number",
        10_000,
      )
      const lastSeen: number = cursorEvent.eventId
      expect(lastSeen).toBeGreaterThan(0)
      wsA.close()

      // B's own socket proves all three were published (and so buffered)
      // before A reconnects: what A then gets can only come from the replay,
      // never from live delivery racing the reconnect.
      const wsB = await connectWs(url, b12UserB.token)
      const sentIds: string[] = []
      try {
        for (let i = 1; i <= 3; i++) {
          const res = await api(url, `/api/threads/${b12ThreadId}/messages`, {
            token: b12UserB.token,
            body: { content: `replay-msg-${i}` },
          })
          expect(res.status).toBe(200)
          sentIds.push(res.body.data.id)
        }
        const deadline = Date.now() + 10_000
        const published = () =>
          new Set(
            wsB.messages
              .filter((m: any) => isB12Message(m) && sentIds.includes(m.payload?.data?.id))
              .map((m: any) => m.payload.data.id),
          ).size
        while (published() < 3 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10))
        }
        expect(published()).toBe(3)
      } finally {
        wsB.close()
      }

      const wsA2 = await connectWs(url, b12UserA.token, lastSeen)

      try {
        const deadline = Date.now() + 10_000
        const replayed = () =>
          wsA2.messages.filter((m: any) => isB12Message(m) && sentIds.includes(m.payload?.data?.id))
        while (replayed().length < 3 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 10))
        }

        const replayedMsgs = replayed()
        expect(new Set(replayedMsgs.map((m: any) => m.payload.data.id)).size).toBe(3)

        const eventIds = [...new Set(replayedMsgs.map((m: any) => m.eventId))].sort(
          (a: number, b: number) => a - b,
        )
        expect(eventIds.length).toBe(3)
        expect(eventIds[0]).toBeGreaterThan(lastSeen)
        for (let i = 1; i < eventIds.length; i++) {
          expect(eventIds[i]).toBeGreaterThan(eventIds[i - 1])
        }
        // Nothing at or before the cursor is replayed.
        expect(wsA2.messages.some((m: any) => isB12Message(m) && m.eventId <= lastSeen)).toBe(false)
      } finally {
        wsA2.close()
      }
    },
    WS_TEST_TIMEOUT,
  )

  it(
    "B12 — presence_sync delivered on reconnect",
    async () => {
      const wsA = await connectWs(url, b12UserA.token)

      try {
        const sync = wsA.messages.find((m: any) => m.type === "presence_sync")
        expect(sync).toBeDefined()
        expect(sync.users).toBeDefined()
        expect(typeof sync.users).toBe("object")
      } finally {
        wsA.close()
      }
    },
    WS_TEST_TIMEOUT,
  )

  // ═══════════════════════════════════════════════════════════
  //  C1: Thread Pagination with Populated World
  // ═══════════════════════════════════════════════════════════

  it("C1 — paginate threads with limit=5, cursor, exhaust all pages", async () => {
    // Admin participates in threads from world.populate (25 threads)
    const adminToken = world.admin.token

    // Page 1
    const p1 = await api(url, "/api/threads?limit=5", { token: adminToken })
    expect(p1.status).toBe(200)
    expect(p1.body.data.length).toBe(5)
    expect(p1.body.meta.hasMore).toBe(true)
    expect(p1.body.meta.cursor).toBeDefined()

    // Page 2 (URL-encode cursor — it's a timestamp with special chars)
    const p2 = await api(
      url,
      `/api/threads?limit=5&cursor=${encodeURIComponent(p1.body.meta.cursor)}`,
      { token: adminToken },
    )
    expect(p2.status).toBe(200)
    expect(p2.body.data.length).toBeGreaterThan(0)

    // No duplicates across pages
    const p1Ids = new Set(p1.body.data.map((t: any) => t.id))
    for (const t of p2.body.data) {
      expect(p1Ids.has(t.id)).toBe(false)
    }

    // Exhaust all pages
    const allIds = new Set([...p1.body.data.map((t: any) => t.id)])
    let cursor: string | null = p1.body.meta.cursor
    let pages = 1
    while (cursor) {
      const page = await api(url, `/api/threads?limit=5&cursor=${encodeURIComponent(cursor)}`, {
        token: adminToken,
      })
      for (const t of page.body.data) {
        expect(allIds.has(t.id)).toBe(false) // no duplicates
        allIds.add(t.id)
      }
      cursor = page.body.meta.hasMore ? page.body.meta.cursor : null
      pages++
      if (pages > 20) break // safety
    }
    expect(allIds.size).toBeGreaterThanOrEqual(5) // at least some threads visible
  })

  // ═══════════════════════════════════════════════════════════
  //  C2: Concurrent Thread Operations
  // ═══════════════════════════════════════════════════════════

  it("C2 — concurrent messages: 3 users send simultaneously, all succeed", async () => {
    const [u1] = await world.addUsers([{ name: "C2-A" }])
    const [u2] = await world.addUsers([{ name: "C2-B" }])
    const [u3] = await world.addUsers([{ name: "C2-C" }])
    const thread = await world.threads.create(u1, {
      participantIds: [u2.id, u3.id],
      initialMessage: { content: "setup" },
    })

    const results = await Promise.all([
      api(url, `/api/threads/${thread.id}/messages`, {
        token: u1.token,
        body: { content: "from u1" },
      }),
      api(url, `/api/threads/${thread.id}/messages`, {
        token: u2.token,
        body: { content: "from u2" },
      }),
      api(url, `/api/threads/${thread.id}/messages`, {
        token: u3.token,
        body: { content: "from u3" },
      }),
    ])

    const ids = results.map((r) => r.body.data.id)
    expect(new Set(ids).size).toBe(3) // all unique
    for (const r of results) {
      expect(r.status).toBe(200)
    }
  })

  it("C2 — concurrent reactions: 2 users react simultaneously, both counted", async () => {
    const [rA] = await world.addUsers([{ name: "C2-RA" }])
    const [rB] = await world.addUsers([{ name: "C2-RB" }])
    const thread = await world.threads.create(rA, {
      participantIds: [rB.id],
      initialMessage: { content: "react to this" },
    })
    const msgId = thread.initialMessageId

    // A reaction is one RGI emoji (addReactionSchema, S17); a shortcode such as
    // "thumbsup" is rejected with 400.
    const [r1, r2] = await Promise.all([
      api(url, `/api/threads/${thread.id}/messages/${msgId}/reactions`, {
        token: rA.token,
        body: { emoji: "\u{1F44D}" },
      }),
      api(url, `/api/threads/${thread.id}/messages/${msgId}/reactions`, {
        token: rB.token,
        body: { emoji: "\u{1F44D}" },
      }),
    ])

    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)

    // Verify final count
    const msgs = await api(url, `/api/threads/${thread.id}/messages?limit=10`, {
      token: rA.token,
    })
    const msg = msgs.body.data.find((m: any) => m.id === msgId)
    const thumbs = msg.reactions.find((r: any) => r.emoji === "\u{1F44D}")
    expect(thumbs.count).toBe(2)
  })

  // ═══════════════════════════════════════════════════════════
  //  C3: WebSocket Event Ordering Under Load
  // ═══════════════════════════════════════════════════════════

  it(
    "C3 — 10 sequential messages: events delivered in order with monotonic IDs",
    async () => {
      const [cA] = await world.addUsers([{ name: "C3-A" }])
      const [cB] = await world.addUsers([{ name: "C3-B" }])
      const thread = await world.threads.create(cA, {
        participantIds: [cB.id],
        initialMessage: { content: "c3 setup" },
      })

      const wsB = await connectWs(url, cB.token)

      try {
        // Send 10 messages sequentially, waiting for each to arrive before sending next.
        // This ensures reliable delivery under parallel worker load — no dropped events.
        for (let i = 0; i < 10; i++) {
          await api(url, `/api/threads/${thread.id}/messages`, {
            token: cA.token,
            body: { content: `msg-${i}` },
          })
          // Wait for this specific message to arrive via WS before sending next
          await wsB.waitFor(
            "event",
            (m: any) =>
              m.payload?.entity === "message" &&
              m.payload?.action === "create" &&
              m.payload?.data?.content === `msg-${i}`,
            10_000,
          )
        }

        // All 10 messages should be in the buffer now
        const events = wsB.messages.filter(
          (m: any) =>
            m.type === "event" &&
            m.payload?.entity === "message" &&
            m.payload?.action === "create" &&
            m.payload?.data?.threadId === thread.id &&
            m.payload?.data?.content?.startsWith("msg-"),
        )
        expect(events.length).toBe(10)

        // Verify event IDs are monotonically increasing
        const eventIds = events.map((e: any) => e.eventId)
        for (let i = 1; i < eventIds.length; i++) {
          expect(eventIds[i]).toBeGreaterThan(eventIds[i - 1])
        }
      } finally {
        wsB.close()
      }
    },
    WS_TEST_TIMEOUT,
  )
})
