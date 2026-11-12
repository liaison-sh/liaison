// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The /run handler with every platform object faked: the Worker Loader, the
// bundle store (object-bucket shaped, like most hosts), the cell's bundle
// route and the bridge.
import { beforeEach, describe, expect, test } from "bun:test"
import { createHash, createHmac } from "node:crypto"
import { type BridgeProps, callBridge, runStats } from "../src/bridge"
import {
  createAppLoader,
  type LoaderLike,
  parseCellTable,
  type WorkerCode,
  type WorkerIdentity,
} from "../src/loader"
import { bundleKey, deadlineDuration, dynamicWorkerId } from "../src/protocol"
import { sha256Hex, signCellRequestV2, verifyCellRequestV2 } from "../src/sign"

interface R2Like {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    opts?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>
}
interface Env {
  LOADER: LoaderLike
  BUNDLES: R2Like
  CELL_KEYS: string
}
interface Deps {
  now(): number
  makeBridge(props: BridgeProps): unknown
  randomBytes?(n: number): Uint8Array
  fetch?(url: string, init: RequestInit): Promise<Response>
  makeTail?(props: WorkerIdentity): unknown
}

const verified = new Map<string, string>()
const clearVerifiedCache = () => verified.clear()

/** A host: its platform objects per request, the verified texts shared across them. */
function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  return createAppLoader({
    loader: env.LOADER,
    bundles: {
      async get(key) {
        const o = await env.BUNDLES.get(key)
        return o ? o.arrayBuffer() : null
      },
      async put(key, bytes) {
        await env.BUNDLES.put(key, bytes, {
          httpMetadata: { contentType: "application/javascript" },
        })
      },
    },
    cells: () => parseCellTable(env.CELL_KEYS),
    now: deps.now,
    makeBridge: deps.makeBridge,
    ...(deps.makeTail ? { makeTail: deps.makeTail } : {}),
    ...(deps.randomBytes ? { randomBytes: deps.randomBytes } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    verified,
  }).handle(req)
}

/** A LEGACY v1 signature (no version header), built here: the loader no longer has a v1 signer. */
function signV1(cellId: string, key: string, body: string, ts: number): Record<string, string> {
  const sha = createHash("sha256").update(body).digest("hex")
  const sig = createHmac("sha256", key).update(`${ts}.${sha}`).digest("base64")
  return { "x-cell-id": cellId, "x-cell-ts": String(ts), "x-cell-signature": sig }
}

const CELL = "cell-test"
const KEY = "cell-test-key-0123456789abcdef"
const ORIGIN = "https://cell.example.test"
const BUNDLE = "export default class { async run(req, bridge) { return req } }"
const NOW = 1_794_000_000_000

type Behaviour = (
  req: Record<string, unknown>,
  bridge: { call(m: string, a: unknown): Promise<unknown> },
) => Promise<unknown>

type CellAnswer = (url: string, init: RequestInit) => Response | Promise<Response>

function setup(
  opts: {
    behaviour?: Behaviour
    storedBundle?: string | null
    cellKeys?: unknown
    cell?: CellAnswer
    /** The module throws this while it is evaluated: every call of its entrypoint fails with it. */
    startError?: string
    /** LOADER.get or getEntrypoint throws this. */
    getThrows?: string
    getEntrypointThrows?: string
  } = {},
) {
  const r2Puts: { key: string; bytes: Uint8Array; contentType?: string }[] = []
  const cellFetches: { url: string; init: RequestInit }[] = []
  const loads: { id: string; code: WorkerCode }[] = []
  const cache = new Map<string, WorkerCode>()
  const bridgeFetches: { url: string; init: RequestInit }[] = []
  const behaviour: Behaviour = opts.behaviour ?? (async (req) => ({ echo: req.runId }))
  const LOADER: LoaderLike = {
    get(id, getCode) {
      if (opts.getThrows) throw new Error(opts.getThrows)
      return {
        getEntrypoint() {
          if (opts.getEntrypointThrows) throw new Error(opts.getEntrypointThrows)
          const start = async () => {
            if (!cache.has(id)) {
              const code = await getCode()
              cache.set(id, code)
              loads.push({ id, code })
            }
            if (opts.startError) throw new Error(opts.startError)
          }
          // Like an RPC stub: any method name is callable; one the module lacks rejects.
          return new Proxy({} as Record<string, unknown>, {
            get(_t, name) {
              if (name === "then") return undefined
              if (name === "run") {
                return async (req: unknown, bridge: unknown) => {
                  await start()
                  return behaviour(req as Record<string, unknown>, bridge as never)
                }
              }
              return async () => {
                await start()
                throw new TypeError(
                  `The RPC receiver does not implement the method "${String(name)}".`,
                )
              }
            },
          }) as unknown as { run(req: unknown, bridge: unknown): Promise<unknown> }
        },
      }
    },
  }
  const stored = opts.storedBundle === undefined ? BUNDLE : opts.storedBundle
  const r2Gets: string[] = []
  const env: Env = {
    LOADER,
    BUNDLES: {
      async get(key) {
        r2Gets.push(key)
        const put = r2Puts.findLast((p) => p.key === key)
        if (put) return { arrayBuffer: async () => put.bytes.slice().buffer as ArrayBuffer }
        if (stored === null) return null
        return { arrayBuffer: async () => new TextEncoder().encode(stored).buffer as ArrayBuffer }
      },
      async put(key, value, o) {
        r2Puts.push({
          key,
          bytes: new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)),
          contentType: o?.httpMetadata?.contentType,
        })
      },
    },
    CELL_KEYS: JSON.stringify(opts.cellKeys ?? { [CELL]: { key: KEY, bridgeOrigin: ORIGIN } }),
  }
  let nonce = 0
  const deps: Deps = {
    now: () => NOW,
    fetch: async (url, init) => {
      cellFetches.push({ url, init })
      return opts.cell
        ? opts.cell(url, init)
        : new Response("no cell in this test", { status: 599 })
    },
    randomBytes: (n) => new Uint8Array(n).fill(++nonce),
    makeBridge: (props: BridgeProps) => ({
      call: (m: string, a: unknown) =>
        callBridge(props, m, a, async (url, init) => {
          bridgeFetches.push({ url, init })
          const b = JSON.parse(String(init.body))
          return Response.json({
            data: { method: b.method, runId: props.runId, nonce: props.execNonce },
          })
        }),
    }),
  }
  return { env, deps, loads, r2Gets, bridgeFetches, r2Puts, cellFetches }
}

async function runBody(over: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    orgId: "org-1",
    app: "fixture",
    version: "1.0.0",
    sha256: await sha256Hex(BUNDLE),
    exportName: "ping",
    params: { a: 1 },
    extraArgs: [],
    approval: null,
    bridgeMethods: ["db.query", "emit"],
    bridgeUrl: `${ORIGIN}/api/app-bridge/run-1`,
    runToken: "tok-0123456789abcdef0123",
    deadlineMs: 5000,
    limits: { cpuMs: 30000, subRequests: 10000 },
    ...over,
  }
}

/** A /run as a cell sends it: v2 cell->loader by default; `v1: true` the legacy signature. */
async function signed(
  body: unknown,
  o: {
    ts?: number
    key?: string
    cell?: string
    tamper?: boolean
    v1?: boolean
    direction?: "cell->loader" | "loader->cell"
    path?: string
  } = {},
) {
  const text = JSON.stringify(body)
  const h = o.v1
    ? signV1(o.cell ?? CELL, o.key ?? KEY, text, o.ts ?? NOW)
    : await signCellRequestV2({
        cellId: o.cell ?? CELL,
        cellKey: o.key ?? KEY,
        direction: o.direction ?? "cell->loader",
        method: "POST",
        path: o.path ?? "/run",
        body: text,
        ts: o.ts ?? NOW,
      })
  return new Request("https://loader.test/run", {
    method: "POST",
    headers: h,
    body: o.tamper ? `${text} ` : text,
  })
}

/** A loader answer, read loosely: each test asserts the fields it is about. */
async function json(r: Response | Promise<Response>): Promise<any> {
  return (await r).json()
}

beforeEach(() => clearVerifiedCache())

describe("auth", () => {
  test("unsigned -> 401", async () => {
    const s = setup()
    const r = await handle(
      new Request("https://loader.test/run", { method: "POST", body: "{}" }),
      s.env,
      s.deps,
    )
    expect(r.status).toBe(401)
    expect((await json(r)).error.kind).toBe("auth")
  })
  test("unknown cell / wrong key / tampered body -> 401", async () => {
    const s = setup()
    const b = await runBody()
    expect((await handle(await signed(b, { cell: "other" }), s.env, s.deps)).status).toBe(401)
    expect(
      (await handle(await signed(b, { key: "wrong-key-0123456789abcd" }), s.env, s.deps)).status,
    ).toBe(401)
    expect((await handle(await signed(b, { tamper: true }), s.env, s.deps)).status).toBe(401)
    expect(s.loads.length).toBe(0)
  })
  test("skew beyond ±60 s -> 401, inside -> 200", async () => {
    const s = setup()
    const b = await runBody()
    expect((await handle(await signed(b, { ts: NOW - 60_001 }), s.env, s.deps)).status).toBe(401)
    expect((await handle(await signed(b, { ts: NOW + 60_001 }), s.env, s.deps)).status).toBe(401)
    expect((await handle(await signed(b, { ts: NOW - 59_000 }), s.env, s.deps)).status).toBe(200)
  })
  test("bridgeOrigin mismatch -> 403 auth", async () => {
    const s = setup()
    const r = await handle(
      await signed(await runBody({ bridgeUrl: "https://evil.example/api/app-bridge/run-1" })),
      s.env,
      s.deps,
    )
    expect(r.status).toBe(403)
    expect((await json(r)).error.kind).toBe("auth")
    expect(s.loads.length).toBe(0)
  })
  test("malformed CELL_KEYS -> 500, no run", async () => {
    const s = setup({ cellKeys: { [CELL]: { key: "short", bridgeOrigin: ORIGIN } } })
    expect((await handle(await signed(await runBody()), s.env, s.deps)).status).toBe(500)
    expect(s.loads.length).toBe(0)
  })
  test("v2: a signature for the other direction or another path -> 401", async () => {
    const s = setup()
    const b = await runBody()
    expect(
      (await handle(await signed(b, { direction: "loader->cell" }), s.env, s.deps)).status,
    ).toBe(401)
    expect(
      (await handle(await signed(b, { path: "/api/app-bridge/bundles/x" }), s.env, s.deps)).status,
    ).toBe(401)
    expect((await handle(await signed(b), s.env, s.deps)).status).toBe(200)
  })
  test("v1 (no version header) is refused on /run since 2026-11-07; an unknown version is refused", async () => {
    const s = setup()
    const b = await runBody()
    const r1 = await handle(await signed(b, { v1: true }), s.env, s.deps)
    expect(r1.status).toBe(401)
    expect((await json(r1)).error).toMatchObject({
      kind: "auth",
      message: "signature rejected: missing",
    })
    const req = await signed(b, { v1: true })
    const h = new Headers(req.headers)
    h.set("x-cell-signature-version", "2")
    const r = await handle(
      new Request(req.url, { method: "POST", headers: h, body: JSON.stringify(b) }),
      s.env,
      s.deps,
    )
    expect(r.status).toBe(401)
    expect((await json(r)).error.message).toContain("bad_signature")
    h.set("x-cell-signature-version", "3")
    const r3 = await handle(
      new Request(req.url, { method: "POST", headers: h, body: JSON.stringify(b) }),
      s.env,
      s.deps,
    )
    expect((await json(r3)).error.message).toContain("bad_version")
    expect(s.loads.length).toBe(0)
  })
  test("a prototype key is not a cell", async () => {
    const s = setup()
    expect(
      (await handle(await signed(await runBody(), { cell: "__proto__" }), s.env, s.deps)).status,
    ).toBe(401)
  })
})

describe("bundle", () => {
  test("hash mismatch -> 409, nothing loaded", async () => {
    const s = setup({ storedBundle: "export default class { tampered() {} }" })
    const r = await handle(await signed(await runBody()), s.env, s.deps)
    expect(r.status).toBe(409)
    expect((await json(r)).error).toMatchObject({ kind: "load", code: "hash_mismatch" })
    expect(s.loads.length).toBe(0)
  })
  test("missing bundle (in R2 and at the cell) -> 404 load", async () => {
    const s = setup({ storedBundle: null, cell: () => new Response("", { status: 404 }) })
    const r = await handle(await signed(await runBody()), s.env, s.deps)
    expect(r.status).toBe(404)
    expect((await json(r)).error).toMatchObject({ kind: "bundle_missing", code: "bundle_missing" })
  })
  test("R2 key and id; WorkerCode has empty env, no outbound, capped limits", async () => {
    const s = setup()
    const b = await runBody({ limits: { cpuMs: 999_999, subRequests: 5 } })
    const r = await handle(await signed(b), s.env, s.deps)
    expect(r.status).toBe(200)
    expect(s.r2Gets).toEqual([`fixture/1.0.0/${b.sha256}.js`])
    expect(bundleKey(b)).toBe(`fixture/1.0.0/${b.sha256}.js`)
    expect(s.loads[0].id).toBe(`${CELL}:org-1:fixture@1.0.0#${b.sha256}`)
    expect(dynamicWorkerId(CELL, b)).toStartWith(`${CELL}:`)
    expect(s.loads[0].code).toEqual({
      compatibilityDate: "2026-10-01",
      mainModule: "worker.js",
      modules: { "worker.js": BUNDLE },
      env: {},
      globalOutbound: null,
      limits: { cpuMs: 30000, subRequests: 5 },
    })
  })
  test("cold on first run of an id, warm after; verified text cached per isolate", async () => {
    const s = setup()
    const r1 = await json(handle(await signed(await runBody()), s.env, s.deps))
    const r2 = await json(
      handle(
        await signed(
          await runBody({ runId: "run-2", bridgeUrl: `${ORIGIN}/api/app-bridge/run-2` }),
        ),
        s.env,
        s.deps,
      ),
    )
    expect(r1.timings.cold).toBe(true)
    expect(r2.timings.cold).toBe(false)
    expect(s.r2Gets.length).toBe(1)
    expect(s.loads.length).toBe(1)
  })
  test("different cells / orgs get different ids", async () => {
    const s = setup({
      cellKeys: {
        [CELL]: { key: KEY, bridgeOrigin: ORIGIN },
        "cell-b": { key: KEY, bridgeOrigin: ORIGIN },
      },
    })
    await handle(await signed(await runBody()), s.env, s.deps)
    await handle(await signed(await runBody(), { cell: "cell-b" }), s.env, s.deps)
    await handle(await signed(await runBody({ orgId: "org-2" })), s.env, s.deps)
    expect(new Set(s.loads.map((l) => l.id)).size).toBe(3)
  })
  test("id separators are refused in id components", async () => {
    const s = setup()
    for (const over of [{ orgId: "a:b" }, { app: "x@y" }, { version: "1#2" }, { sha256: "abc" }]) {
      expect((await handle(await signed(await runBody(over)), s.env, s.deps)).status).toBe(400)
    }
  })
})

describe("bundle from the cell (R2 has none)", () => {
  const cellServing =
    (text: string, status = 200): CellAnswer =>
    () =>
      new Response(status === 200 ? text : "nope", {
        status,
        headers: { "content-type": "application/javascript" },
      })

  test("fetched signed v2 loader->cell from the cell's bridge origin, verified, cached in R2, then run", async () => {
    const s = setup({ storedBundle: null, cell: cellServing(BUNDLE) })
    const b = await runBody()
    const r = await handle(await signed(b), s.env, s.deps)
    expect(r.status).toBe(200)
    expect(s.cellFetches.length).toBe(1)
    const f = s.cellFetches[0]
    expect(f.url).toBe(`${ORIGIN}/api/app-bridge/bundles/${b.sha256}`)
    expect(f.init.method).toBe("GET")
    const h = f.init.headers as Record<string, string>
    expect(h["x-cell-id"]).toBe(CELL)
    expect(h["x-cell-signature-version"]).toBe("2")
    // Exactly what the cell's bundle route checks.
    expect(
      await verifyCellRequestV2({
        cellKey: KEY,
        direction: "loader->cell",
        method: "GET",
        path: `/api/app-bridge/bundles/${b.sha256}`,
        ts: h["x-cell-ts"],
        signature: h["x-cell-signature"],
        version: h["x-cell-signature-version"],
        body: "",
        now: NOW,
      }),
    ).toEqual({ ok: true })
    expect(s.r2Puts.map((p) => [p.key, p.contentType])).toEqual([
      [bundleKey(b), "application/javascript"],
    ])
    expect(new TextDecoder().decode(s.r2Puts[0].bytes)).toBe(BUNDLE)
    expect(s.loads[0].code.modules["worker.js"]).toBe(BUNDLE)
    // Next isolate (verified cache cleared): read from R2, not the cell again.
    clearVerifiedCache()
    const r2 = await handle(
      await signed(await runBody({ runId: "run-2", bridgeUrl: `${ORIGIN}/api/app-bridge/run-2` })),
      s.env,
      s.deps,
    )
    expect(r2.status).toBe(200)
    expect(s.cellFetches.length).toBe(1)
  })
  test("bytes that do not hash to the sha -> 409, never cached, never loaded", async () => {
    const s = setup({ storedBundle: null, cell: cellServing("export default class { evil() {} }") })
    const r = await handle(await signed(await runBody()), s.env, s.deps)
    expect(r.status).toBe(409)
    expect((await json(r)).error.code).toBe("hash_mismatch")
    expect(s.r2Puts.length).toBe(0)
    expect(s.loads.length).toBe(0)
  })
  test("the cell knows no such module -> 404 bundle_missing; a cell error -> 502", async () => {
    const s404 = setup({ storedBundle: null, cell: cellServing("", 404) })
    const r = await handle(await signed(await runBody()), s404.env, s404.deps)
    expect(r.status).toBe(404)
    expect((await json(r)).error.code).toBe("bundle_missing")
    const s500 = setup({ storedBundle: null, cell: cellServing("", 500) })
    const r5 = await handle(await signed(await runBody()), s500.env, s500.deps)
    expect(r5.status).toBe(502)
    expect((await json(r5)).error).toMatchObject({
      kind: "bundle_fetch_failed",
      code: "bundle_fetch_failed",
    })
    const sThrow = setup({
      storedBundle: null,
      cell: () => {
        throw new Error("connection refused")
      },
    })
    expect((await handle(await signed(await runBody()), sThrow.env, sThrow.deps)).status).toBe(502)
    for (const x of [s404, s500, sThrow]) expect(x.r2Puts.length).toBe(0)
  })
  test("an unsigned or refused /run never reaches the cell", async () => {
    const s = setup({ storedBundle: null, cell: cellServing(BUNDLE) })
    await handle(await signed(await runBody(), { key: "wrong-key-0123456789abcd" }), s.env, s.deps)
    await handle(
      await signed(await runBody({ bridgeUrl: "https://evil.example/api/app-bridge/run-1" })),
      s.env,
      s.deps,
    )
    expect(s.cellFetches.length).toBe(0)
  })
})

describe("run", () => {
  test("worker gets the request without token or bridge URL; bridge called twice with token + nonce", async () => {
    let seen: Record<string, unknown> = {}
    const s = setup({
      behaviour: async (req, bridge) => {
        seen = req
        const a = await bridge.call("db.query", [1])
        const b = await bridge.call("emit", ["x"])
        return { a, b }
      },
    })
    const j = await json(handle(await signed(await runBody()), s.env, s.deps))
    expect(j.ok).toBe(true)
    expect(j.result.a.data).toMatchObject({ method: "db.query", runId: "run-1" })
    expect(j.timings).toMatchObject({ bridgeCalls: 2, cold: true })
    expect(Object.keys(seen).sort()).toEqual([
      "app",
      "approval",
      "bridgeMethods",
      "exportName",
      "extraArgs",
      "orgId",
      "params",
      "runId",
      "version",
    ])
    expect(JSON.stringify(seen)).not.toContain("tok-")
    expect(s.bridgeFetches.length).toBe(2)
    const h = s.bridgeFetches[0].init.headers as Record<string, string>
    expect(h.authorization).toBe("Bearer tok-0123456789abcdef0123")
    expect(h["x-exec-nonce"]).toBe(j.result.a.data.nonce)
    expect(s.bridgeFetches[0].url).toBe(`${ORIGIN}/api/app-bridge/run-1`)
    expect(JSON.parse(String(s.bridgeFetches[0].init.body))).toMatchObject({
      method: "db.query",
      args: [1],
    })
    expect(runStats.size).toBe(0)
  })
  test("a fresh execNonce per /run (a replayed body gets a new nonce)", async () => {
    const s = setup({ behaviour: async (_r, bridge) => bridge.call("emit", []) })
    const b = await runBody()
    const j1 = await json(handle(await signed(b), s.env, s.deps))
    const j2 = await json(handle(await signed(b), s.env, s.deps))
    expect(j1.result.data.nonce).not.toBe(j2.result.data.nonce)
  })
  test("two concurrent runs of one id each reach their own runId", async () => {
    const s = setup({
      behaviour: async (req, bridge) => {
        await new Promise((r) => setTimeout(r, req.runId === "A" ? 30 : 5))
        return bridge.call("emit", [req.runId])
      },
    })
    const [a, b] = await Promise.all([
      handle(
        await signed(await runBody({ runId: "A", bridgeUrl: `${ORIGIN}/api/app-bridge/A` })),
        s.env,
        s.deps,
      ),
      handle(
        await signed(await runBody({ runId: "B", bridgeUrl: `${ORIGIN}/api/app-bridge/B` })),
        s.env,
        s.deps,
      ),
    ])
    expect((await json(a)).result.data.runId).toBe("A")
    expect((await json(b)).result.data.runId).toBe("B")
    expect(s.bridgeFetches.map((f) => f.url).sort()).toEqual([
      `${ORIGIN}/api/app-bridge/A`,
      `${ORIGIN}/api/app-bridge/B`,
    ])
  })
  test("unlisted bridge method is refused without a fetch", async () => {
    const s = setup({ behaviour: async (_r, bridge) => bridge.call("secrets.get", []) })
    const j = await json(handle(await signed(await runBody()), s.env, s.deps))
    expect(j.result).toMatchObject({ errorStatus: 404, errorCode: "unknown_method" })
    expect(s.bridgeFetches.length).toBe(0)
  })
  test("handler error -> ok:false kind handler with status/code", async () => {
    const s = setup({
      behaviour: async () => {
        throw Object.assign(new Error("boom"), { status: 422, code: "bad_input" })
      },
    })
    const j = await json(handle(await signed(await runBody()), s.env, s.deps))
    expect(j.ok).toBe(false)
    expect(j.error).toEqual({ message: "boom", kind: "handler", status: 422, code: "bad_input" })
  })
  test("limit errors -> kind limit; module errors -> kind load", async () => {
    const kindOf = async (msg: string, ctor: ErrorConstructor = Error) => {
      const s = setup({
        behaviour: async () => {
          throw new ctor(msg)
        },
      })
      return (await json(handle(await signed(await runBody()), s.env, s.deps))).error.kind
    }
    expect(await kindOf("Worker exceeded CPU time limit.")).toBe("limit")
    expect(await kindOf("Too many subrequests.")).toBe("limit")
    expect(await kindOf("SyntaxError: Unexpected token '}'")).toBe("load")
    expect(await kindOf("entrypoint.run is not a function")).toBe("load")
    expect(await kindOf("order not found")).toBe("handler")
  })
  test("a module that throws while it is evaluated -> kind load; its handler's own throw stays handler", async () => {
    const broken = setup({ startError: "module init failed on this host" })
    const j = await json(handle(await signed(await runBody()), broken.env, broken.deps))
    expect(j.ok).toBe(false)
    expect(j.error).toEqual({ message: "module init failed on this host", kind: "load" })
    const thrower = setup({
      behaviour: async () => {
        throw new Error("module init failed on this host")
      },
    })
    expect(
      (await json(handle(await signed(await runBody()), thrower.env, thrower.deps))).error.kind,
    ).toBe("handler")
  })
  test("LOADER.get or getEntrypoint throwing -> kind load, nothing run", async () => {
    for (const o of [
      { getThrows: "loader get failed" },
      { getEntrypointThrows: "no default entrypoint" },
    ]) {
      const s = setup(o)
      const j = await json(handle(await signed(await runBody()), s.env, s.deps))
      expect(j.ok).toBe(false)
      expect(j.error.kind).toBe("load")
      expect(j.error.message).toBe(o.getThrows ?? o.getEntrypointThrows)
      expect(s.bridgeFetches).toHaveLength(0)
    }
  })
  test("deadline -> ok:false kind timeout", async () => {
    const s = setup({ behaviour: () => new Promise((r) => setTimeout(() => r("late"), 200)) })
    const j = await json(handle(await signed(await runBody({ deadlineMs: 20 })), s.env, s.deps))
    expect(j.error).toEqual({ message: "App execution timed out", kind: "timeout" })
  })
  test("deadline accepts a duration or an absolute epoch, capped", () => {
    expect(deadlineDuration(5000, NOW)).toBe(5000)
    expect(deadlineDuration(NOW + 7000, NOW)).toBe(7000)
    expect(deadlineDuration(NOW - 1, NOW)).toBe(0)
    expect(deadlineDuration(10 ** 9, NOW)).toBe(15 * 60_000)
  })
  test("bad JSON / missing fields -> 400; other paths 404; GET /run 405", async () => {
    const s = setup()
    const h = await signCellRequestV2({
      cellId: CELL,
      cellKey: KEY,
      direction: "cell->loader",
      method: "POST",
      path: "/run",
      body: "nope",
      ts: NOW,
    })
    expect(
      (
        await handle(
          new Request("https://l/run", { method: "POST", headers: h, body: "nope" }),
          s.env,
          s.deps,
        )
      ).status,
    ).toBe(400)
    expect((await handle(await signed({ runId: "x" }), s.env, s.deps)).status).toBe(400)
    expect((await handle(new Request("https://l/other"), s.env, s.deps)).status).toBe(404)
    expect((await handle(new Request("https://l/run"), s.env, s.deps)).status).toBe(405)
  })
})

describe("bridge call mapping", () => {
  const props: BridgeProps = {
    bridgeUrl: "https://c/api/app-bridge/r",
    runToken: "t",
    runId: "r",
    execNonce: "n",
    bridgeMethods: ["m"],
  }
  test("error bodies pass through; reason-only bodies map to errorCode; failures are 502", async () => {
    expect(
      await callBridge(props, "m", [], async () =>
        Response.json({ error: "nope", errorStatus: 400, errorCode: "x" }),
      ),
    ).toEqual({ error: "nope", errorStatus: 400, errorCode: "x" })
    expect(
      await callBridge(props, "m", [], async () =>
        Response.json({ reason: "expired" }, { status: 401 }),
      ),
    ).toEqual({
      error: "expired",
      errorStatus: 401,
      errorCode: "expired",
    })
    expect(
      await callBridge(props, "m", [], async () => new Response("gateway", { status: 502 })),
    ).toMatchObject({
      errorStatus: 502,
      errorCode: "bridge_bad_response",
    })
    // the cell's JSON for an undefined result is a bare {} with 200
    expect(await callBridge(props, "m", [], async () => Response.json({}))).toEqual({
      data: undefined,
    })
    expect(
      await callBridge(props, "m", [], async () => {
        throw new Error("dns")
      }),
    ).toMatchObject({ errorStatus: 502, errorCode: "bridge_unreachable" })
  })
})

describe("error kinds", () => {
  const KINDS = [
    "auth",
    "bundle_missing",
    "bundle_fetch_failed",
    "load",
    "limit",
    "handler",
    "timeout",
    "loader_internal",
  ]
  test("every error answer of /run carries a kind from the list", async () => {
    const answers: unknown[] = []
    const push = async (r: Response | Promise<Response>) => answers.push(await (await r).json())
    const s = setup()
    await push(
      handle(new Request("https://loader.test/run", { method: "POST", body: "{}" }), s.env, s.deps),
    )
    await push(handle(await signed({ runId: "x" }), s.env, s.deps))
    const bad = setup({ cellKeys: { [CELL]: { key: "short", bridgeOrigin: ORIGIN } } })
    await push(handle(await signed(await runBody()), bad.env, bad.deps))
    const missing = setup({ storedBundle: null, cell: () => new Response("", { status: 404 }) })
    await push(handle(await signed(await runBody()), missing.env, missing.deps))
    const slow = setup({ behaviour: () => new Promise((r) => setTimeout(r, 100)) })
    await push(handle(await signed(await runBody({ deadlineMs: 5 })), slow.env, slow.deps))
    for (const a of answers) {
      expect((a as { ok: boolean }).ok).toBe(false)
      expect(KINDS).toContain((a as { error: { kind: string } }).error.kind)
    }
    expect(answers.map((a) => (a as { error: { kind: string } }).error.kind)).toEqual([
      "auth",
      "loader_internal",
      "loader_internal",
      "bundle_missing",
      "timeout",
    ])
  })
  test("a loader fault (R2 throws) is loader_internal 500, never kindless", async () => {
    const s = setup()
    s.env.BUNDLES.get = async () => {
      throw new Error("R2 unavailable")
    }
    const r = await handle(await signed(await runBody()), s.env, s.deps)
    expect(r.status).toBe(500)
    expect((await json(r)).error).toMatchObject({ kind: "loader_internal" })
  })
  test("an app's verdict cannot claim a loader-level kind", async () => {
    const s = setup({
      behaviour: async () => ({ ok: false, error: { message: "x", kind: "auth" }, timings: {} }),
    })
    const j = await json(handle(await signed(await runBody()), s.env, s.deps))
    expect(j.error).toMatchObject({ message: "x", kind: "handler" })
  })
  test("the worker's captured console lines pass through on success and on error", async () => {
    const logs = [{ level: "info", msg: "hello", at: 1 }]
    const ok = setup({
      behaviour: async () => ({ ok: true, result: 1, timings: {}, logs, logsDropped: 2 }),
    })
    const j1 = await json(handle(await signed(await runBody()), ok.env, ok.deps))
    expect(j1).toMatchObject({ ok: true, logs, logsDropped: 2 })
    const bad = setup({
      behaviour: async () => ({ ok: false, error: { message: "x" }, timings: {}, logs }),
    })
    const j2 = await json(handle(await signed(await runBody()), bad.env, bad.deps))
    expect(j2).toMatchObject({ ok: false, logs })
  })
  test("a product run id `<instanceId>:<uuid>` is accepted", async () => {
    const s = setup()
    const runId = "0b6c5a52-1d3e-4c8f-9a2b-7e6f5d4c3b2a:9f8e7d6c-5b4a-4321-8fed-cba987654321"
    const r = await handle(
      await signed(await runBody({ runId, bridgeUrl: `${ORIGIN}/api/app-bridge/${runId}` })),
      s.env,
      s.deps,
    )
    expect(r.status).toBe(200)
    expect((await json(r)).result.echo).toBe(runId)
  })
})
