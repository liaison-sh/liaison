// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { z } from "zod"
import { initEventBus, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import {
  MailboxPlaintextRegistryTestAccess,
  type MailboxRequestResponse,
  resolveMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import { toolRegistry } from "~/modules/apps/app-registries"
import {
  fulfilMcpMailboxMarker,
  MCP_MAILBOX_OPEN_AND_UNLOCK,
  type McpMailboxDeps,
} from "~/modules/mcp/mcp-mailbox-plaintext"
import {
  cleanupSeededOrg,
  seedMcpConnection,
  seedOrgWithTicketsApp,
  userContextFor,
} from "~/modules/mcp/test-helpers"
import { handleToolCall } from "~/modules/mcp/tool-call"

const USER = "00000000-0000-4000-8000-0000000000a1"
const sealedRead = () => ({
  conversation: { id: "conv-1", encrypted: true },
  envelope: [{ messageId: "m1" }, { messageId: "m2" }],
  needsPlaintext: {
    requestKind: "mail.read",
    messageIds: ["m1", "m2"],
    purpose: "read this conversation to answer the user",
  },
})

/** A browser double: records each ask and answers it the way the window would. */
function fakeWindow(opts: {
  unlocked: boolean
  answer?: (ask: Record<string, unknown>) => MailboxRequestResponse | null
}) {
  const asks: Array<{ action: string; data: Record<string, unknown> }> = []
  const deps: McpMailboxDeps = {
    async getUnlock() {
      return opts.unlocked
        ? { unlocked: true, keyIds: [1], expiresAt: Date.now() + 60_000 }
        : undefined
    },
    async emit(action, data) {
      asks.push({ action, data })
      const response = opts.answer?.(data)
      if (response) {
        queueMicrotask(() =>
          resolveMailboxRequest(String(data.requestId), {
            userId: USER,
            turnNonce: String(data.turnNonce),
            response,
          }),
        )
      }
    },
    async clientIdentity() {
      return { label: "Claude Code", connectedAt: "2026-09-30T12:00:00.000Z" }
    },
  }
  return { deps, asks }
}

const base = { orgId: "org-1", userId: USER, connectionId: "conn-1", threadId: "thread-1" }

afterEach(() => MailboxPlaintextRegistryTestAccess.reset())

describe("MCP mailbox read through the user's own window", () => {
  it("with no unlocked window, says what to do instead of returning an empty body", async () => {
    const { deps, asks } = fakeWindow({ unlocked: false })
    const out = await fulfilMcpMailboxMarker({ ...base, result: sealedRead(), deps })
    const result = out.result as Record<string, any>
    expect(result.needsPlaintext).toBeUndefined()
    expect(result.mailbox).toEqual({
      status: "MAILBOX_LOCKED",
      message: MCP_MAILBOX_OPEN_AND_UNLOCK,
    })
    expect(result.envelope).toHaveLength(2)
    expect(asks).toHaveLength(0)
  })

  it("asks the window with ids only, and returns the plaintext it supplies for this call", async () => {
    const { deps, asks } = fakeWindow({
      unlocked: true,
      answer: () => ({
        kind: "plaintext",
        items: [
          { messageId: "m1", subject: "Invoice", textBody: "Please find the invoice." },
          { messageId: "m2", subject: "Re: Invoice", textBody: "Thanks." },
          // Never asked for: must not reach the caller.
          { messageId: "m9", subject: "Other", textBody: "Not this one." },
        ],
        undecryptable: [],
      }),
    })
    const out = await fulfilMcpMailboxMarker({
      ...base,
      result: sealedRead(),
      conversationId: "conv-1",
      deps,
    })
    expect(asks).toHaveLength(1)
    expect(asks[0]?.action).toBe("mailbox_decrypt_request")
    expect(asks[0]?.data).toMatchObject({
      origin: "mcp",
      connectionId: "conn-1",
      client: "Claude Code",
      clientConnectedAt: "2026-09-30T12:00:00.000Z",
      requestKind: "mail.read",
      messageIds: ["m1", "m2"],
      conversationId: "conv-1",
    })
    // The ask carries no content of any kind.
    expect(JSON.stringify(asks[0]?.data)).not.toContain("invoice")
    const result = out.result as Record<string, any>
    expect(result.needsPlaintext).toBeUndefined()
    expect(result.mailbox.status).toBe("delivered")
    expect(result.mailbox.messages).toEqual([
      { messageId: "m1", subject: "Invoice", textBody: "Please find the invoice." },
      { messageId: "m2", subject: "Re: Invoice", textBody: "Thanks." },
    ])
  })

  it("relays the user's refusal as a named status", async () => {
    const { deps } = fakeWindow({
      unlocked: true,
      answer: () => ({ kind: "denied", reason: "you chose not to share these messages" }),
    })
    const out = await fulfilMcpMailboxMarker({ ...base, result: sealedRead(), deps })
    expect((out.result as any).mailbox.status).toBe("MAILBOX_DENIED")
    expect((out.result as any).mailbox.message).toContain("you chose not to share")
  })

  it("an older window that refuses the turn tells the user to reload, not that they said no", async () => {
    const { deps } = fakeWindow({
      unlocked: true,
      answer: () => ({
        kind: "denied",
        reason:
          "this request names a turn this browser did not start, or one that is no longer open",
      }),
    })
    const out = await fulfilMcpMailboxMarker({ ...base, result: sealedRead(), deps })
    expect((out.result as any).mailbox.status).toBe("MAILBOX_LOCKED")
    expect((out.result as any).mailbox.message).toContain("reload Liaison")
  })

  it("a window that never answers times out to an actionable status", async () => {
    const { deps } = fakeWindow({ unlocked: true })
    const out = await fulfilMcpMailboxMarker({ ...base, result: sealedRead(), deps, waitMs: 20 })
    expect((out.result as any).mailbox.status).toBe("MAILBOX_LOCKED")
    expect((out.result as any).mailbox.message).toContain("did not answer in time")
  })

  it("a free text search hands back the ids the window matched as retry arguments", async () => {
    const { deps, asks } = fakeWindow({
      unlocked: true,
      answer: () => ({ kind: "search", messageIds: ["m4"], indexComplete: true }),
    })
    const out = await fulfilMcpMailboxMarker({
      ...base,
      result: { items: [], totalCount: 0, needsClientSearch: { query: "invoice", limit: 10 } },
      deps,
    })
    expect(asks[0]?.action).toBe("mailbox_search_request")
    expect(out.retryArgs).toEqual({
      __mailboxSearchIds: ["m4"],
      __mailboxSearchIndexComplete: true,
    })
  })
})

describe("MCP tools/call wiring", () => {
  let orgId: string
  let ownerId: string
  let scopes: string[]

  beforeAll(async () => {
    resetEventBus()
    initEventBus()
    registerEventSubscribers({
      bufferAndBroadcast: async () => {},
      broadcast: async () => {},
    } as any)
    const seed = await seedOrgWithTicketsApp()
    orgId = seed.orgId
    ownerId = seed.ownerId
    scopes = seed.scopes
    // Stands in for mail:read on an encrypted mailbox: the envelope and the marker.
    toolRegistry.set([orgId, "kernel", "sealed_read_probe"], {
      appName: "kernel",
      name: "sealed_read_probe",
      readOnly: true,
      description: "test probe",
      requiredScopes: ["test:items:read"],
      params: z.object({ conversationId: z.string().optional() }),
      handler: (async () => sealedRead()) as (p: unknown, c: unknown) => Promise<unknown>,
    })
  })

  afterAll(async () => {
    await cleanupSeededOrg(orgId)
  })

  it("an MCP read of an encrypted mailbox no longer hands the raw marker to the client", async () => {
    const conn = await seedMcpConnection({
      orgId,
      userId: ownerId,
      clientId: "claude-code",
      label: "Claude Code",
    })
    const result = (await handleToolCall(
      {
        orgId,
        actor: userContextFor(orgId, ownerId, scopes),
        connectionId: conn.id,
        ownerUserId: ownerId,
        connectionThreadId: null,
        discovered: new Set(),
      },
      "kernel__sealed_read_probe",
      { conversationId: "conv-1" },
    )) as { structuredContent?: Record<string, any>; isError?: boolean }
    expect(result.isError).toBeFalsy()
    const data = result.structuredContent ?? {}
    expect(data.needsPlaintext).toBeUndefined()
    // No socket server runs in this process, so no window is open: the caller is
    // told how to make one available.
    expect(data.mailbox).toEqual({ status: "MAILBOX_LOCKED", message: MCP_MAILBOX_OPEN_AND_UNLOCK })
    expect(data.envelope).toHaveLength(2)
  })
})
