// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  type BillingStateReply,
  billingStateReplySchema,
  CONTRACT_VERSION,
  INSTANCE_ENVELOPE_VERSION,
  INSTANCE_HEADER,
  MESSAGE_TYPES,
  type MessageType,
  messageSchemas,
  REJECTION_CODES,
  type RejectionCode,
  rejectionReplySchema,
  retryLaterReplySchema,
  SIGNATURE_HEADER,
} from "@liaison/control-plane-contract"
import { deriveInstanceKey, signBody } from "@liaison/control-plane-contract/node"
import { Hono } from "hono"

/**
 * Mock control plane server for Phase 14 E2E tests.
 *
 * Mirrors the inbound contract that production calls via
 *   GET ${CONTROL_PLANE_URL}/v1/orgs/:orgId/billing-state
 * with Authorization: Bearer ${CONTROL_PLANE_API_KEY}.
 *
 * Each `startFakeControlPlane(port)` boots an isolated Bun.serve instance with
 * its own mutable payload + request log. This is a real second process — the
 * API under test exercises real TCP + HTTP semantics, not in-process stubs.
 *
 * It also fakes the Liaison team's control plane endpoints
 *   POST /webhooks/:org/control/:endpoint
 * (`control`): every message is validated with the contract's schemas, every
 * signature checked with the contract's key derivation from `masterSecret`, a
 * registration answers the derived instance key, a replayed messageId answers
 * the kernel's duplicate reply, and rejections use the contract's rejection
 * envelope. `control.setMode` makes it down / 401 / 403 / 409 / 503 /
 * retry_later / slow; `control.queueReplies` scripts the next replies.
 */

/** The billing-state reply, shaped by the contract package the API parses it with. */
export type ControlPlanePayload = BillingStateReply

export interface FakeControlPlaneRequest {
  method: string
  path: string
  authorization: string | null
}

/** One request to a control plane endpoint, as the fake received it. */
export interface FakeControlRequest {
  endpoint: string
  headers: Record<string, string>
  rawBody: string
  body: unknown
  /** The status the fake answered. */
  status: number
}

export type FakeControlMode = "up" | "down" | "401" | "403" | "409" | "503" | "retry_later" | "slow"

/** A scripted reply, used once, before any other processing. */
export interface FakeControlReply {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export interface FakeControlHandle {
  /** `<url>/webhooks/<org>/control`: what LIAISON_TEAM_ENDPOINT points at. */
  endpoint: string
  masterSecret: string
  /** `down` stops the listener (connection refused) until another mode is set. */
  setMode: (
    mode: FakeControlMode,
    opts?: { retryAfterSeconds?: number; delayMs?: number },
  ) => Promise<void>
  queueReplies: (replies: FakeControlReply[]) => void
  /** The clock the fake's `Date` header reads (default: real time). */
  setClock: (clock: () => Date) => void
  /** Forget a registered instance: its next signed message gets 403 unknown_instance. */
  forget: (instanceId: string) => void
  requests: () => FakeControlRequest[]
  /** Every accepted message, once per messageId. */
  acks: () => { type: MessageType; messageId: string; instanceId: string }[]
  /** Registered instance ids, in registration order. */
  instances: () => string[]
}

export interface FakeControlPlaneHandle {
  url: string
  port: number
  control: FakeControlHandle
  setPayload: (payload: ControlPlanePayload) => void
  setStatus: (status: number) => void
  getRequests: () => FakeControlPlaneRequest[]
  resetRequests: () => void
  kill: () => Promise<void>
}

// Built through the same schema the API validates replies with, so the fake
// cannot drift from what production accepts.
const DEFAULT_PAYLOAD: ControlPlanePayload = billingStateReplySchema.parse({
  tier: "team",
  status: "active",
  billingPortalUrl: "https://fake.control-plane.local/portal",
  checkoutUrl: "https://fake.control-plane.local/checkout",
  includedCredits: "10000",
  periodEnd: "2099-01-01T00:00:00.000Z",
})

const FAKE_ORG = "00000000-0000-4000-8000-0000000000c0"

export async function startFakeControlPlane(
  port: number,
  opts: { initialPayload?: ControlPlanePayload; masterSecret?: string } = {},
): Promise<FakeControlPlaneHandle> {
  let payload: ControlPlanePayload = billingStateReplySchema.parse({
    ...DEFAULT_PAYLOAD,
    ...(opts.initialPayload ?? {}),
  })
  let statusCode = 200
  const requestLog: FakeControlPlaneRequest[] = []

  const app = new Hono()

  app.use("*", async (c, next) => {
    requestLog.push({
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      authorization: c.req.header("authorization") ?? null,
    })
    return next()
  })

  app.get("/__health", (c) => c.json({ ok: true }))

  app.get("/v1/orgs/:orgId/billing-state", (c) => {
    if (statusCode >= 400) {
      return c.json({ error: { message: "control plane error" } }, statusCode as 400)
    }
    return c.json(payload)
  })

  // ── Liaison team control plane endpoints ──────────────────────────────────
  const masterSecret = opts.masterSecret ?? "fake-control-master-secret"
  let mode: FakeControlMode = "up"
  let modeRetryAfter: number | undefined
  let modeDelayMs = 0
  let clock: () => Date = () => new Date()
  const scripted: FakeControlReply[] = []
  const controlLog: FakeControlRequest[] = []
  const registered = new Map<string, string>() // instanceId -> nonce
  const order: string[] = []
  const forgotten = new Set<string>()
  const seen = new Set<string>()
  const ackLog: { type: MessageType; messageId: string; instanceId: string }[] = []

  const reject = (code: RejectionCode) => rejectionReplySchema.parse({ error: { message: code } })

  app.post("/webhooks/:org/control/:endpoint", async (c) => {
    const endpoint = c.req.param("endpoint")
    const rawBody = await c.req.text()
    const headers: Record<string, string> = {}
    c.req.raw.headers.forEach((v, k) => {
      headers[k] = v
    })
    let body: unknown = null
    try {
      body = JSON.parse(rawBody)
    } catch {
      body = null
    }
    const answer = (status: number, json: unknown, extra: Record<string, string> = {}) => {
      controlLog.push({ endpoint, headers, rawBody, body, status })
      return new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json", date: clock().toUTCString(), ...extra },
      })
    }

    const next = scripted.shift()
    if (next) return answer(next.status, next.body ?? {}, next.headers)
    if (mode === "slow") await new Promise((r) => setTimeout(r, modeDelayMs))
    if (mode === "401") return answer(401, { error: { message: "Invalid signature" } })
    if (mode === "403") return answer(403, { error: { message: "Webhook rejected" } })
    if (mode === "409") return answer(409, reject(REJECTION_CODES.alreadyRegistered))
    if (mode === "503") {
      return answer(
        503,
        { error: { message: "Webhook rejected" } },
        modeRetryAfter ? { "retry-after": String(modeRetryAfter) } : {},
      )
    }
    if (mode === "retry_later") {
      return answer(200, {
        data: retryLaterReplySchema.parse({
          type: "retry_later",
          reason: "fake_retry_later",
          ...(modeRetryAfter ? { retryAfterSeconds: modeRetryAfter } : {}),
        }),
      })
    }

    if (!(MESSAGE_TYPES as readonly string[]).includes(endpoint)) {
      return answer(404, { error: { message: "Unknown webhook endpoint" } })
    }
    const type = endpoint as MessageType
    const parsed = messageSchemas[type].safeParse(body)
    if (!parsed.success) return answer(400, reject(REJECTION_CODES.invalidMessage))
    // A control plane that predates contract v2 accepts only `v: 1` on the
    // version-1 message types, so an instance must keep stamping those with 1.
    if ((body as { v?: unknown }).v !== INSTANCE_ENVELOPE_VERSION) {
      return answer(400, reject(REJECTION_CODES.invalidMessage))
    }
    const msg = parsed.data as { messageId: string; instanceId: string; data: { nonce?: string } }
    if (headers[INSTANCE_HEADER] !== msg.instanceId) {
      return answer(401, { error: { message: "Invalid signature" } })
    }

    if (type === "register") {
      const known = registered.get(msg.instanceId)
      if (forgotten.has(msg.instanceId) || (known && known !== msg.data.nonce)) {
        return answer(409, reject(REJECTION_CODES.alreadyRegistered))
      }
      if (seen.has(msg.messageId)) return answer(200, { data: { received: true, duplicate: true } })
      seen.add(msg.messageId)
      if (!known) {
        registered.set(msg.instanceId, msg.data.nonce ?? "")
        order.push(msg.instanceId)
      }
      ackLog.push({ type, messageId: msg.messageId, instanceId: msg.instanceId })
      return answer(200, {
        data: {
          type: "registered",
          instanceKey: deriveInstanceKey(masterSecret, msg.instanceId),
          contract: CONTRACT_VERSION,
        },
      })
    }

    const signature = headers[SIGNATURE_HEADER]
    const expected = signBody(deriveInstanceKey(masterSecret, msg.instanceId), rawBody)
    if (!signature || signature !== expected) {
      return answer(401, { error: { message: "Invalid signature" } })
    }
    if (!registered.has(msg.instanceId) || forgotten.has(msg.instanceId)) {
      return answer(403, reject(REJECTION_CODES.unknownInstance))
    }
    if (seen.has(msg.messageId)) return answer(200, { data: { received: true, duplicate: true } })
    seen.add(msg.messageId)
    ackLog.push({ type, messageId: msg.messageId, instanceId: msg.instanceId })
    if (type === "deregister") forgotten.add(msg.instanceId)
    return answer(200, { data: { type: "ack", messageId: msg.messageId } })
  })

  app.all("*", (c) => c.json({ error: { message: "not found" } }, 404))

  let server = Bun.serve({ fetch: app.fetch, port })
  const boundPort = server.port ?? port

  // Tiny readiness probe — Bun.serve binds synchronously, but a fetch
  // round-trip catches the rare port-collision case before tests race in.
  const url = `http://127.0.0.1:${boundPort}`
  const waitReady = async () => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${url}/__health`)
        if (r.ok) break
      } catch {
        // not ready yet
      }
      await new Promise((res) => setTimeout(res, 20))
    }
  }
  await waitReady()
  let stopped = false

  const control: FakeControlHandle = {
    endpoint: `${url}/webhooks/${FAKE_ORG}/control`,
    masterSecret,
    setMode: async (next, modeOpts = {}) => {
      modeRetryAfter = modeOpts.retryAfterSeconds
      modeDelayMs = modeOpts.delayMs ?? 15_000
      if (next === "down" && !stopped) {
        server.stop(true)
        stopped = true
      } else if (next !== "down" && stopped) {
        server = Bun.serve({ fetch: app.fetch, port: boundPort })
        stopped = false
        await waitReady()
      }
      mode = next
    },
    queueReplies: (replies) => {
      scripted.push(...replies)
    },
    setClock: (next) => {
      clock = next
    },
    forget: (instanceId) => {
      forgotten.add(instanceId)
    },
    requests: () => [...controlLog],
    acks: () => [...ackLog],
    instances: () => [...order],
  }

  return {
    url,
    port: boundPort,
    control,
    setPayload: (next) => {
      payload = billingStateReplySchema.parse(next)
    },
    setStatus: (status) => {
      statusCode = status
    },
    getRequests: () => [...requestLog],
    resetRequests: () => {
      requestLog.length = 0
    },
    kill: async () => {
      if (!stopped) server.stop(true)
      stopped = true
    },
  }
}
