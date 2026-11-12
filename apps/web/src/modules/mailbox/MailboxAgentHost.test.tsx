// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE THREE HALVES OF THE TWO-PHASE AGENT READ, wired together.
//
// Each of the three phases that built one of these verified its own half in
// isolation, and the protocol was dead in the running app because nothing
// connected them. This test drives the production path end to end and fails if
// ANY ONE of them comes loose again:
//
//   1. the `{ type: "status", scope: "mailbox" }` frame on the socket,
//   2. the turn nonce in the chat submit,
//   3. the responder subscribed to the `kernel:agent_stream` events.
//
// The one case at the bottom is deliberately not three cases: a nonce nobody
// asserted, a frame no request follows, and a request no turn owns each pass on
// their own while the feature does not work.

import { render, screen } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { dispatchWsEventMessage } from "~/framework/app-registry"
import { MailboxAgentHost } from "~/modules/mailbox/MailboxAgentHost"
import { beginMailboxAgentTurn, runMailboxJobTurn } from "~/modules/mailbox/mailbox-agent-runtime"

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111"

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn(), rawGet: vi.fn() },
  send: vi.fn(),
  unlocked: true,
  openMessage: vi.fn(),
  ensurePersonalAgentDm: vi.fn(async () => "dm-thread-1"),
  loadMessages: vi.fn(async () => {}),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: () => true,
}))
vi.mock("~/modules/shell/WsContext", () => ({
  useWs: () => ({ send: mocks.send, status: () => "connected" }),
  useOptionalWs: () => ({ send: mocks.send, status: () => "connected" }),
}))
vi.mock("~/modules/mailbox/mailbox-store", () => ({
  MAIL_READ_SCOPE: "mail:conversations:read",
  agentMailAccessSyncDeps: () => ({ userId: null, crypto: null }),
  mailboxStore: {
    get status() {
      return mocks.unlocked ? "unlocked" : "locked"
    },
    keyring: { identityId: "i", keyId: 1, identities: [{ keyId: 1, status: "active" }], wraps: [] },
    idleTimeoutMs: 0,
    lastErrorCode: null,
    deviceMissingKeyring: false,
  },
  isMailboxUnlocked: () => mocks.unlocked,
  mailboxCryptoClient: () => ({
    isUnlocked: () => mocks.unlocked,
    openMessage: mocks.openMessage,
    openAttachment: vi.fn(),
  }),
  openSealedMessage: vi.fn(),
}))
vi.mock("~/modules/threads/personal-dm-store", () => ({
  ensurePersonalAgentDm: mocks.ensurePersonalAgentDm,
}))
vi.mock("~/modules/mail/mail-message-store", () => ({
  sealedMessageById: (id: string) => ({ id, encVersion: 1, encKeyId: 1 }),
  loadedMailMessageIds: () => [MESSAGE_ID],
  loadMessages: mocks.loadMessages,
  getMessages: (conversationId: string) =>
    conversationId === "conv-1" ? [{ id: MESSAGE_ID }] : [],
}))

function dispatchDecryptRequest(
  turnNonce: string,
  requestId: string,
  messageIds: string[] = [MESSAGE_ID],
): void {
  dispatchWsEventMessage(
    {
      type: "event",
      payload: {
        app: "kernel",
        entity: "agent_stream",
        action: "mailbox_decrypt_request",
        data: {
          threadId: "thread-1",
          requestId,
          turnNonce,
          requestKind: "mail.read",
          messageIds,
          purpose: "answer the question about this thread",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: the dispatcher takes the raw frame
    } as any,
    { currentUserId: USER_ID, activeTabId: null, isDocumentVisible: true, isOwnAction: false },
  )
}

/** The ask the server sends for an app connected over MCP (mcp-mailbox-plaintext.ts). */
function dispatchMcpReadRequest(requestId: string, messageIds: string[] = [MESSAGE_ID]): void {
  dispatchWsEventMessage(
    {
      type: "event",
      payload: {
        app: "kernel",
        entity: "agent_stream",
        action: "mailbox_decrypt_request",
        data: {
          threadId: "connection-thread-1",
          requestId,
          turnNonce: `mcp:${requestId}`,
          origin: "mcp",
          connectionId: "c0ffee00-1111-4111-8111-111111111111",
          requestKind: "mail.read",
          messageIds,
          conversationId: "conv-1",
          purpose: "read this conversation to answer the user",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: the dispatcher takes the raw frame
    } as any,
    { currentUserId: USER_ID, activeTabId: null, isDocumentVisible: true, isOwnAction: false },
  )
}

describe("MailboxAgentHost", () => {
  beforeEach(() => {
    mocks.api.post.mockReset()
    mocks.api.post.mockResolvedValue({})
    mocks.ensurePersonalAgentDm.mockClear()
    mocks.send.mockReset()
    mocks.openMessage.mockReset()
    mocks.openMessage.mockResolvedValue({
      id: MESSAGE_ID,
      subject: "Invoice",
      textBody: "the body",
      htmlBody: null,
      snippet: null,
    })
    mocks.unlocked = true
    localStorage.clear()
  })

  it("asserts the unlock, carries the nonce, and answers the decrypt request", async () => {
    render(() => <MailboxAgentHost />)

    // 1. The unlock assertion. Without it the server reads every turn as locked.
    const frame = mocks.send.mock.calls.map(([f]) => f).find((f) => f?.scope === "mailbox")
    expect(frame).toMatchObject({ type: "status", scope: "mailbox", unlocked: true })
    expect(frame.keyIds).toEqual([1])

    // 2. The nonce a chat turn carries. Null here means no browser can answer.
    const turnNonce = beginMailboxAgentTurn()
    expect(typeof turnNonce).toBe("string")

    // 3. The responder, on the path the ephemeral event really takes.
    dispatchDecryptRequest(turnNonce as string, "req-1")
    await vi.waitFor(() => expect(mocks.api.post).toHaveBeenCalled())
    const [path, body] = mocks.api.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe("/agent/mailbox-plaintext/req-1")
    expect(body.turnNonce).toBe(turnNonce)
    expect(body.items).toEqual([
      { messageId: MESSAGE_ID, subject: "Invoice", textBody: "the body", htmlBody: null },
    ])
    // Non-vacuity: the plaintext really came from the crypto worker handle.
    expect(mocks.openMessage).toHaveBeenCalledTimes(1)
  })

  it("opens a batch's messages all at once, not one after another, and keeps their order", async () => {
    const second = "22222222-2222-4222-8222-222222222222"
    const opens: Array<{ id: string; resolve: () => void }> = []
    mocks.openMessage.mockImplementation(
      (sealed: { id: string }) =>
        new Promise((resolve) => {
          opens.push({
            id: sealed.id,
            resolve: () =>
              resolve({
                id: sealed.id,
                subject: null,
                textBody: `body ${sealed.id}`,
                htmlBody: null,
                snippet: null,
              }),
          })
        }),
    )
    render(() => <MailboxAgentHost />)
    const turnNonce = beginMailboxAgentTurn({ allowedIds: [MESSAGE_ID, second] }) as string
    dispatchDecryptRequest(turnNonce, "req-batch", [MESSAGE_ID, second])
    // Both opens are in flight before either finishes.
    await vi.waitFor(() => expect(opens.length).toBe(2))
    expect(mocks.api.post).not.toHaveBeenCalled()
    opens[1].resolve()
    opens[0].resolve()
    await vi.waitFor(() => expect(mocks.api.post).toHaveBeenCalled())
    const [, body] = mocks.api.post.mock.calls[0] as [string, Record<string, unknown>]
    expect((body.items as Array<{ messageId: string }>).map((i) => i.messageId)).toEqual([
      MESSAGE_ID,
      second,
    ])
  })

  it("stays silent on a request naming a turn this browser never started", async () => {
    // Another client of the same user started that turn and is the only one
    // that can answer it. A refusal from here would arrive first and settle
    // the request before that client's plaintext.
    render(() => <MailboxAgentHost />)
    dispatchDecryptRequest("a-turn-nobody-here-opened", "req-2")
    await new Promise((r) => setTimeout(r, 50))
    expect(mocks.api.post).not.toHaveBeenCalled()
    expect(mocks.openMessage).not.toHaveBeenCalled()
  })

  it("starts building the client search index once the mailbox is unlocked", async () => {
    mocks.api.get.mockReset()
    mocks.api.get.mockRejectedValue(new Error("no such route"))
    render(() => <MailboxAgentHost />)
    // The client index is the ONLY index over sealed mail: the server one is
    // deliberately empty. Nobody was building it.
    await vi.waitFor(() =>
      expect(
        mocks.api.get.mock.calls.some(([path]) => String(path).startsWith("/mailbox/sync-cursor")),
      ).toBe(true),
    )
    // A listing this deployment does not serve leaves search UNAVAILABLE, which
    // is a sentence the user sees, never a silent empty result set.
    const { searchIndexStore } = await import("~/modules/mailbox/search-index/search-index-store")
    await vi.waitFor(() => expect(searchIndexStore.status).toBe("unavailable"))
  })

  it("honours the settings switch that turns the assistant off", async () => {
    const { setAgentMailAccessEnabled } = await import("~/modules/mailbox/agent-mail-access")
    setAgentMailAccessEnabled(false)
    render(() => <MailboxAgentHost />)
    const turnNonce = beginMailboxAgentTurn() as string
    dispatchDecryptRequest(turnNonce, "req-3")
    await vi.waitFor(() => expect(mocks.api.post).toHaveBeenCalled())
    const [, body] = mocks.api.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.denied).toBeTruthy()
    expect(mocks.openMessage).not.toHaveBeenCalled()
    setAgentMailAccessEnabled(true)
  })

  // P4c FX-B3 (D4): this host created its job-turn thread with `POST /threads
  // { type: "agent_chat" }`, a route T04 retired (400 `agent_chat_retired`), so
  // every drained mail job would have failed at thread creation. The one
  // conversation with the personal agent is the DM, resolved through
  // `POST /threads/dm`.
  it("the mailbox agent host resolves its conversation through /threads/dm, never type agent_chat", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("no network in this test"))
    vi.stubGlobal("fetch", fetchMock)
    try {
      render(() => <MailboxAgentHost />)
      await expect(
        runMailboxJobTurn({
          jobId: "job-1",
          kind: "mail.triage",
          prompt: "envelope only",
          turnNonce: "drainer-placeholder",
          messageIds: [MESSAGE_ID],
          plaintext: [],
        }),
      ).rejects.toThrow()

      // The DM store is the ONLY route to the conversation.
      expect(mocks.ensurePersonalAgentDm).toHaveBeenCalledTimes(1)
      const retired = mocks.api.post.mock.calls.some(
        ([path, body]) =>
          String(path) === "/threads" &&
          (body as { type?: string } | undefined)?.type === "agent_chat",
      )
      expect(retired).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("asserts a locked mailbox rather than staying silent", async () => {
    mocks.unlocked = false
    render(() => <MailboxAgentHost />)
    const frame = mocks.send.mock.calls.map(([f]) => f).find((f) => f?.scope === "mailbox")
    expect(frame).toMatchObject({ unlocked: false, keyIds: [] })
  })

  it("a read asked by an app connected over MCP is answered at once, with no prompt", async () => {
    render(() => <MailboxAgentHost />)
    dispatchMcpReadRequest("req-mcp-1")
    await vi.waitFor(() => expect(mocks.api.post).toHaveBeenCalled())
    const [path, body] = mocks.api.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(path).toBe("/agent/mailbox-plaintext/req-mcp-1")
    expect(body.turnNonce).toBe("mcp:req-mcp-1")
    expect(body.items).toEqual([
      { messageId: MESSAGE_ID, subject: "Invoice", textBody: "the body", htmlBody: null },
    ])
    // The conversation was loaded into this window before anything was opened.
    expect(mocks.loadMessages).toHaveBeenCalledWith(mocks.api, "conv-1")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("an MCP read while the mailbox is locked releases nothing and says it is locked", async () => {
    mocks.unlocked = false
    render(() => <MailboxAgentHost />)
    dispatchMcpReadRequest("req-mcp-2")
    await vi.waitFor(() =>
      expect(
        mocks.api.post.mock.calls.some(([path]) => path === "/agent/mailbox-plaintext/req-mcp-2"),
      ).toBe(true),
    )
    const [, body] = mocks.api.post.mock.calls.find(
      ([path]) => path === "/agent/mailbox-plaintext/req-mcp-2",
    ) as [string, Record<string, unknown>]
    expect(body.denied).toMatchObject({ code: "locked" })
    expect(body.items).toBeUndefined()
    expect(mocks.openMessage).not.toHaveBeenCalled()
  })

  it("an MCP read naming a message outside the conversation is refused whole", async () => {
    render(() => <MailboxAgentHost />)
    dispatchMcpReadRequest("req-mcp-3", [MESSAGE_ID, "99999999-9999-4999-8999-999999999999"])
    await vi.waitFor(() => expect(mocks.api.post).toHaveBeenCalled())
    const [, body] = mocks.api.post.mock.calls[0] as [string, Record<string, unknown>]
    expect(body.denied).toBeTruthy()
    expect(mocks.openMessage).not.toHaveBeenCalled()
  })
})
