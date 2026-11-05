// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The pending-request registry of the two-phase mailbox read protocol
// (blueprint Task 9.2, spec section 5.3b).
//
// One process, one map, no Redis, no database, no outbox. That is not an
// optimisation, it is the property: nothing about a pending decrypt request may
// outlive the process that is waiting on it, and nothing about it may be
// readable anywhere else. The request the browser answers carries ids only; the
// ANSWER (which carries plaintext) is handed straight to an in-memory promise
// resolver and is never written anywhere.
//
// Modelled on `stream-registry.ts`, which is single-process by the same design
// constraint. What this adds over that model is instance affinity: the id is
// minted by `infra/instance-id.ts` so a response that reaches a DIFFERENT
// process (or the same process after a restart) is refused with a wrong-instance
// answer rather than silently dropped.
//
// ANY OF THE USER'S UNLOCKED APPS ANSWERS. The mailbox's end-to-end encryption
// exists so that an admin or a coworker can never read another member's mail.
// It is not meant to stop the user's own devices from serving the user's own
// agent. So the request is offered to every live connection of the user who
// owns the turn (the window that started it and, say, the desktop app or the
// phone), and any of them that has the mailbox unlocked may decrypt and answer.
// The boundary held hard is the user: only an authenticated session of the
// same user, in the same org, may answer, and other users, admins and the
// server at rest never get plaintext.
//
// Two ways to prove an answer belongs to the request: the turn's nonce (the
// window that started the turn minted it) or the request's ANSWER TOKEN, an
// opaque random id minted here for this one request and sent with it to that
// user's connections only. The token is how a client that did not start the
// turn answers. A conversion (`mail.convert`) is a disclosure the owner must
// confirm in the window they are using, so it accepts the nonce only.
//
// FIRST USABLE ANSWER WINS, a refusal only when nobody else can answer. A
// client whose mailbox is locked, or that found nothing, answers faster than
// one that has to decrypt. So a usable answer settles at once; an unusable one
// is held, and settles only when no connection of the user can still answer:
// every unlocked connection has answered, none is unlocked any more, or the
// request's deadline passes. The caller reports who could still answer
// (`noteAnswerers`). A deliberate refusal from the turn's own window (its
// agent-access switch is off, the user declined a conversion, a per-turn cap)
// settles at once: it is the user's own answer in the window they are using.
//
// A wait whose caller does not track the answerers (MCP, the routine handoff)
// keeps the older rule: an answer from the turn's window settles at once, and
// anything else is held for a short grace.

import { isOwnInstanceScopedId, mintInstanceScopedId } from "~/infra/instance-id"
import type { MailboxAnswerers } from "~/infra/websocket-state/types"

/** What the client may send back. Only `plaintext` carries content. */
export type MailboxRequestResponse =
  | {
      kind: "plaintext"
      items: Array<{
        messageId: string
        subject?: string | null
        textBody?: string | null
        htmlBody?: string | null
        /** `mail.quote` only: the assembled quote and the resolved subject. */
        quotedBody?: string | null
        resolvedSubject?: string | null
        /** `mail.attachment` only: the staged plaintext bytes, base64. */
        bytesBase64?: string | null
      }>
      undecryptable?: string[]
      /**
       * `mail.convert` only (blueprint Task 9.7). True only when the mailbox
       * owner explicitly agreed, in their own browser, to make this content
       * readable by everyone with access to the target inbox. Absent or false
       * means REFUSE: a missing confirmation is never a default yes.
       */
      consented?: boolean
    }
  | { kind: "search"; messageIds: string[]; indexComplete?: boolean }
  | {
      kind: "denied"
      reason: string
      /** The answering client's mailbox is locked: the agent tells the user to unlock it. */
      code?: "locked"
      /**
       * Set by this registry, never by a client: the refusal was held while
       * the user's other apps were asked, and nothing better arrived.
       */
      unconfirmed?: boolean
    }

/** How a wait ended. `cancelled` covers abort and timeout alike. */
export type MailboxRequestOutcome = MailboxRequestResponse | { kind: "cancelled"; reason: string }

export type MailboxRequestKind =
  | "mail.read"
  | "mail.quote"
  | "mail.attachment"
  | "mail.search"
  /** Ticket conversion: a consented DISCLOSURE, not a read (Task 9.7). */
  | "mail.convert"

export interface MailboxRequestRegistration {
  requestId: string
  userId: string
  orgId: string
  turnNonce: string
  /**
   * Minted per request and sent with it to the user's own connections only:
   * what a client that did not start the turn answers with. Absent: only the
   * turn's nonce is accepted.
   */
  answerToken?: string
  kind: MailboxRequestKind
  messageIds: string[]
}

export interface PendingMailboxRequest {
  requestId: string
  promise: Promise<MailboxRequestOutcome>
  /** Evict the entry and settle the promise. Idempotent. */
  cancel(reason: string): void
  /**
   * The latest count of the user's unlocked live connections, for a wait
   * registered with `trackAnswerers`. A held answer settles once every one of
   * them has answered; `unknown` keeps it waiting.
   */
  noteAnswerers(answerers: MailboxAnswerers): void
}

export interface MailboxRequestOptions {
  /**
   * Hold unusable answers until every unlocked connection of the user has
   * answered (reported through `noteAnswerers`), not for the grace.
   */
  trackAnswerers?: boolean
}

interface RegistryEntry extends MailboxRequestRegistration {
  settle(outcome: MailboxRequestOutcome): void
  createdAt: number
  /** The best unusable answer so far. */
  fallback?: MailboxRequestResponse
  graceTimer?: ReturnType<typeof setTimeout>
  trackAnswerers: boolean
  /** The latest `noteAnswerers` report; unknown until the first. */
  answerers: MailboxAnswerers
  /** The turn's own window gave an unusable answer. */
  turnWindowAnswered: boolean
  /** Unusable answers from clients that did not say they started the turn. */
  otherAnswers: number
}

const pending = new Map<string, RegistryEntry>()

/**
 * Requests settled a moment ago, ids and owners only (never an answer), so the
 * user's other client answering late is told "already answered" instead of
 * "no such request". Kept just long enough to outlive any client's answer.
 */
const settledRecently = new Map<
  string,
  { userId: string; orgId: string; turnNonce: string; answerToken?: string; at: number }
>()
const SETTLED_MEMORY_MS = 120_000

/**
 * How long a held (unusable) answer waits for a usable one from another client
 * of the same user, in a wait that does not track the answerers. The request's
 * own timeout still bounds the whole wait.
 */
export const MAILBOX_ANSWER_GRACE_MS = 10_000
let answerGraceMs = MAILBOX_ANSWER_GRACE_MS

/**
 * True when an answer gives the turn something to work with. A refusal, a read
 * that decrypted nothing, and a search from a client with no index do not: they
 * are what a client that cannot help says, and another client may still help.
 */
export function isUsableMailboxAnswer(response: MailboxRequestResponse): boolean {
  if (response.kind === "denied") return false
  if (response.kind === "search") {
    return response.messageIds.length > 0 || response.indexComplete !== false
  }
  return response.items.length > 0
}

/** Of two unusable answers, keep the more informative one: anything beats a refusal. */
function betterFallback(
  held: MailboxRequestResponse | undefined,
  next: MailboxRequestResponse,
): MailboxRequestResponse {
  if (!held) return next
  if (held.kind === "denied" && next.kind !== "denied") return next
  return held
}

/** A held answer as the wait settles with it. */
function fromFallback(fallback: MailboxRequestResponse): MailboxRequestResponse {
  return fallback.kind === "denied" ? { ...fallback, unconfirmed: true } : fallback
}

/**
 * Every unlocked connection of the user that could still answer has answered:
 * the turn's window (when it is unlocked) and each of the others.
 */
function nobodyLeftToAnswer(entry: RegistryEntry): boolean {
  const answerers = entry.answerers
  if (answerers === "unknown") return false
  if (answerers.turnWindowUnlocked && !entry.turnWindowAnswered) return false
  return entry.otherAnswers >= answerers.otherUnlocked
}

/** Settle with the held answer once nobody can still give a better one. */
function settleHeldIfDone(requestId: string, entry: RegistryEntry): void {
  if (entry.fallback && nobodyLeftToAnswer(entry)) {
    finish(requestId, entry, fromFallback(entry.fallback))
  }
}

function armGrace(requestId: string, entry: RegistryEntry): void {
  if (entry.graceTimer || !entry.fallback || entry.trackAnswerers) return
  const timer = setTimeout(() => {
    entry.graceTimer = undefined
    if (entry.fallback) finish(requestId, entry, fromFallback(entry.fallback))
  }, answerGraceMs)
  timer.unref?.()
  entry.graceTimer = timer
}

function finish(requestId: string, entry: RegistryEntry, outcome: MailboxRequestOutcome): void {
  if (pending.get(requestId) === entry) pending.delete(requestId)
  if (entry.graceTimer) clearTimeout(entry.graceTimer)
  settledRecently.set(requestId, {
    userId: entry.userId,
    orgId: entry.orgId,
    turnNonce: entry.turnNonce,
    ...(entry.answerToken ? { answerToken: entry.answerToken } : {}),
    at: Date.now(),
  })
  entry.settle(outcome)
}

/**
 * A pending request that nothing ever settles must not pin memory for the life
 * of the process. Comfortably above the longest turn-scoped wait budget.
 */
const STALE_AFTER_MS = 300_000

function sweepStale(): void {
  const now = Date.now()
  for (const [id, entry] of pending) {
    if (now - entry.createdAt > STALE_AFTER_MS) {
      finish(id, entry, { kind: "cancelled", reason: "stale" })
    }
  }
  for (const [id, record] of settledRecently) {
    if (now - record.at > SETTLED_MEMORY_MS) settledRecently.delete(id)
  }
}

/** `<instanceId>:<uuid>` (spec section 15 A21). */
export function mintMailboxRequestId(): string {
  return mintInstanceScopedId()
}

/** True when this process minted `requestId` on this boot. */
export function ownsMailboxRequestId(requestId: string): boolean {
  return isOwnInstanceScopedId(requestId)
}

export function registerMailboxRequest(
  registration: MailboxRequestRegistration,
  options: MailboxRequestOptions = {},
): PendingMailboxRequest {
  sweepStale()
  let settle!: (outcome: MailboxRequestOutcome) => void
  let settled = false
  const promise = new Promise<MailboxRequestOutcome>((resolve) => {
    settle = (outcome) => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
  })
  const entry: RegistryEntry = {
    ...registration,
    settle,
    createdAt: Date.now(),
    trackAnswerers: options.trackAnswerers === true,
    answerers: "unknown",
    turnWindowAnswered: false,
    otherAnswers: 0,
  }
  pending.set(registration.requestId, entry)
  return {
    requestId: registration.requestId,
    promise,
    cancel(reason: string) {
      // A wait that ends (timeout, abort) with an answer held settles with that
      // answer: a client did reply, and what it said beats "nobody answered".
      const outcome: MailboxRequestOutcome = entry.fallback
        ? fromFallback(entry.fallback)
        : { kind: "cancelled", reason }
      finish(registration.requestId, entry, outcome)
    },
    noteAnswerers(answerers: MailboxAnswerers) {
      if (!entry.trackAnswerers || pending.get(registration.requestId) !== entry) return
      entry.answerers = answerers
      settleHeldIfDone(registration.requestId, entry)
    },
  }
}

/**
 * `held`: accepted, but not settled, because another client may still give a
 * usable answer. `already_settled`: a late answer from the same user and turn,
 * which is the normal fate of every client but one when several are open.
 */
export type ResolveOutcome =
  | "resolved"
  | "held"
  | "already_settled"
  | "not_found"
  | "nonce_mismatch"

/** An authenticated client's answer to one request. */
export interface MailboxAnswerInput {
  userId: string
  /** The answering session's org. Required with `answerToken`. */
  orgId?: string
  /** The turn's nonce, which the window that started the turn holds. */
  turnNonce?: string
  /** The request's answer token, which every connection of the user received. */
  answerToken?: string
  response: MailboxRequestResponse
  turnOwner?: boolean
}

/** Does this answer carry the proof the request accepts? */
function answerProof(
  record: { orgId: string; turnNonce: string; answerToken?: string },
  input: MailboxAnswerInput,
): "nonce" | "token" | null {
  if (input.orgId !== undefined && input.orgId !== record.orgId) return null
  if (input.turnNonce !== undefined && input.turnNonce === record.turnNonce) return "nonce"
  if (
    input.answerToken !== undefined &&
    record.answerToken !== undefined &&
    input.orgId === record.orgId &&
    input.answerToken === record.answerToken
  ) {
    return "token"
  }
  return null
}

/**
 * Settle one pending request from an authenticated client response.
 *
 * `not_found` covers an unknown id, an id belonging to another user and one of
 * another org on purpose: distinguishing them would tell an attacker whether a
 * request id they guessed exists and whose it is. A second answer for an id
 * settled a moment ago is `already_settled` only for the same user with the
 * request's nonce or token, which the answering client already holds, so it
 * learns nothing it did not know.
 *
 * `turnOwner` is the answering client saying it started this turn. It counts
 * only with the turn's nonce, and can only make that client's own answer count
 * sooner, for that client's own user, so it needs no further proof.
 */
export function resolveMailboxRequest(
  requestId: string,
  input: MailboxAnswerInput,
): ResolveOutcome {
  const entry = pending.get(requestId)
  if (!entry) {
    const settled = settledRecently.get(requestId)
    if (settled && settled.userId === input.userId && answerProof(settled, input)) {
      return "already_settled"
    }
    return "not_found"
  }
  if (entry.userId !== input.userId) return "not_found"
  if (input.orgId !== undefined && input.orgId !== entry.orgId) return "not_found"
  const proof = answerProof(entry, input)
  if (!proof) return "nonce_mismatch"
  // A conversion is the owner's disclosure, confirmed in the window they use.
  if (entry.kind === "mail.convert" && proof !== "nonce") return "nonce_mismatch"
  const fromTurnWindow = proof === "nonce" && input.turnOwner === true
  // Never let a client set the registry's own marker.
  const response: MailboxRequestResponse =
    input.response.kind === "denied"
      ? {
          kind: "denied",
          reason: input.response.reason,
          ...(input.response.code ? { code: input.response.code } : {}),
        }
      : input.response
  if (isUsableMailboxAnswer(response)) {
    finish(requestId, entry, response)
    return "resolved"
  }
  if (fromTurnWindow) {
    const deliberate =
      entry.kind === "mail.convert" || (response.kind === "denied" && response.code !== "locked")
    if (!entry.trackAnswerers || deliberate) {
      finish(requestId, entry, response)
      return "resolved"
    }
  }
  entry.fallback = betterFallback(entry.fallback, response)
  if (fromTurnWindow) entry.turnWindowAnswered = true
  else entry.otherAnswers += 1
  armGrace(requestId, entry)
  settleHeldIfDone(requestId, entry)
  return pending.get(requestId) === entry ? "held" : "resolved"
}

/** Test and diagnostics only: how many waits are outstanding right now. */
export function pendingMailboxRequestCount(): number {
  return pending.size
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const MailboxPlaintextRegistryTestAccess = {
  /** The ids currently awaiting an answer. */
  listPendingRequestIds(): string[] {
    return [...pending.keys()]
  },

  /** Cancel every outstanding wait and empty the registry. */
  reset(): void {
    for (const entry of pending.values()) {
      if (entry.graceTimer) clearTimeout(entry.graceTimer)
      entry.settle({ kind: "cancelled", reason: "reset" })
    }
    pending.clear()
    settledRecently.clear()
    answerGraceMs = MAILBOX_ANSWER_GRACE_MS
  },

  /** Shorten the grace a held answer waits for a usable one. */
  setAnswerGraceMs(ms: number): void {
    answerGraceMs = ms
  },
}
