// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The parent Worker of ONE workerd process of the sandbox pool: the shared app
// loader (@liaison/app-loader) with workerd's own platform objects.
//
//   loader     workerd's Worker Loader binding (needs `--experimental`): one
//              dynamic worker per run id key, empty env, no outbound network
//   bundles    an in-memory map the supervisor fills (`PUT /__module`): the
//              process never fetches a module, so it holds no key to fetch with
//   cells      one entry, the "sandbox" cell, whose key is this process's own
//              random key (PROCESS_KEY, from the environment the supervisor
//              spawned it with; it dies with the process) and whose bridge
//              origin is the app's bridge-only listener (BRIDGE_ORIGIN)
//   makeBridge a per-run Bridge capability whose props (the run token, the
//              bridge URL) the module never sees
//
// This Worker's own outbound network is the bridge listener and nothing else
// (globalOutbound in the process config, pool.ts): a bridge call is the only
// request that leaves the process.
//
// The supervisor signs every /run it forwards with PROCESS_KEY: a request
// that reaches this process any other way is refused (401), whatever it says.

import { WorkerEntrypoint } from "cloudflare:workers"
import {
  type BridgeProps,
  callBridge,
  createAppLoader,
  fail,
  type LoaderLike,
  MAX_FETCHED_BUNDLE_BYTES,
} from "@liaison/app-loader"
import { SANDBOX_CELL_ID } from "./cell"


interface HostEnv {
  LOADER: LoaderLike
  PROCESS_KEY: string
  BRIDGE_ORIGIN: string
}

type HostCtx = {
  exports: { Bridge(o: { props: BridgeProps }): unknown }
}

/** The module texts the supervisor pushed, by the loader's bundle key. */
const modules = new Map<string, Uint8Array>()

export class Bridge extends WorkerEntrypoint<HostEnv, BridgeProps> {
  call(method: string, args: unknown) {
    return callBridge(this.ctx.props, method, args)
  }
}

let loader: ReturnType<typeof createAppLoader> | null = null

function loaderFor(env: HostEnv, ctx: HostCtx) {
  if (loader) return loader
  loader = createAppLoader({
    loader: env.LOADER,
    bundles: {
      async get(key) {
        return modules.get(key) ?? null
      },
      async put(key, bytes) {
        modules.set(key, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
      },
    },
    cells: () =>
      env.PROCESS_KEY && env.PROCESS_KEY.length >= 16
        ? { [SANDBOX_CELL_ID]: { key: env.PROCESS_KEY, bridgeOrigin: env.BRIDGE_ORIGIN } }
        : null,
    now: () => Date.now(),
    makeBridge: (props) => ctx.exports.Bridge({ props }),
    // Modules are pushed, never fetched: a missing one is `bundle_missing`.
    fetch: async () => new Response("modules are pushed", { status: 404 }),
  })
  return loader
}

export default {
  async fetch(request: Request, env: HostEnv, ctx: HostCtx): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === "/__module" && request.method === "PUT") {
      // Content addressed: the loader re-hashes the bytes against the run's
      // sha256 before it loads them, so a wrong push is a hash mismatch.
      const key = url.searchParams.get("key") ?? ""
      if (!/^[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,128}\/[0-9a-f]{64}\.js$/.test(key)) {
        return fail(400, "loader_internal", "invalid module key", { code: "bad_request" })
      }
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.byteLength > MAX_FETCHED_BUNDLE_BYTES) {
        return fail(413, "loader_internal", "module too large", { code: "bad_request" })
      }
      modules.clear()
      modules.set(key, bytes)
      return new Response(null, { status: 204 })
    }
    return loaderFor(env, ctx).handle(request)
  },
}
