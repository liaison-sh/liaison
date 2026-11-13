// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Worker modules of code that runs without an installed app version: an
// app-builder draft's preview, an import transform, a PDF template. Such code
// runs through runApp like an installed app (sandbox/run-app.ts): on the app
// loader or the instance's sandbox service, with the same limits, once it has
// a module. This file gives it one.
//
//   ensureScriptModule  a plain script (a transform, a template bundle): the
//                       script, in a function scope of its own, placed before
//                       the platform's Worker runtime (built from repo code with
//                       the builder of every package's worker.js,
//                       app-builder/build/freeze-core.ts buildWorkerModule), its
//                       named functions exported as the module's handlers
//   ensureBuiltModule   a module built already (a draft's worker.js, built with
//                       the draft by app-builder/build/build-worker.ts)
//   readAdhocModule     the bytes for a sha, re-hashed (the loader's bundle
//                       route and the sandbox service's module push)
//
// Every module is stored in kernel.app_code_modules (migration 0299) by the
// org and a source key: the sha256 of the module's text (the script and the
// runtime), so the same code is built once per release and per org, and a new
// release builds anew. Sites build when the code is saved or installed (a
// transform's save, a template's install) and look up on every run that goes to
// a remote executor (a process cache in front of the table); nothing is built
// for a run that stays on QuickJS.
//
// The script itself never reaches a bundler or Bun's transpiler: Bun runs a
// macro import (`with { type: "macro" }`) while it parses, in this process, and
// no plugin hook sees it first. So the script is read only by the TypeScript
// parser (sandbox/import-attributes.ts plainScriptIssue: no import, export,
// `import(...)` or `import.meta`), then joined to the runtime as text. Bun builds
// only the runtime and the export wrappers, all of them platform code. Each
// wrapper looks its function up when called: a top-level function of the script
// (a transform's `transform`), else a property the script set on globalThis (a
// template's `renderTemplate`). The module is an ES module, so the script runs
// in strict mode, as on the loader.

import { createHash } from "node:crypto"
import { and, eq, isNull, lt, or, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { type AppCodeModuleOrigin, appCodeModules } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { buildWorkerModule } from "~/modules/app-builder/build/freeze-core"
import { plainScriptIssue, topLevelStatementCount } from "~/modules/apps/sandbox/import-attributes"
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
const runtimes = new Map<string, Promise<string>>()
/** sha of origin|exports|script -> source key, so a run's lookup does not re-read the script. */
const sourceKeys = new Map<string, string>()
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

/** The binding the script's slot defines and the export wrappers call. */
const SCRIPT_LOOKUP = "__liaison_adhoc_script"

function checkExports(exports: readonly string[]): void {
  for (const name of exports) {
    if (!EXPORT_NAME.test(name) || name.startsWith("__liaison_")) {
      throw new AdhocModuleError(`invalid export name ${JSON.stringify(name)}`)
    }
  }
}

/**
 * The handlers module the runtime is built with: platform code only, one
 * wrapper per export, each calling the lookup the script's slot defines.
 */
export function runtimeHandlersSource(exports: readonly string[]): string {
  checkExports(exports)
  const lines: string[] = []
  for (const name of exports) {
    const local = `__liaison_export_${name}`
    lines.push(
      `const ${local} = function (...args) {`,
      `  const fn = ${SCRIPT_LOOKUP}(${JSON.stringify(name)})`,
      `  if (typeof fn !== "function") throw new Error(${JSON.stringify(`${name} is not defined`)})`,
      "  return fn.apply(this, args)",
      "}",
      `export { ${local} as ${name} }`,
    )
  }
  return `${lines.join("\n")}\n`
}

/**
 * The script's slot: the script in a function scope of its own (its top-level
 * names never meet the runtime's), returning the lookup of its exports.
 */
export function scriptSlotSource(script: string, exports: readonly string[]): string {
  checkExports(exports)
  const cases = exports.map(
    (name) =>
      `    case ${JSON.stringify(name)}: return typeof ${name} === "function" ? ${name} : globalThis[${JSON.stringify(name)}]`,
  )
  return [
    `const ${SCRIPT_LOOKUP} = (function () {`,
    script,
    ";",
    "  return function (name) {",
    "    switch (name) {",
    ...cases,
    "    }",
    "    return undefined",
    "  }",
    "})();",
    "",
  ].join("\n")
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
      // The wrappers import nothing.
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

/** The runtime with the wrappers of `exports` (sorted), built once per process. */
function runtimeModule(exports: readonly string[]): Promise<string> {
  const key = exports.join(",")
  let p = runtimes.get(key)
  if (!p) {
    p = buildFromHandlers(runtimeHandlersSource(exports))
    runtimes.set(key, p)
    p.catch(() => runtimes.delete(key))
  }
  return p
}

/**
 * The Worker module of a plain script, as text: the script's slot, then the
 * runtime. The script is read by the TypeScript parser only, never by Bun.
 */
export async function scriptModuleText(
  script: string,
  exports: readonly string[],
): Promise<string> {
  const issue = await plainScriptIssue(script)
  if (issue) throw new AdhocModuleError(`the code does not build as a Worker module: ${issue}`)
  const slot = scriptSlotSource(script, exports)
  // The script stays inside its function scope: text that closes it is refused.
  if ((await topLevelStatementCount(slot)) !== 1) {
    throw new AdhocModuleError(
      "the code does not build as a Worker module: it does not stay inside its own scope",
    )
  }
  let runtime: string
  try {
    runtime = await runtimeModule(exports)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new AdhocModuleError(`the Worker runtime does not build: ${detail}`)
  }
  return `${slot}\n${runtime}`
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
  // The source key of a script seen before in this process (the runtime does
  // not change within one), so a run's lookup does not read the script again.
  const inputKey = sha256Hex(`${input.origin}\0${exports.join(",")}\0${input.script}`)
  const moduleText = async (): Promise<string> => {
    try {
      return await scriptModuleText(input.script, exports)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      log.warn(
        { origin: input.origin, orgId: input.orgId, err: detail },
        "Worker module build failed",
      )
      throw err instanceof AdhocModuleError ? err : new AdhocModuleError(detail)
    }
  }
  let sourceKey = sourceKeys.get(inputKey)
  let text: string | null = null
  if (!sourceKey) {
    text = await moduleText()
    sourceKey = sha256Hex(`${input.origin}\0${text}`)
    sourceKeys.set(inputKey, sourceKey)
    if (sourceKeys.size > CACHE_MAX) {
      const oldest = sourceKeys.keys().next().value
      if (oldest !== undefined) sourceKeys.delete(oldest)
    }
  }
  const key = sourceKey
  return ensure(
    input.orgId,
    key,
    async (use) =>
      store(use, {
        orgId: input.orgId,
        origin: input.origin,
        sourceKey: key,
        bytes: new TextEncoder().encode(text ?? (await moduleText())),
      }),
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
    sourceKeys.clear()
  },
}
