// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Several app processes share one sandbox service (the rolling `api` and
// `worker` topology): each run's bridge calls go back to the process that sent
// the run, through the service's relay. The release handshake refuses a caller
// of another release and turns /health unhealthy. Every answer carries the
// run's measured CPU.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import type { Server } from "bun"
import { DEFAULTS } from "../src/config"
import { RELEASE_HEADER, RELEASE_MISMATCH_CODE } from "../src/release"
import { CPU_HEADER, createSupervisor, RSS_HEADER, type Supervisor } from "../src/supervisor"
import { PROBE_APP, PROBE_SHA } from "./helpers"

const RELEASE = "v9.9.9+abcdef"

interface AppProcess {
  name: string
  host: string
  server: Server<undefined>
  seen: string[]
  tokens: Map<string, string>
}

/** A stand-in for one app process's bridge-only listener, at `host` on `port`. */
function appProcess(name: string, host: string, port: number): AppProcess {
  const seen: string[] = []
  const tokens = new Map<string, string>()
  const server = Bun.serve({
    hostname: host,
    port,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method !== "POST") return new Response("Not Found", { status: 404 })
      const runId = decodeURIComponent(url.pathname.replace("/api/app-bridge/", ""))
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      const body = (await req.json()) as { method: string; args: unknown[] }
      if (tokens.get(runId) !== token) {
        return Response.json({ error: "Unknown run", reason: "bad_token" }, { status: 401 })
      }
      seen.push(runId)
      return Response.json({ data: { pong: body.args[0], from: name } })
    },
  })
  return { name, host, server, seen, tokens }
}

describe("one sandbox service, several app processes", () => {
  let sup: Supervisor
  let front: Server<undefined>
  let a: AppProcess
  let b: AppProcess
  let port = 0

  beforeAll(async () => {
    // Two processes on the same bridge port at two addresses, as on the
    // sandbox network (here IPv4 and IPv6 loopback).
    a = appProcess("a", "127.0.0.1", 0)
    port = a.server.port ?? 0
    b = appProcess("b", "::1", port)
    sup = await createSupervisor(
      { ...DEFAULTS, bridgeOrigin: `http://app-bridge:${port}`, spares: 0 },
      { release: RELEASE },
    )
    front = Bun.serve({
      hostname: "::",
      port: 0,
      idleTimeout: 0,
      fetch: (r, srv) => sup.fetch(r, srv),
    })
    const put = await fetch(`http://127.0.0.1:${front.port}/modules/${PROBE_SHA}`, {
      method: "PUT",
      headers: { [RELEASE_HEADER]: RELEASE },
      body: PROBE_APP,
    })
    expect(put.status).toBe(204)
  }, 60_000)

  afterAll(async () => {
    front.stop(true)
    a.server.stop(true)
    b.server.stop(true)
    await sup.stop()
  })

  async function runFrom(p: AppProcess, exportName: string, release: string | null = RELEASE) {
    const runId = `t:${randomBytes(6).toString("hex")}`
    const runToken = randomBytes(32).toString("base64url")
    p.tokens.set(runId, runToken)
    const host = p.host.includes(":") ? `[${p.host}]` : p.host
    const res = await fetch(`http://${host}:${front.port}/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(release ? { [RELEASE_HEADER]: release } : {}),
      },
      body: JSON.stringify({
        runId,
        orgId: "org-a",
        app: "probe",
        version: "1.0.0",
        sha256: PROBE_SHA,
        exportName,
        params: { from: p.name },
        extraArgs: [],
        approval: null,
        bridgeMethods: ["ping"],
        bridgeUrl: `http://app-bridge:${port}/api/app-bridge/${encodeURIComponent(runId)}`,
        runToken,
        deadlineMs: 10_000,
        limits: { cpuMs: 400 },
      }),
    })
    return { runId, res, body: (await res.json()) as Record<string, any> }
  }

  test("each run's bridge calls reach the process that sent it, and no other", async () => {
    const ra = await runFrom(a, "bridge")
    const rb = await runFrom(b, "bridge")
    // The probe's `bridge` export returns the bridge's reply body as it came.
    expect(ra.body).toMatchObject({
      ok: true,
      result: { data: { pong: { from: "a" }, from: "a" } },
    })
    expect(rb.body).toMatchObject({
      ok: true,
      result: { data: { pong: { from: "b" }, from: "b" } },
    })
    expect(a.seen).toEqual([ra.runId])
    expect(b.seen).toEqual([rb.runId])
  }, 60_000)

  test("/health?bridge=1 says whether the caller's bridge listener answers from the service", async () => {
    const ok = await fetch(`http://127.0.0.1:${front.port}/health?bridge=1`, {
      headers: { [RELEASE_HEADER]: RELEASE },
    })
    expect(await ok.json()).toEqual({ ok: true, release: RELEASE, bridge: "ok" })
  })

  test("every answer carries the run's CPU as the supervisor measured it", async () => {
    const echo = await runFrom(a, "echo")
    expect(echo.body.ok).toBe(true)
    expect(Number(echo.res.headers.get(CPU_HEADER))).toBeGreaterThanOrEqual(0)
    expect(Number(echo.res.headers.get(RSS_HEADER))).toBeGreaterThan(0)
    const spin = await runFrom(a, "spin")
    expect(spin.body.error).toMatchObject({ code: "cpu_limit" })
    expect(Number(spin.res.headers.get(CPU_HEADER))).toBeGreaterThanOrEqual(300)
  }, 60_000)

  test("a caller of another release is refused, and /health turns unhealthy until this release calls again", async () => {
    const old = await runFrom(a, "echo", "v9.9.8+000000")
    expect(old.res.status).toBe(409)
    expect(old.body.error).toMatchObject({ code: RELEASE_MISMATCH_CODE })
    expect(old.body.error.message).toContain("recreate the sandbox service")
    expect(a.seen.length).toBe(1)
    const put = await fetch(`http://127.0.0.1:${front.port}/modules/${PROBE_SHA}`, {
      method: "PUT",
      headers: { [RELEASE_HEADER]: "v9.9.8+000000" },
      body: PROBE_APP,
    })
    expect(put.status).toBe(409)

    // A probe without a release (the container's own health check): unhealthy
    // while only callers of another release were seen lately.
    let health = await fetch(`http://127.0.0.1:${front.port}/health`)
    // Calls of this release were seen moments ago (the tests above): healthy.
    expect(health.status).toBe(200)
    const fresh = await createSupervisor(
      { ...DEFAULTS, bridgeOrigin: `http://app-bridge:${port}`, spares: 0 },
      { release: RELEASE },
    )
    try {
      const refused = await fresh.fetch(
        new Request("http://sandbox/health", { headers: { [RELEASE_HEADER]: "v1+old" } }),
      )
      expect(refused.status).toBe(409)
      health = await fresh.fetch(new Request("http://sandbox/health"))
      expect(health.status).toBe(503)
      expect(await health.json()).toMatchObject({ ok: false, code: RELEASE_MISMATCH_CODE })
      await fresh.fetch(
        new Request("http://sandbox/health", { headers: { [RELEASE_HEADER]: RELEASE } }),
      )
      expect((await fresh.fetch(new Request("http://sandbox/health"))).status).toBe(200)
    } finally {
      await fresh.stop()
    }
  }, 60_000)
})
