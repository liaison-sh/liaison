// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import {
  createMcpPlaintextResponder,
  MCP_ACCESS_GRANT_MS,
  type McpAccessPrompt,
  type McpMailboxRequest,
  readMcpMailboxRequest,
} from "~/modules/mailbox/mcp-plaintext-responder"

function setup(answer: "once" | "window" | "deny") {
  let clock = 1_000
  const askUser = vi.fn(async (_prompt: McpAccessPrompt) => answer)
  const postPlaintext = vi.fn(async () => {})
  const responder = createMcpPlaintextResponder({
    isUnlocked: () => true,
    agentMailAccessEnabled: () => true,
    askUser,
    loadConversation: async () => {},
    conversationMessageIds: () => ["m1"],
    openMessages: async (ids) =>
      ids.map((id) => ({ id, subject: "s", textBody: "t", htmlBody: null, snippet: null })),
    postPlaintext,
    postSearch: vi.fn(async () => {}),
    now: () => clock,
  })
  return {
    responder,
    askUser,
    postPlaintext,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const read = (n: number, connectionId = "conn-claude"): McpMailboxRequest => ({
  requestId: `r${n}`,
  turnNonce: `mcp:r${n}`,
  requestKind: "mail.read",
  connectionId,
  client: "Claude Code",
  clientConnectedAt: "2026-09-30T12:00:00.000Z",
  messageIds: ["m1"],
  conversationId: "conv-1",
})

describe("MCP plaintext responder", () => {
  it("only reads frames the server marked as coming from an MCP client", () => {
    expect(readMcpMailboxRequest("mailbox_decrypt_request", { ...read(1) })).toBeNull()
    expect(
      readMcpMailboxRequest("mailbox_decrypt_request", { ...read(1), origin: "mcp" }),
    ).toMatchObject({ requestId: "r1", connectionId: "conn-claude", conversationId: "conv-1" })
    // No server-resolved connection: nothing to key a grant on, so not answered.
    const { connectionId: _dropped, ...anonymous } = read(1)
    expect(
      readMcpMailboxRequest("mailbox_decrypt_request", { ...anonymous, origin: "mcp" }),
    ).toBeNull()
  })

  it("allow once asks again next time", async () => {
    const t = setup("once")
    await t.responder.handle(read(1))
    await t.responder.handle(read(2))
    expect(t.askUser).toHaveBeenCalledTimes(2)
  })

  it("allow for a while stops asking that app until it lapses or the mailbox locks", async () => {
    const t = setup("window")
    await t.responder.handle(read(1))
    await t.responder.handle(read(2))
    expect(t.askUser).toHaveBeenCalledTimes(1)
    t.advance(MCP_ACCESS_GRANT_MS + 1)
    await t.responder.handle(read(3))
    expect(t.askUser).toHaveBeenCalledTimes(2)
    t.responder.reset()
    await t.responder.handle(read(4))
    expect(t.askUser).toHaveBeenCalledTimes(3)
    expect(t.postPlaintext).toHaveBeenCalledTimes(4)
  })

  it("a grant belongs to the connection, not to the name: a second client called the same is asked", async () => {
    const t = setup("window")
    await t.responder.handle(read(1, "conn-claude"))
    // Another MCP client of this user that registered under the very same name.
    await t.responder.handle(read(2, "conn-impostor"))
    expect(t.askUser).toHaveBeenCalledTimes(2)
    expect(t.askUser.mock.calls[1]?.[0]).toMatchObject({
      connectionId: "conn-impostor",
      client: "Claude Code",
    })
    // The genuine connection's grant still stands.
    await t.responder.handle(read(3, "conn-claude"))
    expect(t.askUser).toHaveBeenCalledTimes(2)
  })
})
