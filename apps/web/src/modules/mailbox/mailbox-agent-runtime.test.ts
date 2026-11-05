// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The runtime that connects the three phases. The host test drives it through
// the real event path; this file pins the parts a host cannot show: the search
// half, and what happens when this browser cannot answer.

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  answerMailboxHandoff,
  createMailboxAgentRuntime,
  installMailboxAgentRuntime,
} from "~/modules/mailbox/mailbox-agent-runtime"
import type { SearchIndexAdapter } from "~/modules/mailbox/search-index/adapter"

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111"

function fakeAdapter(hits: string[]): SearchIndexAdapter {
  return {
    mode: () => "full",
    setMode: () => {},
    add: async () => {},
    remove: async () => {},
    search: async () => hits,
    exportShards: async () => [],
    importShards: async () => {},
    clear: async () => {},
    size: () => hits.length,
    // biome-ignore lint/suspicious/noExplicitAny: the adapter surface is wider than this test needs
  } as any
}

function harness(
  options: {
    adapter?: SearchIndexAdapter | null
    unlocked?: boolean
    agentAccess?: boolean
    confirmDisclosure?: (disclosure: string, messageIds: string[]) => Promise<boolean>
  } = {},
) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  const runtime = createMailboxAgentRuntime({
    post: async (path, body) => {
      posts.push({ path, body: body as Record<string, unknown> })
    },
    send: () => {},
    isUnlocked: () => options.unlocked ?? true,
    keyIds: () => [1],
    openMessages: async (ids) =>
      ids.map((id) => ({
        id,
        subject: "Hi",
        textBody: "SECRET-BODY",
        htmlBody: null,
        snippet: null,
      })),
    agentMailAccessEnabled: () => options.agentAccess ?? true,
    turnScopeIds: () => [],
    searchAdapter: () => options.adapter ?? null,
    indexComplete: () => true,
    ...(options.confirmDisclosure ? { confirmDisclosure: options.confirmDisclosure } : {}),
  })
  return { runtime, posts }
}

describe("mailbox agent runtime, client search", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("answers a search request with ids and never with the query text", async () => {
    const { runtime, posts } = harness({ adapter: fakeAdapter([MESSAGE_ID]) })
    const turnNonce = runtime.beginTurn()

    runtime.handleAgentStreamEvent("mailbox_search_request", {
      requestId: "search-1",
      turnNonce,
      query: "invoice from acme",
      limit: 10,
    })

    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].path).toBe("/agent/mailbox-search/search-1")
    expect(posts[0].body.messageIds).toEqual([MESSAGE_ID])
    // The query is an argument to a local function and appears on no wire.
    expect(JSON.stringify(posts[0].body)).not.toContain("acme")
    // The hits this turn's own result named are now readable by that turn, and
    // nothing wider is.
    expect(runtime.session.isIdInTurnScope(MESSAGE_ID, turnNonce)).toBe(true)
    expect(runtime.session.isIdInTurnScope("some-other-id", turnNonce)).toBe(false)
  })

  it("answers, rather than going silent, when there is no index here", async () => {
    const { runtime, posts } = harness({ adapter: null })
    const turnNonce = runtime.beginTurn()

    runtime.handleAgentStreamEvent("mailbox_search_request", {
      requestId: "search-2",
      turnNonce,
      query: "anything",
    })

    // A turn that hears nothing spends its whole wait budget before falling
    // back. `indexComplete: false` tells it now.
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ messageIds: [], indexComplete: false })
  })

  it("ignores events that are not mailbox requests", () => {
    const { runtime, posts } = harness({})
    expect(runtime.handleAgentStreamEvent("delta", { delta: "hello" })).toBe(false)
    expect(posts).toHaveLength(0)
  })
})

// A user with several clients open (a browser tab and the desktop app, say):
// every one of them hears every decrypt and search request, and only the one
// that started the turn can answer it. Another client answering, even with a
// refusal, used to settle the request first and take the turn's read from the
// client that could have decrypted it.
describe("mailbox agent runtime, several clients of one user", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("stays silent on a decrypt request for a turn another client started", async () => {
    const { runtime, posts } = harness()
    runtime.beginTurn()
    runtime.handleAgentStreamEvent("mailbox_decrypt_request", {
      requestId: "req-other",
      turnNonce: "a-nonce-another-client-minted",
      requestKind: "mail.read",
      messageIds: [MESSAGE_ID],
      purpose: "read",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(posts).toHaveLength(0)
  })

  it("stays silent on a search request for a turn another client started", async () => {
    const { runtime, posts } = harness({ adapter: fakeAdapter([MESSAGE_ID]) })
    runtime.beginTurn()
    runtime.handleAgentStreamEvent("mailbox_search_request", {
      requestId: "search-other",
      turnNonce: "a-nonce-another-client-minted",
      query: "invoice",
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(posts).toHaveLength(0)
  })

  it("answers its own turn and says so, so the server settles on it", async () => {
    const { runtime, posts } = harness({ adapter: fakeAdapter([MESSAGE_ID]) })
    const turnNonce = runtime.beginTurn({ allowedIds: [MESSAGE_ID] })
    runtime.handleAgentStreamEvent("mailbox_decrypt_request", {
      requestId: "req-own",
      turnNonce,
      requestKind: "mail.read",
      messageIds: [MESSAGE_ID],
      purpose: "read",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    runtime.handleAgentStreamEvent("mailbox_search_request", {
      requestId: "search-own",
      turnNonce,
      query: "invoice",
    })
    await vi.waitFor(() => expect(posts).toHaveLength(2))
    for (const post of posts) expect(post.body.turnOwner).toBe(true)
  })

  it("tells the server which turns this client owns, as soon as one opens and ends", () => {
    const frames: Array<Record<string, unknown>> = []
    const runtime = createMailboxAgentRuntime({
      post: async () => {},
      send: (frame) => frames.push(frame as Record<string, unknown>),
      isUnlocked: () => false,
      keyIds: () => [1],
      openMessages: async () => [],
      agentMailAccessEnabled: () => true,
      turnScopeIds: () => [],
    })
    const turnNonce = runtime.beginTurn()
    // Sent even while locked: the server needs to know the owner is still here.
    expect(frames.at(-1)).toMatchObject({ type: "status", scope: "mailbox", turns: [turnNonce] })
    runtime.endTurn(turnNonce)
    expect(frames.at(-1)).toMatchObject({ turns: [] })
  })

  it("answers a request for another app's turn with the answer token while unlocked", async () => {
    const { runtime, posts } = harness({ adapter: fakeAdapter([MESSAGE_ID]) })
    runtime.handleAgentStreamEvent("mailbox_decrypt_request", {
      requestId: "req-phone",
      turnNonce: "a-nonce-the-phone-minted",
      answerToken: "token-1",
      requestKind: "mail.read",
      messageIds: [MESSAGE_ID],
      purpose: "read",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    runtime.handleAgentStreamEvent("mailbox_search_request", {
      requestId: "search-phone",
      turnNonce: "a-nonce-the-phone-minted",
      answerToken: "token-2",
      query: "invoice",
    })
    await vi.waitFor(() => expect(posts).toHaveLength(2))
    const read = posts.find((p) => p.path === "/agent/mailbox-plaintext/req-phone")
    expect(read?.body).toMatchObject({ answerToken: "token-1", items: [{ messageId: MESSAGE_ID }] })
    const search = posts.find((p) => p.path === "/agent/mailbox-search/search-phone")
    expect(search?.body).toMatchObject({ answerToken: "token-2", messageIds: [MESSAGE_ID] })
    // Not the turn's window: it neither claims the turn nor knows its nonce's scope.
    for (const post of posts) {
      expect(post.body.turnOwner).toBeUndefined()
      expect(post.body.turnNonce).toBeUndefined()
    }
  })

  it("stays silent on another app's turn while locked, and never answers its conversion", async () => {
    const locked = harness({ unlocked: false, adapter: fakeAdapter([MESSAGE_ID]) })
    locked.runtime.handleAgentStreamEvent("mailbox_decrypt_request", {
      requestId: "req-phone",
      turnNonce: "a-nonce-the-phone-minted",
      answerToken: "token-1",
      requestKind: "mail.read",
      messageIds: [MESSAGE_ID],
      purpose: "read",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    locked.runtime.handleAgentStreamEvent("mailbox_search_request", {
      requestId: "search-phone",
      turnNonce: "a-nonce-the-phone-minted",
      answerToken: "token-2",
      query: "invoice",
    })
    const unlocked = harness()
    unlocked.runtime.handleAgentStreamEvent("mailbox_decrypt_request", {
      requestId: "req-convert",
      turnNonce: "a-nonce-the-phone-minted",
      answerToken: "token-3",
      requestKind: "mail.convert",
      messageIds: [MESSAGE_ID],
      purpose: "make a ticket",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(locked.posts).toHaveLength(0)
    expect(unlocked.posts).toHaveLength(0)
  })

  it("another app's turn with the agent's mail access off is refused out loud, with the token", async () => {
    const { runtime, posts } = harness({ agentAccess: false })
    runtime.handleAgentStreamEvent("mailbox_decrypt_request", {
      requestId: "req-phone",
      turnNonce: "a-nonce-the-phone-minted",
      answerToken: "token-1",
      requestKind: "mail.read",
      messageIds: [MESSAGE_ID],
      purpose: "read",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ answerToken: "token-1", denied: {} })
    expect(JSON.stringify(posts[0].body)).not.toContain("SECRET-BODY")
  })

  it("a locked client that started the turn says it is locked, by code", async () => {
    const { runtime, posts } = harness({ unlocked: false })
    const turnNonce = runtime.beginTurn({ allowedIds: [MESSAGE_ID] })
    runtime.handleAgentStreamEvent("mailbox_decrypt_request", {
      requestId: "req-locked",
      turnNonce,
      requestKind: "mail.read",
      messageIds: [MESSAGE_ID],
      purpose: "read",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ turnOwner: true, denied: { code: "locked" } })
  })
})

// The turn's own window is never stricter than the user's other apps. The
// encryption keeps this user's mail from other members, admins and plaintext at
// rest; it does not keep it from the user's own agent in the user's own turn.
// So a read the agent asks for is served even when this window never loaded that
// mail (the agent found it through a contact, not through Mail), under the same
// lock, switch, nonce and caps. A conversion still needs the id in the turn's
// scope and the user's yes in this window.
describe("mailbox agent runtime, the turn's own window", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  function readNeverLoaded(runtime: ReturnType<typeof harness>["runtime"], turnNonce: string) {
    runtime.handleAgentStreamEvent("mailbox_decrypt_request", {
      requestId: "req-contact",
      turnNonce,
      requestKind: "mail.read",
      messageIds: [MESSAGE_ID],
      purpose: "read the customer's last email, found through their contact",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
  }

  it("serves a read of mail this window never loaded", async () => {
    const { runtime, posts } = harness()
    // Nothing loaded in Mail: the turn opens with an empty scope.
    const turnNonce = runtime.beginTurn()
    expect(runtime.session.isIdInTurnScope(MESSAGE_ID, turnNonce)).toBe(false)
    readNeverLoaded(runtime, turnNonce)
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].path).toBe("/agent/mailbox-plaintext/req-contact")
    expect(posts[0].body).toMatchObject({
      turnNonce,
      turnOwner: true,
      items: [{ messageId: MESSAGE_ID, textBody: "SECRET-BODY" }],
    })
    expect(posts[0].body.denied).toBeUndefined()
  })

  it("still refuses it while this window's mailbox is locked, by code", async () => {
    const { runtime, posts } = harness({ unlocked: false })
    readNeverLoaded(runtime, runtime.beginTurn())
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ turnOwner: true, denied: { code: "locked" } })
    expect(JSON.stringify(posts[0].body)).not.toContain("SECRET-BODY")
  })

  it("still refuses it with the agent's mail access switched off", async () => {
    const { runtime, posts } = harness({ agentAccess: false })
    readNeverLoaded(runtime, runtime.beginTurn())
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ turnOwner: true, denied: {} })
    expect(JSON.stringify(posts[0].body)).not.toContain("SECRET-BODY")
  })

  it("still refuses a read for a turn nonce it does not hold, from its own responder", async () => {
    const { runtime, posts } = harness()
    runtime.beginTurn()
    const outcome = await runtime.responder.handle({
      requestId: "req-forged",
      turnNonce: "a-nonce-nobody-here-minted",
      requestKind: "mail.read",
      messageIds: [MESSAGE_ID],
      purpose: "read",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    expect(outcome.accepted).toBe(false)
    expect(JSON.stringify(posts)).not.toContain("SECRET-BODY")
  })

  it("keeps a conversion of mail outside the turn's scope refused, even with a yes", async () => {
    const asked: string[][] = []
    const { runtime, posts } = harness({
      confirmDisclosure: async (_text, ids) => {
        asked.push(ids)
        return true
      },
    })
    const turnNonce = runtime.beginTurn()
    runtime.handleAgentStreamEvent("mailbox_decrypt_request", {
      requestId: "req-convert-own",
      turnNonce,
      requestKind: "mail.convert",
      messageIds: [MESSAGE_ID],
      purpose: "make a ticket",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    await vi.waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ turnOwner: true, denied: {} })
    expect(asked).toHaveLength(0)
    expect(JSON.stringify(posts[0].body)).not.toContain("SECRET-BODY")
  })
})

describe("Run now's handoff", () => {
  it("answers the run's request in the click, for the turn the click opened", async () => {
    const { runtime, posts } = harness()
    const uninstall = installMailboxAgentRuntime(runtime)
    const turnNonce = runtime.beginTurn()
    const outcome = await answerMailboxHandoff(turnNonce, {
      requestId: "inst:handoff-1",
      messageIds: [MESSAGE_ID],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })
    uninstall()
    expect(outcome?.accepted).toBe(true)
    expect(posts).toHaveLength(1)
    expect(posts[0].path).toBe("/agent/mailbox-plaintext/inst:handoff-1")
    expect(posts[0].body.turnNonce).toBe(turnNonce)
    expect(JSON.stringify(posts[0].body)).toContain("SECRET-BODY")
  })

  it("releases nothing for a turn this window did not open, or with agent access off", async () => {
    for (const setup of [{ nonce: "forged" }, { nonce: null, agentAccess: false }]) {
      const { runtime, posts } = harness({ agentAccess: setup.agentAccess })
      const uninstall = installMailboxAgentRuntime(runtime)
      const turnNonce = setup.nonce ?? runtime.beginTurn()
      const outcome = await answerMailboxHandoff(turnNonce, {
        requestId: "inst:handoff-2",
        messageIds: [MESSAGE_ID],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      uninstall()
      expect(outcome?.accepted).toBe(false)
      // A refusal is posted, never a message body.
      expect(JSON.stringify(posts)).not.toContain("SECRET-BODY")
    }
  })
})
