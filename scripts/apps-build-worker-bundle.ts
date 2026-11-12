#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Build an app's Worker module on its own (a development aid: every
// `.liaisonapp` already carries its `worker.js`, built by scripts/freeze-app.ts
// with the same step). Build only: nothing is uploaded.
//
//   bun run apps:build-worker-bundle <app> [--app-dir <dir>] [--out <dir>]
//
// <app> is a directory under bundled-apps/ (or --app-dir points at any app
// directory with app.manifest.json + handlers.ts). The version comes from its
// app.manifest.json. Output, under --out (default <repo>/dist-worker, gitignored):
//
//   <out>/<app>/<version>/worker.js       ES module for the Workers loader:
//                                         default export = WorkerEntrypoint with
//                                         run(req, bridge) (worker-entry.ts).
//                                         Imports only `cloudflare:workers`.
//   <out>/<app>/<version>/worker-core.js  the same app + core with no Cloudflare
//                                         import, for a plain JS host (the test
//                                         fake loader): `export function
//                                         run(req, bridge)`, same contract.
//
// Both come from `buildWorkerModule` (freeze-core.ts): no `node:` import (the
// build fails if one remains). Prints the sha256 of worker.js (hex, over its
// bytes). Run from the repo root, as the freeze is: the bundle's module path
// comments are relative to the process's cwd, so the sha matches the package's
// worker.js only from there.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { buildWorkerModule } from "../apps/api/src/modules/app-builder/build/freeze-core"

const REPO_ROOT = resolve(import.meta.dir, "..")

export interface WorkerBundleBuild {
  app: string
  version: string
  sha256: string
  workerPath: string
  corePath: string
  workerBytes: number
  coreBytes: number
}

function readManifest(appDir: string): { name: string; version: string } {
  const path = join(appDir, "app.manifest.json")
  if (!existsSync(path)) throw new Error(`No app.manifest.json at ${path}`)
  const raw = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown }
  if (typeof raw.name !== "string" || typeof raw.version !== "string") {
    throw new Error(`${path}: name and version must be strings`)
  }
  return { name: raw.name, version: raw.version }
}

export async function buildWorkerBundle(opts: {
  app?: string
  appDir?: string
  outRoot?: string
}): Promise<WorkerBundleBuild> {
  const appDir = resolve(opts.appDir ?? join(REPO_ROOT, "bundled-apps", opts.app ?? ""))
  const handlers = join(appDir, "handlers.ts")
  if (!existsSync(handlers)) throw new Error(`No handlers.ts at ${handlers}`)
  const { name, version } = readManifest(appDir)
  const outDir = join(resolve(opts.outRoot ?? join(REPO_ROOT, "dist-worker")), name, version)
  mkdirSync(outDir, { recursive: true })
  const worker = await buildWorkerModule({ handlersPath: handlers })
  const core = await buildWorkerModule({ handlersPath: handlers, core: true })
  const workerPath = join(outDir, "worker.js")
  const corePath = join(outDir, "worker-core.js")
  writeFileSync(workerPath, worker.text)
  writeFileSync(corePath, core.text)
  const bytes = readFileSync(workerPath)
  return {
    app: name,
    version,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    workerPath,
    corePath,
    workerBytes: bytes.length,
    coreBytes: readFileSync(corePath).length,
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (n: string) => {
    const i = args.indexOf(n)
    if (i === -1) return undefined
    const v = args[i + 1]
    args.splice(i, 2)
    return v
  }
  const appDir = flag("--app-dir")
  const outRoot = flag("--out")
  const app = args[0]
  if (!app && !appDir) {
    console.error("usage: bun run apps:build-worker-bundle <app> [--app-dir <dir>] [--out <dir>]")
    process.exit(2)
  }
  try {
    const r = await buildWorkerBundle({ app, appDir, outRoot })
    console.log(`worker.js       ${r.workerPath} (${r.workerBytes} bytes)`)
    console.log(`worker-core.js  ${r.corePath} (${r.coreBytes} bytes)`)
    console.log(`sha256          ${r.sha256}`)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
}
