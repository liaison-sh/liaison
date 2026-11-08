// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Publishing a draft version as the org's custom app.
//
// Two steps, so what a person approves is exactly what gets installed:
//
//  1. `preparePublish` (the gated tool's preflight, or the first half of the
//     REST publish): builds the version for its next publish (name and version
//     forced BEFORE the build, check.ts) or reuses that build, and returns the
//     PIN: {draftId, n, appName, appVersion, baseVersion, packageSha256,
//     workerSha256?, grants: {scopes, connections, capabilities,
//     crossAppCalls, domains}}. The approval stores it (a pinned param: the caller's
//     value is dropped, `approval_update_payload` refuses every edit of this
//     tool), and its card shows the sha and the delta against the active
//     version (`manifestDelta`).
//  2. `executePublish`: re-reads the stored package bytes by the pinned sha
//     (re-hashed: missing or altered bytes refuse, `pin_mismatch`), refuses
//     when the app moved since the pin (`publish_stale`), and installs exactly
//     those bytes with exactly the pinned grants, the outbound domains
//     included: a package declaring other domains than the pinned ones is
//     refused (`pin_mismatch`; install-service.ts
//     installAppFromBytes: the /custom/install path, the org as owner, the
//     health gate, never a session-trusted interface), and the pinned Workers
//     module (re-hashed the same way) on the install row. Then the draft is
//     marked published (its app name fixed for good) and the audit row
//     `app.custom.published` {draftId, n, sha256} written. Changing the draft
//     after the approval changes nothing: the bytes are the pinned ones.
//
// Identity: a draft publishes only into its own app. An app another draft
// published, or one installed by URL (not built here), is refused. The org's
// customApps cap applies to the first publish only (installAppFromTarball).

import type { RlsClient } from "~/db"
import type { AppDraftRow } from "~/db/schema/kernel"
import { customAppsEnabled } from "~/lib/edition"
import { UNKNOWN_TURN_TAINT } from "~/modules/agent/scopes/scope-taint"
import { buildDraftVersion, packagedManifest } from "~/modules/app-builder/check"
import {
  type DraftCaller,
  DraftError,
  draftAppName,
  draftOwningApp,
  getBuildArtifact,
  getDraft,
  markDraftPublished,
  type TxRunner,
} from "~/modules/app-builder/drafts"
import {
  activeCustomApp,
  customAppBuiltByDraft,
  customAppInstalled,
  hasPublishedAudit,
  writePublishedAudit,
} from "~/modules/app-builder/installed"
import { DomainPinMismatchError, declaredDomains } from "~/modules/apps/egress-grants"
import {
  declaredCapabilities,
  declaredCrossAppCalls,
  installAppFromBytes,
} from "~/modules/apps/install-service"

export interface PublishGrants {
  scopes: string[]
  connections: string[]
  capabilities: string[]
  crossAppCalls: string[]
  /** The outbound domains (network + connections) the approval consents to (egress-grants.ts). */
  domains: string[]
}

/** What an approval pins and a publish installs. */
export interface PublishPin {
  draftId: string
  n: number
  appName: string
  appVersion: string
  /** The active version when pinned (null: first publish). */
  baseVersion: string | null
  packageSha256: string
  workerSha256?: string
  grants: PublishGrants
  /** The pinned build's type check, shown on the approval card (informational). */
  typecheck?: PinTypecheck
}

/** A type check as the approval card shows it: passed, or its error count and first error. */
export interface PinTypecheck {
  ok: boolean
  errors: number
  first?: string
}

/** `sourceUrl` of a builder install: how the builder knows an app is its own. */
export function builderSourceUrl(draftId: string, n: number): string {
  return `builder:draft/${draftId}/${n}`
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

/** The grants a manifest needs, every one of them (the install refuses a missing one). */
export function grantsOf(manifest: Record<string, unknown>): PublishGrants {
  return {
    scopes: [...new Set(strings(manifest.scopes))],
    connections: Object.keys(record(manifest.connections)),
    capabilities: declaredCapabilities(manifest as never),
    crossAppCalls: declaredCrossAppCalls(manifest as never),
    domains: declaredDomains(manifest),
  }
}

/**
 * A draft publishes only into its own app: refuses another draft's, or one not
 * built here. An install this draft's own publish made (its `source_url` names
 * the draft) whose marking never landed (the request failed after the install
 * committed) is this draft's: the marking is completed here, so a publish of
 * the draft never stays refused.
 */
async function assertPublishIdentity(
  tx: RlsClient,
  caller: DraftCaller,
  draft: AppDraftRow,
): Promise<string> {
  if (draft.status === "discarded") {
    throw new DraftError("draft_discarded", "this draft was discarded")
  }
  const appName = draft.publishedAppName ?? draftAppName(caller.orgId, draft.baseName)
  const owner = await draftOwningApp(tx, appName)
  if (owner && owner.id !== draft.id) {
    throw new DraftError(
      "app_owned_by_other_draft",
      `the app ${appName} belongs to another draft ("${owner.title}")`,
      { draftId: owner.id },
    )
  }
  if (!owner && (await customAppInstalled(caller.orgId, appName))) {
    if (!(await customAppBuiltByDraft(caller.orgId, appName, draft.id))) {
      throw new DraftError(
        "app_not_built_by_builder",
        `the organisation already has an app ${appName} that the app builder did not build: pick another base name`,
      )
    }
    await markDraftPublished(tx, caller, draft.id)
  }
  return appName
}

function assertCustomAppsOn(): void {
  if (!customAppsEnabled()) {
    throw new DraftError(
      "custom_apps_off",
      "this server does not let organisations build or install their own apps",
    )
  }
}

/** The card's form of a build's type check (null: none ran). */
export function pinTypecheck(
  typecheck:
    | { ok: boolean; errors: Array<{ file?: string; line?: number; message: string }> }
    | undefined,
): PinTypecheck | undefined {
  if (!typecheck) return undefined
  const e = typecheck.errors[0]
  return {
    ok: typecheck.ok,
    errors: typecheck.errors.length,
    ...(e
      ? { first: `${e.file ?? ""}${e.line ? `:${e.line}` : ""} ${e.message}`.trim().slice(0, 120) }
      : {}),
  }
}

export interface PreparedPublish {
  pin: PublishPin
  title: string
  manifest: Record<string, unknown>
  activeManifest: Record<string, unknown> | null
  delta: string[]
  typecheck: { ok: boolean; errors: number } | null
}

/**
 * Builds (or reuses the build of) version `n` for its next publish, with its
 * type check, and pins it. The identity check runs in a short transaction, the
 * build in none (check.ts buildDraftVersion).
 */
export async function preparePublish(
  db: TxRunner,
  caller: DraftCaller,
  input: { draftId: string; n?: number },
): Promise<PreparedPublish> {
  assertCustomAppsOn()
  await db.run(async (tx) => {
    const { draft } = await getDraft(tx, input.draftId)
    await assertPublishIdentity(tx, caller, draft)
  })
  const built = await buildDraftVersion(db, caller, { ...input, typecheck: true })
  if (!built.build.ok || !built.build.packageSha256 || !built.manifest) {
    throw new DraftError(
      "build_failed",
      `version ${built.version.n} does not build: run apps_build_check and fix its errors`,
      { errors: (built.build.errors ?? []).slice(0, 10) },
    )
  }
  const typecheck = pinTypecheck(built.build.typecheck)
  const pin: PublishPin = {
    draftId: built.draft.id,
    n: built.version.n,
    appName: built.target.appName,
    appVersion: built.target.appVersion,
    baseVersion: built.target.active?.version ?? null,
    packageSha256: built.build.packageSha256,
    ...(built.build.workerSha256 ? { workerSha256: built.build.workerSha256 } : {}),
    grants: grantsOf(built.manifest),
    ...(typecheck ? { typecheck } : {}),
  }
  const activeManifest = built.target.active?.manifest ?? null
  return {
    pin,
    title: built.draft.title,
    manifest: built.manifest,
    activeManifest,
    delta: manifestDelta(activeManifest, built.manifest, built.target.active?.version ?? null),
    typecheck: typecheck ? { ok: typecheck.ok, errors: typecheck.errors } : null,
  }
}

function readTypecheck(value: unknown): PinTypecheck | undefined {
  const t = record(value)
  if (typeof t.ok !== "boolean" || typeof t.errors !== "number") return undefined
  return {
    ok: t.ok,
    errors: t.errors,
    ...(typeof t.first === "string" ? { first: t.first.slice(0, 120) } : {}),
  }
}

/** A pin read back from an approval payload, or null when it is not one. */
export function readPin(value: unknown): PublishPin | null {
  const p = record(value)
  const g = record(p.grants)
  if (
    typeof p.draftId !== "string" ||
    typeof p.n !== "number" ||
    typeof p.appName !== "string" ||
    typeof p.appVersion !== "string" ||
    typeof p.packageSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(p.packageSha256) ||
    !(p.baseVersion === null || typeof p.baseVersion === "string") ||
    !(
      p.workerSha256 === undefined ||
      (typeof p.workerSha256 === "string" && /^[0-9a-f]{64}$/.test(p.workerSha256))
    )
  ) {
    return null
  }
  return {
    draftId: p.draftId,
    n: p.n,
    appName: p.appName,
    appVersion: p.appVersion,
    baseVersion: p.baseVersion as string | null,
    packageSha256: p.packageSha256,
    ...(typeof p.workerSha256 === "string" ? { workerSha256: p.workerSha256 } : {}),
    ...(readTypecheck(p.typecheck) ? { typecheck: readTypecheck(p.typecheck) } : {}),
    grants: {
      scopes: strings(g.scopes),
      connections: strings(g.connections),
      capabilities: strings(g.capabilities),
      crossAppCalls: strings(g.crossAppCalls),
      // A pin from before domains were pinned carries none: a package that
      // declares any is then refused at install (request the publish again).
      domains: strings(g.domains),
    },
  }
}

export interface PublishResult {
  appName: string
  appVersion: string
  sha256: string
  draftId: string
  n: number
  firstPublish: boolean
}

/**
 * Installs exactly the pinned bytes with exactly the pinned grants (see the
 * file header). The pin is verified in one short transaction, the install
 * (with its 30 s health gate) runs in none, and the draft is marked in another.
 * A retry of a publish whose install landed but whose marking did not (the app
 * already runs these exact bytes, installed from this draft version) completes
 * the marking and the audit instead of refusing.
 */
export async function executePublish(
  db: TxRunner,
  caller: DraftCaller & { installedBy: string },
  pinned: unknown,
  opts: { approvalRequestId?: string | null } = {},
): Promise<PublishResult> {
  const pin = readPin(pinned)
  if (!pin) throw new DraftError("pin_mismatch", "the publish carries no valid pin")
  assertCustomAppsOn()
  const verified = await db.run(async (tx) => {
    const { draft } = await getDraft(tx, pin.draftId)
    const appName = await assertPublishIdentity(tx, caller, draft)
    if (appName !== pin.appName) {
      throw new DraftError("pin_mismatch", "the pinned app name is not this draft's app")
    }
    const active = await activeCustomApp(caller.orgId, appName)
    if (
      active &&
      active.version === pin.appVersion &&
      active.sha256 === pin.packageSha256 &&
      active.sourceUrl === builderSourceUrl(pin.draftId, pin.n)
    ) {
      return { done: true as const, active }
    }
    if ((active?.version ?? null) !== pin.baseVersion) {
      throw new DraftError(
        "publish_stale",
        `the app moved to ${active?.version ?? "nothing"} since this publish was prepared (from ${pin.baseVersion ?? "nothing"}): request the publish again`,
      )
    }
    const artifact = await getBuildArtifact(tx, {
      draftId: pin.draftId,
      sha256: pin.packageSha256,
    })
    if (artifact?.kind !== "package") {
      throw new DraftError(
        "pin_mismatch",
        "the approved package bytes are no longer stored or changed: request the publish again",
      )
    }
    // The Workers module of the same build, pinned beside the package: recorded
    // on the install row (0278) so a cell with LIAISON_WORKERS_CUSTOM_APPS runs
    // exactly these bytes on the loader (workers/bundle-route.ts serves them).
    let workerModule: { sha256: string; bytes: Uint8Array } | undefined
    if (pin.workerSha256) {
      const worker = await getBuildArtifact(tx, {
        draftId: pin.draftId,
        sha256: pin.workerSha256,
      })
      if (worker?.kind !== "worker") {
        throw new DraftError(
          "pin_mismatch",
          "the approved Workers module is no longer stored or changed: request the publish again",
        )
      }
      workerModule = { sha256: pin.workerSha256, bytes: worker.bytes }
    }
    return { done: false as const, active, bytes: artifact.bytes, workerModule }
  })

  let installed: { name: string; version: string }
  if (verified.done) {
    installed = { name: verified.active.name, version: verified.active.version }
  } else {
    try {
      installed = await installAppFromBytes({
        bytes: verified.bytes,
        ownerOrgId: caller.orgId,
        installedBy: caller.installedBy,
        grantedScopes: pin.grants.scopes,
        grantedConnections: pin.grants.connections,
        grantedCapabilities: pin.grants.capabilities,
        grantedCrossAppCalls: pin.grants.crossAppCalls,
        // Written on the install row in the install's transaction, exactly the pinned ones.
        grantedDomains: pin.grants.domains,
        sourceUrl: builderSourceUrl(pin.draftId, pin.n),
        ...(verified.workerModule ? { workerModule: verified.workerModule } : {}),
      })
    } catch (err) {
      if (err instanceof DomainPinMismatchError) {
        throw new DraftError("pin_mismatch", `${err.message}: request the publish again`)
      }
      throw err
    }
  }
  await db.run((tx) => markDraftPublished(tx, caller, pin.draftId))
  if (
    !verified.done ||
    !(await hasPublishedAudit({
      orgId: caller.orgId,
      appName: installed.name,
      sha256: pin.packageSha256,
    }))
  ) {
    await writePublishedAudit({
      orgId: caller.orgId,
      actorId: caller.installedBy,
      appName: installed.name,
      appVersion: installed.version,
      draftId: pin.draftId,
      n: pin.n,
      sha256: pin.packageSha256,
      approvalRequestId: opts.approvalRequestId ?? null,
    })
  }
  return {
    appName: installed.name,
    appVersion: installed.version,
    sha256: pin.packageSha256,
    draftId: pin.draftId,
    n: pin.n,
    firstPublish: pin.baseVersion === null,
  }
}

// ── The delta an approval card shows ─────────────────────────────────────────

function tablesOf(manifest: Record<string, unknown> | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [table, def] of Object.entries(record(manifest?.schema))) {
    const d = record(def)
    out.set(table, new Set(Object.keys(record(d.fields ?? d.columns))))
  }
  return out
}

function domainsOf(manifest: Record<string, unknown> | null): string[] {
  const out = new Set(strings(record(manifest?.network).allowedDomains))
  for (const conn of Object.values(record(manifest?.connections))) {
    for (const d of strings(record(conn).allowedDomains)) out.add(d)
  }
  return [...out].sort()
}

function secretsOf(manifest: Record<string, unknown> | null): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, decl] of Object.entries(record(manifest?.secrets))) {
    const d = record(decl)
    out.set(key, `${String(d.in ?? "")} to ${strings(d.hosts).join(", ")}`)
  }
  return out
}

function diff(before: string[], after: string[]): { added: string[]; removed: string[] } {
  const b = new Set(before)
  const a = new Set(after)
  return { added: after.filter((x) => !b.has(x)), removed: before.filter((x) => !a.has(x)) }
}

function list(items: string[], max = 6): string {
  return items.length > max
    ? `${items.slice(0, max).join(", ")} and ${items.length - max} more`
    : items.join(", ")
}

/**
 * What a publish changes against the active version (or, for a first publish,
 * everything it asks for): scopes, allowed domains, tables and columns,
 * connections, secret placements, cross-app calls, capabilities, and the
 * tables kept although the new version no longer declares them.
 */
export function manifestDelta(
  active: Record<string, unknown> | null,
  next: Record<string, unknown>,
  activeVersion: string | null,
): string[] {
  const lines: string[] = []
  const nextGrants = grantsOf(next)
  const activeGrants = active ? grantsOf(active) : null
  const pairs: Array<[string, string[], string[]]> = [
    ["Scopes", activeGrants?.scopes ?? [], nextGrants.scopes],
    ["Allowed domains", active ? domainsOf(active) : [], domainsOf(next)],
    ["Connections", activeGrants?.connections ?? [], nextGrants.connections],
    ["Cross-app calls", activeGrants?.crossAppCalls ?? [], nextGrants.crossAppCalls],
    ["Capabilities", activeGrants?.capabilities ?? [], nextGrants.capabilities],
  ]
  for (const [label, before, after] of pairs) {
    const { added, removed } = diff(before, after)
    if (added.length) lines.push(`${label} ${active ? "added" : "asked"}: ${list(added)}.`)
    if (removed.length) lines.push(`${label} removed: ${list(removed)}.`)
  }
  const beforeTables = tablesOf(active)
  const afterTables = tablesOf(next)
  const newTables = [...afterTables.keys()].filter((t) => !beforeTables.has(t))
  if (newTables.length) lines.push(`New tables: ${list(newTables)}.`)
  const newColumns: string[] = []
  for (const [table, cols] of afterTables) {
    const was = beforeTables.get(table)
    if (!was) continue
    for (const c of cols) if (!was.has(c)) newColumns.push(`${table}.${c}`)
  }
  if (newColumns.length) lines.push(`New columns: ${list(newColumns)}.`)
  const kept = [...beforeTables.keys()].filter((t) => !afterTables.has(t))
  if (kept.length) {
    lines.push(
      `Tables kept: ${list(kept)} (this version no longer declares them; their data stays).`,
    )
  }
  const sBefore = secretsOf(active)
  const sAfter = secretsOf(next)
  for (const [key, where] of sAfter) {
    if (sBefore.get(key) !== where) lines.push(`Secret ${key}: ${where}.`)
  }
  for (const key of sBefore.keys()) {
    if (!sAfter.has(key)) lines.push(`Secret ${key}: no longer used.`)
  }
  if (lines.length === 0) {
    lines.push(
      activeVersion
        ? `No change of access against ${activeVersion}: code only.`
        : "It asks for no scope, domain, table or connection.",
    )
  }
  return lines
}

/** The card's type check line. */
export function typecheckLine(t: PinTypecheck | undefined): string {
  if (!t) return "Type check: not run."
  if (t.ok) return "Type check: ok."
  return `Type check: ${t.errors} ${t.errors === 1 ? "error" : "errors"}${t.first ? ` (first: ${t.first})` : ""}.`
}

/**
 * What the agent had read while it wrote the draft (this version and the ones before it):
 * its code and texts can carry that data to everyone who uses the published app.
 */
function taintLine(taintScopes: readonly string[]): string {
  const named = taintScopes.map((s) =>
    UNKNOWN_TURN_TAINT.includes(s) ? "a scope that was not recorded" : s,
  )
  return named.length > 0 ? `Contains data read under: ${named.join(", ")}` : "No restricted data"
}

/** The approval card's lines for a pin: name, version, sha, type check, taint, delta. */
export async function summarizePin(
  tx: RlsClient,
  orgId: string,
  pinned: unknown,
): Promise<{ title: string; lines: string[] }> {
  const pin = readPin(pinned)
  if (!pin) return { title: "Publish an app", lines: ["The request carries no valid pin."] }
  const { draft, version } = await getDraft(tx, pin.draftId, { version: pin.n })
  const next = packagedManifest(version.files, pin) ?? {}
  const active = await activeCustomApp(orgId, pin.appName)
  const delta = manifestDelta(active?.manifest ?? null, next, active?.version ?? null)
  // The outbound domains this approval consents to that the running version was
  // not granted: always shown, first of the delta's lines.
  const newDomains = pin.grants.domains.filter((d) => !(active?.grantedDomains ?? []).includes(d))
  const consent = newDomains.length ? [`Outbound domains to approve: ${list(newDomains, 4)}.`] : []
  const rest = consent.length ? delta.filter((l) => !l.startsWith("Allowed domains ")) : delta
  // A card has 8 lines: the version, the sha, the type check, what data its writers
  // had read, at most 3 of the delta (the domains to approve first), the frame note.
  const room = 3 - consent.length
  const shown = [
    ...consent,
    ...(rest.length > room
      ? [...rest.slice(0, room - 1), `And ${rest.length - room + 1} more changes.`]
      : rest),
  ]
  const lines = [
    pin.baseVersion
      ? `Updates ${pin.appName} from ${pin.baseVersion} to ${pin.appVersion} (draft version ${pin.n}).`
      : `Installs ${pin.appName} ${pin.appVersion} as this organisation's app (draft version ${pin.n}). It counts against the organisation's custom apps.`,
    `Package sha256: ${pin.packageSha256}`,
    typecheckLine(pin.typecheck),
    taintLine(version.taintScopes),
    ...shown,
    "Its interface, if any, runs framed: never with your session.",
  ]
  return {
    title: `Publish the app "${draft.title}"`.slice(0, 200),
    lines: lines.map((l) => (l.length > 200 ? `${l.slice(0, 199)}…` : l)),
  }
}
