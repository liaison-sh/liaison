// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Worker modules of code that runs without an installed app version: an
// app-builder draft's preview, an import transform, a PDF template. Such code
// runs through runApp like an installed app (sandbox/run-app.ts): on the app
// loader or the instance's sandbox service, with the same limits, once it has
// a module. This file gives it one.
//
//   ensureScriptModule  a plain script (a transform, a template bundle): built
//                       with the builder of every package's worker.js
//                       (app-builder/build/freeze-core.ts buildWorkerModule),
//                       its named functions exported as the module's handlers
//   ensureBuiltModule   a module built already (a draft's worker.js, built with
//                       the draft by app-builder/build/build-worker.ts)
//   readAdhocModule     the bytes for a sha, re-hashed (the loader's bundle
//                       route and the sandbox service's module push)
//
// Every module is stored in kernel.app_code_modules (migration 0299) by the
// org and a source key: the sha256 of the script, its export list and the
// platform's Worker runtime (an empty module built with the same builder), so
// the same code is built once per release and per org, and a new release
// builds anew. Sites build when the code is saved or installed (a transform's
// save, a template's install) and look up on every run that goes to a remote
// executor (a process cache in front of the table); nothing is built for a run
// that stays on QuickJS.
//
// A script is bundled from a virtual module: it may import nothing (any import
// fails the build, a Bun macro included, so no code of it runs at build time),
// and its export wrappers look the function up when called: a top-level
// function of the script (a transform's `transform`), else a property the
// script set on globalThis (a template's `renderTemplate`). The module is an
// ES module, so the script runs in strict mode, as on the loader.

import { createHash } from "node:crypto"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type AppCodeModuleOrigin, appCodeModules } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { buildWorkerModule } from "~/modules/app-builder/build/freeze-core"
import { sweepSkippingMoving } from "~/modules/org/transfer-state/skip-moving"

const log = rootLogger.child({ module: "apps-adhoc-module" })

/** The largest module the loader and the sandbox service accept (@liaison/app-loader). */
export const ADHOC_MODULE_MAX_BYTES = 8 * 1024 * 1024
/** A module no run has looked up for this long is pruned. */
export const ADHOC_MODULE_RETENTION_DAYS = 30
/** A lookup that finds a module touches its row at most this often per process. */
const TOUCH_EVERY_MS = 60 * 60 * 1000
const CACHE_MAX = 1_000

const VIRTUAL_HANDLERS = "liaison-adhoc-handlers"
const VIRTUAL_NS = "liaison-adhoc"
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The module a run of ad-hoc code goes to: its sha and the version label of its runs. */
export interface AdhocModuleRef {
  sha256: string
  version: string
}

export class AdhocModuleError extends Error {
  readonly code = "worker_module_build_failed"
  constructor(message: string) {
    super(message)
    this.name = "AdhocModuleError"
  }
}

const sha256Hex = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** org|source key -> {sha, last touch}. */
const cache = new Map<string, { sha256: string; touchedAt: number }>()
const inflight = new Map<string, Promise<string>>()
let runtime: Promise<string> | null = null
let builds = 0

function cacheKey(orgId: string | null, sourceKey: string): string {
  return `${orgId ?? "-"}|${sourceKey}`
}

function remember(key: string, sha256: string, touchedAt: number): void {
  cache.delete(key)
  cache.set(key, { sha256, touchedAt })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
}

/** The handlers module of a script: the script, then one wrapper per export. */
export function scriptHandlersSource(script: string, exports: readonly string[]): string {
  const lines = [script, ""]
  for (const name of exports) {
    if (!EXPORT_NAME.test(name) || name.startsWith("__liaison_export_")) {
      throw new AdhocModuleError(`invalid export name ${JSON.stringify(name)}`)
    }
    const local = `__liaison_export_${name}`
    lines.push(
      `const ${local} = function (...args) {`,
      `  const fn = typeof ${name} === "function" ? ${name} : globalThis[${JSON.stringify(name)}]`,
      `  if (typeof fn !== "function") throw new Error(${JSON.stringify(`${name} is not defined`)})`,
      "  return fn.apply(this, args)",
      "}",
      `export { ${local} as ${name} }`,
    )
  }
  return `${lines.join("\n")}\n`
}

/** Build a module from a handlers source held in memory; nothing else may be imported. */
async function buildFromHandlers(handlers: string): Promise<string> {
  const plugin: Bun.BunPlugin = {
    name: "liaison-adhoc-handlers",
    setup(build) {
      build.onResolve({ filter: /^liaison-adhoc-handlers$/ }, () => ({
        path: "handlers.js",
        namespace: VIRTUAL_NS,
      }))
      build.onLoad({ filter: /.*/, namespace: VIRTUAL_NS }, () => ({
        contents: handlers,
        loader: "js",
      }))
      // The script's own imports: none resolves.
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.namespace === VIRTUAL_NS || args.importer === "handlers.js") {
          throw new Error(`import is not available here (${JSON.stringify(args.path)})`)
        }
        return undefined
      })
    },
  }
  builds++
  const built = await buildWorkerModule({ handlersPath: VIRTUAL_HANDLERS, plugins: [plugin] })
  return built.text
}

/**
 * sha256 of an empty module built with the builder: the platform's Worker
 * runtime as this release bundles it. Part of every source key.
 */
function runtimeFingerprint(): Promise<string> {
  runtime ??= buildFromHandlers("export {}\n").then(sha256Hex)
  runtime.catch(() => {
    runtime = null
  })
  return runtime
}

/** The caller's transaction when it holds one (a save), else a system connection of its own. */
type DbUse = <T>(reason: string, fn: (db: PrivilegedDb) => Promise<T>) => Promise<T>
const systemDb: DbUse = (reason, fn) => withSystemDb(reason, fn)
const inTx =
  (tx: PrivilegedDb): DbUse =>
  (_reason, fn) =>
    fn(tx)

async function lookup(use: DbUse, orgId: string | null, sourceKey: string): Promise<string | null> {
  const [row] = await use("adhoc-module:lookup", (db) =>
    db
      .update(appCodeModules)
      .set({ lastUsedAt: sql`now()` })
      .where(
        and(
          orgId === null ? isNull(appCodeModules.orgId) : eq(appCodeModules.orgId, orgId),
          eq(appCodeModules.sourceKey, sourceKey),
        ),
      )
      .returning({ sha256: appCodeModules.sha256 }),
  )
  return row?.sha256 ?? null
}

async function store(
  use: DbUse,
  input: {
    orgId: string | null
    origin: AppCodeModuleOrigin
    sourceKey: string
    bytes: Uint8Array
  },
): Promise<string> {
  if (input.bytes.byteLength > ADHOC_MODULE_MAX_BYTES) {
    throw new AdhocModuleError(
      `the Worker module is ${input.bytes.byteLength} bytes, over the ${ADHOC_MODULE_MAX_BYTES}-byte limit`,
    )
  }
  const sha256 = sha256Hex(input.bytes)
  await use("adhoc-module:store", (db) =>
    db
      .insert(appCodeModules)
      .values({
        orgId: input.orgId,
        origin: input.origin,
        sourceKey: input.sourceKey,
        sha256,
        bytes: input.bytes,
        sizeBytes: input.bytes.byteLength,
      })
      .onConflictDoUpdate({
        target: [appCodeModules.orgId, appCodeModules.sourceKey],
        set: { lastUsedAt: sql`now()` },
      }),
  )
  return sha256
}

/** The cached sha for a key, the stored one, or the one `make` stores. One at a time per key. */
async function ensure(
  orgId: string | null,
  sourceKey: string,
  make: (use: DbUse) => Promise<string>,
  tx?: PrivilegedDb,
): Promise<string> {
  const key = cacheKey(orgId, sourceKey)
  if (tx) {
    // In the caller's transaction (a save): not cached, the transaction may
    // still roll back.
    const hit = cache.get(key)
    if (hit) return hit.sha256
    const use = inTx(tx)
    return (await lookup(use, orgId, sourceKey)) ?? (await make(use))
  }
  const hit = cache.get(key)
  const now = Date.now()
  if (hit && now - hit.touchedAt < TOUCH_EVERY_MS) return hit.sha256
  const running = inflight.get(key)
  if (running) return running
  const p = (async () => {
    const sha256 = (await lookup(systemDb, orgId, sourceKey)) ?? (await make(systemDb))
    remember(key, sha256, Date.now())
    return sha256
  })()
  inflight.set(key, p)
  try {
    return await p
  } finally {
    inflight.delete(key)
  }
}

/**
 * The Worker module of a plain script whose `exports` are top-level functions
 * (or globalThis properties) of it, built and stored on first use. Throws
 * AdhocModuleError when the script does not build.
 */
export async function ensureScriptModule(input: {
  origin: Exclude<AppCodeModuleOrigin, "draft">
  orgId: string | null
  script: string
  exports: readonly string[]
  /** The caller's transaction, when it holds one (the row is written in it). */
  tx?: PrivilegedDb
}): Promise<string> {
  const exports = [...new Set(input.exports)].sort()
  const handlers = scriptHandlersSource(input.script, exports)
  const fingerprint = await runtimeFingerprint()
  const sourceKey = sha256Hex(`${input.origin}\0${fingerprint}\0${handlers}`)
  return ensure(
    input.orgId,
    sourceKey,
    async (use) => {
      let text: string
      try {
        text = await buildFromHandlers(handlers)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        log.warn(
          { origin: input.origin, orgId: input.orgId, err: detail },
          "Worker module build failed",
        )
        throw new AdhocModuleError(`the code does not build as a Worker module: ${detail}`)
      }
      return store(use, {
        orgId: input.orgId,
        origin: input.origin,
        sourceKey,
        bytes: new TextEncoder().encode(text),
      })
    },
    input.tx,
  )
}

/** A module built already (a draft's worker.js), stored under its own sha. */
export async function ensureBuiltModule(input: {
  origin: "draft"
  orgId: string
  sha256: string
  /** Read only when the module is not stored yet. */
  bytes: () => Promise<Uint8Array | null>
}): Promise<string | null> {
  const sourceKey = `draft:${input.sha256}`
  try {
    return await ensure(input.orgId, sourceKey, async (use) => {
      const bytes = await input.bytes()
      if (!bytes) throw new AdhocModuleError("the draft's Worker module is missing")
      if (sha256Hex(bytes) !== input.sha256) {
        throw new AdhocModuleError("the draft's Worker module does not match its recorded sha256")
      }
      return store(use, { orgId: input.orgId, origin: input.origin, sourceKey, bytes })
    })
  } catch (err) {
    if (err instanceof AdhocModuleError && /missing/.test(err.message)) return null
    throw err
  }
}

/** The bytes stored for `sha256`, re-hashed, or null. */
export async function readAdhocModule(sha256: string): Promise<Uint8Array | null> {
  const rows = await withSystemDb("adhoc-module:read", (db) =>
    db
      .select({ bytes: appCodeModules.bytes })
      .from(appCodeModules)
      .where(eq(appCodeModules.sha256, sha256))
      .limit(2),
  )
  for (const row of rows) {
    if (sha256Hex(row.bytes) === sha256) return row.bytes
    log.error({ sha256 }, "Stored Worker module does not match its recorded sha256")
  }
  return null
}

/**
 * Delete modules no run has looked up for the retention period, never those of
 * an org being moved to another server. Returns how many went.
 */
export async function pruneAdhocModules(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - ADHOC_MODULE_RETENTION_DAYS * 86_400_000)
  const gone = await sweepSkippingMoving((notMoving) =>
    withSystemDb("adhoc-module:prune", (db) =>
      db
        .delete(appCodeModules)
        .where(
          and(
            lt(appCodeModules.lastUsedAt, before),
            or(isNull(appCodeModules.orgId), notMoving(sql`${appCodeModules.orgId}`)),
          ),
        )
        .returning({ id: appCodeModules.id }),
    ),
  )
  cache.clear()
  return gone.length
}

/** Test seams. */
export const AdhocModuleTestAccess = {
  builds: () => builds,
  clearCache(): void {
    cache.clear()
  },
}
