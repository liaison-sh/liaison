// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A bridge call that lands on a process which did not dispatch the run is
// forwarded to the owner's internal listener, signed, and answered there by
// the owner's own registry; it never goes through Redis.
//
// "Instance A" is a run registry and an internal listener built for a foreign
// instance id (as mailbox-forward.test.ts does): the runs it registers are not
// this process's, so the public route here ("instance B", its own registry)
// must forward them.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { INSTANCE_ID } from "~/infra/instance-id"
import { LIVE_INSTANCE_KEY } from "~/infra/instance-registry"
import { redis } from "~/lib/redis"
import { errorHandler } from "~/middleware/error-handler"
import {
  type InternalListener,
  startInternalListener,
} from "~/modules/agent/mailbox-plaintext/mailbox-forward"
import {
  type BridgeForwardFields,
  bridgeForwardHeaders,
  createBridgeForwarder,
  INTERNAL_APP_BRIDGE_MAX_BODY_BYTES,
  INTERNAL_APP_BRIDGE_PATH,
  INTERNAL_REFUSAL_HEADER,
  internalAppBridgeRoute,
  ReplaySet,
  signBridgeForward,
} from "./bridge-forward"
import { createAppBridgeRoutes } from "./bridge-route"
import { type RegisterRunOptions, RunRegistry } from "./run-registry"

const A = randomUUID()
/** An instance with no listener and no record: a process that is gone. */
const GONE = randomUUID()
const regA = new RunRegistry({ instanceId: A })
const regGone = new RunRegistry({ instanceId: GONE })
const regB = new RunRegistry()

let listenerA: InternalListener
const ownerUrls = new Map<string, string>()
let forwards = 0
const countingFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    forwards++
    return fetch(input, init)
  },
  { preconnect: fetch.preconnect },
)

function stackB(forwarderOpts: Parameters<typeof createBridgeForwarder>[0] = {}): Hono {
  const s = new Hono()
  s.onError(errorHandler)
  s.route(
    "/api/app-bridge",
    createAppBridgeRoutes({
      registry: regB,
      isConfigured: () => true,
      forwarder: createBridgeForwarder({
        readOwnerUrl: async (id) => ownerUrls.get(id),
        fetch: countingFetch,
        ...forwarderOpts,
      }),
    }),
  )
  return s
}

function register(
  registry: RunRegistry,
  bridge: Record<string, unknown>,
  over: Partial<RegisterRunOptions> = {},
) {
  return registry.registerRun({
    bridge,
    bridgeMethods: Object.keys(bridge),
    orgId: "00000000-0000-0000-0000-00000000a001",
    appName: "fixture",
    version: "1.0.0",
    timeoutMs: 30_000,
    ...over,
  })
}

function call(
  s: Hono,
  runId: string,
  token: string | undefined,
  method: string,
  args: unknown[] = [],
  nonce = "nonce-1",
) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  if (nonce) headers["x-exec-nonce"] = nonce
  return s.request(`/api/app-bridge/${encodeURIComponent(runId)}`, {
    method: "POST",
    headers,
    // A fresh call id per call, as the loader sends (bridge-reply.ts).
    body: JSON.stringify({ callId: randomUUID(), method, args }),
  })
}

/** A forward straight to A's listener, as a non-owner would send it, with parts overridden. */
async function directForward(
  fields: Partial<BridgeForwardFields> & { runId: string; token: string },
  tamper: { body?: Uint8Array; headers?: Record<string, string>; signFor?: string } = {},
): Promise<{ res: Response; signature: string }> {
  const full: BridgeForwardFields = {
    timestamp: Date.now(),
    ownerInstanceId: A,
    nonce: "nonce-1",
    body: new TextEncoder().encode(JSON.stringify({ callId: 1, method: "echo", args: ["x"] })),
    ...fields,
  }
  const signature = signBridgeForward({
    ...full,
    ownerInstanceId: tamper.signFor ?? full.ownerInstanceId,
  })
  const res = await fetch(new URL(INTERNAL_APP_BRIDGE_PATH, listenerA.url), {
    method: "POST",
    headers: { ...bridgeForwardHeaders(full, signature), ...tamper.headers },
    body: tamper.body ?? full.body,
  })
  return { res, signature }
}

beforeAll(async () => {
  listenerA = await startInternalListener({
    instanceId: A,
    port: 0,
    host: "127.0.0.1",
    extraRoutes: [internalAppBridgeRoute({ registry: regA })],
  })
  ownerUrls.set(A, listenerA.url)
})

afterAll(async () => {
  listenerA.stop()
  await redis.del(LIVE_INSTANCE_KEY(A))
})

beforeEach(() => {
  forwards = 0
})

describe("app bridge calls across processes", () => {
  it("a call landing on the non-owner is answered by the owner's registry", async () => {
    let calls = 0
    const run = register(regA, {
      echo: async (a: string) => {
        calls++
        return `A:${a}`
      },
    })
    expect(run.runId.startsWith(`${A}:`)).toBe(true)
    const res = await call(stackB(), run.runId, run.runToken, "echo", ["x"])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: "A:x" })
    expect(forwards).toBe(1)
    expect(calls).toBe(1)
    // The owner counted it as the run's own call.
    expect(run.settle().bridgeCalls).toBe(1)
  })

  it("a call for this process's own run is answered here, without a forward", async () => {
    const run = register(regB, { echo: async () => "B" })
    const res = await call(stackB(), run.runId, run.runToken, "echo")
    expect(await res.json()).toEqual({ data: "B" })
    expect(forwards).toBe(0)
    run.settle()
  })

  it("the owner's statuses cross the hop: 409 another nonce, 404 unknown method, 410 settled", async () => {
    const run = register(regA, { echo: async () => 1 })
    const s = stackB()
    expect((await call(s, run.runId, run.runToken, "echo", [], "nonce-1")).status).toBe(200)
    const other = await call(s, run.runId, run.runToken, "echo", [], "nonce-2")
    expect(other.status).toBe(409)
    expect(((await other.json()) as { reason: string }).reason).toBe("nonce_mismatch")
    const unknown = await call(s, run.runId, run.runToken, "constructor")
    expect(unknown.status).toBe(404)
    run.settle()
    const settled = await call(s, run.runId, run.runToken, "echo")
    expect(settled.status).toBe(410)
    expect(((await settled.json()) as { reason: string }).reason).toBe("settled")
  })

  it("a garbage token is refused on the non-owner without any forward", async () => {
    const run = register(regA, { echo: async () => 1 })
    const other = register(regA, { echo: async () => 2 })
    const s = stackB()
    for (const token of [undefined, "garbage", "A".repeat(86), other.runToken]) {
      const res = await call(s, run.runId, token, "echo")
      expect(res.status).toBe(401)
      expect(((await res.json()) as { reason: string }).reason).toBe("bad_token")
    }
    // A run id that names a foreign owner but is not `<uuid>:<uuid>`.
    expect((await call(s, `${A}:nope`, run.runToken, "echo")).status).toBe(401)
    expect(forwards).toBe(0)
    run.settle()
    other.settle()
  })

  it("a correctly signed forward carrying another run's token gets 403 at the owner", async () => {
    let reached = 0
    const run = register(regA, { echo: async () => reached++ })
    const other = register(regA, { echo: async () => reached++ })
    const { res } = await directForward({ runId: run.runId, token: other.runToken })
    expect(res.status).toBe(403)
    expect(res.headers.get(INTERNAL_REFUSAL_HEADER)).toBeNull()
    expect(((await res.json()) as { reason: string }).reason).toBe("wrong_run")
    expect(reached).toBe(0)
    run.settle()
    other.settle()
  })

  it("a tampered body, run, token, nonce or timestamp, or a call signed for another instance, is refused", async () => {
    let reached = 0
    const run = register(regA, { echo: async () => reached++ })
    const other = register(regA, { echo: async () => reached++ })
    const T = Date.now()
    const evil = new TextEncoder().encode(
      JSON.stringify({ callId: 1, method: "echo", args: ["y"] }),
    )
    const cases: Array<Parameters<typeof directForward>[1]> = [
      { body: evil },
      { headers: { "x-liaison-run-id": other.runId } },
      { headers: { authorization: `Bearer ${other.runToken}` } },
      { headers: { "x-exec-nonce": "nonce-2" } },
      { headers: { "x-liaison-internal-ts": String(T + 1) } },
      { headers: { "x-liaison-internal-signature": "0".repeat(64) } },
      { signFor: INSTANCE_ID },
    ]
    for (const tamper of cases) {
      const { res } = await directForward(
        { runId: run.runId, token: run.runToken, timestamp: T },
        tamper,
      )
      expect(res.status).toBe(401)
      expect(res.headers.get(INTERNAL_REFUSAL_HEADER)).toBe("1")
    }
    // Outside the 30 s skew window, even correctly signed.
    const stale = await directForward({
      runId: run.runId,
      token: run.runToken,
      timestamp: Date.now() - 31_000,
    })
    expect(stale.res.status).toBe(401)
    expect(reached).toBe(0)
    run.settle()
    other.settle()
  })

  it("a replayed forward is refused and the bridge runs once", async () => {
    let reached = 0
    const run = register(regA, { echo: async () => ++reached })
    const timestamp = Date.now()
    const first = await directForward({ runId: run.runId, token: run.runToken, timestamp })
    expect(first.res.status).toBe(200)
    const again = await directForward({ runId: run.runId, token: run.runToken, timestamp })
    expect(again.signature).toBe(first.signature)
    expect(again.res.status).toBe(409)
    expect(((await again.res.json()) as { error: string }).error).toBe("REPLAYED")
    expect(reached).toBe(1)
    run.settle()
  })

  it("a body over the internal cap is refused before it is read", async () => {
    const run = register(regA, { echo: async () => 1 })
    const big = new Uint8Array(INTERNAL_APP_BRIDGE_MAX_BODY_BYTES + 1)
    const { res } = await directForward({ runId: run.runId, token: run.runToken, body: big })
    expect(res.status).toBe(413)
    run.settle()
  })

  it("a 7 s bridge call is forwarded and answered", async () => {
    const run = register(regA, {
      slow: async () => {
        await Bun.sleep(7_000)
        return "done"
      },
    })
    const res = await call(stackB(), run.runId, run.runToken, "slow")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: "done" })
    run.settle()
  }, 20_000)

  it("a run whose owner has no instance record is 410 run_owner_gone", async () => {
    const run = register(regGone, { echo: async () => 1 })
    const res = await call(stackB(), run.runId, run.runToken, "echo")
    expect(res.status).toBe(410)
    expect(((await res.json()) as { reason: string }).reason).toBe("run_owner_gone")
    expect(forwards).toBe(0)
    run.settle()
  })

  it("by default the owner's address comes from its instance record in Redis", async () => {
    const s = new Hono()
    s.route("/api/app-bridge", createAppBridgeRoutes({ registry: regB, isConfigured: () => true }))
    const run = register(regA, { echo: async () => "via-record" })
    // No record yet: the owner is gone.
    expect((await call(s, run.runId, run.runToken, "echo")).status).toBe(410)
    await redis.set(
      LIVE_INSTANCE_KEY(A),
      JSON.stringify({ role: "worker", pid: 1, startedAt: Date.now(), internalUrl: listenerA.url }),
      "PX",
      30_000,
    )
    const res = await call(s, run.runId, run.runToken, "echo")
    expect(await res.json()).toEqual({ data: "via-record" })
    run.settle()
  })

  it("an owner that refuses the hop itself is 502 forward_refused, not the run's status", async () => {
    // GONE's address points at A's listener, which checks signatures as A.
    ownerUrls.set(GONE, listenerA.url)
    try {
      const run = register(regGone, { echo: async () => 1 })
      const res = await call(stackB(), run.runId, run.runToken, "echo")
      expect(res.status).toBe(502)
      expect(((await res.json()) as { reason: string }).reason).toBe("forward_refused")
      run.settle()
    } finally {
      ownerUrls.delete(GONE)
    }
  })

  it("the per-IP limit counts forwarded calls only", async () => {
    const s = stackB({ ipLimit: { max: 2, windowMs: 60_000 } })
    const run = register(regA, { echo: async () => 1 })
    const own = register(regB, { echo: async () => 1 })
    // Refused before forwarding, and this process's own runs: not counted.
    for (let i = 0; i < 5; i++) {
      expect((await call(s, run.runId, "garbage", "echo")).status).toBe(401)
      expect((await call(s, own.runId, own.runToken, "echo")).status).toBe(200)
    }
    expect((await call(s, run.runId, run.runToken, "echo")).status).toBe(200)
    expect((await call(s, run.runId, run.runToken, "echo")).status).toBe(200)
    const limited = await call(s, run.runId, run.runToken, "echo")
    expect(limited.status).toBe(429)
    expect(forwards).toBe(2)
    run.settle()
    own.settle()
  })
})

describe("replay set", () => {
  it("refuses a signature inside its window and forgets it once its second passed", () => {
    const set = new ReplaySet()
    expect(set.add("s1", 10_000, 1_000)).toBe(true)
    expect(set.add("s1", 10_000, 1_500)).toBe(false)
    expect(set.add("s2", 20_000, 1_500)).toBe(true)
    expect(set.size()).toBe(2)
    expect(set.add("s3", 30_000, 10_001)).toBe(true)
    expect(set.size()).toBe(2)
    expect(set.add("s1", 40_000, 10_002)).toBe(true)
  })
})
