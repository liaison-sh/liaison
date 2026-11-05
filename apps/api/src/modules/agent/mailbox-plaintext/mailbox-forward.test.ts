// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A mailbox answer that reaches another process is forwarded to the minting
// process's internal listener, signed, and never through Redis (spec A30, P2 T13).
//
// "Instance A" is a listener built for a foreign instance id: the request id it
// owns is not this process's, so the public route here (instance B) must forward
// it. The registry it resolves into is the real one, shared in this process, so
// the pending promise is the turn's real wait.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { createHmac } from "node:crypto"
import { connect, type Socket } from "node:net"
import Redis from "ioredis"
import { app } from "~/app"
import { sql } from "~/db"
import { INSTANCE_ID } from "~/infra/instance-id"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { env } from "~/lib/env"
import { REDIS_PREFIX, redis } from "~/lib/redis"
import { isHealthOnlyPath } from "~/lib/server"
import {
  createInternalApp,
  forwardMailboxAnswer,
  INTERNAL_MAILBOX_ANSWER_PATH,
  INTERNAL_MAX_BODY_BYTES,
  type InternalListener,
  internalAddresses,
  internalSigningKey,
  signInternalRequest,
  startInternalListener,
} from "~/modules/agent/mailbox-plaintext/mailbox-forward"
import {
  MailboxPlaintextRegistryTestAccess,
  type MailboxRequestOutcome,
  mintMailboxRequestId,
  type PendingMailboxRequest,
  registerMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-0000009d0001"
const USER_ID = "00000000-0000-4000-8000-0000009d0002"
const OTHER_USER_ID = "00000000-0000-4000-8000-0000009d0003"
const NONCE = "turn-nonce-forward"

let token: string
let otherToken: string
const listeners: InternalListener[] = []
const recordKeys: string[] = []

async function tokenFor(userId: string, name: string): Promise<string> {
  return await signAccessToken(
    {
      userId,
      orgId: ORG_ID,
      name,
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["*"],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
}

/** A listener for `instanceId`, published in its heartbeat record as the registry writes it. */
async function ownerInstance(instanceId: string): Promise<InternalListener> {
  const listener = await startInternalListener({ instanceId, port: 0, host: "127.0.0.1" })
  listeners.push(listener)
  await publishRecord(instanceId, listener.url)
  return listener
}

async function publishRecord(instanceId: string, internalUrl: string): Promise<void> {
  recordKeys.push(LIVE_INSTANCE_KEY(instanceId))
  await redis.set(
    LIVE_INSTANCE_KEY(instanceId),
    JSON.stringify({ role: "api", pid: 1, startedAt: Date.now(), internalUrl }),
    "PX",
    30_000,
  )
}

const ANSWER_TOKEN = "answer-token-forward"

function pendingFor(requestId: string, userId = USER_ID): PendingMailboxRequest {
  return registerMailboxRequest({
    requestId,
    userId,
    orgId: ORG_ID,
    turnNonce: NONCE,
    answerToken: ANSWER_TOKEN,
    kind: "mail.read",
    messageIds: ["m1"],
  })
}

async function postAnswer(requestId: string, body: unknown, bearer = token): Promise<Response> {
  return await app.request(`/api/agent/mailbox-plaintext/${requestId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  })
}

/** A signed call straight to a listener, as a forwarder would send it. */
async function signedCall(
  listener: InternalListener,
  opts: {
    instanceId: string
    requestId: string
    userId?: string
    turnNonce?: string
    timestamp?: number
    key?: Buffer
    path?: string
  },
): Promise<{ res: Response; body: string; timestamp: number; signature: string }> {
  const userId = opts.userId ?? USER_ID
  const turnNonce = opts.turnNonce ?? NONCE
  const timestamp = opts.timestamp ?? Date.now()
  const body = JSON.stringify({
    requestId: opts.requestId,
    userId,
    turnNonce,
    response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "hello" }] },
  })
  const signature = signInternalRequest(
    {
      path: opts.path ?? INTERNAL_MAILBOX_ANSWER_PATH,
      timestamp,
      instanceId: opts.instanceId,
      body,
    },
    opts.key,
  )
  const res = await send(listener, body, timestamp, signature)
  return { res, body, timestamp, signature }
}

async function send(
  listener: InternalListener,
  body: string,
  timestamp: number,
  signature: string,
): Promise<Response> {
  return await fetch(`${listener.url}${INTERNAL_MAILBOX_ANSWER_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-liaison-internal-ts": String(timestamp),
      "x-liaison-internal-signature": signature,
    },
    body,
  })
}

/**
 * MONITOR on a plain socket, its lines in the server's order. Not ioredis's
 * `monitor()`: it enters monitoring mode a microtask after MONITOR's +OK, so on
 * a busy server the monitor lines that arrive in the same read as the +OK meet
 * an empty command queue and throw "Command queue state error" outside any test.
 */
async function rawMonitor(url: string): Promise<{
  lines: string[]
  /** Resolves once a line containing `needle` arrived (every earlier command's line came before it). */
  until(needle: string, ms?: number): Promise<void>
  close(): void
}> {
  const u = new URL(url)
  const lines: string[] = []
  let buffered = ""
  const waiters: Array<() => void> = []
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect({ host: u.hostname, port: Number(u.port || 6379) }, () => resolve(s))
    s.once("error", reject)
  })
  socket.setEncoding("utf8")
  let ok: () => void = () => {}
  const started = new Promise<void>((r) => {
    ok = r
  })
  socket.on("data", (chunk: string) => {
    buffered += chunk
    let end = buffered.indexOf("\r\n")
    while (end !== -1) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 2)
      if (line === "+OK") ok()
      else if (line.startsWith("+")) lines.push(line.slice(1))
      end = buffered.indexOf("\r\n")
    }
    for (const w of waiters.splice(0)) w()
  })
  const auth = u.password
    ? `AUTH ${u.username ? `${decodeURIComponent(u.username)} ` : ""}${decodeURIComponent(u.password)}\r\n`
    : ""
  socket.write(`${auth}MONITOR\r\n`)
  await started
  return {
    lines,
    async until(needle, ms = 10_000) {
      const deadline = Date.now() + ms
      while (!lines.some((l) => l.includes(needle))) {
        if (Date.now() > deadline) throw new Error(`monitor never saw ${needle}`)
        await new Promise<void>((r) => {
          waiters.push(r)
          setTimeout(r, 50)
        })
      }
    },
    close: () => socket.destroy(),
  }
}

async function settledWithin(
  pending: PendingMailboxRequest,
  ms = 2_000,
): Promise<MailboxRequestOutcome | "pending"> {
  return await Promise.race([
    pending.promise,
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ])
}

describe("mailbox answers forwarded to the minting instance", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'MailboxForwardOrg', 'mailbox-forward-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'mailbox-forward@test.com', 'Forward User')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER_USER_ID}, ${ORG_ID}, 'mailbox-forward-other@test.com', 'Other User')`
    token = await tokenFor(USER_ID, "Forward User")
    otherToken = await tokenFor(OTHER_USER_ID, "Other User")
  })

  afterEach(async () => {
    for (const l of listeners.splice(0)) l.stop()
    const keys = recordKeys.splice(0)
    if (keys.length > 0) await redis.del(...keys)
    MailboxPlaintextRegistryTestAccess.reset()
  })

  afterAll(async () => {
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("an answer posted to instance B reaches the request minted on instance A", async () => {
    const instanceA = crypto.randomUUID()
    expect(instanceA).not.toBe(INSTANCE_ID)
    await ownerInstance(instanceA)
    const requestId = `${instanceA}:${crypto.randomUUID()}`
    const pending = pendingFor(requestId)

    const res = await postAnswer(requestId, {
      turnNonce: NONCE,
      items: [{ messageId: "m1", textBody: "forwarded body" }],
    })
    expect(res.status).toBe(200)
    const outcome = await settledWithin(pending)
    expect(outcome).toEqual({
      kind: "plaintext",
      items: [{ messageId: "m1", textBody: "forwarded body" }],
      undecryptable: [],
    })
  })

  it("with defaults, a request this process minted resolves through its own listener", async () => {
    const own = await startInternalListener({ port: 0, host: "127.0.0.1" })
    listeners.push(own)
    await publishRecord(INSTANCE_ID, own.url)
    const requestId = mintMailboxRequestId()
    const pending = pendingFor(requestId)
    const outcome = await forwardMailboxAnswer(requestId, {
      userId: USER_ID,
      turnNonce: NONCE,
      response: { kind: "denied", reason: "no" },
      turnOwner: true,
    })
    // `turnOwner` crossed the hop: without it a refusal is only held.
    expect(outcome).toBe("resolved")
    expect(await settledWithin(pending)).toEqual({ kind: "denied", reason: "no" })
  })

  it("a refusal from a client that did not start the turn is held across the hop", async () => {
    const own = await startInternalListener({ port: 0, host: "127.0.0.1" })
    listeners.push(own)
    await publishRecord(INSTANCE_ID, own.url)
    const requestId = mintMailboxRequestId()
    const pending = pendingFor(requestId)
    const held = await forwardMailboxAnswer(requestId, {
      userId: USER_ID,
      turnNonce: NONCE,
      response: { kind: "denied", reason: "locked", code: "locked" },
    })
    expect(held).toBe("held")
    expect(await settledWithin(pending, 100)).toBe("pending")
    const usable = await forwardMailboxAnswer(requestId, {
      userId: USER_ID,
      turnNonce: NONCE,
      response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "hi" }] },
    })
    expect(usable).toBe("resolved")
    expect(await settledWithin(pending)).toEqual({
      kind: "plaintext",
      items: [{ messageId: "m1", textBody: "hi" }],
    })
    const late = await forwardMailboxAnswer(requestId, {
      userId: USER_ID,
      turnNonce: NONCE,
      response: { kind: "denied", reason: "late" },
    })
    expect(late).toBe("already_settled")
  })

  it("an answer from another app of the user carries its answer token and org across the hop", async () => {
    const instanceA = crypto.randomUUID()
    await ownerInstance(instanceA)
    const requestId = `${instanceA}:${crypto.randomUUID()}`
    const pending = pendingFor(requestId)

    // Another user with the token: refused by the owner, nothing settles.
    const stolen = await postAnswer(
      requestId,
      { answerToken: ANSWER_TOKEN, items: [{ messageId: "m1", textBody: "forged" }] },
      otherToken,
    )
    expect(stolen.status).toBe(404)
    const wrongToken = await postAnswer(requestId, { answerToken: "guessed", items: [] })
    expect(wrongToken.status).toBe(403)
    expect(await settledWithin(pending, 100)).toBe("pending")

    const res = await postAnswer(requestId, {
      answerToken: ANSWER_TOKEN,
      items: [{ messageId: "m1", textBody: "from the desktop" }],
    })
    expect(res.status).toBe(200)
    expect(await settledWithin(pending)).toEqual({
      kind: "plaintext",
      items: [{ messageId: "m1", textBody: "from the desktop" }],
      undecryptable: [],
    })
  })

  it("the forwarded call carries the token and org, and the owner checks the org", async () => {
    const own = await startInternalListener({ port: 0, host: "127.0.0.1" })
    listeners.push(own)
    await publishRecord(INSTANCE_ID, own.url)
    const requestId = mintMailboxRequestId()
    const pending = pendingFor(requestId)
    const otherOrg = await forwardMailboxAnswer(requestId, {
      userId: USER_ID,
      orgId: "00000000-0000-4000-8000-0000009dffff",
      answerToken: ANSWER_TOKEN,
      response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "x" }] },
    })
    expect(otherOrg).toBe("not_found")
    const noOrg = await forwardMailboxAnswer(requestId, {
      userId: USER_ID,
      answerToken: ANSWER_TOKEN,
      response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "x" }] },
    })
    expect(noOrg).toBe("nonce_mismatch")
    const outcome = await forwardMailboxAnswer(requestId, {
      userId: USER_ID,
      orgId: ORG_ID,
      answerToken: ANSWER_TOKEN,
      response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "hi" }] },
    })
    expect(outcome).toBe("resolved")
    expect(await settledWithin(pending)).toMatchObject({ kind: "plaintext" })
  })

  it("the owner re-runs the user and turn-nonce checks", async () => {
    const instanceA = crypto.randomUUID()
    await ownerInstance(instanceA)
    const requestId = `${instanceA}:${crypto.randomUUID()}`
    const pending = pendingFor(requestId)

    const wrongNonce = await postAnswer(requestId, { turnNonce: "other-nonce", items: [] })
    expect(wrongNonce.status).toBe(403)
    expect(((await wrongNonce.json()) as { error: { message: string } }).error.message).toBe(
      "TURN_NONCE_MISMATCH",
    )
    const otherUser = await postAnswer(requestId, { turnNonce: NONCE, items: [] }, otherToken)
    expect(otherUser.status).toBe(404)
    expect(await settledWithin(pending, 200)).toBe("pending")
  })

  it("an answer for a dead owner is 409 WRONG_INSTANCE", async () => {
    // No heartbeat record at all.
    const gone = `${crypto.randomUUID()}:${crypto.randomUUID()}`
    const res = await postAnswer(gone, { turnNonce: NONCE, items: [] })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      "WRONG_INSTANCE",
    )
    // A record whose listener is gone.
    const instanceA = crypto.randomUUID()
    const listener = await ownerInstance(instanceA)
    listener.stop()
    const res2 = await postAnswer(`${instanceA}:${crypto.randomUUID()}`, {
      turnNonce: NONCE,
      items: [],
    })
    expect(res2.status).toBe(409)
  })

  it("a forged signature is refused and the request stays pending", async () => {
    const instanceA = crypto.randomUUID()
    const listener = await ownerInstance(instanceA)
    const requestId = `${instanceA}:${crypto.randomUUID()}`
    const pending = pendingFor(requestId)

    // Keyed with the raw JWT_SECRET instead of the HKDF-derived key.
    const rawKey = await signedCall(listener, {
      instanceId: instanceA,
      requestId,
      key: Buffer.from(env.JWT_SECRET),
    })
    expect(rawKey.res.status).toBe(401)
    // A valid signature over a different body.
    const valid = signInternalRequest({
      path: INTERNAL_MAILBOX_ANSWER_PATH,
      timestamp: Date.now(),
      instanceId: instanceA,
      body: "{}",
    })
    const tampered = await send(
      listener,
      JSON.stringify({
        requestId,
        userId: USER_ID,
        turnNonce: NONCE,
        response: { kind: "denied", reason: "x" },
      }),
      Date.now(),
      valid,
    )
    expect(tampered.status).toBe(401)
    // Signed for another instance, sent to A.
    const otherInstance = await signedCall(listener, {
      instanceId: crypto.randomUUID(),
      requestId,
    })
    expect(otherInstance.res.status).toBe(401)
    // Signed for another path.
    const otherPath = await signedCall(listener, {
      instanceId: instanceA,
      requestId,
      path: "/internal/other",
    })
    expect(otherPath.res.status).toBe(401)
    // An HMAC with the right key over a different field layout.
    const loose = createHmac("sha256", internalSigningKey()).update(requestId).digest("hex")
    expect((await send(listener, rawKey.body, Date.now(), loose)).status).toBe(401)

    expect(await settledWithin(pending, 200)).toBe("pending")
  })

  it("an expired signature is refused (more than 30 s of skew)", async () => {
    const instanceA = crypto.randomUUID()
    const listener = await ownerInstance(instanceA)
    const requestId = `${instanceA}:${crypto.randomUUID()}`
    const pending = pendingFor(requestId)
    const old = await signedCall(listener, {
      instanceId: instanceA,
      requestId,
      timestamp: Date.now() - 31_000,
    })
    expect(old.res.status).toBe(401)
    expect(await old.res.json()).toEqual({ error: "EXPIRED" })
    const future = await signedCall(listener, {
      instanceId: instanceA,
      requestId,
      timestamp: Date.now() + 31_000,
    })
    expect(future.res.status).toBe(401)
    expect(await settledWithin(pending, 200)).toBe("pending")
  })

  it("a replayed signature is refused", async () => {
    const instanceA = crypto.randomUUID()
    const listener = await ownerInstance(instanceA)
    const requestId = `${instanceA}:${crypto.randomUUID()}`
    const pending = pendingFor(requestId)
    // The first call carries a wrong nonce, so the request stays pending: the
    // second refusal can only come from the replay check, not the registry.
    const first = await signedCall(listener, { instanceId: instanceA, requestId, turnNonce: "x" })
    expect(first.res.status).toBe(200)
    expect(await first.res.json()).toEqual({ outcome: "nonce_mismatch" })
    const replay = await send(listener, first.body, first.timestamp, first.signature)
    expect(replay.status).toBe(409)
    expect(await replay.json()).toEqual({ error: "REPLAYED" })
    expect(await settledWithin(pending, 200)).toBe("pending")
  })

  it("a replay in another spelling of the same signature is refused", async () => {
    const instanceA = crypto.randomUUID()
    const listener = await ownerInstance(instanceA)
    const requestId = `${instanceA}:${crypto.randomUUID()}`
    const pending = pendingFor(requestId)
    const first = await signedCall(listener, { instanceId: instanceA, requestId, turnNonce: "x" })
    expect(first.res.status).toBe(200)
    expect(first.signature).toMatch(/^[0-9a-f]{64}$/)
    // The same HMAC bytes, spelled in upper case: decodes to the same bytes.
    const upper = await send(listener, first.body, first.timestamp, first.signature.toUpperCase())
    expect(upper.status).toBe(401)
    expect(await upper.json()).toEqual({ error: "BAD_SIGNATURE" })
    // The same HMAC with one extra nibble, which a hex decoder drops.
    const extra = await send(listener, first.body, first.timestamp, `${first.signature}0`)
    expect(extra.status).toBe(401)
    expect(await extra.json()).toEqual({ error: "BAD_SIGNATURE" })
    expect(await settledWithin(pending, 200)).toBe("pending")
  })

  it("an unsigned body is refused before it is parsed", async () => {
    const instanceA = crypto.randomUUID()
    const internal = createInternalApp({ instanceId: instanceA })
    const body = JSON.stringify({
      requestId: `${instanceA}:${crypto.randomUUID()}`,
      userId: USER_ID,
      turnNonce: NONCE,
      response: { kind: "denied", reason: "unsigned" },
    })
    const parse = spyOn(JSON, "parse")
    try {
      for (const signature of ["", "0".repeat(64)]) {
        const res = await internal.request(INTERNAL_MAILBOX_ANSWER_PATH, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-liaison-internal-ts": String(Date.now()),
            "x-liaison-internal-signature": signature,
          },
          body,
        })
        expect(res.status).toBe(401)
      }
      expect(parse.mock.calls.filter(([text]) => text === body)).toEqual([])
    } finally {
      parse.mockRestore()
    }
  })

  it("a body over the cap is refused before it is parsed, even correctly signed", async () => {
    const instanceA = crypto.randomUUID()
    const listener = await ownerInstance(instanceA)
    const requestId = `${instanceA}:${crypto.randomUUID()}`
    const big = JSON.stringify({
      requestId,
      userId: USER_ID,
      turnNonce: NONCE,
      response: {
        kind: "plaintext",
        items: [{ messageId: "m1", textBody: "x".repeat(INTERNAL_MAX_BODY_BYTES) }],
      },
    })
    const timestamp = Date.now()
    const signature = signInternalRequest({
      path: INTERNAL_MAILBOX_ANSWER_PATH,
      timestamp,
      instanceId: instanceA,
      body: big,
    })
    const parse = spyOn(JSON, "parse")
    try {
      // In process, through the handler's own cap (no content-length either).
      const internal = createInternalApp({ instanceId: instanceA })
      const stream = new Blob([big]).stream()
      const inProc = await internal.request(INTERNAL_MAILBOX_ANSWER_PATH, {
        method: "POST",
        headers: {
          "x-liaison-internal-ts": String(timestamp),
          "x-liaison-internal-signature": signature,
        },
        body: stream,
      })
      expect(inProc.status).toBe(413)
      // And over the wire, where the server refuses it too.
      const wire = await send(listener, big, timestamp, signature)
      expect(wire.status).toBe(413)
      expect(parse.mock.calls.filter(([text]) => text === big)).toEqual([])
    } finally {
      parse.mockRestore()
    }
  })

  it("an answer as large as the public route accepts still reaches its owner", async () => {
    const instanceA = crypto.randomUUID()
    await ownerInstance(instanceA)
    const requestId = `${instanceA}:${crypto.randomUUID()}`
    const pending = pendingFor(requestId)
    // The public route's body cap is 1 MiB (app.ts, apiBodyLimitMiddleware).
    const text = "y".repeat(1024 * 1024 - 200)
    const res = await postAnswer(requestId, {
      turnNonce: NONCE,
      items: [{ messageId: "m1", textBody: text }],
    })
    expect(res.status).toBe(200)
    const outcome = await settledWithin(pending)
    expect(outcome).not.toBe("pending")
    expect(JSON.stringify(outcome)).toContain(text)
  })

  it("the listener binds the address it advertises unless told otherwise", async () => {
    expect(await internalAddresses({ host: "127.0.0.1" })).toEqual({
      advertise: "127.0.0.1",
      bind: "127.0.0.1",
    })
    expect(await internalAddresses({ host: "localhost" })).toEqual({
      advertise: "localhost",
      bind: "127.0.0.1",
    })
    expect(await internalAddresses({ host: "10.1.2.3", bind: "0.0.0.0" })).toEqual({
      advertise: "10.1.2.3",
      bind: "0.0.0.0",
    })
    // Unset: the hostname, bound on what it resolves to, never every interface.
    const fallback = await internalAddresses({
      hostname: `no-such-host-${crypto.randomUUID()}.invalid`,
    })
    expect(fallback).toEqual({ advertise: "127.0.0.1", bind: "127.0.0.1" })
    const listener = await startInternalListener({
      instanceId: crypto.randomUUID(),
      port: 0,
      host: "127.0.0.1",
    })
    listeners.push(listener)
    expect(listener.bind).toBe("127.0.0.1")
  })

  it("the public app and the health-only server have no internal route", async () => {
    for (const path of [INTERNAL_MAILBOX_ANSWER_PATH, `/api${INTERNAL_MAILBOX_ANSWER_PATH}`]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      expect(res.status).toBe(404)
    }
    expect(isHealthOnlyPath(INTERNAL_MAILBOX_ANSWER_PATH)).toBe(false)
    // And the internal listener serves nothing but its one route.
    const internal = createInternalApp({ instanceId: crypto.randomUUID() })
    expect((await internal.request("/api/agent/threads")).status).toBe(404)
    expect((await internal.request("/healthz")).status).toBe(404)
  })

  it("the forwarded body is never written to Redis", async () => {
    const marker = `plaintext-marker-${crypto.randomUUID()}`
    const monitor = await rawMonitor(env.REDIS_URL)
    try {
      const instanceA = crypto.randomUUID()
      await ownerInstance(instanceA)
      const requestId = `${instanceA}:${crypto.randomUUID()}`
      const pending = pendingFor(requestId)
      const res = await postAnswer(requestId, {
        turnNonce: NONCE,
        items: [{ messageId: "m1", subject: marker, textBody: marker, htmlBody: marker }],
      })
      expect(res.status).toBe(200)
      const outcome = await settledWithin(pending)
      // Non-vacuity: the marker did travel, through HTTP.
      expect(JSON.stringify(outcome)).toContain(marker)
      // Every command of the flow reached the monitor before this one did.
      const sentinel = `monitor-sentinel-${crypto.randomUUID()}`
      await redis.echo(sentinel)
      await monitor.until(sentinel)
      // The forwarder read the owner's record (so the monitor saw this flow).
      expect(monitor.lines.some((cmd) => cmd.includes(LIVE_INSTANCE_KEY(instanceA)))).toBe(true)
      expect(monitor.lines.filter((cmd) => cmd.includes(marker))).toEqual([])

      // And nothing stored under this run's prefix carries it.
      const reader = new Redis(env.REDIS_URL)
      try {
        let cursor = "0"
        const keys: string[] = []
        do {
          const [next, batch] = await reader.scan(
            cursor,
            "MATCH",
            `${REDIS_PREFIX}*`,
            "COUNT",
            "1000",
          )
          cursor = next
          keys.push(...batch)
        } while (cursor !== "0")
        expect(keys.length).toBeGreaterThan(0)
        for (const key of keys) {
          const type = await reader.type(key)
          let value: unknown = null
          if (type === "string") value = await reader.getBuffer(key)
          else if (type === "hash") value = await reader.hgetall(key)
          else if (type === "list") value = await reader.lrange(key, 0, -1)
          else if (type === "set") value = await reader.smembers(key)
          else if (type === "zset") value = await reader.zrange(key, "0", "-1")
          else if (type === "stream") value = await reader.xrange(key, "-", "+")
          expect(
            `${key} ${String(value instanceof Buffer ? value.toString("latin1") : JSON.stringify(value))}`,
          ).not.toContain(marker)
        }
      } finally {
        reader.disconnect()
      }
    } finally {
      monitor.close()
    }
  })
})
