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
//    collections: wiped at the draft's next preview and a day after its last
//    write (installed.ts pruneDraftStoreNamespaces);
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
//    (a draft's name is its custom app name: sandboxTenantKey), and never goes
//    to the Workers executor (no installed identity);
//  - its ctx.logger lines go to kernel.app_logs under the draft, readable by
//    this person only (logs.ts), and come back with the result.
// Whoever puts the result or the lines in an agent's context marks the turn as
// having read outside text (the preview tool is a taint source).

import { randomUUID } from "node:crypto"
import { type ActorContext, createRlsSession, type UserContext, withRlsContext } from "~/db/rls"
import { captureSpawnParentFrame } from "~/modules/agent/runtime/run-context"
import { projectTaintScopes } from "~/modules/agent/scopes/taint-read-scopes"
import { capturedFrameWriteScopes } from "~/modules/agent/scopes/write-required-scopes"
import { buildDraftVersion } from "~/modules/app-builder/check"
import { type DraftCaller, DraftError, getBuildArtifact } from "~/modules/app-builder/drafts"
import type { ActiveCustomApp } from "~/modules/app-builder/installed"
import {
  attachRunLogSink,
  createRunLogSink,
  type RunLogLine,
  UNKNOWN_TAINT_TAGS,
} from "~/modules/app-builder/logs"
import { forWorkersRun, typedError } from "~/modules/apps/sandbox/bridge/secret-free"
import { createStoreMethods } from "~/modules/apps/sandbox/bridge/store"
import { esmExportsToGlobalThis } from "~/modules/apps/sandbox/bundle-loader"
import {
  type AppManifestForBridge,
  createSessionRpcBridge,
} from "~/modules/apps/sandbox/rpc-bridge"
import { runApp } from "~/modules/apps/sandbox/run-app"
import { draftStoreApp, wipeDraftStore } from "~/modules/data-store/service"
import { hasScope } from "~/modules/permissions/permissions"

/** A preview run lasts this long at most. */
export const PREVIEW_TIMEOUT_MS = 30_000

export type PreviewEntryKind = "tool" | "job" | "webhook"

export interface PreviewInput {
  draftId: string
  /** The version (default: the latest). */
  n?: number
  entry: { kind: PreviewEntryKind; name: string }
  params?: unknown
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
  /** Where this preview's ctx.store writes went (wiped at the next preview). */
  storeNamespace: string
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
  const granted = domainsOf(active?.manifest ?? null)
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
  const prepared = await withRlsContext(userCtx, async (tx) => {
    const built = await buildDraftVersion(tx, caller, {
      draftId: input.draftId,
      ...(input.n !== undefined ? { n: input.n } : {}),
    })
    if (!built.build.ok || !built.build.bundleSha256 || !built.manifest) {
      return { built, bundle: null }
    }
    const artifact = await getBuildArtifact(tx, {
      draftId: built.draft.id,
      sha256: built.build.bundleSha256,
    })
    return { built, bundle: artifact ? new TextDecoder().decode(artifact.bytes) : null }
  })
  const { built } = prepared
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
  if (!prepared.bundle || !built.manifest) {
    return {
      ...base,
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
  // The previous preview's documents go first (its own committed transaction:
  // the run's writes take the same usage rows).
  await session.run((tx) => wipeDraftStore(tx, actor.orgId, built.draft.id))

  const runId = randomUUID()
  const frame = captureSpawnParentFrame({ includeCallingTool: true })
  const sink = createRunLogSink({
    orgId: actor.orgId,
    app: built.target.appName,
    draftId: built.draft.id,
    runId,
    actorUserId: actor.userId,
    scopeTags:
      frame === null
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
      trusted: false,
      appName: built.target.appName,
      orgId: actor.orgId,
      // Not installed: never the Workers executor, never an installed bundle.
      installed: null,
      bundleSource: esmExportsToGlobalThis(prepared.bundle),
      exportName,
      params: input.params ?? {},
      ...(input.entry.kind === "webhook" ? { extraArgs: [{}] } : {}),
      bridge,
      timeoutMs: PREVIEW_TIMEOUT_MS,
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
