// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The browser's half of an MCP client's encrypted mail read.
//
// An app connected to Liaison over MCP (Claude desktop, Claude Code) acts for
// this same user, but no turn of THIS browser started its call, so the in-app
// responder refuses it on the turn nonce, by design: a server naming ids for a
// turn the browser did not start is exactly what that check exists to stop.
//
// Here the user's consent is the MCP connection itself: they connected that app
// with their own login, and the server routes the ask to this user's own
// sockets only. So it is answered without a prompt, the same way any of the
// user's unlocked apps answers their own agent. What still holds: the mailbox
// must be unlocked in an open window, the settings switch that turns agent mail
// access off applies here too, a read is capped per request, and every id must
// belong to the conversation the ask names. Keys never leave this window; only
// the opened text goes back, over the authenticated REST route, to the one
// waiting call.

import type { OpenedMessage } from "~/modules/mailbox/crypto-protocol"

/** Mirrors the in-app per-request cap. */
export const MCP_MAX_MESSAGES_PER_REQUEST = 25

export interface McpMailboxRequest {
  requestId: string
  turnNonce: string
  requestKind: "mail.read" | "mail.search"
  messageIds: string[]
  conversationId?: string
  query?: string
  filters?: unknown
  limit?: number
}

export interface McpPlaintextResponderDeps {
  isUnlocked(): boolean
  agentMailAccessEnabled(): boolean
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
}

export interface McpPlaintextResponder {
  handle(request: McpMailboxRequest): Promise<{ accepted: boolean; reason?: string }>
}

/** Reads the ids-only ask off the socket frame, or null when it is not one. */
export function readMcpMailboxRequest(action: string, data: unknown): McpMailboxRequest | null {
  if (!data || typeof data !== "object") return null
  const frame = data as Record<string, unknown>
  if (frame.origin !== "mcp") return null
  if (typeof frame.requestId !== "string" || typeof frame.turnNonce !== "string") return null
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
  }
}
