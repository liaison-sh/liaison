// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE BROWSER HALF OF THE TWO-PHASE AGENT READ (spec sections 5.3b, 5.3c and
// 9.8). Phases 9, 10 and 11 each built one piece of it; this is where the
// pieces meet the running app.
//
// Three wirings, and the protocol is dead unless all three are live:
//
//   1. THE UNLOCK ASSERTION. `{ type: "status", scope: "mailbox", unlocked,
//      keyIds }` on the socket. Without it `wsManager.getMailboxUnlock` is
//      undefined and the server short-circuits every marker to MAILBOX_LOCKED.
//   2. THE TURN NONCE. Minted here when a turn is submitted and carried in the
//      `POST /api/agent/chat` body. Without it the broker refuses to ask,
//      because a turn with no nonce was not started by a browser that can
//      answer it.
//   3. THE RESPONDER. Subscribed to the ephemeral `mailbox_decrypt_request` /
//      `mailbox_search_request` events, so `POST /api/agent/mailbox-plaintext/
//      :requestId` is actually called. Any of the user's unlocked apps answers
//      for the user's own agent, not only the window that started the turn: a
//      request for another app's turn is answered with its answer token.
//
// Nothing here holds key material. It moves ids and ciphertext-shaped strings
// between the socket, the crypto worker handle and the REST surface, and every
// consent decision is taken by `agent-plaintext-responder.ts`, on this client's
// own evidence.

import {
  type AgentDecryptRequest,
  type AgentDecryptRequestKind,
  type AgentPlaintextOutcome,
  type AgentPlaintextResponder,
  createAgentPlaintextResponder,
  type DisclosureEntry,
} from "~/modules/mailbox/agent-plaintext-responder"
import { createJobAgentTurnRunner } from "~/modules/mailbox/agent-turn-runner"
import {
  type AgentTurnSession,
  createAgentTurnSession,
  openMessagesForTurn,
} from "~/modules/mailbox/agent-turn-session"
import type { AgentTurnRequest, AgentTurnRunner } from "~/modules/mailbox/client-job-drainer"
import type { OpenedMessage } from "~/modules/mailbox/crypto-protocol"
import {
  type McpPlaintextResponder,
  readMcpMailboxRequest,
} from "~/modules/mailbox/mcp-plaintext-responder"
import type { SearchIndexAdapter } from "~/modules/mailbox/search-index/adapter"
import { answerClientSearch } from "~/modules/mailbox/search-index/client-search-responder"

/** The socket frame the server parses in `lib/mailbox-status-frame.ts`. */
export interface MailboxStatusFrame {
  type: "status"
  scope: "mailbox"
  unlocked: boolean
  keyIds: number[]
  /**
   * The turns this client started and still has open. Only this client can
   * answer for them, so the server stops waiting once no connection holds one.
   */
  turns: string[]
}

/**
 * The server holds the assertion for 90 s. Re-asserting at 45 s keeps an
 * unlocked mailbox continuously readable without making the socket chatty, and
 * a tab that dies simply stops asserting, which reads as locked.
 */
export const MAILBOX_STATUS_REFRESH_MS = 45_000

export interface MailboxAgentRuntimeDeps {
  /** `POST /api/<path>`, kernel-relative (the api client adds the prefix). */
  post(path: string, body: unknown): Promise<unknown>
  /** The websocket send. */
  send(frame: unknown): void
  isUnlocked(): boolean
  /** Key ids on this keyring, for the assertion. Metadata, never key material. */
  keyIds(): number[]
  /** Opens sealed rows in the crypto worker. Ids the caller could not open are
   *  simply absent from the result, which the responder reports as undecryptable. */
  openMessages(messageIds: string[]): Promise<OpenedMessage[]>
  openAttachments?(fileIds: string[]): Promise<Array<{ fileId: string; bytesBase64: string }>>
  /** The settings switch. */
  agentMailAccessEnabled(): boolean
  /**
   * Ids the mail surface has actually surfaced: the turn's scope, which binds a
   * conversion (and serves plaintext this tab already holds). Reads are not
   * limited to it.
   */
  turnScopeIds(): readonly string[]
  /** The client search index, when one has been built on this device. */
  searchAdapter?(): SearchIndexAdapter | null
  indexComplete?(): boolean
  recordDisclosure?(entry: DisclosureEntry): void
  confirmDisclosure?(disclosure: string, messageIds: string[]): Promise<boolean>
  /** Submits a server-side turn for a drained client job (blueprint Task 11.3). */
  submitTurn?(input: { prompt: string; turnNonce: string }): Promise<{ text: string }>
  /**
   * Answers reads asked by an app connected over MCP for this same user, after
   * asking the user in this window (mcp-plaintext-responder.ts). Absent, such an
   * ask falls through to the in-app responder, which refuses it.
   */
  mcpResponder?: McpPlaintextResponder
}

export interface MailboxAgentRuntime {
  session: AgentTurnSession
  responder: AgentPlaintextResponder
  /** Opens a turn scope and returns the nonce the chat POST must carry. */
  beginTurn(input?: { allowedIds?: readonly string[] }): string
  endTurn(turnNonce: string): void
  /** Asserts the current lock state to the server. */
  sendStatusFrame(): void
  /**
   * Routes one `kernel:agent_stream` event. Returns true when it was a mailbox
   * request, so the caller knows the thread stream has nothing to do with it.
   */
  handleAgentStreamEvent(action: string, data: unknown): boolean
  /** The client job drainer's turn runner. Throws when no `submitTurn` exists. */
  runJobTurn: AgentTurnRunner
  reset(): void
}

const DECRYPT_ACTION = "mailbox_decrypt_request"
const SEARCH_ACTION = "mailbox_search_request"

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

/** The request as it arrives on the wire, validated before anything acts on it. */
function readDecryptRequest(data: unknown): AgentDecryptRequest | null {
  if (!data || typeof data !== "object") return null
  const frame = data as Record<string, unknown>
  const requestId = frame.requestId
  const turnNonce = frame.turnNonce
  const requestKind = frame.requestKind
  if (typeof requestId !== "string" || typeof turnNonce !== "string") return null
  if (typeof requestKind !== "string") return null
  return {
    requestId,
    turnNonce,
    requestKind: requestKind as AgentDecryptRequestKind,
    messageIds: asStringArray(frame.messageIds),
    purpose: typeof frame.purpose === "string" ? frame.purpose : "",
    expiresAt: typeof frame.expiresAt === "string" ? frame.expiresAt : "",
    ...(typeof frame.disclosure === "string" ? { disclosure: frame.disclosure } : {}),
    ...(typeof frame.answerToken === "string" ? { answerToken: frame.answerToken } : {}),
  }
}

export function createMailboxAgentRuntime(deps: MailboxAgentRuntimeDeps): MailboxAgentRuntime {
  const session = createAgentTurnSession()

  const responder = createAgentPlaintextResponder({
    isOpenTurn: (turnNonce) => session.isOpenTurn(turnNonce),
    isUnlocked: () => deps.isUnlocked(),
    isIdInTurnScope: (messageId, turnNonce) => session.isIdInTurnScope(messageId, turnNonce),
    agentMailAccessEnabled: () => deps.agentMailAccessEnabled(),
    // Plaintext this client already holds for the turn (a drained job) is
    // served from the turn scope; only the rest reaches the worker.
    openMessages: openMessagesForTurn(session, (ids) => deps.openMessages(ids)),
    post: async (requestId, body) => {
      await deps.post(`/agent/mailbox-plaintext/${requestId}`, body)
    },
    recordDisclosure: (entry) => deps.recordDisclosure?.(entry),
    ...(deps.openAttachments ? { openAttachments: deps.openAttachments } : {}),
    ...(deps.confirmDisclosure ? { confirmDisclosure: deps.confirmDisclosure } : {}),
  })

  // Requests for a turn another app of this user started (the phone, another
  // window). It serves reads exactly as the turn's own window does (neither
  // limits a read to what it loaded: the threat model in
  // agent-plaintext-responder.ts); the caps, the switch and the lock still hold,
  // and it never confirms a conversion (no `confirmDisclosure`).
  const otherAppResponder = createAgentPlaintextResponder({
    answerWithToken: true,
    isOpenTurn: () => true,
    isUnlocked: () => deps.isUnlocked(),
    isIdInTurnScope: () => true,
    agentMailAccessEnabled: () => deps.agentMailAccessEnabled(),
    openMessages: (ids) => deps.openMessages(ids),
    post: async (requestId, body) => {
      await deps.post(`/agent/mailbox-plaintext/${requestId}`, body)
    },
    recordDisclosure: (entry) => deps.recordDisclosure?.(entry),
    ...(deps.openAttachments ? { openAttachments: deps.openAttachments } : {}),
  })

  async function handleSearch(data: Record<string, unknown>): Promise<void> {
    const requestId = data.requestId
    const turnNonce = data.turnNonce
    if (typeof requestId !== "string" || typeof turnNonce !== "string") return
    const ownTurn = session.isOpenTurn(turnNonce)
    const answerToken = typeof data.answerToken === "string" ? data.answerToken : null
    // Another app of this user started that turn: answer it with the request's
    // token while unlocked; locked, stay silent (the server knows this app is
    // locked and does not wait for it).
    if (!ownTurn && (!answerToken || !deps.isUnlocked())) return
    const adapter = deps.searchAdapter?.() ?? null
    const proof = ownTurn ? { turnNonce, turnOwner: true } : { answerToken }
    const post = async (id: string, body: unknown) => {
      await deps.post(`/agent/mailbox-search/${id}`, { ...(body as object), ...proof })
    }
    if (!adapter || !deps.isUnlocked()) {
      // Answered, not ignored. A turn that hears nothing spends its whole wait
      // budget before falling back; `indexComplete: false` tells it now that
      // this browser cannot answer the free-text half.
      await post(requestId, { messageIds: [], indexComplete: false }).catch(() => {})
      return
    }
    try {
      const outcome = await answerClientSearch(
        {
          adapter,
          isUnlocked: () => deps.isUnlocked(),
          turnNonce: () => turnNonce,
          ...(deps.indexComplete ? { indexComplete: deps.indexComplete } : {}),
          post: async (id, body) => {
            await post(id, body)
          },
        },
        {
          requestId,
          turnNonce,
          query: typeof data.query === "string" ? data.query : "",
          ...(typeof data.limit === "number" ? { limit: data.limit } : {}),
          ...(data.filters && typeof data.filters === "object"
            ? { filters: data.filters as { accountIds?: readonly string[] } }
            : {}),
        },
      )
      // Ids this turn's own result named are now in scope for it: that is what
      // lets the agent read a hit it just found, and nothing wider.
      if (ownTurn) session.addIds(turnNonce, outcome.messageIds)
    } catch {
      await post(requestId, { messageIds: [], indexComplete: false }).catch(() => {})
    }
  }

  const runtime: MailboxAgentRuntime = {
    session,
    responder,
    beginTurn(input) {
      const turnNonce = session.begin({
        allowedIds: [...(input?.allowedIds ?? deps.turnScopeIds())],
      })
      // Before the chat POST: the server learns this window owns the turn.
      runtime.sendStatusFrame()
      return turnNonce
    },
    endTurn(turnNonce) {
      session.end(turnNonce)
      runtime.sendStatusFrame()
    },
    sendStatusFrame() {
      const unlocked = deps.isUnlocked()
      const frame: MailboxStatusFrame = {
        type: "status",
        scope: "mailbox",
        unlocked,
        // A locked assertion carries no key ids: there is nothing to say.
        keyIds: unlocked ? deps.keyIds() : [],
        turns: session.openTurnNonces(),
      }
      deps.send(frame)
    },
    handleAgentStreamEvent(action, data) {
      if (action !== DECRYPT_ACTION && action !== SEARCH_ACTION) return false
      const mcpRequest = deps.mcpResponder ? readMcpMailboxRequest(action, data) : null
      if (mcpRequest && deps.mcpResponder) {
        void deps.mcpResponder.handle(mcpRequest).catch(() => {
          // The responder posts its own refusals; the waiting call times out otherwise.
        })
        return true
      }
      const frame = (data ?? {}) as Record<string, unknown>
      if (action === SEARCH_ACTION) {
        void handleSearch(frame)
        return true
      }
      const request = readDecryptRequest(frame)
      if (!request) return true
      // The request reaches every app of this user. The window that started the
      // turn answers on its own evidence (nonce; scope for a conversion). Any other app of the
      // user answers too while its mailbox is unlocked, with the request's
      // answer token; locked, it stays SILENT (the server does not count a
      // locked app as one that can still answer, so silence costs nothing).
      if (!session.isOpenTurn(request.turnNonce)) {
        if (!request.answerToken || !deps.isUnlocked()) return true
        void otherAppResponder.handle(request).catch(() => {})
        return true
      }
      void responder.handle(request).catch(() => {
        // The responder posts its own refusals. An exception here is a browser
        // that could not even do that, and there is nobody left to tell.
      })
      return true
    },
    runJobTurn: async (request: AgentTurnRequest) => {
      const submitTurn = deps.submitTurn
      if (!submitTurn) {
        throw new Error("this browser has no way to submit a mailbox job turn")
      }
      return await createJobAgentTurnRunner({ session, submitTurn })(request)
    },
    reset() {
      session.reset()
      responder.reset()
      otherAppResponder.reset()
      deps.mcpResponder?.reset()
    },
  }
  return runtime
}

// ── The one live runtime ─────────────────────────────────────────────────────
//
// A module singleton, because the two callers that need it (the chat submit
// path and the client job drainer) are not in the mailbox host's component
// tree and must not be given a crypto handle just to reach it.

let current: MailboxAgentRuntime | null = null

export function installMailboxAgentRuntime(runtime: MailboxAgentRuntime): () => void {
  current = runtime
  return () => {
    if (current === runtime) current = null
  }
}

export function mailboxAgentRuntime(): MailboxAgentRuntime | null {
  return current
}

/**
 * The nonce a chat turn carries. Null when no mailbox session is live, which is
 * the honest answer: a turn nobody can answer must not claim it can be.
 */
export function beginMailboxAgentTurn(input?: { allowedIds?: readonly string[] }): string | null {
  return current ? current.beginTurn(input) : null
}

export function endMailboxAgentTurn(turnNonce: string | null | undefined): void {
  if (turnNonce) current?.endTurn(turnNonce)
}

/** The broker request a routine's Run now returns (the server's routine-mailbox-wait.ts). */
export interface MailboxHandoffRequest {
  requestId: string
  messageIds: string[]
  expiresAt: string
}

/**
 * Run now's handoff: the run's request for the mail that started it, answered
 * here, in the owner's click, by the same responder and inside the same bounds
 * as any read a turn asks for (the agent-access switch, the lock, the caps).
 * Its ids join this turn's scope first: the owner pressing Run now on that run
 * is the ask. Once answered, the run needs no browser for that mail, and the
 * window may close. Null when no runtime runs in this tab.
 */
export async function answerMailboxHandoff(
  turnNonce: string,
  handoff: MailboxHandoffRequest,
): Promise<AgentPlaintextOutcome | null> {
  const runtime = current
  if (!runtime) return null
  runtime.session.addIds(turnNonce, handoff.messageIds)
  return await runtime.responder.handle({
    requestId: handoff.requestId,
    turnNonce,
    requestKind: "mail.read",
    messageIds: handoff.messageIds,
    purpose: "the email that started this routine run, opened for it at Run now",
    expiresAt: handoff.expiresAt,
  })
}

/** Routed from the `kernel:agent_stream` subscription. */
export function handleMailboxAgentStreamEvent(action: string, data: unknown): boolean {
  return current?.handleAgentStreamEvent(action, data) ?? false
}

/** The drainer's runner, resolved at call time so the host owns the lifetime. */
export const runMailboxJobTurn: AgentTurnRunner = async (request) => {
  const runtime = current
  if (!runtime) throw new Error("the mailbox agent runtime is not running in this tab")
  return await runtime.runJobTurn(request)
}

export type { AgentPlaintextOutcome }
