// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sandbox service in this process with a stand-in for the app's bridge
// listener: it answers `ping` and `nest` for runs it registered (by token),
// refuses every other call, and records what it saw.
import { createHash, randomBytes } from "node:crypto"
import type { Server } from "bun"
import { DEFAULTS, readProcessUids, type SupervisorConfig } from "../src/config"
import { createSupervisor, RUN_DEPTH_HEADER, type Supervisor } from "../src/supervisor"

// The probe module, as text (the bytes the sandbox hashes and loads).
import probeAppText from "./fixtures/probe-app.js" with { type: "text" }

export const PROBE_APP = new TextEncoder().encode(probeAppText)
export const PROBE_SHA = createHash("sha256").update(PROBE_APP).digest("hex")

export interface Sandbox {
  url: string
  sup: Supervisor
  bridgeOrigin: string
  /** Bridge calls the stand-in answered or refused, by run id. */
  calls: Array<{ runId: string; method: string; status: number }>
  run(
    exportName: string,
    params?: unknown,
    o?: {
      orgId?: string
      depth?: number
      deadlineMs?: number
      cpuMs?: number
      token?: string
      lane?: "interactive" | "background"
    },
  ): Promise<{ status: number; body: Record<string, any>; headers: Headers }>
  stop(): Promise<void>
}

export async function startSandbox(over: Partial<SupervisorConfig> = {}): Promise<Sandbox> {
  const tokens = new Map<string, { orgId: string; depth: number }>()
  const calls: Sandbox["calls"] = []
  let sandbox: Sandbox
  const bridge: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const runId = decodeURIComponent(url.pathname.replace("/api/app-bridge/", ""))
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "")
      const body = (await req.json()) as { method: string; args: unknown[] }
      const run = tokens.get(`${runId} ${token}`)
      if (!run) {
        calls.push({ runId, method: body.method, status: 401 })
        return Response.json({ error: "Unknown run", reason: "bad_token" }, { status: 401 })
      }
      calls.push({ runId, method: body.method, status: 200 })
      if (body.method === "ping") return Response.json({ data: { pong: body.args[0] } })
      if (body.method === "nest") {
        const want = (body.args[0] as { to: number }).to
        if (run.depth >= want) return Response.json({ data: { depth: run.depth } })
        const r = await sandbox.run(
          "nest",
          { to: want },
          { orgId: run.orgId, depth: run.depth + 1 },
        )
        return Response.json({ data: r.body })
      }
      return Response.json({ error: "Unknown method", errorStatus: 404 }, { status: 404 })
    },
  })
  const bridgeOrigin = `http://127.0.0.1:${bridge.port}`
  // As root on Linux (the service's container), each process runs as its own uid.
  const processUids = readProcessUids(process.env, DEFAULTS.poolSize + DEFAULTS.overflow + 8)
  const sup = await createSupervisor({
    ...DEFAULTS,
    bridgeOrigin,
    spares: 0,
    processUids,
    ...over,
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch: (r, srv) => sup.fetch(r, srv),
  })
  const url = `http://127.0.0.1:${server.port}`
  const put = await fetch(`${url}/modules/${PROBE_SHA}`, { method: "PUT", body: PROBE_APP })
  if (put.status !== 204) throw new Error(`module push failed: ${put.status}`)
  sandbox = {
    url,
    sup,
    bridgeOrigin,
    calls,
    async run(exportName, params = null, o = {}) {
      const runId = `test:${randomBytes(8).toString("hex")}`
      const runToken = o.token ?? randomBytes(32).toString("base64url")
      const orgId = o.orgId ?? "org-a"
      if (!o.token) tokens.set(`${runId} ${runToken}`, { orgId, depth: o.depth ?? 0 })
      const res = await fetch(`${url}/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(o.depth ? { [RUN_DEPTH_HEADER]: String(o.depth) } : {}),
        },
        body: JSON.stringify({
          runId,
          orgId,
          app: "probe",
          version: "1.0.0",
          sha256: PROBE_SHA,
          exportName,
          params,
          extraArgs: [],
          approval: null,
          bridgeMethods: ["ping", "nest"],
          bridgeUrl: `${bridgeOrigin}/api/app-bridge/${encodeURIComponent(runId)}`,
          runToken,
          deadlineMs: o.deadlineMs ?? 10_000,
          ...(o.cpuMs ? { limits: { cpuMs: o.cpuMs } } : {}),
          ...(o.lane ? { lane: o.lane } : {}),
        }),
      })
      tokens.delete(`${runId} ${runToken}`)
      return {
        status: res.status,
        body: (await res.json()) as Record<string, any>,
        headers: res.headers,
      }
    },
    async stop() {
      server.stop(true)
      bridge.stop(true)
      await sup.stop()
    },
  }
  return sandbox
}
