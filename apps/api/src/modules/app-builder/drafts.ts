// SPDX-License-Identifier: FSL-1.1-ALv2
//
// App builder drafts (kernel.app_drafts, app_draft_versions,
// app_build_artifacts; migration 0276): an org's app in the making, its
// versions of files and the bytes each build produced.
//
//  - Every function runs in the CALLER's RLS transaction (`tx`, short: see
//    TxRunner): the database
//    keeps orgs apart and lets only holders of kernel:apps:build write (FORCE
//    RLS). The caller's org and user are taken from `caller`, never from a
//    parameter.
//  - Identity: `base_name` (`^[a-z][a-z0-9-]{1,40}$`, not a Liaison page
//    segment, not the name of an app this server provides) makes the custom
//    app name `<base>-o<orgKey>` (custom-app-name.ts). One live draft per base
//    and org; a base whose app a draft has published stays that draft's (even
//    discarded). `published_app_name` is set once, at the first publish, and
//    never changes after (service check, trigger backstop).
//  - Versions: every change of files is a new version (n = the draft's
//    `latest_version` + 1, never reused); the last 20 are kept, and the build
//    artifacts no kept version names go with the pruned ones. Files: only
//    app.manifest.json, handlers.ts, ui.tsx, README.md, at most 512 KiB.

import { createHash } from "node:crypto"
import { isReservedWebRouteSegment } from "@liaison/shared"
import { and, desc, eq, lte, ne, sql } from "drizzle-orm"
import type { RlsClient } from "~/db"
import { withReleasedSavepoint } from "~/db/savepoint"
import {
  type AppBuildArtifactKind,
  type AppDraftBuild,
  type AppDraftRow,
  appBuildArtifacts,
  appDrafts,
  appDraftVersions,
} from "~/db/schema/kernel"
import { isUniqueViolationOn } from "~/lib/unique-violation"
import {
  BUILD_OUTPUT_CAP_BYTES,
  DRAFT_FILE_NAMES,
  DRAFT_MAX_TOTAL_BYTES,
  type DraftFiles,
} from "~/modules/app-builder/build/build-draft"
import { expectedCustomAppName } from "~/modules/apps/app-org-scope"
import { listCatalog } from "~/modules/apps/catalog"
import { discoverInTreeApps } from "~/modules/apps/discover-apps"
import { wipeDraftStore } from "~/modules/data-store/service"

/** Versions kept per draft. */
export const DRAFT_VERSIONS_KEPT = 20
export const DRAFT_BASE_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/
export const DRAFT_TITLE_MAX = 200
export const DRAFT_MESSAGE_MAX = 500

export type DraftErrorCode =
  | "not_found"
  | "invalid_base_name"
  | "base_name_reserved"
  | "base_name_taken"
  | "invalid_title"
  | "invalid_files"
  | "files_too_large"
  | "version_not_found"
  | "draft_discarded"
  | "published_name_immutable"
  | "invalid_build"
  | "build_failed"
  | "app_owned_by_other_draft"
  | "app_not_built_by_builder"
  | "publish_stale"
  | "pin_mismatch"
  | "preview_busy"
  | "custom_apps_off"

/** A refused draft call; `code` is stable for callers (tools, routes). */
export class DraftError extends Error {
  readonly code: DraftErrorCode
  readonly details?: Record<string, unknown>
  constructor(code: DraftErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = "DraftError"
    this.code = code
    this.details = details
  }
}

/**
 * Runs `fn` in a transaction: an RlsSession (`createRlsSession`, a short
 * transaction per call) or a live transaction (`inTx`). The builds and the
 * install run between such calls, never inside one (no connection is held
 * idle in a transaction across a 30 s build or the install's health gate).
 */
export interface TxRunner {
  run<T>(fn: (tx: RlsClient) => Promise<T>): Promise<T>
}

/** A live transaction as a TxRunner (every call joins it). */
export function inTx(tx: RlsClient): TxRunner {
  return { run: (fn) => fn(tx) }
}

/** Who acts: the authenticated org and person, never a parameter. */
export interface DraftCaller {
  orgId: string
  userId: string | null
  /** The calling agent turn's taint (what it had read); none for a person's own edit. */
  taintScopes?: readonly string[]
}

export interface DraftVersion {
  draftId: string
  n: number
  files: DraftFiles
  message: string | null
  build: AppDraftBuild | null
  /** The data scopes this version's writers had read, carried forward from earlier versions. */
  taintScopes: string[]
  createdBy: string | null
  createdAt: Date
}

export interface DraftVersionSummary {
  n: number
  message: string | null
  build: AppDraftBuild | null
  sizeBytes: number
  createdBy: string | null
  createdAt: Date
}

export interface DraftWithVersion {
  draft: AppDraftRow
  version: DraftVersion
}

/** The custom app name a draft of `baseName` publishes as in `orgId`. */
export function draftAppName(orgId: string, baseName: string): string {
  return expectedCustomAppName(baseName, orgId)
}

/** Total bytes of a draft's files (UTF-8). */
export function draftFilesBytes(files: Record<string, string>): number {
  let total = 0
  for (const value of Object.values(files)) total += Buffer.byteLength(value)
  return total
}

/** Refuses anything but the known files as text, the two required ones, at most 512 KiB. */
export function checkDraftFiles(files: unknown): DraftFiles {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new DraftError("invalid_files", "files must be an object of file name to text")
  }
  const rec = files as Record<string, unknown>
  for (const [name, value] of Object.entries(rec)) {
    if (!(DRAFT_FILE_NAMES as readonly string[]).includes(name)) {
      throw new DraftError("invalid_files", `a draft has only ${DRAFT_FILE_NAMES.join(", ")}`, {
        file: name,
      })
    }
    if (typeof value !== "string") {
      throw new DraftError("invalid_files", `${name} must be text`, { file: name })
    }
  }
  for (const required of ["app.manifest.json", "handlers.ts"]) {
    if (typeof rec[required] !== "string") {
      throw new DraftError("invalid_files", `${required} is required`, { file: required })
    }
  }
  const total = draftFilesBytes(rec as Record<string, string>)
  if (total > DRAFT_MAX_TOTAL_BYTES) {
    throw new DraftError(
      "files_too_large",
      `the draft is ${total} bytes, over the ${DRAFT_MAX_TOTAL_BYTES}-byte limit`,
      { bytes: total, limit: DRAFT_MAX_TOTAL_BYTES },
    )
  }
  return rec as DraftFiles
}

function checkTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim() === "" || title.length > DRAFT_TITLE_MAX) {
    throw new DraftError("invalid_title", `title must be 1 to ${DRAFT_TITLE_MAX} characters`)
  }
  return title.trim()
}

function checkMessage(message: unknown): string | null {
  if (message === undefined || message === null) return null
  if (typeof message !== "string") throw new DraftError("invalid_files", "message must be text")
  return message.slice(0, DRAFT_MESSAGE_MAX)
}

/** The names a base may not take: Liaison page segments and the apps this server provides. */
export async function assertDraftBaseName(baseName: unknown): Promise<string> {
  if (typeof baseName !== "string" || !DRAFT_BASE_NAME_RE.test(baseName)) {
    throw new DraftError(
      "invalid_base_name",
      "base_name is 2 to 41 characters: a lowercase letter, then lowercase letters, digits or '-'",
    )
  }
  if (isReservedWebRouteSegment(baseName)) {
    throw new DraftError("base_name_reserved", `'${baseName}' is the name of a Liaison page`)
  }
  const provided = new Set<string>([
    ...(await discoverInTreeApps()).map((a) => a.name),
    ...listCatalog().map((e) => e.name),
  ])
  if (provided.has(baseName)) {
    throw new DraftError(
      "base_name_reserved",
      `'${baseName}' is the name of an app this server provides`,
    )
  }
  return baseName
}

function toVersion(row: typeof appDraftVersions.$inferSelect): DraftVersion {
  return {
    draftId: row.draftId,
    n: row.n,
    files: row.files as DraftFiles,
    message: row.message,
    build: row.build ?? null,
    taintScopes: row.taintScopes ?? [],
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }
}

/** One sorted set of taint scopes. */
function taintUnion(...sets: ReadonlyArray<readonly string[] | undefined>): string[] {
  return [...new Set(sets.flatMap((s) => s ?? []))].sort()
}

async function lockDraft(tx: RlsClient, draftId: string): Promise<AppDraftRow> {
  const [draft] = await tx.select().from(appDrafts).where(eq(appDrafts.id, draftId)).for("update")
  if (!draft) throw new DraftError("not_found", "no such draft", { draftId })
  return draft
}

async function readDraft(tx: RlsClient, draftId: string): Promise<AppDraftRow> {
  const [draft] = await tx.select().from(appDrafts).where(eq(appDrafts.id, draftId))
  if (!draft) throw new DraftError("not_found", "no such draft", { draftId })
  return draft
}

/** Drop versions older than the last 20, and the artifacts no kept version names. */
async function pruneDraft(tx: RlsClient, draftId: string, latest: number): Promise<void> {
  const floor = latest - DRAFT_VERSIONS_KEPT
  if (floor >= 1) {
    await tx
      .delete(appDraftVersions)
      .where(and(eq(appDraftVersions.draftId, draftId), lte(appDraftVersions.n, floor)))
  }
  await pruneArtifacts(tx, draftId)
}

async function pruneArtifacts(tx: RlsClient, draftId: string): Promise<void> {
  await tx.execute(sql`
    DELETE FROM ${appBuildArtifacts} a
    WHERE a.draft_id = ${draftId}
      AND NOT EXISTS (
        SELECT 1 FROM ${appDraftVersions} v
        WHERE v.draft_id = a.draft_id
          AND v.build IS NOT NULL
          AND a.sha256 IN (
            v.build->>'packageSha256', v.build->>'bundleSha256',
            v.build->>'uiSha256', v.build->>'workerSha256'
          )
      )
  `)
}

async function insertVersion(
  tx: RlsClient,
  caller: DraftCaller,
  draftId: string,
  n: number,
  files: DraftFiles,
  message: string | null,
  taintScopes: string[],
): Promise<DraftVersion> {
  const [row] = await tx
    .insert(appDraftVersions)
    .values({
      orgId: caller.orgId,
      draftId,
      n,
      files,
      message,
      taintScopes,
      createdBy: caller.userId,
    })
    .returning()
  return toVersion(row!)
}

/** A new draft and its version 1. */
export async function createDraft(
  tx: RlsClient,
  caller: DraftCaller,
  input: { baseName: string; title: string; files: unknown; message?: string },
): Promise<DraftWithVersion> {
  const baseName = await assertDraftBaseName(input.baseName)
  const title = checkTitle(input.title)
  const files = checkDraftFiles(input.files)
  const appName = draftAppName(caller.orgId, baseName)
  // A base whose app a draft has published stays that draft's, discarded or not.
  const [owner] = await tx
    .select({ id: appDrafts.id })
    .from(appDrafts)
    .where(and(eq(appDrafts.orgId, caller.orgId), eq(appDrafts.publishedAppName, appName)))
    .limit(1)
  if (owner) {
    throw new DraftError("base_name_taken", `'${baseName}' is the app of another draft`, {
      draftId: owner.id,
    })
  }
  let draft: AppDraftRow
  try {
    draft = await withReleasedSavepoint(tx, async (sp) => {
      const [row] = await sp
        .insert(appDrafts)
        .values({
          orgId: caller.orgId,
          baseName,
          title,
          createdBy: caller.userId,
          updatedBy: caller.userId,
        })
        .returning()
      return row!
    })
  } catch (err) {
    if (isUniqueViolationOn(err, ["app_drafts_live_base_name_idx"])) {
      throw new DraftError("base_name_taken", `a draft named '${baseName}' already exists`)
    }
    throw err
  }
  const version = await insertVersion(
    tx,
    caller,
    draft.id,
    1,
    files,
    checkMessage(input.message),
    taintUnion(caller.taintScopes),
  )
  return { draft, version }
}

/** A draft and one of its versions (the latest by default). */
export async function getDraft(
  tx: RlsClient,
  draftId: string,
  opts: { version?: number } = {},
): Promise<DraftWithVersion> {
  const draft = await readDraft(tx, draftId)
  const n = opts.version ?? draft.latestVersion
  const [row] = await tx
    .select()
    .from(appDraftVersions)
    .where(and(eq(appDraftVersions.draftId, draftId), eq(appDraftVersions.n, n)))
  if (!row) throw new DraftError("version_not_found", `no version ${n} of this draft`, { n })
  return { draft, version: toVersion(row) }
}

/** The org's drafts, newest change first (discarded ones only when asked). */
export async function listDrafts(
  tx: RlsClient,
  opts: { includeDiscarded?: boolean } = {},
): Promise<AppDraftRow[]> {
  return tx
    .select()
    .from(appDrafts)
    .where(opts.includeDiscarded ? undefined : ne(appDrafts.status, "discarded"))
    .orderBy(desc(appDrafts.updatedAt))
}

/** A draft's kept versions, newest first, without their files. */
export async function listDraftVersions(
  tx: RlsClient,
  draftId: string,
): Promise<DraftVersionSummary[]> {
  await readDraft(tx, draftId)
  const rows = await tx
    .select({
      n: appDraftVersions.n,
      message: appDraftVersions.message,
      build: appDraftVersions.build,
      sizeBytes: sql<number>`octet_length(${appDraftVersions.files}::text)`.mapWith(Number),
      createdBy: appDraftVersions.createdBy,
      createdAt: appDraftVersions.createdAt,
    })
    .from(appDraftVersions)
    .where(eq(appDraftVersions.draftId, draftId))
    .orderBy(desc(appDraftVersions.n))
  return rows.map((r) => ({ ...r, build: r.build ?? null }))
}

async function nextVersion(
  tx: RlsClient,
  caller: DraftCaller,
  draft: AppDraftRow,
  files: DraftFiles,
  message: string | null,
  title?: string,
  carriedTaint: readonly string[] = [],
): Promise<DraftVersion> {
  if (draft.status === "discarded") {
    throw new DraftError("draft_discarded", "this draft was discarded")
  }
  const n = draft.latestVersion + 1
  // A version is written from what came before it, so it carries the latest version's
  // taint (pruning old versions never drops what they held) plus this turn's.
  const [latest] = await tx
    .select({ taintScopes: appDraftVersions.taintScopes })
    .from(appDraftVersions)
    .where(and(eq(appDraftVersions.draftId, draft.id), eq(appDraftVersions.n, draft.latestVersion)))
  const taint = taintUnion(latest?.taintScopes, carriedTaint, caller.taintScopes)
  const version = await insertVersion(tx, caller, draft.id, n, files, message, taint)
  await tx
    .update(appDrafts)
    .set({
      latestVersion: n,
      updatedBy: caller.userId,
      updatedAt: new Date(),
      ...(title !== undefined ? { title } : {}),
    })
    .where(eq(appDrafts.id, draft.id))
  await pruneDraft(tx, draft.id, n)
  return version
}

/** New files: a new version (the last 20 are kept). */
export async function updateDraftFiles(
  tx: RlsClient,
  caller: DraftCaller,
  input: { draftId: string; files: unknown; message?: string; title?: string },
): Promise<DraftVersion> {
  const files = checkDraftFiles(input.files)
  const title = input.title === undefined ? undefined : checkTitle(input.title)
  const draft = await lockDraft(tx, input.draftId)
  return nextVersion(tx, caller, draft, files, checkMessage(input.message), title)
}

/** Version `n`'s files again, as a new version. */
export async function restoreDraftVersion(
  tx: RlsClient,
  caller: DraftCaller,
  input: { draftId: string; n: number },
): Promise<DraftVersion> {
  const draft = await lockDraft(tx, input.draftId)
  const [source] = await tx
    .select()
    .from(appDraftVersions)
    .where(and(eq(appDraftVersions.draftId, draft.id), eq(appDraftVersions.n, input.n)))
  if (!source) {
    throw new DraftError("version_not_found", `no version ${input.n} of this draft`, {
      n: input.n,
    })
  }
  return nextVersion(
    tx,
    caller,
    draft,
    source.files as DraftFiles,
    `Restored version ${input.n}`,
    undefined,
    source.taintScopes,
  )
}

/** The draft is discarded: its base is free again unless it published an app; its built bytes go. */
export async function discardDraft(
  tx: RlsClient,
  caller: DraftCaller,
  draftId: string,
): Promise<AppDraftRow> {
  const draft = await lockDraft(tx, draftId)
  if (draft.status === "discarded") return draft
  const [row] = await tx
    .update(appDrafts)
    .set({ status: "discarded", updatedBy: caller.userId, updatedAt: new Date() })
    .where(eq(appDrafts.id, draftId))
    .returning()
  await tx.delete(appBuildArtifacts).where(eq(appBuildArtifacts.draftId, draftId))
  // Its preview namespace goes with it.
  await wipeDraftStore(tx, caller.orgId, draftId)
  return row!
}

/** A preview holds its draft this long at most (the run's 30 s and some margin). */
export const PREVIEW_LEASE_MS = 60_000

/**
 * Takes the draft's preview lease (one preview of a draft at a time, on every
 * process: else `preview_busy`) and readies its store namespace: emptied when
 * version `n` is not the one that last wrote it, or on `freshStore`; kept
 * otherwise, so a write in one preview is read in the next one of the same
 * version. Returns whether it was emptied.
 */
export async function claimDraftPreview(
  tx: RlsClient,
  caller: DraftCaller,
  input: { draftId: string; n: number; freshStore: boolean; now?: Date },
): Promise<{ wiped: boolean }> {
  const now = input.now ?? new Date()
  const [claimed] = await tx
    .update(appDrafts)
    .set({ previewLeaseUntil: new Date(now.getTime() + PREVIEW_LEASE_MS) })
    .where(
      and(
        eq(appDrafts.id, input.draftId),
        sql`(${appDrafts.previewLeaseUntil} IS NULL OR ${appDrafts.previewLeaseUntil} < ${now.toISOString()}::timestamptz)`,
      ),
    )
    .returning({ previewStoreN: appDrafts.previewStoreN })
  if (!claimed) {
    await readDraft(tx, input.draftId)
    throw new DraftError(
      "preview_busy",
      "another preview of this draft is running: wait for it to end, then try again",
    )
  }
  const wiped = input.freshStore || claimed.previewStoreN !== input.n
  if (wiped) {
    await wipeDraftStore(tx, caller.orgId, input.draftId)
    await tx
      .update(appDrafts)
      .set({ previewStoreN: input.n })
      .where(eq(appDrafts.id, input.draftId))
  }
  return { wiped }
}

/** Gives the draft's preview lease back. */
export async function releaseDraftPreview(tx: RlsClient, draftId: string): Promise<void> {
  await tx.update(appDrafts).set({ previewLeaseUntil: null }).where(eq(appDrafts.id, draftId))
}

export interface BuildArtifactInput {
  kind: AppBuildArtifactKind
  bytes: Uint8Array
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * Records version `n`'s build outcome and stores its artifacts by sha256 (each
 * hashed here; a build naming a sha no artifact carries is refused).
 */
export async function recordVersionBuild(
  tx: RlsClient,
  caller: DraftCaller,
  input: {
    draftId: string
    n: number
    build: Omit<AppDraftBuild, "at"> & { at?: string }
    artifacts: BuildArtifactInput[]
  },
): Promise<AppDraftBuild> {
  const draft = await readDraft(tx, input.draftId)
  const stored = new Map<string, AppBuildArtifactKind>()
  for (const a of input.artifacts) {
    if (a.bytes.byteLength > BUILD_OUTPUT_CAP_BYTES) {
      throw new DraftError("invalid_build", `a ${a.kind} artifact is over the output cap`)
    }
    stored.set(sha256Hex(a.bytes), a.kind)
  }
  const named: Array<[keyof AppDraftBuild, AppBuildArtifactKind]> = [
    ["packageSha256", "package"],
    ["bundleSha256", "bundle"],
    ["uiSha256", "ui"],
    ["workerSha256", "worker"],
  ]
  for (const [key, kind] of named) {
    const sha = input.build[key as keyof typeof input.build]
    if (sha !== undefined && stored.get(String(sha)) !== kind) {
      throw new DraftError("invalid_build", `the build names a ${kind} sha256 no artifact carries`)
    }
  }
  const build: AppDraftBuild = { ...input.build, at: input.build.at ?? new Date().toISOString() }
  const [updated] = await tx
    .update(appDraftVersions)
    .set({ build })
    .where(and(eq(appDraftVersions.draftId, draft.id), eq(appDraftVersions.n, input.n)))
    .returning({ n: appDraftVersions.n })
  if (!updated) {
    throw new DraftError("version_not_found", `no version ${input.n} of this draft`, {
      n: input.n,
    })
  }
  for (const a of input.artifacts) {
    await tx
      .insert(appBuildArtifacts)
      .values({
        orgId: caller.orgId,
        draftId: draft.id,
        sha256: sha256Hex(a.bytes),
        kind: a.kind,
        bytes: a.bytes,
        sizeBytes: a.bytes.byteLength,
      })
      .onConflictDoNothing()
  }
  // A rebuild's previous bytes no kept version names go now.
  await pruneArtifacts(tx, draft.id)
  return build
}

/** A stored build artifact of a draft, re-hashed on read (null when absent or altered). */
export async function getBuildArtifact(
  tx: RlsClient,
  input: { draftId: string; sha256: string },
): Promise<{ kind: AppBuildArtifactKind; bytes: Uint8Array } | null> {
  const [row] = await tx
    .select({ kind: appBuildArtifacts.kind, bytes: appBuildArtifacts.bytes })
    .from(appBuildArtifacts)
    .where(
      and(eq(appBuildArtifacts.draftId, input.draftId), eq(appBuildArtifacts.sha256, input.sha256)),
    )
  if (!row) return null
  const bytes = new Uint8Array(row.bytes)
  return sha256Hex(bytes) === input.sha256 ? { kind: row.kind, bytes } : null
}

/**
 * Marks the draft published as its custom app: `published_app_name` is set at
 * the first publish and never changes. Returns the app name.
 */
export async function markDraftPublished(
  tx: RlsClient,
  caller: DraftCaller,
  draftId: string,
): Promise<string> {
  const draft = await lockDraft(tx, draftId)
  if (draft.status === "discarded")
    throw new DraftError("draft_discarded", "this draft was discarded")
  const appName = draftAppName(caller.orgId, draft.baseName)
  if (draft.publishedAppName !== null && draft.publishedAppName !== appName) {
    throw new DraftError("published_name_immutable", "a draft's published app never changes")
  }
  await tx
    .update(appDrafts)
    .set({
      status: "published",
      publishedAppName: appName,
      updatedBy: caller.userId,
      updatedAt: new Date(),
    })
    .where(eq(appDrafts.id, draftId))
  return appName
}

/** The draft that published `appName` in the caller's org, if any. */
export async function draftOwningApp(tx: RlsClient, appName: string): Promise<AppDraftRow | null> {
  const [row] = await tx
    .select()
    .from(appDrafts)
    .where(eq(appDrafts.publishedAppName, appName))
    .limit(1)
  return row ?? null
}
