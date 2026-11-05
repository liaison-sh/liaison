// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Delivery receipts from this phone (spec-push S2, A3, A7).
//
// Two writers, one server route (POST /api/notifications/receipts, authorized
// by the device's receipt-only credential, never by the session):
//
//   - The Notification Service Extension (ios/App/NotificationService) posts
//     `received` for every alert push, app running or not. It is Swift and has
//     no JS, so it only moves bytes: it reads the credential this file stored,
//     posts, and on a failed post leaves the receipt in the App Group queue.
//   - The app (push-client.ts) posts the FINAL outcome: `shown` when it
//     presents a push or finds one the OS presented, `suppressed/on_screen`
//     when the conversation is already in front of the user. The server keeps
//     the strongest of the three (received < shown < suppressed).
//
// The decisions all live here so they are tested: which outcome, which server
// and credential, what a failed post becomes, and how long a failed push
// registration waits before it tries again. Credentials are kept per SERVER
// ORIGIN (A7, multi-server): a push names the origin it came from, and only
// that origin's credential is ever presented to it.

import { serverAddressOrigin } from "./boot/server-global"

/** The receipt route, on whichever server the push came from. */
export const RECEIPTS_PATH = "/api/notifications/receipts"

export type ReceiptOutcome = "received" | "shown" | "suppressed"

/** What the keychain holds per server origin. */
export interface StoredCredential {
  credential: string
  /** The server's id for this device (the push token row id). */
  deviceId: string
}

/** One receipt waiting in the App Group container. The NSE writes this shape too. */
export interface QueuedReceipt {
  origin: string
  notificationId: string
  outcome: ReceiptOutcome
  reason?: string
  appState?: string
  /** Milliseconds since the epoch. */
  queuedAt: number
}

/** The native half: the shared keychain group and the App Group queue. */
export interface ReceiptNative {
  getCredential: (origin: string) => Promise<StoredCredential | null>
  setCredential: (origin: string, credential: StoredCredential) => Promise<void>
  deleteCredential: (origin: string) => Promise<void>
  listQueue: () => Promise<Array<{ key: string; receipt: QueuedReceipt }>>
  removeQueued: (keys: string[]) => Promise<void>
  enqueue: (receipt: QueuedReceipt) => Promise<void>
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ReceiptInput {
  notificationId: string
  outcome: ReceiptOutcome
  reason?: string
  appState?: string
}

/**
 * What a post came to. `queued`: it will be tried again from the App Group.
 * `dropped`: the server refused it for good (unknown delivery, revoked
 * credential). `no-credential`: this phone holds none for that server.
 */
export type PostResult = "sent" | "queued" | "dropped" | "no-credential"

export interface FlushResult {
  sent: number
  kept: number
  dropped: number
}

export interface ReceiptClient {
  post: (origin: string, input: ReceiptInput) => Promise<PostResult>
  flush: () => Promise<FlushResult>
  native: ReceiptNative
}

/** A queued receipt older than this is no longer worth anything to anyone. */
export const QUEUE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** First wait after a failed registration POST, and the ceiling (S3, M5). */
export const REGISTER_BACKOFF_BASE_MS = 2_000
export const REGISTER_BACKOFF_MAX_MS = 300_000

/**
 * How long to wait before registration attempt `attempt + 1`, after `attempt`
 * consecutive failures: 2 s, 4 s, 8 s ... capped at 5 minutes. The first retry
 * lands well within M5's 2 minute window.
 */
export function registrationBackoffMs(attempt: number): number {
  const n = Number.isFinite(attempt) && attempt >= 1 ? Math.floor(attempt) : 1
  return Math.min(REGISTER_BACKOFF_BASE_MS * 2 ** (n - 1), REGISTER_BACKOFF_MAX_MS)
}

/**
 * Whether a failed registration POST is worth trying again. A transport
 * failure (null), an expired bearer, a timeout, rate limiting and a server
 * error can all clear up; a validation error or a refused (restricted)
 * session will answer the same thing every time.
 */
export function isRetryableRegisterStatus(status: number | null): boolean {
  if (status === null) return true
  return status === 401 || status === 408 || status === 429 || status >= 500
}

/**
 * The app's final outcome for a push it is presenting (A3). The conversation
 * or session on screen gets no notice, so its receipt says why.
 */
export function presentationOutcome(
  payload: Record<string, unknown>,
  threadOnScreen: string | null,
): { outcome: "shown" } | { outcome: "suppressed"; reason: "on_screen" } {
  // The on-screen slot holds the conversation OR the node session on screen
  // (P4, P-D3); ids are UUIDs, so the two cannot collide.
  if (threadOnScreen !== null) {
    for (const id of [payload.threadId, payload.sessionId]) {
      if (typeof id === "string" && id === threadOnScreen) {
        return { outcome: "suppressed", reason: "on_screen" }
      }
    }
  }
  return { outcome: "shown" }
}

/**
 * The server a receipt for `payload` goes to: the origin the payload names,
 * else the server this install is bound to. Null when neither is an http(s)
 * origin.
 */
export function receiptOrigin(
  payload: Record<string, unknown>,
  boundServer: string | null,
): string | null {
  const named = payload.server
  if (typeof named === "string" && named.length > 0) return serverAddressOrigin(named)
  return boundServer === null ? null : serverAddressOrigin(boundServer)
}

/**
 * Keeps the credential a push token registration answered with (POST
 * /api/push/tokens -> `{data: {id, receiptCredential}}`), under the server's
 * origin. Every registration rotates it server side, so the latest one wins.
 */
export async function storeRegistrationCredential(
  native: ReceiptNative,
  server: string,
  answer: unknown,
): Promise<boolean> {
  const data = (answer as { data?: { id?: unknown; receiptCredential?: unknown } } | null)?.data
  const origin = serverAddressOrigin(server)
  if (
    origin === null ||
    typeof data?.id !== "string" ||
    typeof data.receiptCredential !== "string" ||
    data.receiptCredential.length === 0
  ) {
    return false
  }
  await native.setCredential(origin, { credential: data.receiptCredential, deviceId: data.id })
  return true
}

type SendResult = "sent" | "retry" | "drop" | "no-credential"

export function createReceiptClient(deps: {
  native: ReceiptNative
  fetchImpl?: FetchLike
  now?: () => number
}): ReceiptClient {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init))
  const now = deps.now ?? Date.now
  const native = deps.native

  const send = async (origin: string, input: ReceiptInput): Promise<SendResult> => {
    const stored = await native.getCredential(origin).catch(() => null)
    if (stored === null) return "no-credential"
    const body: Record<string, string> = {
      notificationId: input.notificationId,
      outcome: input.outcome,
    }
    if (input.reason) body.reason = input.reason
    if (input.appState) body.appState = input.appState
    body.deviceId = stored.deviceId
    let status: number
    try {
      const response = await fetchImpl(`${origin}${RECEIPTS_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${stored.credential}`,
        },
        body: JSON.stringify(body),
      })
      status = response.status
    } catch {
      return "retry"
    }
    if (status >= 200 && status < 300) return "sent"
    // 401/403: the credential is revoked or another device's; 404: no
    // delivery to this device; 400: malformed. None of them changes on retry.
    if (status === 408 || status === 429 || status >= 500) return "retry"
    return "drop"
  }

  let flushing: Promise<FlushResult> | null = null

  const flushOnce = async (): Promise<FlushResult> => {
    const result: FlushResult = { sent: 0, kept: 0, dropped: 0 }
    const entries = await native.listQueue().catch(() => [])
    const done: string[] = []
    for (const { key, receipt } of entries) {
      if (now() - receipt.queuedAt > QUEUE_MAX_AGE_MS) {
        result.dropped += 1
        done.push(key)
        continue
      }
      const outcome = await send(receipt.origin, receipt)
      if (outcome === "sent") {
        result.sent += 1
        done.push(key)
      } else if (outcome === "retry") {
        result.kept += 1
      } else {
        // Refused for good, or no credential left for that server (signed out).
        result.dropped += 1
        done.push(key)
      }
    }
    if (done.length > 0) await native.removeQueued(done).catch(() => undefined)
    return result
  }

  return {
    native,
    async post(origin, input) {
      const outcome = await send(origin, input)
      if (outcome === "sent") return "sent"
      if (outcome === "no-credential") return "no-credential"
      if (outcome === "drop") return "dropped"
      const queued: QueuedReceipt = {
        origin,
        notificationId: input.notificationId,
        outcome: input.outcome,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.appState ? { appState: input.appState } : {}),
        queuedAt: now(),
      }
      await native.enqueue(queued).catch(() => undefined)
      return "queued"
    },
    // Launch and foreground can ask at once; one pass at a time, or a receipt
    // listed by both is sent twice.
    flush() {
      if (flushing === null) {
        flushing = flushOnce().finally(() => {
          flushing = null
        })
      }
      return flushing
    },
  }
}

/** An in-memory native half: the tests', and the shape a platform without one gets. */
export function createMemoryReceiptNative(): ReceiptNative {
  const credentials = new Map<string, StoredCredential>()
  const queue = new Map<string, QueuedReceipt>()
  let seq = 0
  return {
    getCredential: async (origin) => credentials.get(origin) ?? null,
    setCredential: async (origin, credential) => {
      credentials.set(origin, { ...credential })
    },
    deleteCredential: async (origin) => {
      credentials.delete(origin)
    },
    listQueue: async () => [...queue].map(([key, receipt]) => ({ key, receipt: { ...receipt } })),
    removeQueued: async (keys) => {
      for (const key of keys) queue.delete(key)
    },
    enqueue: async (receipt) => {
      queue.set(`m-${++seq}`, { ...receipt })
    },
  }
}
