// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The browser's half of an MCP client's encrypted mail read.
//
// An app connected to Liaison over MCP (Claude desktop, Claude Code) acts for
// this same user, but no turn of THIS browser started its call, so the in-app
// responder refuses it on the turn nonce, by design: a server naming ids for a
// turn the browser did not start is exactly what that check exists to stop.
//
// Here the consent comes from the user instead. Every ask names the connected
// app and how many messages it wants, and the user answers in this window:
// allow once, allow that app for a short while, or deny. Nothing is released
// without that answer, the mailbox must be unlocked, the settings switch that
// turns agent mail access off applies here too, and every id must belong to the
// conversation the ask names. Keys never leave this window; only the opened
// text goes back, over the authenticated REST route, to the one waiting call.

import type { OpenedMessage } from "~/modules/mailbox/crypto-protocol"

/** How long "allow for a while" lasts, per connected app. */
export const MCP_ACCESS_GRANT_MS = 15 * 60 * 1000
/** Mirrors the in-app per-request cap. */
export const MCP_MAX_MESSAGES_PER_REQUEST = 25

export type McpAccessAnswer = "once" | "window" | "deny"

export interface McpMailboxRequest {
  requestId: string
  turnNonce: string
  requestKind: "mail.read" | "mail.search"
  /**
   * The MCP connection the ask came from, as the server resolved it from the
   * caller's token. Grants are keyed on THIS, never on the name.
   */
  connectionId: string
  /** The name the app registered under and the user saw at consent. Self-chosen
   *  by the app, so it is shown beside the connection's date, never alone. */
  client: string
  /** When the user created this connection (server record), ISO 8601. */
  clientConnectedAt: string | null
  messageIds: string[]
  conversationId?: string
  query?: string
  filters?: unknown
  limit?: number
}

export interface McpAccessPrompt {
  connectionId: string
  client: string
  clientConnectedAt: string | null
  requestKind: "mail.read" | "mail.search"
  messageCount: number
  query?: string
}

export interface McpPlaintextResponderDeps {
  isUnlocked(): boolean
  agentMailAccessEnabled(): boolean
  /** Shows the prompt in this window and resolves to the user's answer. */
  askUser(prompt: McpAccessPrompt): Promise<McpAccessAnswer>
  /** Loads the conversation's sealed rows into this window. */
  loadConversation(conversationId: string): Promise<void>
  /** The ids of the messages this window holds for that conversation. */
  conversationMessageIds(conversationId: string): readonly string[]
  /** Opens loaded sealed rows in the crypto worker. */
  openMessages(messageIds: string[]): Promise<OpenedMessage[]>
  postPlaintext(requestId: string, body: Record<string, unknown>): Promise<void>
  postSearch(requestId: string, body: Record<string, unknown>): Promise<void>
  /** The local search index, when this device has one. */
  search?(request: McpMailboxRequest): Promise<{ messageIds: string[]; indexComplete: boolean }>
  now?(): number
}

export interface McpPlaintextResponder {
  handle(request: McpMailboxRequest): Promise<{ accepted: boolean; reason?: string }>
  /** Called on lock: every standing "allow for a while" ends with the session. */
  reset(): void
}

/** Reads the ids-only ask off the socket frame, or null when it is not one. */
export function readMcpMailboxRequest(action: string, data: unknown): McpMailboxRequest | null {
  if (!data || typeof data !== "object") return null
  const frame = data as Record<string, unknown>
  if (frame.origin !== "mcp") return null
  if (typeof frame.requestId !== "string" || typeof frame.turnNonce !== "string") return null
  // No connection, no grant key and no identity to show: not answerable here.
  if (typeof frame.connectionId !== "string" || frame.connectionId === "") return null
  const requestKind =
    action === "mailbox_search_request"
      ? "mail.search"
      : frame.requestKind === "mail.read"
        ? "mail.read"
        : null
  if (!requestKind) return null
  return {
    requestId: frame.requestId,
    turnNonce: frame.turnNonce,
    requestKind,
    connectionId: frame.connectionId,
    clientConnectedAt: typeof frame.clientConnectedAt === "string" ? frame.clientConnectedAt : null,
    client:
      typeof frame.client === "string" && frame.client.trim() ? frame.client : "A connected app",
    messageIds: Array.isArray(frame.messageIds)
      ? frame.messageIds.filter((v): v is string => typeof v === "string")
      : [],
    ...(typeof frame.conversationId === "string" ? { conversationId: frame.conversationId } : {}),
    ...(typeof frame.query === "string" ? { query: frame.query } : {}),
    ...(frame.filters !== undefined ? { filters: frame.filters } : {}),
    ...(typeof frame.limit === "number" ? { limit: frame.limit } : {}),
  }
}

export function createMcpPlaintextResponder(
  deps: McpPlaintextResponderDeps,
): McpPlaintextResponder {
  const now = deps.now ?? (() => Date.now())
  const grants = new Map<string, number>()

  async function refuse(request: McpMailboxRequest, reason: string, code?: "locked") {
    try {
      if (request.requestKind === "mail.search") {
        await deps.postSearch(request.requestId, {
          turnNonce: request.turnNonce,
          messageIds: [],
          indexComplete: false,
        })
      } else {
        await deps.postPlaintext(request.requestId, {
          turnNonce: request.turnNonce,
          denied: { reason, ...(code ? { code } : {}) },
        })
      }
    } catch {
      // A refusal that cannot be delivered still stands: the call times out.
    }
    return { accepted: false, reason }
  }

  async function consent(request: McpMailboxRequest): Promise<boolean> {
    // Keyed on the connection: another client of this user that registered
    // under the same name holds a different connection and is asked again.
    const until = grants.get(request.connectionId)
    if (until !== undefined && until > now()) return true
    const answer = await deps.askUser({
      connectionId: request.connectionId,
      client: request.client,
      clientConnectedAt: request.clientConnectedAt,
      requestKind: request.requestKind,
      messageCount: request.messageIds.length,
      ...(request.query ? { query: request.query } : {}),
    })
    if (answer === "window") grants.set(request.connectionId, now() + MCP_ACCESS_GRANT_MS)
    return answer !== "deny"
  }

  return {
    async handle(request) {
      if (!deps.agentMailAccessEnabled()) {
        return await refuse(
          request,
          "the agent's access to this mailbox is turned off in the mailbox security settings",
        )
      }
      if (!deps.isUnlocked()) {
        // Another window of this user may be unlocked: the server holds this
        // refusal briefly for its answer rather than settling on it.
        return await refuse(
          request,
          "this mailbox is locked, so nothing can be decrypted",
          "locked",
        )
      }

      if (request.requestKind === "mail.search") {
        if (!deps.search) return await refuse(request, "this device has no search index")
        if (!(await consent(request))) {
          return await refuse(request, "the user chose not to let this app search the mailbox")
        }
        const outcome = await deps.search(request)
        await deps.postSearch(request.requestId, {
          turnNonce: request.turnNonce,
          messageIds: outcome.messageIds,
          indexComplete: outcome.indexComplete,
        })
        return { accepted: true }
      }

      const ids = request.messageIds
      if (ids.length === 0) return await refuse(request, "this request named no messages")
      if (ids.length > MCP_MAX_MESSAGES_PER_REQUEST) {
        return await refuse(
          request,
          `one request may ask for at most ${MCP_MAX_MESSAGES_PER_REQUEST} messages, and this one asked for ${ids.length}`,
        )
      }
      if (!request.conversationId) {
        return await refuse(request, "this request named no conversation")
      }
      if (!(await consent(request))) {
        return await refuse(request, "the user chose not to share these messages with this app")
      }
      await deps.loadConversation(request.conversationId)
      const inConversation = new Set(deps.conversationMessageIds(request.conversationId))
      // Refused whole, never served in part: a partial answer would tell the
      // caller which of its guessed ids exist.
      if (ids.some((id) => !inConversation.has(id))) {
        return await refuse(
          request,
          "some of the messages asked for are not in the conversation named, so nothing was released",
        )
      }
      const opened = await deps.openMessages(ids)
      const byId = new Map(opened.map((m) => [m.id, m]))
      await deps.postPlaintext(request.requestId, {
        turnNonce: request.turnNonce,
        items: opened.map((m) => ({
          messageId: m.id,
          subject: m.subject,
          textBody: m.textBody,
          htmlBody: m.htmlBody,
        })),
        undecryptable: ids.filter((id) => !byId.has(id)),
      })
      return { accepted: true }
    },
    reset() {
      grants.clear()
    },
  }
}
