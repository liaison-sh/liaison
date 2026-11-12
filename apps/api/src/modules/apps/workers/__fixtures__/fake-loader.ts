// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test support: a local host of the app loader. The request handling is the
// loader package itself (@liaison/app-loader `createAppLoader`, the code every
// loader host runs: signature, body checks, bridgeUrl origin, the module from
// the bundle store or fetched from the cell and re-hashed, one dynamic worker
// per id, the per-run bridge, the deadline race, the error kinds, the start
// probe). Only the platform objects are stand-ins:
//
//  - the Worker Loader: one module instance per dynamic worker id, imported
//    in this process (module globals persist across runs of one id). A
//    bundle registered with a `corePath` runs the build's `worker-core.js`
//    (no `cloudflare:workers` import); any other module (one fetched from
//    the cell) runs its real `worker.js` with `cloudflare:workers` rewritten
//    to a stand-in WorkerEntrypoint, its default export's `run(req, bridge)`
//    being the entry. A module that throws while it is evaluated fails every
//    call of its id, the start probe included (kind `load`), as an isolate
//    whose start failed does. Fetch is not blocked inside it.
//  - the bundle store: files on disk, keyed `<app>/<version>/<sha256>.js`.
//  - the bridge: the package's `callBridge`, with every answer body recorded.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  callBridge,
  createAppLoader,
  type LoaderLike,
  START_PROBE_METHOD,
  type WorkerCode,
} from "@liaison/app-loader"
import type { Server } from "bun"

export interface FakeLoaderBundle {
  /** The Worker module whose sha256 is the bundle's identity (worker.js). */
  workerPath: string
  /**
   * The same build without the Cloudflare entry (worker-core.js), what runs
   * here; absent for a module fetched from the cell (then worker.js runs).
   */
  corePath?: string
}

export interface BundleFetch {
  url: string
  status: number
  headers: Record<string, string>
}

export interface FakeLoaderOptions {
  cells: Record<string, { key: string; bridgeOrigin: string }>
  /** `<app>/<version>/<sha256>.js` -> files, the R2 bucket's analogue. */
  bundles: Record<string, FakeLoaderBundle>
  now?: () => number
}

export interface RecordedRun {
  headers: Record<string, string>
  body: string
}

export interface FakeLoader {
  url: string
  stop(): void
  /** Every signed /run that reached the loader, raw (for replay tests). */
  runs: RecordedRun[]
  /** Every bridge-route answer body the isolate received (for secret scans). */
  bridgeResponses: string[]
  /** How many times a Dynamic Worker id was loaded cold. */
  coldLoads: number
  /** Add or replace a bundle while running. */
  setBundle(key: string, bundle: FakeLoaderBundle): void
  /** Drop a bundle (the R2 object) and its verified module, so the next run fetches it. */
  dropBundle(key: string): void
  /** Every bundle GET the loader sent to a cell. */
  bundleFetches: BundleFetch[]
}

type CoreModule = {
  run(req: unknown, bridge: { call(m: string, a: unknown): Promise<unknown> }): Promise<unknown>
}

export function startFakeLoader(opts: FakeLoaderOptions): FakeLoader {
  const now = opts.now ?? Date.now
  const bundles = { ...opts.bundles }
  /** One module instance per dynamic worker id, as LOADER.get keeps one isolate per id. */
  const modules = new Map<string, Promise<CoreModule>>()
  const verified = new Map<string, string>()
  const fetchedDir = mkdtempSync(join(tmpdir(), "fake-loader-fetched-"))
  const shim = join(fetchedDir, "cloudflare-workers-shim.js")
  writeFileSync(
    shim,
    "export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env } }\n",
  )
  const shaOfId = (id: string) => id.slice(id.lastIndexOf("#") + 1)
  const loader: FakeLoader = {
    url: "",
    stop: () => {
      server.stop(true)
      rmSync(fetchedDir, { recursive: true, force: true })
    },
    runs: [],
    bridgeResponses: [],
    coldLoads: 0,
    bundleFetches: [],
    setBundle: (key, bundle) => {
      bundles[key] = bundle
    },
    dropBundle: (key) => {
      delete bundles[key]
      const sha = key.split("/").pop()?.replace(/\.js$/, "")
      for (const id of [...verified.keys()]) if (shaOfId(id) === sha) verified.delete(id)
      for (const id of [...modules.keys()]) if (shaOfId(id) === sha) modules.delete(id)
    },
  }

  /** The module of a dynamic worker: the registered worker-core build, else the module text itself. */
  async function instantiate(id: string, code: WorkerCode): Promise<CoreModule> {
    const sha = shaOfId(id)
    const registered = Object.entries(bundles).find(([k]) => k.endsWith(`/${sha}.js`))?.[1]
    if (registered?.corePath) {
      return (await import(`${registered.corePath}?id=${encodeURIComponent(id)}`)) as CoreModule
    }
    const text = (code.modules[code.mainModule] ?? "").replaceAll(
      /from\s*["']cloudflare:workers["']/g,
      `from ${JSON.stringify(shim)}`,
    )
    const runnable = join(fetchedDir, `${sha}.run.js`)
    writeFileSync(runnable, text)
    const m = (await import(`${runnable}?id=${encodeURIComponent(id)}`)) as {
      default: new () => CoreModule
    }
    return new m.default()
  }

  const workerLoader: LoaderLike = {
    get(id, getCode) {
      let mod = modules.get(id)
      if (!mod) {
        // getCode runs now, as the real loader's factory runs on a cold id.
        const code = getCode()
        loader.coldLoads++
        mod = Promise.resolve(code).then((c) => instantiate(id, c))
        mod.catch(() => undefined)
        modules.set(id, mod)
      }
      const started = mod
      return {
        getEntrypoint: () =>
          ({
            run: async (req: unknown, bridge: { call(m: string, a: unknown): Promise<unknown> }) =>
              (await started).run(req, bridge),
            // A started module has no such method, like any RPC stub.
            [START_PROBE_METHOD]: async () => {
              await started
              throw new TypeError(`The RPC receiver does not implement "${START_PROBE_METHOD}".`)
            },
          }) as never,
      }
    },
  }

  const app = createAppLoader({
    loader: workerLoader,
    bundles: {
      async get(key) {
        const b = bundles[key]
        return b ? new Uint8Array(readFileSync(b.workerPath)) : null
      },
      async put(key, bytes) {
        const workerPath = join(fetchedDir, `${key.split("/").pop()}`)
        writeFileSync(workerPath, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
        bundles[key] = { workerPath }
      },
    },
    cells: () => opts.cells,
    now,
    fetch: async (url, init) => {
      const res = await fetch(url, init)
      loader.bundleFetches.push({
        url,
        status: res.status,
        headers: { ...(init.headers as Record<string, string>) },
      })
      return res
    },
    makeBridge: (props) => ({
      call: (m: string, a: unknown) =>
        callBridge(props, m, a, undefined, now, (text) => loader.bridgeResponses.push(text)),
    }),
    verified,
  })

  async function handle(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/run") {
      loader.runs.push({
        headers: Object.fromEntries(req.headers.entries()),
        body: await req.clone().text(),
      })
    }
    return app.handle(req)
  }

  const server: Server<undefined> = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle })
  loader.url = `http://127.0.0.1:${server.port}`
  return loader
}
