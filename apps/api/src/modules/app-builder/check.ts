// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Building a draft version for check, preview and publish.
//
//  - The bytes carry the name and version they will be installed under, forced
//    BEFORE the build (build-draft.ts): the name is the draft's custom app name
//    (`<base>-o<orgKey>`, or the one it published as), the version the next
//    patch over the app's active version (0.1.0 when it was never published).
//    So the build a check makes is the build a publish installs, byte for byte,
//    as long as nothing was published in between.
//  - Every build goes through the build governor (governance.ts: one per org at
//    a time, 30 an hour, 2 per process; else `build_busy`) and is recorded on
//    its version with its artifacts by sha256 (drafts.ts recordVersionBuild).
//  - A version whose recorded build already carries the target name and
//    version, and whose package bytes are stored, is reused, never rebuilt.

import type { RlsClient } from "~/db"
import type { AppDraftBuild, AppDraftRow } from "~/db/schema/kernel"
import { type BuildDraftResult, buildDraft } from "~/modules/app-builder/build/build-draft"
import { buildGovernor } from "~/modules/app-builder/build/governance"
import {
  type DraftCaller,
  DraftError,
  type DraftVersion,
  draftAppName,
  getBuildArtifact,
  getDraft,
  recordVersionBuild,
} from "~/modules/app-builder/drafts"
import { type ActiveCustomApp, activeCustomApp } from "~/modules/app-builder/installed"

/** The version a first publish ships as. */
export const FIRST_PUBLISH_VERSION = "0.1.0"

/** The next patch of `version` (`1.2.3` -> `1.2.4`; a pre-release or build tag is dropped). */
export function nextPatchVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) return FIRST_PUBLISH_VERSION
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

export interface PublishTarget {
  appName: string
  appVersion: string
  /** The org's app as it runs now, or null when it was never published. */
  active: ActiveCustomApp | null
}

/** The name and version a draft's next publish installs. */
export async function publishTarget(
  caller: DraftCaller,
  draft: Pick<AppDraftRow, "baseName" | "publishedAppName">,
): Promise<PublishTarget> {
  const appName = draft.publishedAppName ?? draftAppName(caller.orgId, draft.baseName)
  const active = await activeCustomApp(caller.orgId, appName)
  return {
    appName,
    appVersion: active ? nextPatchVersion(active.version) : FIRST_PUBLISH_VERSION,
    active,
  }
}

export interface VersionBuild {
  draft: AppDraftRow
  version: DraftVersion
  target: PublishTarget
  build: AppDraftBuild
  /** The draft manifest as packaged (name and version forced), when it parsed. */
  manifest: Record<string, unknown> | null
  /** The recorded build was reused. */
  reused: boolean
}

function recordOf(r: BuildDraftResult, target: PublishTarget): Omit<AppDraftBuild, "at"> {
  return {
    ok: r.ok,
    ...(r.package ? { packageSha256: r.package.sha256, sizeBytes: r.package.sizeBytes } : {}),
    ...(r.bundle ? { bundleSha256: r.bundle.sha256 } : {}),
    ...(r.ui ? { uiSha256: r.ui.sha256 } : {}),
    ...(r.worker ? { workerSha256: r.worker.sha256 } : {}),
    errors: r.errors.slice(0, 50),
    appName: target.appName,
    appVersion: target.appVersion,
    ...(r.typecheck
      ? { typecheck: { ok: r.typecheck.ok, errors: r.typecheck.errors.slice(0, 50) } }
      : {}),
  }
}

/** The draft manifest of a version as it would be packaged, or null when it does not parse. */
export function packagedManifest(
  files: DraftVersion["files"],
  target: Pick<PublishTarget, "appName" | "appVersion">,
): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(files["app.manifest.json"]) as unknown
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
    return { ...(raw as Record<string, unknown>), name: target.appName, version: target.appVersion }
  } catch {
    return null
  }
}

/**
 * Version `n` (default: the latest) built for its next publish: the recorded
 * build when it matches the target and its bytes are stored, else a new build
 * (recorded). `typecheck` forces a new build when the recorded one has no type
 * check.
 */
export async function buildDraftVersion(
  tx: RlsClient,
  caller: DraftCaller,
  input: { draftId: string; n?: number; typecheck?: boolean },
): Promise<VersionBuild> {
  const { draft, version } = await getDraft(
    tx,
    input.draftId,
    input.n !== undefined ? { version: input.n } : {},
  )
  if (draft.status === "discarded") {
    throw new DraftError("draft_discarded", "this draft was discarded")
  }
  const target = await publishTarget(caller, draft)
  const manifest = packagedManifest(version.files, target)
  const recorded = version.build
  if (
    recorded?.ok &&
    recorded.appName === target.appName &&
    recorded.appVersion === target.appVersion &&
    recorded.packageSha256 &&
    (!input.typecheck || recorded.typecheck) &&
    (await getBuildArtifact(tx, { draftId: draft.id, sha256: recorded.packageSha256 }))
  ) {
    return { draft, version, target, build: recorded, manifest, reused: true }
  }
  const result = await buildGovernor.run(caller.orgId, () =>
    buildDraft(version.files, {
      appName: target.appName,
      version: target.appVersion,
      typecheck: input.typecheck === true,
    }),
  )
  const artifacts = [
    result.package ? { kind: "package" as const, bytes: result.package.bytes } : null,
    result.bundle ? { kind: "bundle" as const, bytes: result.bundle.bytes } : null,
    result.ui ? { kind: "ui" as const, bytes: result.ui.bytes } : null,
    result.worker ? { kind: "worker" as const, bytes: result.worker.bytes } : null,
  ].filter((a): a is NonNullable<typeof a> => a !== null)
  const build = await recordVersionBuild(tx, caller, {
    draftId: draft.id,
    n: version.n,
    build: recordOf(result, target),
    artifacts: result.ok ? artifacts : [],
  })
  return {
    draft,
    version: { ...version, build },
    target,
    build,
    manifest: result.manifest ?? manifest,
    reused: false,
  }
}

export interface CheckResult {
  draftId: string
  n: number
  ok: boolean
  /** Build and validation errors, each with its file and line when known. */
  errors: NonNullable<AppDraftBuild["errors"]>
  typecheck: AppDraftBuild["typecheck"] | null
  appName: string
  appVersion: string
  packageSha256: string | null
  sizeBytes: number | null
}

/**
 * apps_build_check: builds version `n` (the latest by default) with the type
 * check, records the build and its artifacts, and returns the errors.
 */
export async function checkDraft(
  tx: RlsClient,
  caller: DraftCaller,
  input: { draftId: string; n?: number },
): Promise<CheckResult> {
  const built = await buildDraftVersion(tx, caller, { ...input, typecheck: true })
  return {
    draftId: built.draft.id,
    n: built.version.n,
    ok: built.build.ok && (built.build.typecheck?.ok ?? true),
    errors: built.build.errors ?? [],
    typecheck: built.build.typecheck ?? null,
    appName: built.target.appName,
    appVersion: built.target.appVersion,
    packageSha256: built.build.packageSha256 ?? null,
    sizeBytes: built.build.sizeBytes ?? null,
  }
}
