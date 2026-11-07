// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bridge call that reaches a process which does not own the run.
//
// The run registry is per process (run-registry.ts), and with several API and
// worker processes behind one public address, a run's isolate may call back on
// any of them. The run id names its owner (`<instanceId>:<uuid>`,
// infra/instance-id.ts), so the process that received the call forwards it,
// over a direct HTTP call, to the owner's INTERNAL listener (the one the
// mailbox answers use, mailbox-forward.ts). The call's args and result never
// go through Redis: Redis only holds where each process listens (its
// heartbeat record, infra/instance-registry.ts).
//
// On the receiving (non-owner) process, before anything is forwarded:
//   - the token's MAC must be valid for this run id (run-token.ts), so garbage
//     or a token presented for another run id costs one HMAC, no Redis read
//     and no forward;
//   - forwarded calls are limited per client IP (FORWARD_IP_LIMIT);
//   - an owner with no instance record is gone: 410 `run_owner_gone`.
// The raw body is then forwarded unchanged, signed with HMAC-SHA256 under the
// internal key (HKDF of JWT_SECRET, mailbox-forward.ts) over
//   path | timestamp | ownerInstanceId | runId | sha256(token) | nonce | sha256(body)
// so the run, the credential and the execution nonce are covered with the
// bytes.
//
// On the owner, the internal route reads at most INTERNAL_APP_BRIDGE_MAX_BODY_BYTES,
// checks the signature over the raw bytes before it parses anything, refuses
// more than 30 s of skew, a signature already seen (a replay set pruned per
// second, not per call) and a call signed for another instance, then answers
// with answerBridgeCall: the registry re-authenticates the token and the nonce,
// so the statuses (401 / 403 / 409 / 410 / 404 / 504) are the public route's.
// A refusal of the hop itself carries INTERNAL_REFUSAL_HEADER, and the
// forwarder answers it as 502 `forward_refused` (a deploy fault: two
// processes with different secrets), never as the run's own status.
//
// The forward waits as long as the call may last: the owner ends the call at
// the run's own deadline (504), and the forwarder's own bound is the longest
// run deadline the loader accepts (MAX_RUN_DEADLINE_MS) plus the registry's
// grace. It is aborted as soon as the caller disconnects.

import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import type { Hono } from "hono"
import { INSTANCE_ID } from "~/infra/instance-id"
import { readInstance } from "~/infra/instance-registry"
import { rootLogger } from "~/lib/logger"
import {
  INTERNAL_MAX_SKEW_MS,
  type InternalRoute,
  internalSigningKey,
  ownerInstanceOf,
  readCapped,
} from "~/modules/agent/mailbox-plaintext/mailbox-forward"
import { APP_BRIDGE_BODY_MAX_BYTES, answerBridgeCall, type BridgeAnswer } from "./bridge-call"
import { RUN_DEADLINE_GRACE_MS, type RunRegistry, runRegistry } from "./run-registry"
import { runTokenMintedFor } from "./run-token"

const log = rootLogger.child({ module: "app-bridge-forward" })

export const INTERNAL_APP_BRIDGE_PATH = "/internal/app-bridge"
/** The public route's cap plus room: the forwarded body is the public body, unchanged. */
export const INTERNAL_APP_BRIDGE_MAX_BODY_BYTES = APP_BRIDGE_BODY_MAX_BYTES + 64 * 1024
/** The loader's longest run deadline (its MAX_DEADLINE). */
export const MAX_RUN_DEADLINE_MS = 15 * 60_000
/** The forwarder's own bound on one forwarded call. */
export const FORWARD_MAX_WAIT_MS = MAX_RUN_DEADLINE_MS + RUN_DEADLINE_GRACE_MS
/**
 * Forwarded calls per client IP and window, per process. A run's calls come
 * from the loader's addresses and only a share of them lands on a non-owner;
 * this bounds what one address holding a valid token can make the cell do.
 */
export const FORWARD_IP_LIMIT = { max: 2_000, windowMs: 10_000 } as const

const HEADER_TIMESTAMP = "x-liaison-internal-ts"
const HEADER_SIGNATURE = "x-liaison-internal-signature"
const HEADER_RUN_ID = "x-liaison-run-id"
/** Set on a refusal of the hop itself (signature, skew, replay, size, addressee). */
export const INTERNAL_REFUSAL_HEADER = "x-liaison-internal-refusal"

const SIGNATURE_RE = /^[0-9a-f]{64}$/
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
/** A run id as the registry mints it: `<instanceId>:<uuid>`. */
const RUN_ID_RE = new RegExp(`^${UUID}:${UUID}$`, "i")
/** An execution nonce as the loader mints it (base64url). */
const NONCE_RE = /^[A-Za-z0-9_-]{1,128}$/

const sha256Hex = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")

export interface BridgeForwardFields {
  timestamp: number
  /** The instance the call is addressed to (the run's owner). */
  ownerInstanceId: string
  runId: string
  token: string
  nonce: string
  /** The exact bytes sent. */
  body: Uint8Array
}

export function signBridgeForward(
  fields: BridgeForwardFields,
  key: Buffer = internalSigningKey(),
): string {
  return createHmac("sha256", key)
    .update(
      [
        INTERNAL_APP_BRIDGE_PATH,
        String(fields.timestamp),
        fields.ownerInstanceId,
        fields.runId,
        sha256Hex(fields.token),
        fields.nonce,
        sha256Hex(fields.body),
      ].join("|"),
    )
    .digest("hex")
}

/** The headers a forwarded call carries, besides the content type. */
export function bridgeForwardHeaders(
  fields: BridgeForwardFields,
  signature: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${fields.token}`,
    "x-exec-nonce": fields.nonce,
    [HEADER_RUN_ID]: fields.runId,
    [HEADER_TIMESTAMP]: String(fields.timestamp),
    [HEADER_SIGNATURE]: signature,
  }
}

const answer = (status: number, value: unknown): BridgeAnswer => ({
  status,
  body: JSON.stringify(value),
})

/**
 * Signatures seen inside the skew window. Each is kept until its expiry
 * second; expired seconds are dropped at most once per second, so a call
 * costs O(1) whatever the number of calls in the window.
 */
export class ReplaySet {
  private readonly seen = new Set<string>()
  private readonly buckets = new Map<number, string[]>()
  private lastPrunedSecond = Number.NEGATIVE_INFINITY

  /** False when `signature` was already seen; else records it until `expiresAt` (epoch ms). */
  add(signature: string, expiresAt: number, now: number): boolean {
    this.prune(now)
    if (this.seen.has(signature)) return false
    this.seen.add(signature)
    const second = Math.ceil(expiresAt / 1000)
    const bucket = this.buckets.get(second)
    if (bucket) bucket.push(signature)
    else this.buckets.set(second, [signature])
    return true
  }

  size(): number {
    return this.seen.size
  }

  private prune(now: number): void {
    const second = Math.floor(now / 1000)
    if (second === this.lastPrunedSecond) return
    this.lastPrunedSecond = second
    for (const [s, sigs] of this.buckets) {
      if (s > second) continue
      for (const sig of sigs) this.seen.delete(sig)
      this.buckets.delete(s)
    }
  }
}

/** A fixed-window counter per IP; the whole table is dropped when the window rolls. */
class IpWindowLimiter {
  private counts = new Map<string, number>()
  private windowStart = Number.NEGATIVE_INFINITY

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  allow(ip: string, now: number): boolean {
    if (now - this.windowStart >= this.windowMs) {
      this.counts = new Map()
      this.windowStart = now
    }
    const n = (this.counts.get(ip) ?? 0) + 1
    this.counts.set(ip, n)
    return n <= this.max
  }
}

export interface ForwardBridgeRequest {
  runId: string
  /** The owner named in the run id (not this process). */
  owner: string
  token: string | undefined
  nonce: string | undefined
  clientIp: string
  /** The raw request body, read only once the call is to be forwarded. */
  body: () => Promise<ArrayBuffer>
  /** The caller's request signal: the forward stops when the caller is gone. */
  signal?: AbortSignal
}

export interface BridgeForwarder {
  forward(req: ForwardBridgeRequest): Promise<BridgeAnswer>
}

export interface BridgeForwarderOptions {
  /** The owner's internal URL, or undefined when it has no instance record. */
  readOwnerUrl?: (instanceId: string) => Promise<string | undefined>
  fetch?: typeof fetch
  now?: () => number
  ipLimit?: { max: number; windowMs: number }
  /** Overrides FORWARD_MAX_WAIT_MS (tests). */
  maxWaitMs?: number
}

async function ownerUrlFromRegistry(instanceId: string): Promise<string | undefined> {
  return (await readInstance(instanceId))?.internalUrl
}

export function createBridgeForwarder(opts: BridgeForwarderOptions = {}): BridgeForwarder {
  const readOwnerUrl = opts.readOwnerUrl ?? ownerUrlFromRegistry
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init))
  const now = opts.now ?? Date.now
  const limit = opts.ipLimit ?? FORWARD_IP_LIMIT
  const limiter = new IpWindowLimiter(limit.max, limit.windowMs)
  const maxWaitMs = opts.maxWaitMs ?? FORWARD_MAX_WAIT_MS

  return {
    async forward(req) {
      const { runId, owner } = req
      // What a non-owner can check without the run: the id's shape and the
      // token's MAC. A failure here is answered as the owner would answer it.
      if (!RUN_ID_RE.test(runId))
        return answer(401, { error: "Unknown run", reason: "unknown_run" })
      if (!runTokenMintedFor(runId, req.token)) {
        log.debug({ runId }, "App bridge call refused before forwarding: invalid run token")
        return answer(401, { error: "Invalid run token", reason: "bad_token" })
      }
      if (!req.nonce || !NONCE_RE.test(req.nonce)) {
        return answer(409, { error: "Execution nonce mismatch", reason: "nonce_mismatch" })
      }
      if (!limiter.allow(req.clientIp, now())) {
        log.warn({ runId, ip: req.clientIp }, "App bridge forwards over the per-IP limit")
        return answer(429, { error: "Too many forwarded bridge calls", reason: "rate_limited" })
      }

      let internalUrl: string | undefined
      try {
        internalUrl = await readOwnerUrl(owner)
      } catch (err) {
        log.warn({ err, owner, runId }, "could not read the run owner's instance record")
        return answer(503, { error: "Run owner lookup failed", reason: "owner_lookup_failed" })
      }
      if (!internalUrl) {
        log.warn({ owner, runId }, "App bridge call for a run whose process is gone")
        return answer(410, {
          error: "The process that ran this run is gone",
          reason: "run_owner_gone",
        })
      }

      const body = new Uint8Array(await req.body())
      if (body.byteLength > APP_BRIDGE_BODY_MAX_BYTES) {
        return answer(413, { error: "Body too large", reason: "too_large" })
      }
      const fields: BridgeForwardFields = {
        timestamp: now(),
        ownerInstanceId: owner,
        runId,
        token: req.token as string,
        nonce: req.nonce,
        body,
      }
      const signature = signBridgeForward(fields)
      const signals = [AbortSignal.timeout(maxWaitMs)]
      if (req.signal) signals.push(req.signal)
      let res: Response
      try {
        res = await doFetch(new URL(INTERNAL_APP_BRIDGE_PATH, internalUrl), {
          method: "POST",
          headers: bridgeForwardHeaders(fields, signature),
          body,
          signal: AbortSignal.any(signals),
        })
      } catch (err) {
        if ((err as Error)?.name === "TimeoutError") {
          log.warn({ owner, runId }, "a forwarded app bridge call outlived the longest run")
          return answer(504, {
            error: "Run deadline passed during the bridge call",
            reason: "expired",
          })
        }
        log.warn({ err, owner, runId, internalUrl }, "the owner of an app run is unreachable")
        return answer(502, {
          error: "The run's process is unreachable",
          reason: "run_owner_unreachable",
        })
      }
      const text = await res.text().catch(() => "")
      if (res.headers.get(INTERNAL_REFUSAL_HEADER)) {
        // Between our own processes: their secrets or clocks differ. Loud.
        log.error(
          { owner, runId, status: res.status, error: text.slice(0, 200) },
          "the owner of an app run refused the forwarded bridge call",
        )
        return answer(502, { error: "Forwarded bridge call refused", reason: "forward_refused" })
      }
      return { status: res.status, body: text }
    },
  }
}

export interface InternalAppBridgeOptions {
  registry?: RunRegistry
}

/**
 * The owner's side: the internal listener's `/internal/app-bridge` route
 * (mailbox-forward.ts startInternalListener, `extraRoutes`).
 */
export function internalAppBridgeRoute(opts: InternalAppBridgeOptions = {}): InternalRoute {
  const registry = opts.registry ?? runRegistry
  return {
    maxBodyBytes: INTERNAL_APP_BRIDGE_MAX_BODY_BYTES,
    mount(app: Hono, ctx: { instanceId?: string; now: () => number }) {
      const instanceId = ctx.instanceId ?? INSTANCE_ID
      const key = internalSigningKey()
      const replays = new ReplaySet()

      app.post(INTERNAL_APP_BRIDGE_PATH, async (c) => {
        const refuse = (status: 400 | 401 | 409 | 413, error: string) =>
          c.json({ error }, status, { [INTERNAL_REFUSAL_HEADER]: "1" })
        const at = ctx.now()
        const timestamp = Number(c.req.header(HEADER_TIMESTAMP))
        const signature = c.req.header(HEADER_SIGNATURE) ?? ""
        if (!Number.isFinite(timestamp) || Math.abs(at - timestamp) > INTERNAL_MAX_SKEW_MS) {
          return refuse(401, "EXPIRED")
        }
        if (!SIGNATURE_RE.test(signature)) return refuse(401, "BAD_SIGNATURE")
        const runId = c.req.header(HEADER_RUN_ID) ?? ""
        const token =
          /^Bearer\s+(\S+)$/i.exec((c.req.header("authorization") ?? "").trim())?.[1] ?? ""
        const nonce = c.req.header("x-exec-nonce") ?? ""
        const raw = await readCapped(c.req.raw, INTERNAL_APP_BRIDGE_MAX_BODY_BYTES)
        if (raw === null) return refuse(413, "TOO_LARGE")
        // The signature is checked over the raw bytes before anything parses them.
        const expected = Buffer.from(
          signBridgeForward(
            { timestamp, ownerInstanceId: instanceId, runId, token, nonce, body: raw },
            key,
          ),
          "hex",
        )
        const given = Buffer.from(signature, "hex")
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
          return refuse(401, "BAD_SIGNATURE")
        }
        if (!replays.add(signature, timestamp + 2 * INTERNAL_MAX_SKEW_MS, at)) {
          return refuse(409, "REPLAYED")
        }
        if (ownerInstanceOf(runId) !== instanceId) return refuse(409, "WRONG_INSTANCE")

        // Signed by one of our processes; the registry re-checks the token and nonce.
        const res = await answerBridgeCall(
          registry,
          runId,
          token || undefined,
          nonce || undefined,
          async () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
        )
        return c.body(res.body, res.status as 200, { "content-type": "application/json" })
      })
    },
  }
}
