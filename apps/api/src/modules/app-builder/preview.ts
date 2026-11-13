// SPDX-License-Identifier: FSL-1.1-ALv2
//
// previewDraft: run one entry point (a tool, a job or a webhook handler) of a
// draft version, without installing it, as the person who asked, and return
// its result with the log lines it wrote.
//
// The code is agent-written and nobody approved it, so the run gets less than
// the app ever would, never more:
//
//  - read-only: every write through the bridge is refused (READ_ONLY_REFUSED,
//    rpc-bridge.ts), on the org's data and through a nested tool call alike;
//  - ctx.store reads and writes go to the draft's own namespace in the data
//    store, `draft:<draftId>` (data-store/service.ts), never to an app's
//    collections. It is kept across previews of the same version (a write in
//    one is read in the next) and emptied when a preview runs another version,
//    when one asks for `freshStore`, when the draft is discarded, and a day
//    after its last write (installed.ts pruneDraftStoreNamespaces). One preview
//    of a draft runs at a time (`preview_busy`, drafts.ts claimDraftPreview);
//  - ctx.db answers `preview_no_schema` while the draft was never published
//    (no app_<name> schema exists); once published, reads run on the app's
//    schema (writes stay refused);
//  - ctx.fetch reaches only the domains the ACTIVE published version was
//    granted (none before the first publish), whatever the draft declares; no
//    `auth`, no `configSecrets`; every secret-returning or secret-using call
//    (connection tokens and credentials, config_get, the *ForConfig signers,
//    imap/smtp/mcp) is refused;
//  - capabilities and cross-app calls: only those the active version was
//    granted (none before the first publish);
//  - scopes: the person's own, narrowed to the scopes the draft manifest
//    declares (the bridge and the database session alike);
//  - the entry point is looked up in the draft manifest in memory; the run
//    lasts 30 s at most, counts against the org's share of the sandbox pool
//    (a draft's name is its custom app name: sandboxTenantKey), and runs where
//    an installed app would (the app loader or the sandbox service, on the
//    worker.js the draft's build made, workers/adhoc-module.ts; else QuickJS),
//    with the preview's limits;
//  - its ctx.logger lines go to kernel.app_logs under the draft, readable by
//    this person only (logs.ts), and come back with the result.
// Whoever puts the result or the lines in an agent's context marks the turn as
// having read outside text (the preview tool is a taint source).

import { randomUUID } from "node:crypto"
import { type ActorContext, createRlsSession, type UserContext } from "~/db/rls"
import { captureSpawnParentFrame } from "~/modules/agent/runtime/run-context"
import { projectTaintScopes } from "~/modules/agent/scopes/taint-read-scopes"
import { capturedFrameWriteScopes } from "~/modules/agent/scopes/write-required-scopes"
import { buildDraftVersion } from "~/modules/app-builder/check"
import {
  claimDraftPreview,
  type DraftCaller,
  DraftError,
  getBuildArtifact,
  releaseDraftPreview,
} from "~/modules/app-builder/drafts"
import type { ActiveCustomApp } from "~/modules/app-builder/installed"
import {
  attachRunLogSink,
  createRunLogSink,
  type RunLogLine,
  UNKNOWN_TAINT_TAGS,
} from "~/modules/app-builder/logs"
import { runLimits } from "~/modules/apps/run-limits"
import { forWorkersRun, typedError } from "~/modules/apps/sandbox/bridge/secret-free"
import { createStoreMethods } from "~/modules/apps/sandbox/bridge/store"
import { esmExportsToGlobalThis } from "~/modules/apps/sandbox/bundle-loader"
import {
  type AppManifestForBridge,
  createSessionRpcBridge,
} from "~/modules/apps/sandbox/rpc-bridge"
import { type RunAppOptions, runApp } from "~/modules/apps/sandbox/run-app"
import { ensureBuiltModule } from "~/modules/apps/workers/adhoc-module"
import { draftStoreApp } from "~/modules/data-store/service"
import { hasScope } from "~/modules/permissions/permissions"

export type PreviewEntryKind = "tool" | "job" | "webhook"

export interface PreviewInput {
  draftId: string
  /** The version (default: the latest). */
  n?: number
  entry: { kind: PreviewEntryKind; name: string }
  params?: unknown
  /** Empty the draft's store namespace first, even for the same version. */
  freshStore?: boolean
}

export interface PreviewResult {
  draftId: string
  n: number
  entry: { kind: PreviewEntryKind; name: string }
  ok: boolean
  result?: unknown
  error?: { code: string; message: string; status?: number }
  logs: RunLogLine[]
  logsDropped: number
  runId: string
  durationMs: number
  /** Where this preview's ctx.store writes went (kept for the next preview of the same version). */
  storeNamespace: string
  /** The namespace was emptied before this run (another version, or freshStore). */
  storeWiped: boolean
  /** The draft was never published: ctx.db has no schema, ctx.fetch no domain. */
  neverPublished: boolean
}

/** Who previews: the person (their own scopes), in their org. */
export interface PreviewActor {
  orgId: string
  userId: string
  scopes: readonly string[]
  dimensionGrants?: Record<string, string[]>
  threadId?: string
}

const STORE_METHODS = [
  "store_get",
  "store_set",
  "store_update",
  "store_delete",
  "store_query",
  "store_count",
] as const

/** Bridge methods a preview never gets (secrets, mail and MCP accounts), on top of read-only. */
const PREVIEW_REFUSED = (name: string): boolean =>
  /ForConfig$/.test(name) ||
  /^(imap|smtp|mcp)_/.test(name) ||
  name === "connections_getToken" ||
  name === "connections_getCredentials" ||
  name === "connections_disconnect"

function refusal(code: string, message: string, status = 403): Error {
  return typedError(status, code, message)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The export a draft manifest names for an entry point, or a typed refusal. */
export function resolvePreviewEntry(
  manifest: Record<string, unknown>,
  entry: { kind: PreviewEntryKind; name: string },
): string {
  const section = entry.kind === "tool" ? "tools" : entry.kind === "job" ? "jobs" : "webhooks"
  const decl = record(record(manifest[section])[entry.name])
  const handler = decl.handler
  if (typeof handler !== "string" || handler === "") {
    const names = Object.keys(record(manifest[section]))
    throw new DraftError(
      "invalid_files",
      `the draft manifest declares no ${entry.kind} '${entry.name}'${names.length ? ` (its ${section}: ${names.join(", ")})` : ""}`,
    )
  }
  return handler
}

function domainsOf(manifest: Record<string, unknown> | null): Set<string> {
  const out = new Set<string>()
  if (!manifest) return out
  for (const d of (record(manifest.network).allowedDomains as unknown[] | undefined) ?? []) {
    if (typeof d === "string") out.add(d.toLowerCase())
  }
  for (const conn of Object.values(record(manifest.connections))) {
    for (const d of (record(conn).allowedDomains as unknown[] | undefined) ?? []) {
      if (typeof d === "string") out.add(d.toLowerCase())
    }
  }
  return out
}

/**
 * The manifest the preview's bridge is built on: the draft's, with its egress,
 * connections, capabilities and cross-app calls cut down to what the active
 * version was granted.
 */
export function previewManifest(
  draft: Record<string, unknown>,
  active: ActiveCustomApp | null,
): Record<string, unknown> & { allowedCrossAppCalls: string[] } {
  // What the active version was granted (egress-grants.ts), not merely declared.
  const granted = new Set((active?.grantedDomains ?? []).map((d) => d.toLowerCase()))
  const declared = [...domainsOf({ network: draft.network })]
  const allowedDomains = declared.filter((d) => granted.has(d))
  const grantedCaps = new Set(active?.grantedCapabilities ?? [])
  const capabilities = ((draft.capabilities as unknown[] | undefined) ?? []).filter(
    (c): c is string => typeof c === "string" && grantedCaps.has(c),
  )
  const grantedCalls = new Set(active?.grantedCrossAppCalls ?? [])
  const crossAppCalls = ((draft.cross_app_calls as unknown[] | undefined) ?? []).filter(
    (c) => typeof record(c).target === "string" && grantedCalls.has(record(c).target as string),
  )
  return {
    ...draft,
    network: { allowedDomains },
    connections: {},
    capabilities,
    cross_app_calls: crossAppCalls,
    allowedCrossAppCalls: crossAppCalls.map((c) => record(c).target as string),
  }
}

/** The scopes a draft declares: its `scopes` and every tool's `requiredScopes`. */
function declaredScopes(manifest: Record<string, unknown>): string[] {
  const out = new Set<string>()
  for (const s of (manifest.scopes as unknown[] | undefined) ?? []) {
    if (typeof s === "string") out.add(s)
  }
  for (const tool of Object.values(record(manifest.tools))) {
    for (const s of (record(tool).requiredScopes as unknown[] | undefined) ?? []) {
      if (typeof s === "string") out.add(s)
    }
  }
  return [...out]
}

function fetchOptions(optsJson: unknown): Record<string, unknown> {
  if (typeof optsJson === "string" && optsJson !== "") {
    try {
      return record(JSON.parse(optsJson))
    } catch {
      return {}
    }
  }
  return record(optsJson)
}

/** The session bridge of a preview run, narrowed as the file header says. */
function previewBridge(input: {
  appName: string
  draftId: string
  actor: PreviewActor
  session: ReturnType<typeof createRlsSession>
  manifest: ReturnType<typeof previewManifest>
  callerScopes: string[]
  neverPublished: boolean
  sink: ReturnType<typeof createRunLogSink>
}): Record<string, any> {
  const { appName, draftId, actor, session, manifest, callerScopes } = input
  const bridge = createSessionRpcBridge(
    appName,
    actor.userId,
    actor.orgId,
    session,
    manifest as unknown as AppManifestForBridge,
    callerScopes,
    undefined,
    undefined,
    {
      origin: "in-app-agent",
      readOnlyRunOverride: true,
      callChain: [],
      ...(actor.threadId ? { threadId: actor.threadId } : {}),
    },
  )

  // No secret, no config: every config_get refused (no key can be shown not to be one).
  forWorkersRun(bridge, { secretConfigKeys: null, reason: "custom_app" })
  for (const name of Object.keys(bridge)) {
    if (typeof bridge[name] !== "function") continue
    if (PREVIEW_REFUSED(name)) {
      bridge[name] = async () => {
        throw refusal("preview_refused", `ctx.${name} is not available in a draft preview`)
      }
    } else if (input.neverPublished && name.startsWith("db_")) {
      bridge[name] = async () => {
        throw refusal(
          "preview_no_schema",
          "this draft was never published, so its app has no tables yet: ctx.db works after the first publish (use ctx.store in a preview)",
          409,
        )
      }
    }
  }

  // ctx.fetch: the narrowed manifest decides the hosts; no credential and no secret.
  const fetchImpl = bridge.fetch
  if (typeof fetchImpl === "function") {
    bridge.fetch = async (url: string, optsJson: unknown) => {
      const opts = fetchOptions(optsJson)
      if (opts.auth !== undefined || opts.configSecrets !== undefined) {
        throw refusal(
          "preview_refused",
          "ctx.fetch with auth or configSecrets is not available in a draft preview",
        )
      }
      return fetchImpl(url, optsJson)
    }
    // `send` is a plain (non-async) alias of fetch: keep its kind, route it here.
    bridge.send = (url: string, optsJson: unknown) => bridge.fetch(url, optsJson)
  }

  // Cross-app calls: only the targets the active version was granted.
  const allowedCalls = new Set(manifest.allowedCrossAppCalls)
  const executeTool = bridge.executeTool
  if (typeof executeTool === "function") {
    bridge.executeTool = async (target: string, paramsJson: string) => {
      if (!allowedCalls.has(String(target))) {
        throw refusal(
          "preview_refused",
          `ctx.executeTool('${String(target)}') is not available in this preview: only the cross-app calls the published app was granted are`,
        )
      }
      return executeTool(target, paramsJson)
    }
  }

  // ctx.store: the draft's own namespace, writes allowed (the run is otherwise read-only).
  const storeApp = draftStoreApp(draftId)
  for (const name of STORE_METHODS) {
    bridge[name] = async (...args: unknown[]) =>
      session.run((tx) => {
        const methods = createStoreMethods({
          appName: storeApp,
          orgId: actor.orgId,
          userId: actor.userId,
          actorType: "user",
          txDb: tx,
        }) as unknown as Record<string, (...a: unknown[]) => Promise<string>>
        return methods[name]!(...args)
      })
  }

  // ctx.logger: this preview's own sink (kept lines come back with the result).
  for (const level of ["info", "warn", "error", "debug"] as const) {
    bridge[`log_${level}`] = (msg: string, dataJson?: string) => {
      input.sink.append(level, msg, dataJson)
    }
  }
  attachRunLogSink(bridge, input.sink)
  return bridge
}

function errorOf(err: unknown): { code: string; message: string; status?: number } {
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null
  const code = typeof e?.code === "string" ? e.code : "handler_error"
  const message = typeof e?.message === "string" ? e.message : String(err)
  return {
    code,
    message: message.slice(0, 2000),
    ...(typeof e?.status === "number" ? { status: e.status } : {}),
  }
}

/** Runs one entry point of a draft version (see the file header). */
export async function previewDraft(
  actor: PreviewActor,
  input: PreviewInput,
): Promise<PreviewResult> {
  const caller: DraftCaller = { orgId: actor.orgId, userId: actor.userId }
  const userCtx: UserContext = {
    actorType: "user",
    userId: actor.userId,
    orgId: actor.orgId,
    scopes: [...actor.scopes],
    dimensionGrants: actor.dimensionGrants ?? {},
  }
  // Short transactions only: the version is read, built (in none) and its
  // bundle read; the run itself holds no connection (the bridge takes one per
  // call).
  const db = createRlsSession(userCtx)
  const built = await buildDraftVersion(db, caller, {
    draftId: input.draftId,
    ...(input.n !== undefined ? { n: input.n } : {}),
  })
  const bundleSha = built.build.ok && built.manifest ? built.build.bundleSha256 : undefined
  const bundle = bundleSha
    ? await db.run(async (tx) => {
        const artifact = await getBuildArtifact(tx, { draftId: built.draft.id, sha256: bundleSha })
        return artifact ? new TextDecoder().decode(artifact.bytes) : null
      })
    : null
  const n = built.version.n
  const storeNamespace = draftStoreApp(built.draft.id)
  const neverPublished = built.target.active === null
  const base = {
    draftId: built.draft.id,
    n,
    entry: input.entry,
    storeNamespace,
    neverPublished,
  }
  if (!bundle || !built.manifest) {
    return {
      ...base,
      storeWiped: false,
      ok: false,
      error: {
        code: "build_failed",
        message: `version ${n} does not build: ${(built.build.errors ?? [])
          .slice(0, 5)
          .map((e) => `${e.file ?? ""}${e.line ? `:${e.line}` : ""} ${e.message}`)
          .join("; ")}`,
      },
      logs: [],
      logsDropped: 0,
      runId: randomUUID(),
      durationMs: 0,
    }
  }
  const exportName = resolvePreviewEntry(built.manifest, input.entry)
  const manifest = previewManifest(built.manifest, built.target.active)
  const callerScopes = declaredScopes(built.manifest).filter((s) => hasScope(s, [...actor.scopes]))
  const sessionCtx: ActorContext = { ...userCtx, scopes: callerScopes }
  const session = createRlsSession(sessionCtx)
  // The draft's preview lease (one at a time), and its namespace emptied when
  // this version is not the one that last wrote it (its own committed
  // transaction: the run's writes take the same usage rows).
  const { wiped } = await db.run((tx) =>
    claimDraftPreview(tx, caller, {
      draftId: built.draft.id,
      n,
      freshStore: input.freshStore === true,
    }),
  )
  try {
    return await runPreview({
      actor,
      input,
      built,
      bundle,
      exportName,
      manifest,
      callerScopes,
      session,
      neverPublished,
      base: { ...base, storeWiped: wiped },
      workerModule: async () => {
        const workerSha = built.build.ok ? built.build.workerSha256 : undefined
        if (!workerSha) return null
        const sha256 = await ensureBuiltModule({
          origin: "draft",
          orgId: actor.orgId,
          sha256: workerSha,
          bytes: () =>
            db.run(
              async (tx) =>
                (await getBuildArtifact(tx, { draftId: built.draft.id, sha256: workerSha }))
                  ?.bytes ?? null,
            ),
        })
        return sha256 ? { sha256, version: `draft-${n}` } : null
      },
    })
  } finally {
    await db.run((tx) => releaseDraftPreview(tx, built.draft.id)).catch(() => undefined)
  }
}

async function runPreview(args: {
  actor: PreviewActor
  input: PreviewInput
  built: Awaited<ReturnType<typeof buildDraftVersion>>
  bundle: string
  exportName: string
  manifest: ReturnType<typeof previewManifest>
  callerScopes: string[]
  session: ReturnType<typeof createRlsSession>
  neverPublished: boolean
  /** The version's Worker module (its build's worker.js), for a remote executor. */
  workerModule: NonNullable<RunAppOptions["workerModule"]>
  base: Pick<
    PreviewResult,
    "draftId" | "n" | "entry" | "storeNamespace" | "neverPublished" | "storeWiped"
  >
}): Promise<PreviewResult> {
  const { actor, input, built, exportName, manifest, callerScopes, session, neverPublished, base } =
    args
  const runId = randomUUID()
  const frame = captureSpawnParentFrame({ includeCallingTool: true })
  const sink = createRunLogSink({
    orgId: actor.orgId,
    app: built.target.appName,
    draftId: built.draft.id,
    runId,
    actorUserId: actor.userId,
    scopeTags:
      // A person's own external client tags as no frame did (scope-taint.ts, rule 14f).
      frame === null || frame.personClient === true
        ? projectTaintScopes(callerScopes)
        : (capturedFrameWriteScopes(frame, callerScopes) ?? UNKNOWN_TAINT_TAGS),
  })
  const bridge = previewBridge({
    appName: built.target.appName,
    draftId: built.draft.id,
    actor,
    session,
    manifest,
    callerScopes,
    neverPublished,
    sink,
  })
  const started = Date.now()
  let outcome: Pick<PreviewResult, "ok" | "result" | "error">
  try {
    const result = await runApp({
      appName: built.target.appName,
      orgId: actor.orgId,
      // Not installed: the version's own worker.js on a remote executor, never
      // an installed bundle.
      installed: null,
      workerModule: args.workerModule,
      bundleSource: esmExportsToGlobalThis(args.bundle),
      exportName,
      params: input.params ?? {},
      ...(input.entry.kind === "webhook" ? { extraArgs: [{}] } : {}),
      bridge,
      timeoutMs: runLimits("preview").wallMs,
      holdsTx: false,
      priority: "interactive",
      // The org's share of the pool: a draft runs under its custom app name.
      appId: built.target.appName,
      ...(input.entry.kind === "tool" ? { toolName: input.entry.name } : {}),
      entry: `preview:${input.entry.kind}:${input.entry.name}`,
    })
    const err = record(result).error
    outcome =
      err && typeof err === "object"
        ? { ok: false, result, error: errorOf(err) }
        : { ok: true, result }
  } catch (err) {
    outcome = { ok: false, error: errorOf(err) }
  }
  await sink.flush()
  return {
    ...base,
    ...outcome,
    logs: [...sink.lines()],
    logsDropped: sink.dropped(),
    runId,
    durationMs: Date.now() - started,
  }
}

/** Test seam: the preview bridge alone, to probe each refusal without a sandbox run. */
export const PreviewTestAccess = { previewBridge }
