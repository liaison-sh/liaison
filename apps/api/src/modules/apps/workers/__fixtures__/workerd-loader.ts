// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The instance's sandbox service (@liaison/sandbox-supervisor: real workerd
// processes running the shared app loader) for the executor parity suite on
// workerd, with recorders where the suite looks:
//
//   url             the service, behind a recorder of every /run it is sent
//                   (headers, body) and of the cold loads it answers
//   bridgeResponses every answer body the cell's bridge sent to a workerd
//                   process (a proxy between the processes and the cell), for
//                   the suite's secret scans
//   deadLoaderUrl   a loader that answers every run with a kindless 503: the
//                   suite points the primary loader there and the sandbox
//                   service is the fallback target, so every run lands on
//                   workerd through the product's own fallback path

import { createSupervisor, DEFAULTS, type Supervisor } from "@liaison/sandbox-supervisor"
import type { Server } from "bun"

export interface RecordedRun {
  headers: Record<string, string>
  body: string
}

export interface WorkerdLoader {
  url: string
  deadLoaderUrl: string
  runs: RecordedRun[]
  bridgeResponses: string[]
  coldLoads: number
  supervisor: Supervisor
  stop(): Promise<void>
}

export async function startWorkerdLoader(opts: { cellOrigin: string }): Promise<WorkerdLoader> {
  const bridgeResponses: string[] = []
  const runs: RecordedRun[] = []
  const cell = new URL(opts.cellOrigin)
  const bridgeProxy: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const u = new URL(req.url)
      const h = new Headers(req.headers)
      h.set("host", cell.host)
      const res = await fetch(`${opts.cellOrigin}${u.pathname}${u.search}`, {
        method: req.method,
        headers: h,
        body: req.method === "GET" ? undefined : await req.arrayBuffer(),
        redirect: "manual",
      })
      const text = await res.text()
      bridgeResponses.push(text)
      return new Response(text, { status: res.status, headers: res.headers })
    },
  })
  const supervisor = await createSupervisor({
    ...DEFAULTS,
    bridgeOrigin: cell.origin,
    bridgeAddress: `127.0.0.1:${bridgeProxy.port}`,
    spares: 0,
  })
  const loader: WorkerdLoader = {
    url: "",
    deadLoaderUrl: "",
    runs,
    bridgeResponses,
    coldLoads: 0,
    supervisor,
    async stop() {
      front.stop(true)
      dead.stop(true)
      bridgeProxy.stop(true)
      await supervisor.stop()
    },
  }
  const front: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req) {
      const u = new URL(req.url)
      if (u.pathname === "/run" && req.method === "POST") {
        const body = await req.text()
        runs.push({ headers: Object.fromEntries(req.headers.entries()), body })
        const res = await supervisor.fetch(
          new Request(req.url, { method: "POST", headers: req.headers, body }),
        )
        const text = await res.text()
        if (/"cold":true/.test(text)) loader.coldLoads++
        return new Response(text, { status: res.status, headers: res.headers })
      }
      return supervisor.fetch(req)
    },
  })
  const dead: Server<undefined> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("loader unavailable", { status: 503 }),
  })
  loader.url = `http://127.0.0.1:${front.port}`
  loader.deadLoaderUrl = `http://127.0.0.1:${dead.port}`
  return loader
}
