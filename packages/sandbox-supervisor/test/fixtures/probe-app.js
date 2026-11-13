// SPDX-License-Identifier: FSL-1.1-ALv2
// A Worker module shaped like an app's worker.js (default export with
// run(req, bridge)), with one export per sandbox probe.
import { WorkerEntrypoint } from "cloudflare:workers"

let calls = 0

const handlers = {
  echo: async (params) => params,
  count: async () => ++calls,
  bridge: async (params, bridge) => bridge.call("ping", [params]),
  nest: async (params, bridge) => bridge.call("nest", [params]),
  spin: async () => {
    for (;;) {}
  },
  // A wait far past any deadline (workerd cancels a promise that can never settle by itself).
  // Busy for `ms` without CPU (a run waiting on bridge calls), then answers it.
  sleep: async (ms) => new Promise((r) => setTimeout(() => r(ms), ms)),
  hang: async () => new Promise((r) => setTimeout(r, 600_000)),
  bomb: async () => {
    const keep = []
    for (;;) keep.push(new Array(1 << 20).fill(keep.length))
  },
  net: async (params) => {
    try {
      const r = await fetch(params.url)
      return { reached: true, status: r.status }
    } catch (e) {
      return { reached: false, error: String(e?.message ? e.message : e) }
    }
  },
  look: async (_params, _bridge, req, env) => ({
    env: Object.keys(env ?? {}),
    req: Object.keys(req).sort(),
    sharedArrayBuffer: typeof SharedArrayBuffer,
  }),
}

export default class extends WorkerEntrypoint {
  async run(req, bridge) {
    const h = handlers[req.exportName]
    if (!h) return { ok: false, error: { message: `no export ${req.exportName}` } }
    try {
      const result = await h(req.params, bridge, req, this.env)
      return { ok: true, result: result === undefined ? null : result }
    } catch (e) {
      return { ok: false, error: { message: String(e?.message ? e.message : e) } }
    }
  }
}
