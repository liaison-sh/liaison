// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client-verified sweep of spec section 7 step 6, and the client half of
// SC6 and SC11.
//
// WHY THIS EXISTS AT ALL. The server cannot check its own backfill: it holds no
// key, so it has no way to know that the ciphertext it wrote can be opened. The
// only party that can tell is the browser, which during the dual-read window
// holds both representations at once. So the browser walks every message,
// decrypts it, compares it against the plaintext columns that are still there,
// and signs a statement over a digest of the id set it covered. The server
// recomputes that digest over the exact rows it holds and refuses on any
// mismatch. No plaintext, and no value derived from plaintext, ever crosses to
// the server.
//
// A row sealed AT INGEST has no plaintext to compare against, and the server
// says so per row (`hasPlaintext`). For those the sweep verifies that the row
// DECRYPTS and nothing more, because that is the only property such a row has.
// This is not a softening: refusing them would mean no mailbox that has
// received mail since enrolment could ever be swept, and every enrolled mailbox
// receives mail. Coverage is identical either way, the signed id set still
// names every message; only the check per row differs.
//
// THE ONE PROPERTY THAT MUST NEVER BE WEAKENED: this module refuses to sign if
// a single message fails to open or disagrees with its plaintext. The signature
// is what authorises `purgeMailboxPlaintext` to destroy the last readable copy
// of the mailbox, so a sweep that signed over a partial walk would authorise
// destroying mail the user cannot actually read. Every refusal below is that
// property, not defensive coding.
//
// Coverage is checked twice, on purpose. The sweep asks the server how many
// messages it holds and refuses if that disagrees with what it walked, and the
// server then independently recomputes the digest over its own rows. The first
// check makes the failure legible; the second is the one that is load bearing,
// because it does not trust this file.
//
// WHAT THIS SWEEP DOES NOT COVER, stated rather than implied. It compares the
// four content fields (`subject`, `text_body`, `html_body`, `snippet`) and no
// more. Spec section 7 step 6 also names the sealed HEADERS, and they are not
// compared here because the browser has no header-open path at all:
// `SealedMessagePayload` carries no `rawHeadersCiphertext` and the worker has
// no operation that would open one. Conversation and draft rows are likewise
// outside the acknowledgement, which is derived from message ids only; the
// purge covers them with its own `assertFullySealed` gate, which is why that
// gate exists. Anyone widening the acknowledgement's meaning must widen the
// walk first.
//
// The nonce is fetched LAST, immediately before signing, never at the start. A
// real mailbox takes longer to walk than `VERIFY_NONCE_TTL_MS`, and a nonce
// issued at the start of a resumable multi-session walk would be expired by the
// time there was anything to sign.

import { computeIdSetDigest } from "@liaison/mailbox-crypto/src/ack"
import {
  MAILBOX_LOCKED,
  MailboxCryptoError,
  type OpenedMessage,
  type SealedMessagePayload,
} from "~/modules/mailbox/crypto-protocol"
import type { MailboxApi } from "~/modules/mailbox/mailbox-api"

/** The still-present plaintext half of a row, during the dual-read window. */
export interface SweepPlaintext {
  subject: string | null
  textBody: string | null
  htmlBody: string | null
  snippet: string | null
}

export interface SweepItem {
  sealed: SealedMessagePayload
  /**
   * The SERVER's statement about whether this row still holds plaintext. It is
   * authoritative and it is never inferred here from the absence of the half
   * below, because the two absences mean opposite things.
   *
   *   `true`  a LEGACY row, sealed by the backfill, plaintext still beside the
   *           ciphertext during the dual-read window. It is decrypted AND
   *           compared byte for byte, and a disagreement refuses the sweep.
   *   `false` a row sealed AT INGEST. It never had plaintext, so there is
   *           nothing to compare and the only property it has is that it
   *           OPENS. A decrypt failure still refuses.
   *
   * Absent means `true`, so a server that has not learned to say it keeps the
   * strict comparison and a listing served in the wrong mode still refuses.
   *
   * This is not a softening of the acknowledgement. Refusing ingest-sealed rows
   * meant no mailbox that had received mail since enrolment could ever be
   * swept, so the acknowledgement could never be recorded at all, and coverage
   * is unchanged either way: the signed id set still names every message.
   */
  hasPlaintext?: boolean
  /**
   * The plaintext half the sweep compares against. A half missing from a row
   * whose flag says it HAS one is a refusal, never a softer check: the whole
   * claim the acknowledgement makes is that the two representations agree, and
   * an item with nothing to compare against cannot support that claim. The
   * listing must be read in `mode=verify`, which carries the four columns for
   * every row that has them; the default mode carries none of them, and
   * sweeping that listing used to pass silently while comparing nothing.
   */
  plaintext: SweepPlaintext | null
}

export interface SweepPage {
  /** The listing cursor AFTER this page. */
  cursor: string
  done: boolean
  items: SweepItem[]
  /** How many messages the listing covers in total, when it can say. */
  total?: number
}

export interface SweepSource {
  fetchPage(cursor: string | null, limit: number): Promise<SweepPage>
}

export type SweepPhase = "verifying" | "done"

export interface SweepProgress {
  verified: number
  total: number | null
  phase: SweepPhase
}

export type SweepStopReason = "aborted" | "locked"

export interface SweepResult {
  verified: number
  completed: boolean
  stoppedBecause?: SweepStopReason
  /** Present only on a completed, accepted sweep. */
  ack?: { count: number; keyId: number; verifiedAt: string | null }
}

export type SweepFailureReason = "undecryptable" | "mismatch" | "unverifiable"

export interface SweepFailure {
  id: string
  reason: SweepFailureReason
  /** Which field disagreed, for a mismatch. */
  field?: keyof SweepPlaintext
}

/**
 * A refusal to sign. Never downgraded to a warning and never swallowed: it is
 * the difference between a purge that destroys verified plaintext and one that
 * destroys unverified plaintext.
 */
export class MailboxSweepError extends Error {
  readonly failures: SweepFailure[]
  constructor(message: string, failures: SweepFailure[] = []) {
    super(message)
    this.name = "MailboxSweepError"
    this.failures = failures
  }
}

/** What the sweep asks the worker to sign. `userId` and `keyId` are the
 *  worker's to fill: the page must not be able to name either. */
export interface SweepAckStatement {
  accountId: string
  nonce: string
  count: number
  /** Base64 of the 32 raw digest bytes. */
  idSetDigest: string
  backfillCursor: string
}

export interface SweepAckSignature {
  keyId: number
  /** Base64 Ed25519 signature over the canonical statement encoding. */
  signature: string
}

/**
 * Persisted between page loads, so a closed tab costs one page and not a
 * mailbox. It holds message IDS and a cursor, never any content.
 *
 * `ids` and `cursor` are NOT in step with each other, and the walk must not
 * assume they are. A run interrupted in the middle of a page saves the
 * pre-advance cursor next to the ids it had already verified on that page, so
 * the resume re-fetches those same rows. The walk therefore carries the id set
 * as a SET and adds to it, which both makes the resume idempotent and heals a
 * state written by the build that did not.
 */
export interface SweepResumeState {
  cursor: string | null
  ids: string[]
  startedAt: string
}

export interface SweepResumeStore {
  load(): Promise<SweepResumeState | null>
  save(state: SweepResumeState): Promise<void>
  clear(): Promise<void>
}

/** Exported so the panel can offer "start over" without duplicating the name. */
export const MAILBOX_SWEEP_RESUME_KEY = "liaison.mailbox.sweep.v1"

const RESUME_STORAGE_KEY = MAILBOX_SWEEP_RESUME_KEY

/** The default store. `localStorage` is enough: the state is ids and a cursor,
 *  both of which the server already holds. */
export function localSweepResumeStore(): SweepResumeStore {
  const storage = (): Storage | null => {
    try {
      return globalThis.localStorage ?? null
    } catch {
      return null
    }
  }
  return {
    async load() {
      const raw = storage()?.getItem(RESUME_STORAGE_KEY)
      if (!raw) return null
      try {
        const parsed = JSON.parse(raw) as SweepResumeState
        if (!Array.isArray(parsed.ids)) return null
        return parsed
      } catch {
        return null
      }
    },
    async save(state) {
      storage()?.setItem(RESUME_STORAGE_KEY, JSON.stringify(state))
    },
    async clear() {
      storage()?.removeItem(RESUME_STORAGE_KEY)
    },
  }
}

/** In-memory, for tests and for a browser with no storage. */
export function memorySweepResumeStore(): SweepResumeStore {
  let state: SweepResumeState | null = null
  return {
    async load() {
      return state
    },
    async save(next) {
      state = next
    },
    async clear() {
      state = null
    },
  }
}

export interface SweepDeps {
  api: MailboxApi
  /** The account the signed statement names. */
  accountId: string
  source: SweepSource
  /**
   * Opens one sealed row. A `null` return, or any throw that is not
   * `MAILBOX_LOCKED`, is an UNDECRYPTABLE message and refuses the sweep.
   * `MAILBOX_LOCKED` is the one benign stop: it means the session expired
   * mid walk, and the sweep resumes on the next unlock.
   */
  open(sealed: SealedMessagePayload): Promise<OpenedMessage | null>
  signAck(statement: SweepAckStatement): Promise<SweepAckSignature>
  store?: SweepResumeStore
  pageSize?: number
  onProgress?(progress: SweepProgress): void
  yieldToMainThread?(): Promise<void>
  signal?: AbortSignal
}

const DEFAULT_PAGE_SIZE = 50

/** `scheduler.yield` where the browser has it, a macrotask otherwise. A
 *  microtask is not a yield: it runs before the next paint. */
function defaultYield(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (scheduler?.yield) return scheduler.yield()
  return new Promise((resolve) => setTimeout(resolve, 0))
}

const COMPARED_FIELDS: Array<keyof SweepPlaintext> = ["subject", "textBody", "htmlBody", "snippet"]

/**
 * The byte-for-byte comparison of spec section 7 step 6.
 *
 * A null and an empty string are the same absence: a legacy draft row carries
 * `html_body = ''` where the sealed representation has nothing at all (review
 * finding 23), and calling that a mismatch would refuse every sweep forever.
 * Anything else that differs is a real disagreement and refuses.
 */
function firstMismatch(
  opened: OpenedMessage,
  plaintext: SweepPlaintext,
): keyof SweepPlaintext | null {
  for (const field of COMPARED_FIELDS) {
    if ((plaintext[field] ?? "") !== (opened[field] ?? "")) return field
  }
  return null
}

interface NonceResponse {
  nonce: string
  expiresAt: string
  backfillCursor: string
  messageCount: number
}

/**
 * Walk the whole mailbox, verify every message, and submit the signed
 * acknowledgement. Resolves with a partial result when the mailbox locks or the
 * caller aborts, and REJECTS with `MailboxSweepError` when anything fails to
 * verify. It never resolves successfully over an unverified message.
 */
export async function runMailboxVerificationSweep(deps: SweepDeps): Promise<SweepResult> {
  const store = deps.store ?? localSweepResumeStore()
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE
  const yieldNow = deps.yieldToMainThread ?? defaultYield

  const resumed = await store.load()
  let cursor = resumed?.cursor ?? null
  // A set, not a list. See `SweepResumeState`: an interrupted page is re-walked
  // on resume, and pushing those ids a second time made the sweep claim more
  // messages than the mailbox holds. The coverage check then refused, blaming
  // the server, and the resume state is only cleared on success, so the sweep
  // could never complete again.
  const verified = new Set<string>(resumed?.ids ?? [])
  const startedAt = resumed?.startedAt ?? new Date().toISOString()
  let total: number | null = null

  const snapshot = (): SweepResumeState => ({ cursor, ids: [...verified], startedAt })

  const report = (phase: SweepPhase): void => {
    deps.onProgress?.({ verified: verified.size, total, phase })
  }

  for (;;) {
    if (deps.signal?.aborted) {
      await store.save(snapshot())
      return { verified: verified.size, completed: false, stoppedBecause: "aborted" }
    }

    const page = await deps.source.fetchPage(cursor, pageSize)
    if (page.total != null) total = page.total

    const failures: SweepFailure[] = []
    let locked = false

    for (const item of page.items) {
      let opened: OpenedMessage | null = null
      try {
        opened = await deps.open(item.sealed)
      } catch (error) {
        if (error instanceof MailboxCryptoError && error.code === MAILBOX_LOCKED) {
          locked = true
          break
        }
        // Any other throw is this message failing to open. It is never
        // downgraded to a skip: a skipped message is exactly the thing the
        // acknowledgement must not silently cover.
        failures.push({ id: item.sealed.id, reason: "undecryptable" })
        continue
      }
      if (!opened) {
        failures.push({ id: item.sealed.id, reason: "undecryptable" })
        continue
      }
      // A row the server says has no plaintext is verified by the decryption
      // that just succeeded, and by nothing else: there is no second
      // representation to compare it with. Fail-closed on the absent flag, so
      // only an explicit `false` skips the comparison.
      if (item.hasPlaintext !== false) {
        if (!item.plaintext) {
          // The server said this row still holds plaintext and the half is not
          // here. Counting it would turn the sweep into a decryptability check
          // while it still reported itself as a verification, which is worse
          // than failing.
          failures.push({ id: item.sealed.id, reason: "unverifiable" })
          continue
        }
        const field = firstMismatch(opened, item.plaintext)
        if (field) {
          failures.push({ id: item.sealed.id, reason: "mismatch", field })
          continue
        }
      }
      verified.add(item.sealed.id)
    }

    if (failures.length > 0) {
      // Persist what did verify so a rerun after the cause is fixed does not
      // start the mailbox again, then REFUSE. Nothing is signed and nothing is
      // submitted.
      await store.save(snapshot())
      throw new MailboxSweepError(
        `${failures.length} message(s) in this mailbox did not verify, so nothing was signed: ` +
          failures.map((f) => `${f.id} (${f.reason}${f.field ? ` ${f.field}` : ""})`).join(", "),
        failures,
      )
    }

    if (locked) {
      await store.save(snapshot())
      return { verified: verified.size, completed: false, stoppedBecause: "locked" }
    }

    cursor = page.cursor
    await store.save(snapshot())
    report("verifying")

    if (page.done) break
    if (page.items.length === 0) {
      // A listing that answers "not done" with nothing would spin forever.
      throw new MailboxSweepError(
        "the message listing returned an empty page without reporting completion, so coverage cannot be established",
      )
    }
    await yieldNow()
  }

  // ── Everything opened. Only now is there something worth a nonce. ─────────
  const issued = await deps.api.post<NonceResponse>("/mailbox/verify-nonce")
  if (typeof issued?.nonce !== "string") {
    throw new MailboxSweepError("the server did not issue a verification nonce")
  }
  const ids = [...verified]
  if (typeof issued.messageCount === "number" && issued.messageCount !== ids.length) {
    throw new MailboxSweepError(
      `coverage disagreement: this sweep verified ${ids.length} messages and the server holds ` +
        `${issued.messageCount}. Nothing was signed.`,
    )
  }

  const digest = await computeIdSetDigest(ids)
  const idSetDigest = bytesToBase64(digest)
  const statement: SweepAckStatement = {
    accountId: deps.accountId,
    nonce: issued.nonce,
    count: ids.length,
    idSetDigest,
    backfillCursor: issued.backfillCursor ?? "",
  }
  const signed = await deps.signAck(statement)

  const accepted = await deps.api.post<{ verified: boolean; verifiedAt?: string }>(
    "/mailbox/verify-decrypt",
    { ...statement, keyId: signed.keyId, signature: signed.signature },
  )

  await store.clear()
  report("done")
  return {
    verified: ids.length,
    completed: true,
    ack: { count: ids.length, keyId: signed.keyId, verifiedAt: accepted?.verifiedAt ?? null },
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
