// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import {
  createMcpPlaintextResponder,
  type McpMailboxRequest,
  readMcpMailboxRequest,
} from "~/modules/mailbox/mcp-plaintext-responder"

function setup(opts: { unlocked?: boolean; agentMailAccess?: boolean } = {}) {
  const postPlaintext = vi.fn(async (_id: string, _body: Record<string, unknown>) => {})
  const openMessages = vi.fn(async (ids: string[]) =>
    ids.map((id) => ({ id, subject: "s", textBody: "t", htmlBody: null, snippet: null })),
  )
  const responder = createMcpPlaintextResponder({
    isUnlocked: () => opts.unlocked ?? true,
    agentMailAccessEnabled: () => opts.agentMailAccess ?? true,
    loadConversation: async () => {},
    conversationMessageIds: () => ["m1"],
    openMessages,
    postPlaintext,
    postSearch: vi.fn(async () => {}),
  })
  return { responder, postPlaintext, openMessages }
}

const read = (n: number): McpMailboxRequest => ({
  requestId: `r${n}`,
  turnNonce: `mcp:r${n}`,
  requestKind: "mail.read",
  messageIds: ["m1"],
  conversationId: "conv-1",
})

describe("MCP plaintext responder", () => {
  it("only reads frames the server marked as coming from an MCP client", () => {
    expect(readMcpMailboxRequest("mailbox_decrypt_request", { ...read(1) })).toBeNull()
    expect(
      readMcpMailboxRequest("mailbox_decrypt_request", { ...read(1), origin: "mcp" }),
    ).toMatchObject({ requestId: "r1", conversationId: "conv-1" })
  })

  it("answers every read of an unlocked mailbox without asking", async () => {
    const t = setup()
    expect(await t.responder.handle(read(1))).toEqual({ accepted: true })
    expect(await t.responder.handle(read(2))).toEqual({ accepted: true })
    expect(t.postPlaintext).toHaveBeenCalledTimes(2)
    expect(t.postPlaintext.mock.calls[0]?.[1]).toMatchObject({
      items: [{ messageId: "m1", subject: "s", textBody: "t" }],
    })
  })

  it("releases nothing while locked or with agent mail access turned off", async () => {
    for (const opts of [{ unlocked: false }, { agentMailAccess: false }]) {
      const t = setup(opts)
      expect((await t.responder.handle(read(1))).accepted).toBe(false)
      expect(t.openMessages).not.toHaveBeenCalled()
      expect(t.postPlaintext.mock.calls[0]?.[1]).toHaveProperty("denied")
    }
  })
})
