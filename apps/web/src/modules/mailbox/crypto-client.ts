// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The PAGE side handle. It holds no key material of any kind: no Account Key,
// no identity private key, no derived handle, nothing from the opening half of
// the crypto package. It posts requests and reads back plaintext for fields the
// user is about to see. That asymmetry is the whole point of the worker split,
// and `crypto-client.test.ts` asserts it against this file's source text.

import {
  type ExtendLeaseRequest,
  type MailboxAckRequest,
  type MailboxAckSigned,
  MailboxCryptoError,
  type MailboxErrorCode,
  type MintedWrap,
  type MintWrapRequest,
  type OpenedApprovalDraft,
  type OpenedAttachment,
  type OpenedConversation,
  type OpenedMessage,
  type OpenOptions,
  type RestoreRequest,
  type SealedApprovalDraft,
  type SealedAttachmentPayload,
  type SealedConversationPayload,
  type SealedMessagePayload,
  type SealVerdict,
  type UnlockRequest,
  type UnlockResult,
  type WorkerRequest,
  type WorkerRequestBody,
  type WorkerResponse,
} from "~/modules/mailbox/crypto-protocol"

export type MailboxTransport = (request: WorkerRequest) => Promise<WorkerResponse>

export interface MailboxCryptoClient {
  unlock(request: UnlockRequest): Promise<UnlockResult>
  /** True when this device's persisted handles re-opened the session. */
  restore(request: RestoreRequest): Promise<boolean>
  /** A token renewal: this login's device lease now ends at the new expiry. */
  extendLease(request: ExtendLeaseRequest): Promise<boolean>
  openMessage(sealed: SealedMessagePayload, options?: OpenOptions): Promise<OpenedMessage>
  /** A conversation row's own subject and snippet, for the conversation list. */
  openConversation(
    sealed: SealedConversationPayload,
    options?: OpenOptions,
  ): Promise<OpenedConversation>
  /** The sealed draft of a gated mail send's approval payload (Task 9.8). */
  openApprovalDraft(
    sealed: SealedApprovalDraft,
    options?: OpenOptions,
  ): Promise<OpenedApprovalDraft>
  /**
   * A stored attachment, opened whole so its bytes can go back out on a forward
   * or a re-attach (Task 9.9). The page moves base64 in and base64 out; the key
   * that opens it never leaves the worker.
   */
  openAttachment(sealed: SealedAttachmentPayload, options?: OpenOptions): Promise<OpenedAttachment>
  /**
   * Client search-index shards, sealed and opened in the worker under D7.
   * The page moves the base64 to and from storage and never sees the key,
   * exactly as it never sees a content key.
   */
  sealIndexShard(shardId: string, plaintext: string): Promise<string>
  openIndexShard(shardId: string, blob: string): Promise<string>
  /**
   * The downgrade detector's two worker calls (spec section 9.2). Both return
   * verdicts and MACs, never plaintext and never key material, so the page side
   * of this handle stays exactly as key free as it was.
   */
  verifySeals(rows: readonly SealedMessagePayload[]): Promise<SealVerdict[]>
  ledgerMac(statements: readonly string[]): Promise<string[]>
  /**
   * The migration acknowledgement's signature (spec section 7 step 6). The page
   * supplies the nonce, the count, the digest and the cursor; the WORKER
   * supplies `userId` and the active `keyId`, both of which are inside the
   * signed bytes, so this handle cannot sign a statement about someone else.
   */
  signAck(statement: MailboxAckRequest): Promise<MailboxAckSigned>
  /**
   * Add an unlock method (the mailbox password, or this device's passkey) from
   * the session that is open now. What comes back is already wrapped; nothing
   * that opens the mailbox ever crosses to the page.
   */
  mintWrap(request: MintWrapRequest): Promise<MintedWrap>
  /** Ends the minting window of a `mintWraps` unlock in the worker. Idempotent. */
  endMinting(): Promise<void>
  lock(): Promise<void>
  setIdleTimeoutMs(ms: number): Promise<number>
  isUnlocked(): boolean
  refreshStatus(): Promise<boolean>
}

export interface MailboxCryptoClientOptions {
  post: MailboxTransport
}

/**
 * How long a request may wait before the transport calls the worker dead.
 *
 * Generous on purpose: this is a backstop for a wedged worker, not a latency
 * budget. The common failure, a worker that dies at load, is caught by the
 * `error` handler below and never waits at all.
 */
export const MAILBOX_WORKER_TIMEOUT_MS = 60_000

/**
 * Unlock gets its own, much larger budget. A mailbox password unlock runs
 * PBKDF2 at 600 000 iterations, and a legacy row the old Argon2id at m=64 MiB
 * plus the PBKDF2 re-wrap, which is seconds on a laptop and can be tens of
 * seconds on a slow device. Timing that out would lock a mailbox whose only
 * fault is a slow device.
 */
export const MAILBOX_WORKER_UNLOCK_TIMEOUT_MS = 300_000

export interface WorkerTransportOptions {
  timeoutMs?: number
  unlockTimeoutMs?: number
}

/**
 * Turns a real `Worker` into the transport, and FAILS CLOSED when that worker
 * is not there.
 *
 * The failure this exists to prevent: a worker that dies at boot used to leave
 * every request pending forever, so a message rendered "(No content)" with no
 * lock affordance and no error, and the user could not tell that anything was
 * wrong. A hang is worse than a lock, because a lock says what happened and
 * offers a way out. So a dead worker (an `error` event, a `close` event, a
 * `postMessage` that throws, or a request that outlives its deadline) resolves
 * as `MAILBOX_LOCKED`, which is the state the client and the mail surface
 * already know how to render.
 *
 * Once the worker is known dead it stays dead: later requests fail immediately
 * rather than queueing on a channel with nothing at the other end. Recovering
 * means booting a new worker, which is what a re-unlock does.
 */
export function workerTransport(
  worker: Worker,
  options: WorkerTransportOptions = {},
): MailboxTransport {
  const timeoutMs = options.timeoutMs ?? MAILBOX_WORKER_TIMEOUT_MS
  const unlockTimeoutMs = options.unlockTimeoutMs ?? MAILBOX_WORKER_UNLOCK_TIMEOUT_MS
  const pending = new Map<number, (response: WorkerResponse) => void>()
  let dead: string | null = null

  const lockedResponse = (id: number, why: string): WorkerResponse => ({
    id,
    ok: false,
    code: "MAILBOX_LOCKED",
    message: why,
  })

  const die = (why: string): void => {
    dead ??= why
    const waiting = [...pending.entries()]
    pending.clear()
    for (const [id, resolve] of waiting) resolve(lockedResponse(id, dead))
  }

  worker.addEventListener("message", (event: MessageEvent) => {
    const response = event.data as WorkerResponse
    const resolve = pending.get(response?.id)
    if (!resolve) return
    pending.delete(response.id)
    resolve(response)
  })
  worker.addEventListener("error", () => die("the mailbox worker failed to start or stopped"))
  // Not fired by every engine, and free to handle: a dedicated worker that
  // calls `self.close()` ends the channel just as finally as a crash.
  worker.addEventListener("close", () => die("the mailbox worker closed"))
  worker.addEventListener("messageerror", () =>
    die("the mailbox worker sent a message the page could not read"),
  )

  return (request) =>
    new Promise<WorkerResponse>((resolve) => {
      if (dead) {
        resolve(lockedResponse(request.id, dead))
        return
      }
      // Minting a mailbox password wrap runs the same KDF as an unlock.
      const budget =
        request.op === "unlock" || request.op === "mintWrap" ? unlockTimeoutMs : timeoutMs
      const timer = setTimeout(() => {
        pending.delete(request.id)
        resolve(lockedResponse(request.id, "the mailbox worker did not answer in time"))
      }, budget)
      pending.set(request.id, (response) => {
        clearTimeout(timer)
        resolve(response)
      })
      try {
        worker.postMessage(request)
      } catch {
        clearTimeout(timer)
        pending.delete(request.id)
        resolve(lockedResponse(request.id, "the mailbox worker could not be reached"))
      }
    })
}

export function createMailboxCryptoClient(
  options: MailboxCryptoClientOptions,
): MailboxCryptoClient {
  let nextId = 1
  let unlocked = false

  async function call<T>(body: WorkerRequestBody): Promise<T> {
    const response = await options.post({ ...body, id: nextId++ })
    if (!response.ok) {
      if (response.code === "MAILBOX_INTERNAL") {
        throw new Error("the mailbox worker could not complete that operation")
      }
      throw new MailboxCryptoError(response.code as MailboxErrorCode, undefined)
    }
    return response.value as T
  }

  return {
    async unlock(request) {
      const result = await call<UnlockResult>({ op: "unlock", request })
      unlocked = true
      return result
    },
    async restore(request) {
      const result = await call<{ restored: boolean }>({ op: "restore", request })
      if (result.restored) unlocked = true
      return result.restored
    },
    async extendLease(request) {
      const result = await call<{ extended: boolean }>({ op: "extendLease", request })
      return result.extended
    },
    async openMessage(sealed, options) {
      try {
        return await call<OpenedMessage>({ op: "openMessage", sealed, options })
      } catch (error) {
        if (error instanceof MailboxCryptoError && error.code === "MAILBOX_LOCKED") {
          unlocked = false
        }
        throw error
      }
    },
    async openConversation(sealed, options) {
      try {
        return await call<OpenedConversation>({ op: "openConversation", sealed, options })
      } catch (error) {
        if (error instanceof MailboxCryptoError && error.code === "MAILBOX_LOCKED") {
          unlocked = false
        }
        throw error
      }
    },
    async openApprovalDraft(sealed, options) {
      try {
        return await call<OpenedApprovalDraft>({ op: "openApprovalDraft", sealed, options })
      } catch (error) {
        if (error instanceof MailboxCryptoError && error.code === "MAILBOX_LOCKED") {
          unlocked = false
        }
        throw error
      }
    },
    async openAttachment(sealed, options) {
      try {
        return await call<OpenedAttachment>({ op: "openAttachment", sealed, options })
      } catch (error) {
        if (error instanceof MailboxCryptoError && error.code === "MAILBOX_LOCKED") {
          unlocked = false
        }
        throw error
      }
    },
    async sealIndexShard(shardId, plaintext) {
      const result = await call<{ shard: string }>({ op: "sealIndexShard", shardId, plaintext })
      return result.shard
    },
    async openIndexShard(shardId, blob) {
      const result = await call<{ shard: string }>({ op: "openIndexShard", shardId, blob })
      return result.shard
    },
    async verifySeals(rows) {
      const result = await call<{ verdicts: SealVerdict[] }>({
        op: "verifySeals",
        rows: [...rows],
      })
      return result.verdicts
    },
    async signAck(statement) {
      return await call<MailboxAckSigned>({ op: "signAck", statement })
    },
    async ledgerMac(statements) {
      const result = await call<{ macs: string[] }>({
        op: "ledgerMac",
        statements: [...statements],
      })
      return result.macs
    },
    async mintWrap(request) {
      return await call<MintedWrap>({ op: "mintWrap", request })
    },
    async endMinting() {
      await call({ op: "endMinting" })
    },
    async lock() {
      await call({ op: "lock" })
      unlocked = false
    },
    async setIdleTimeoutMs(ms) {
      const result = await call<{ idleTimeoutMs: number }>({ op: "setIdleTimeout", ms })
      return result.idleTimeoutMs
    },
    isUnlocked: () => unlocked,
    async refreshStatus() {
      const result = await call<{ unlocked: boolean }>({ op: "status" })
      unlocked = result.unlocked
      return unlocked
    },
  }
}
