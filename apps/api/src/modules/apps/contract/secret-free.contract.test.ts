// SPDX-License-Identifier: FSL-1.1-ALv2
//
// No app code holds a secret. A run whose isolate lives off the server (the
// Workers loader, the workerd sandbox) gets a secret-free bridge
// (sandbox/bridge/secret-free.ts): `connections_getToken`,
// `connections_getCredentials` and `config_get` of a declared secret are
// refused, so an app that reads its credentials itself works on QuickJS and
// fails on every other executor. Credentials reach the provider through
// `ctx.fetch` auth, `configSecrets` and the *ForConfig crypto methods instead.
//
// Two checks, for every app under the contract:
//   - every contract entry runs on the Workers-shaped executor (worker-core,
//     the code a Workers or workerd isolate runs) over its recorded egress,
//     on a bridge marked the way runApp marks a Workers run's, and none may
//     meet a refusal (whether or not the app catches it);
//   - no bundled app's source calls a secret-returning connection method or
//     the SDK reader of a connection's secrets, so a path no fixture drives
//     cannot read one either.

import { afterAll, describe, expect, it } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  forWorkersRun,
  manifestSecretConfigKeys,
  SECRET_NOT_AVAILABLE_ON_WORKERS,
} from "~/modules/apps/sandbox/bridge/secret-free"
import type { AppBridge } from "~/modules/apps/sandbox/run-app"
import {
  stopWorkerdContractService,
  workerdContractExecutor,
  workerModuleSource,
} from "../../../../test-support/contract/workerd-isolate"
import { appsUnderContract, BUNDLED_APPS_DIR, loadAppUnderContract } from "./apps.test-helpers"
import type { ContractEntry } from "./entries"
import { type AppUnderContract, runAppContract } from "./harness"
import type { ContractSource } from "./isolate"
import { workerCoreContractExecutor } from "./worker-core-isolate"

/**
 * The executor the entries run on: worker-core by default (in process, seconds);
 * `SECRET_FREE_EXECUTOR=workerd` runs them in the real workerd sandbox service.
 */
const ON_WORKERD = process.env.SECRET_FREE_EXECUTOR === "workerd"

const scratch = mkdtempSync(join(tmpdir(), "secret-free-contract-"))
afterAll(async () => {
  rmSync(scratch, { recursive: true, force: true })
  if (ON_WORKERD) await stopWorkerdContractService()
})

let built = 0
/** An app's (or template's) code as an ES module file, for the worker-core executor. */
async function moduleSource(entryPath: string): Promise<ContractSource> {
  const out = await Bun.build({
    entrypoints: [entryPath],
    target: "bun",
    format: "esm",
    external: ["node:*"],
  })
  const art = out.outputs[0]
  if (!out.success || !art) {
    throw new Error(`build of ${entryPath} failed: ${out.logs.map((l) => l.message).join("; ")}`)
  }
  const modulePath = join(scratch, `m${++built}.mjs`)
  writeFileSync(modulePath, await art.text())
  return { modulePath }
}

function isAsync(fn: unknown): boolean {
  return (fn as { constructor?: { name?: string } })?.constructor?.name === "AsyncFunction"
}

/**
 * Mark `bridge` secret-free as runApp marks a Workers run's (the manifest's
 * declared secrets are the refused config keys), and record every refusal.
 */
export function secretFreeBridge(
  bridge: AppBridge,
  secretKeys: Iterable<string>,
  onRefusal: (method: string, args: unknown[]) => void,
): AppBridge {
  forWorkersRun(bridge, { secretConfigKeys: secretKeys })
  for (const [name, fn] of Object.entries(bridge)) {
    if (typeof fn !== "function" || !isAsync(fn)) continue
    bridge[name] = async (...args: unknown[]) => {
      try {
        return await fn(...args)
      } catch (err) {
        if ((err as { code?: string })?.code === SECRET_NOT_AVAILABLE_ON_WORKERS) {
          onRefusal(name, args)
        }
        throw err
      }
    }
  }
  return bridge
}

function manifestOf(dir: string): { connections?: Record<string, never> } {
  return JSON.parse(readFileSync(join(dir, "app.manifest.json"), "utf8"))
}

/** Run every entry of `app` on `executor` over a secret-free bridge; the refusals met. */
export async function secretRefusals(
  loaded: AppUnderContract,
  executor = workerCoreContractExecutor,
): Promise<string[]> {
  const keys = manifestSecretConfigKeys(manifestOf(loaded.dir).connections)
  const refusals = new Set<string>()
  await runAppContract(loaded, executor, {
    bridgeFor: (entry: ContractEntry, bridge: AppBridge) =>
      secretFreeBridge(bridge, keys, (method, args) => {
        const what = method === "config_get" ? `config_get(${String(args[0])})` : method
        refusals.add(`${entry.entry}: ${what}`)
      }),
  })
  return [...refusals].sort()
}

describe("no app entry reads a secret on a secret-free bridge", () => {
  for (const app of appsUnderContract()) {
    it(`${app}: every entry runs on Workers and workerd without a secret`, async () => {
      const loaded = await loadAppUnderContract(app)
      const build = ON_WORKERD ? workerModuleSource : moduleSource
      const workers: AppUnderContract = {
        ...loaded,
        source: await build(join(loaded.dir, "handlers.ts")),
        templateSource: (rel: string) => build(join(loaded.dir, rel)),
      }
      const executor = ON_WORKERD ? workerdContractExecutor : workerCoreContractExecutor
      expect(await secretRefusals(workers, executor)).toEqual([])
    }, 600_000)
  }
})

/** The app-side spellings of a secret-returning read (bridge method or SDK helper). */
const SECRET_READ_RE =
  /\b(?:getCredentials|getToken|connections_getCredentials|connections_getToken|readConnectionCredentials|resolveCredentialsAccessor)\b/

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|test-d)\.tsx?$|testutil|test-ctx/.test(name)) {
      out.push(path)
    }
  }
  return out
}

describe("no bundled app source reads a connection secret", () => {
  it("names no secret-returning connection method or reader", () => {
    const hits: string[] = []
    for (const app of readdirSync(BUNDLED_APPS_DIR)) {
      const dir = join(BUNDLED_APPS_DIR, app)
      if (!statSync(dir).isDirectory()) continue
      for (const file of sourceFiles(dir)) {
        const lines = readFileSync(file, "utf8").split("\n")
        lines.forEach((line, i) => {
          // A comment may name the old methods (it says why the app no longer calls them).
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
          if (SECRET_READ_RE.test(line)) {
            hits.push(`${relative(BUNDLED_APPS_DIR, file)}:${i + 1}: ${line.trim()}`)
          }
        })
      }
    }
    expect(hits).toEqual([])
  })
})
