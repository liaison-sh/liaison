// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A mailbox answer that reaches the wrong process (spec A30, P2 T13).
//
// The pending request lives in one process's memory (mailbox-plaintext-registry):
// the process that minted it. With several processes behind one address, the
// browser's answer can land on any of them. The answer carries decrypted mail, so
// it may never travel through Redis (mailbox-plaintext-broker.ts, property 2).
// Instead the process that received it forwards it, over a direct HTTP call, to
// the minting process's INTERNAL listener:
//
//   - Redis holds only where each process listens: `internalUrl` in its heartbeat
//     record (infra/instance-registry.ts), which expires with the process.
//   - The call is signed with HMAC-SHA256 over
//     `path | timestamp | instanceId | sha256(raw body bytes)` under a MAC key
//     derived with HKDF from JWT_SECRET (label below). The body carries the
//     request id, user and turn nonce, so its hash covers them. This is a request
//     signature between our own processes; it encrypts nothing and touches no
//     mail encryption.
//   - The receiver reads at most INTERNAL_MAX_BODY_BYTES and checks the
//     signature over the raw bytes BEFORE it parses anything. It refuses more
//     than 30 s of clock skew, a signature it already saw, and a signature made
//     for another instance, then re-runs the registry's own user and turn-nonce
//     checks.
//   - The internal listener serves this one route on its own port, bound to the
//     address it advertises (LIAISON_INTERNAL_BIND overrides). The public app
//     never mounts it, so neither the reverse proxy nor a browser reaches it.

import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto"
import { lookup } from "node:dns/promises"
import os from "node:os"
import { Hono } from "hono"
import { z } from "zod"
import { INSTANCE_ID } from "~/infra/instance-id"
import { readInstance } from "~/infra/instance-registry"
import { env } from "~/lib/env"
import { rootLogger } from "~/lib/logger"
import { MAILBOX_ANSWER_BODY_MAX_BYTES } from "~/modules/agent/mailbox-plaintext/answer-limits"
import {
  type MailboxAnswerInput,
  type ResolveOutcome,
  resolveMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"

const log = rootLogger.child({ module: "mailbox-forward" })

export const INTERNAL_MAILBOX_ANSWER_PATH = "/internal/mailbox-answer"
/** A signed call older or newer than this is refused. */
export const INTERNAL_MAX_SKEW_MS = 30_000
/** How long the forwarder waits for the owner. */
export const FORWARD_TIMEOUT_MS = 5_000
/**
 * The forwarded body is the public answer route's body re-serialized plus three
 * short ids. That route is capped at MAILBOX_ANSWER_BODY_MAX_BYTES (app.ts,
 * apiBodyLimitMiddleware), so 1 MiB over it holds any answer it accepted with
 * room to spare, and nothing larger is read before the signature is checked.
 */
export const INTERNAL_MAX_BODY_BYTES = MAILBOX_ANSWER_BODY_MAX_BYTES + 1024 * 1024

const HEADER_TIMESTAMP = "x-liaison-internal-ts"
const HEADER_SIGNATURE = "x-liaison-internal-signature"

/** HKDF label: a MAC key used for nothing else than internal request signatures. */
const HKDF_SALT = "liaison-internal-request-signature"
const HKDF_INFO = "liaison-internal-v1"

export type ForwardOutcome = ResolveOutcome | "wrong_instance"

let cachedKey: { secret: string; key: Buffer } | null = null

/** HKDF-SHA256(JWT_SECRET, salt, "liaison-internal-v1"), 32 bytes. */
export function internalSigningKey(secret: string = env.JWT_SECRET): Buffer {
  if (cachedKey?.secret === secret) return cachedKey.key
  const key = Buffer.from(hkdfSync("sha256", secret, HKDF_SALT, HKDF_INFO, 32))
  cachedKey = { secret, key }
  return key
}

export interface SignedFields {
  path: string
  timestamp: number
  /** The instance the call is addressed to (the request's owner). */
  instanceId: string
  /** The exact bytes sent (a string is hashed as its UTF-8 bytes). */
  body: string | Uint8Array
}

export function signInternalRequest(
  fields: SignedFields,
  key: Buffer = internalSigningKey(),
): string {
  const bodyHash = createHash("sha256").update(fields.body).digest("hex")
  return createHmac("sha256", key)
    .update([fields.path, String(fields.timestamp), fields.instanceId, bodyHash].join("|"))
    .digest("hex")
}

/** A signature as `signInternalRequest` writes it: 32 bytes, lower-case hex. */
const SIGNATURE_RE = /^[0-9a-f]{64}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The minting instance of an `<instanceId>:<uuid>` id, or null when malformed. */
export function ownerInstanceOf(requestId: string): string | null {
  const idx = requestId.indexOf(":")
  if (idx <= 0) return null
  const owner = requestId.slice(0, idx)
  return UUID_RE.test(owner) ? owner : null
}

/** The answer as the minting process's registry checks it (user, org, nonce or token). */
export type ForwardInput = MailboxAnswerInput

/**
 * Hand an answer to the process that minted `requestId`. A dead, unknown or
 * unreachable owner is `wrong_instance` (409 WRONG_INSTANCE, as before forwarding
 * existed): the resolver that answer names is gone.
 */
export async function forwardMailboxAnswer(
  requestId: string,
  input: ForwardInput,
): Promise<ForwardOutcome> {
  const owner = ownerInstanceOf(requestId)
  if (!owner) return "wrong_instance"
  let internalUrl: string | undefined
  try {
    internalUrl = (await readInstance(owner))?.internalUrl
  } catch (err) {
    log.warn({ err, owner }, "could not read the owner's instance record")
    return "wrong_instance"
  }
  if (!internalUrl) return "wrong_instance"

  const body = JSON.stringify({
    requestId,
    userId: input.userId,
    ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
    ...(input.turnNonce !== undefined ? { turnNonce: input.turnNonce } : {}),
    ...(input.answerToken !== undefined ? { answerToken: input.answerToken } : {}),
    response: input.response,
    ...(input.turnOwner ? { turnOwner: true } : {}),
  })
  const timestamp = Date.now()
  const signature = signInternalRequest({
    path: INTERNAL_MAILBOX_ANSWER_PATH,
    timestamp,
    instanceId: owner,
    body,
  })
  let res: Response
  try {
    res = await fetch(new URL(INTERNAL_MAILBOX_ANSWER_PATH, internalUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [HEADER_TIMESTAMP]: String(timestamp),
        [HEADER_SIGNATURE]: signature,
      },
      body,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    })
  } catch (err) {
    log.warn({ err, owner, internalUrl }, "the owner of a mailbox request is unreachable")
    return "wrong_instance"
  }
  if (!res.ok) {
    // A refused signature between our own processes means their secrets differ:
    // a deploy fault, said loudly, answered as an unreachable owner.
    log.error(
      { owner, status: res.status, error: await res.text().catch(() => "") },
      "the owner of a mailbox request refused the forwarded answer",
    )
    return "wrong_instance"
  }
  const parsed = forwardReplySchema.safeParse(await res.json().catch(() => null))
  if (!parsed.success) {
    log.error({ owner }, "the owner of a mailbox request answered something unreadable")
    return "wrong_instance"
  }
  return parsed.data.outcome
}

const forwardReplySchema = z.object({
  outcome: z.enum([
    "resolved",
    "held",
    "already_settled",
    "not_found",
    "nonce_mismatch",
    "wrong_instance",
  ]),
})

const itemSchema = z.object({
  messageId: z.string(),
  subject: z.string().nullable().optional(),
  textBody: z.string().nullable().optional(),
  htmlBody: z.string().nullable().optional(),
  quotedBody: z.string().nullable().optional(),
  resolvedSubject: z.string().nullable().optional(),
  bytesBase64: z.string().nullable().optional(),
})

const responseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("plaintext"),
    items: z.array(itemSchema),
    undecryptable: z.array(z.string()).optional(),
    consented: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("search"),
    messageIds: z.array(z.string()),
    indexComplete: z.boolean().optional(),
  }),
  // No `unconfirmed`: only the owner's registry sets it.
  z.object({
    kind: z.literal("denied"),
    reason: z.string(),
    code: z.enum(["locked"]).optional(),
  }),
])

const forwardBodySchema = z.object({
  requestId: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
  orgId: z.string().min(1).max(200).optional(),
  turnNonce: z.string().min(1).max(128).optional(),
  answerToken: z.string().min(1).max(128).optional(),
  response: responseSchema,
  turnOwner: z.boolean().optional(),
})

/**
 * Another signed route on the internal listener (the app bridge forward,
 * modules/apps/workers/bridge-forward.ts). It checks its own signature and
 * reads its body with its own cap; `maxBodyBytes` raises the listener's.
 */
export interface InternalRoute {
  maxBodyBytes: number
  mount(app: Hono, ctx: { instanceId: string; now: () => number }): void
}

export interface InternalAppOptions {
  /** Who this listener answers for. Default: this process. */
  instanceId?: string
  resolve?: typeof resolveMailboxRequest
  now?: () => number
  extraRoutes?: readonly InternalRoute[]
}

/**
 * The internal listener's whole surface: the signed mailbox route, any
 * `extraRoutes`, everything else 404. Never mounted on the public app.
 */
export function createInternalApp(opts: InternalAppOptions = {}): Hono {
  const instanceId = opts.instanceId ?? INSTANCE_ID
  const resolve = opts.resolve ?? resolveMailboxRequest
  const now = opts.now ?? Date.now
  const key = internalSigningKey()
  // Signatures seen inside the skew window: the same signed call twice is a replay.
  const seen = new Map<string, number>()

  const app = new Hono()
  app.post(INTERNAL_MAILBOX_ANSWER_PATH, async (c) => {
    const at = now()
    const timestamp = Number(c.req.header(HEADER_TIMESTAMP))
    const signature = c.req.header(HEADER_SIGNATURE) ?? ""
    if (!Number.isFinite(timestamp) || Math.abs(at - timestamp) > INTERNAL_MAX_SKEW_MS) {
      return c.json({ error: "EXPIRED" }, 401)
    }
    // One spelling only: a hex decoder accepts upper case and drops a trailing
    // odd nibble, so two header strings would carry the same HMAC and the
    // replay set (keyed by the string) would miss the second.
    if (!SIGNATURE_RE.test(signature)) return c.json({ error: "BAD_SIGNATURE" }, 401)
    const raw = await readCapped(c.req.raw, INTERNAL_MAX_BODY_BYTES)
    if (raw === null) return c.json({ error: "TOO_LARGE" }, 413)
    // The signature is checked over the raw bytes before anything parses them.
    const expected = Buffer.from(
      signInternalRequest(
        { path: INTERNAL_MAILBOX_ANSWER_PATH, timestamp, instanceId, body: raw },
        key,
      ),
      "hex",
    )
    const given = Buffer.from(signature, "hex")
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return c.json({ error: "BAD_SIGNATURE" }, 401)
    }
    for (const [sig, exp] of seen) if (exp < at) seen.delete(sig)
    if (seen.has(signature)) return c.json({ error: "REPLAYED" }, 409)
    seen.set(signature, timestamp + 2 * INTERNAL_MAX_SKEW_MS)

    // Signed by one of our processes: only now is the body parsed.
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw))
    } catch {
      return c.json({ error: "BAD_BODY" }, 400)
    }
    const parsed = forwardBodySchema.safeParse(parsedJson)
    if (!parsed.success) return c.json({ error: "BAD_BODY" }, 400)
    const body = parsed.data

    if (ownerInstanceOf(body.requestId) !== instanceId) {
      return c.json({ outcome: "wrong_instance" satisfies ForwardOutcome })
    }
    // The registry re-runs the user, org, nonce and token checks here, in the owner.
    const outcome = resolve(body.requestId, {
      userId: body.userId,
      ...(body.orgId !== undefined ? { orgId: body.orgId } : {}),
      ...(body.turnNonce !== undefined ? { turnNonce: body.turnNonce } : {}),
      ...(body.answerToken !== undefined ? { answerToken: body.answerToken } : {}),
      response: body.response,
      ...(body.turnOwner ? { turnOwner: true } : {}),
    })
    return c.json({ outcome })
  })
  for (const route of opts.extraRoutes ?? []) route.mount(app, { instanceId, now })
  app.all("*", (c) => c.text("Not Found", 404))
  return app
}

/**
 * The body's bytes, or null past `max`. A declared length over the cap is
 * refused before reading; a stream without one is cut off at the cap.
 */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return new Uint8Array(0)
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

export interface InternalListener {
  /** What other processes call: `http://<host>:<port>`. */
  url: string
  port: number
  /** The address the listener is bound to. */
  bind: string
  stop(): void
}

export interface InternalAddressOptions {
  /** The advertised host. Default `LIAISON_INTERNAL_HOST`, else the hostname. */
  host?: string
  /** The bind address. Default `LIAISON_INTERNAL_BIND`, else the advertised host's address. */
  bind?: string
  /** For tests: the machine's hostname. */
  hostname?: string
}

/**
 * Where other processes reach this one, and where it listens.
 *
 * Advertised: `LIAISON_INTERNAL_HOST`, else the hostname (inside compose, the
 * container's, which the network's DNS resolves). A hostname that does not
 * resolve even here (a laptop) means only processes on this machine can reach
 * it, so loopback is used and said.
 *
 * Bound: `LIAISON_INTERNAL_BIND`, else the address the advertised host resolves
 * to here: the container's own address on the compose network, or loopback, and
 * never every interface by default. When the advertised address is not on this
 * machine (a port mapped through NAT, say), the bind fails at start and names
 * LIAISON_INTERNAL_BIND.
 */
export async function internalAddresses(
  opts: InternalAddressOptions = {},
): Promise<{ advertise: string; bind: string }> {
  let advertise = opts.host ?? env.LIAISON_INTERNAL_HOST
  if (!advertise) {
    const host = opts.hostname ?? os.hostname()
    try {
      await lookup(host)
      advertise = host
    } catch {
      log.warn(
        { host },
        "this hostname does not resolve; mailbox answers can be forwarded here only from this machine (set LIAISON_INTERNAL_HOST)",
      )
      advertise = "127.0.0.1"
    }
  }
  const explicitBind = opts.bind ?? env.LIAISON_INTERNAL_BIND
  if (explicitBind) return { advertise, bind: explicitBind }
  // IPv4 first: a peer resolving the same name picks IPv4 first too.
  const resolved = await lookup(advertise, { family: 4 }).catch(() => lookup(advertise))
  return { advertise, bind: resolved.address }
}

/**
 * Start the internal listener on `LIAISON_INTERNAL_PORT` (0: any free port).
 * Every role starts one: an `api` and a `worker` both run turns that mint
 * mailbox requests, and app runs whose bridge calls may land elsewhere.
 */
export async function startInternalListener(
  opts: InternalAppOptions & { port?: number; host?: string; bind?: string } = {},
): Promise<InternalListener> {
  const app = createInternalApp(opts)
  const { advertise, bind } = await internalAddresses({ host: opts.host, bind: opts.bind })
  let server: ReturnType<typeof Bun.serve>
  try {
    server = Bun.serve({
      hostname: bind,
      port: opts.port ?? env.LIAISON_INTERNAL_PORT,
      maxRequestBodySize: Math.max(
        INTERNAL_MAX_BODY_BYTES,
        ...(opts.extraRoutes ?? []).map((r) => r.maxBodyBytes),
      ),
      // A forwarded app bridge call may run for minutes (to its run's deadline);
      // Bun's default idle timeout is 10 s. 255 s is the most Bun accepts.
      idleTimeout: 255,
      fetch: (req) => app.fetch(req),
    })
  } catch (err) {
    log.error(
      { err, bind, advertise },
      "the internal listener cannot bind the address it advertises; set LIAISON_INTERNAL_BIND to a local address (0.0.0.0 behind NAT, with the port firewalled)",
    )
    throw err
  }
  const port = server.port ?? 0
  const hostPart = advertise.includes(":") ? `[${advertise}]` : advertise
  const url = `http://${hostPart}:${port}`
  log.info({ port, url, bind }, "Internal listener listening")
  return { url, port, bind, stop: () => void server.stop(true) }
}
