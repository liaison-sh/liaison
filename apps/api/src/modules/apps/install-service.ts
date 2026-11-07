// SPDX-License-Identifier: FSL-1.1-ALv2
// Runtime install / upgrade / uninstall of `.liaisonapp` packages.
//
// All install paths verify the package (cosign + schema), enforce that every
// scope the manifest requests was explicitly granted by the admin, force-coerce
// `trusted: false` (installed apps are never trusted), check the app's host API
// range against this server's (host-api.ts), then unpack to the install root and
// record `apps_installed` rows. The companion `apps_active_version` table names the running version.
//
// The new version then goes live without a restart, health-gated, through
// activation.ts (which switches back to the previous version when it fails). The
// server keeps two versions of each app, the active one and the one before it;
// older ones are pruned here.
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, sep } from "node:path"
import { isReservedSettingsNamespace } from "@liaison/app-sdk"
import { isReservedWebRouteSegment, labelSkeleton } from "@liaison/shared"
import { and, eq, isNotNull, isNull, notInArray } from "drizzle-orm"
import { HTTPException } from "hono/http-exception"
import { withSystemDb } from "~/db/privileged"
import {
  appsActiveVersion,
  appsInstalled,
  type InstalledPdfTemplate,
} from "~/db/schema/kernel/apps-installed"
import { appsLogger as log } from "~/lib/logger"
import { ownOption } from "~/lib/safe-path"
import {
  type ActivationActor,
  activateAppVersion,
  announceActiveVersions,
  isNewerVersion,
  readInstalledManifest,
  withAppActivationLock,
} from "~/modules/apps/activation"
import { assertAdditiveSchema } from "~/modules/apps/additive-schema"
import {
  assertCustomAppManifestAllowed,
  assertCustomAppName,
  CustomAppDisabledError,
  customAppNameKey,
  invalidateAppOrgScope,
} from "~/modules/apps/app-org-scope"
import { isCatalogArtifact, listCatalog } from "~/modules/apps/catalog"
import { bumpCatalogGeneration } from "~/modules/apps/catalog-generation"
import { appIconErrors } from "~/modules/apps/contract"
import { discoverInTreeApps, getInstallRoot } from "~/modules/apps/discover-apps"
import { assertHostApiCompatible } from "~/modules/apps/host-api"
import { KNOWN_CAPABILITIES } from "~/modules/apps/manifest-schema"
import {
  deleteStoredPackage,
  deleteStoredPackages,
  withStoredPackage,
} from "~/modules/apps/package-store"
import { assertTabRoutesOwned } from "~/modules/apps/tab-route-ownership"
import { reviewTriggerBody } from "~/modules/apps/trigger-review"
import { type VerifyResult, verifyAppPackage } from "~/modules/apps/verify-package"
import { isTransientDir, placeVersionDir, sweepTransientDirs } from "~/modules/apps/version-dir"
import { versionsInUse } from "~/modules/apps/versions-in-use"
import { assertCustomAppRoom } from "~/modules/org/caps"

export interface InstallOptions {
  /** Local path to the `.liaisonapp` tarball to install. */
  tarballPath: string
  /** UUID of the admin performing the install. */
  installedBy: string
  /** Scopes the admin explicitly granted. Every manifest scope must be present. */
  grantedScopes: string[]
  /** Connections the admin granted. */
  grantedConnections?: string[]
  /**
   * Platform capabilities the admin granted (kernel primitives such as
   * `messages.post`). Every capability the manifest declares must be present. Left
   * undefined by trusted programmatic callers (catalog install, `config apply`), it
   * means "every declared capability"; the HTTP routes always pass an explicit list.
   */
  grantedCapabilities?: string[]
  /**
   * The `cross_app_calls` targets (`app:tool`) the admin approved. A declared target
   * lets the app call that tool without the caller's own scopes, so it is part of the
   * grant exactly like a capability: every declared target must be present, and
   * undefined means "every declared target" for trusted programmatic callers.
   */
  grantedCrossAppCalls?: string[]
  /**
   * The admin's explicit approval that this app's interface (ui.js) runs in the web
   * origin with full access to their session. Recorded on the install row. Not
   * needed for first-party or trusted-publisher-signed packages.
   */
  approveUiFullAccess?: boolean
  /** Install a version older than the active one (a deliberate rollback). */
  allowDowngrade?: boolean
  /** Require a valid cosign signature. */
  requireSignature?: boolean
  cosignIdentityRegex?: string
  /** Path to the detached `<tarball>.cosign.bundle` signature, if downloaded. */
  signatureBundlePath?: string
  /** Where the operator installed from (recorded as `source_url`). */
  sourceUrl?: string
  /** Who the activation is recorded for; default: an operator, `installedBy`. */
  actor?: ActivationActor
  /**
   * Storing the package in object storage may fail without failing the install:
   * only the boot's catalog repair, which installs the image's own tarball and
   * must not depend on object storage (the upkeep stores it later). An install
   * or upgrade an operator asked for always fails when the package cannot be stored.
   */
  storeBestEffort?: boolean
  /**
   * Managed edition: install an org-private custom app for this org. Its
   * name must be `<base>-o<orgKey>`, its manifest may declare org-level
   * declarations only (app-org-scope.ts), a new one takes one of the org's
   * `customApps`, and only this org sees and runs it. Unset: an instance app.
   */
  ownerOrgId?: string
  /**
   * The Workers module the app builder built with this package (the sha256 its
   * publish pinned, and the bytes): recorded on the install row so the Workers
   * executor can run the version and the cell can serve the module to the app
   * loader (0278). Only with `ownerOrgId`; the bytes must hash to the sha.
   */
  workerModule?: { sha256: string; bytes: Uint8Array }
}

export interface InstallResult {
  name: string
  version: string
}

export interface PreviewUpgradeOptions {
  name: string
  tarballPath: string
  requireSignature?: boolean
  cosignIdentityRegex?: string
  signatureBundlePath?: string
}

export interface PreviewUpgradeResult {
  hasUiBundle: boolean
  signatureVerified: boolean
  newCapabilities: string[]
  newCrossAppCalls: string[]
  newScopes: string[]
  removedScopes: string[]
  /** Scopes the admin granted to the currently-installed version. */
  previouslyGranted: string[]
  manifest: VerifyResult["manifest"]
}

export interface ApplyUpgradeOptions {
  name: string
  tarballPath: string
  installedBy: string
  grantedScopes: string[]
  grantedConnections?: string[]
  grantedCapabilities?: string[]
  grantedCrossAppCalls?: string[]
  approveUiFullAccess?: boolean
  /** Install a version that is not newer than the active one (rollback). */
  allowDowngrade?: boolean
  requireSignature?: boolean
  cosignIdentityRegex?: string
  signatureBundlePath?: string
  sourceUrl?: string
  /** Who the activation is recorded for; default: an operator, `installedBy`. */
  actor?: ActivationActor
}

/** Reject installs whose name collides with a bundled in-tree app. */
/** The org that owns installed app `name`; null for an instance app (or none installed). */
async function currentOwnerOf(name: string): Promise<string | null> {
  const [row] = await withSystemDb("install-current-owner", (db) =>
    db
      .select({ orgId: appsInstalled.orgId })
      .from(appsInstalled)
      .where(and(eq(appsInstalled.name, name), isNotNull(appsInstalled.orgId)))
      .limit(1),
  )
  return row?.orgId ?? null
}

/**
 * Who may install `name`. An org-private install: the custom app name
 * rule, the declarations an org-level app may carry, and no other owner of the
 * name. An instance install: never over an org's app, and never a
 * custom-app-shaped name (the boundary's DB-free rule keeps such a name to one
 * org). Every edition.
 */
async function assertOrgOwnership(
  name: string,
  ownerOrgId: string | null,
  rawManifest: Record<string, unknown>,
): Promise<void> {
  const rows = await withSystemDb("install-owner", (db) =>
    db
      .selectDistinct({
        orgId: appsInstalled.orgId,
        disabled: isNotNull(appsInstalled.disabledAt),
      })
      .from(appsInstalled)
      .where(eq(appsInstalled.name, name)),
  )
  // The operator disabled it (modules/cloud/custom-app-disable.ts): no new
  // version until the operator enables it again.
  if (rows.some((r) => r.disabled)) {
    throw new CustomAppDisabledError(name)
  }
  const others = rows.filter((r) => r.orgId !== ownerOrgId)
  if (ownerOrgId === null) {
    if (others.length > 0 || customAppNameKey(name) !== null) {
      throw new HTTPException(409, {
        message: `Cannot install '${name}': that name belongs to an organization's custom app.`,
      })
    }
    return
  }
  const instanceNames = await withSystemDb("install-instance-names", (db) =>
    db
      .selectDistinct({ name: appsInstalled.name })
      .from(appsInstalled)
      .where(isNull(appsInstalled.orgId)),
  )
  const taken = new Set<string>([
    ...(await discoverInTreeApps()).map((a) => a.name),
    ...listCatalog().map((e) => e.name),
    ...instanceNames.map((r) => r.name),
  ])
  assertCustomAppName(name, ownerOrgId, taken)
  assertCustomAppManifestAllowed(rawManifest)
  if (others.length > 0) {
    throw new HTTPException(409, { message: `Cannot install '${name}': the name is taken.` })
  }
  // A new custom app: refused at the cap before any file is placed. The write
  // transaction checks again under the lock (a concurrent install).
  if (!rows.some((r) => r.orgId === ownerOrgId)) {
    await withSystemDb("custom-app-room", (db) => assertCustomAppRoom(db, ownerOrgId))
  }
}

async function assertNotBundled(name: string): Promise<void> {
  const bundled = await discoverInTreeApps()
  if (bundled.some((a) => a.name === name)) {
    throw new Error(
      `Cannot install '${name}': a bundled app already owns that name. Bundled apps always win — pick a different app name.`,
    )
  }
}

/**
 * Read the emitted sandbox bundle artifacts for an app's declared PDF
 * templates. PDF templates are SANDBOXED — the persisted `source` is the
 * sandbox bundle TEXT (`templates/<safeName>.js`, which sets
 * `globalThis.renderTemplate`), NOT the manifest's relative `.ts` path. ANY
 * app may ship a PDF template: the template runs only in the QuickJS app
 * sandbox and the host replays its validated draw-command list against pdf-lib
 * (no untrusted host code). Returns one persistable `{kind, source}` per
 * declared template; an empty array when none are declared.
 */
function readPdfTemplateBundles(
  manifest: VerifyResult["manifest"],
  versionDir: string,
): InstalledPdfTemplate[] {
  const decl = (manifest as { pdf_templates?: Array<{ kind: string; source: string }> })
    .pdf_templates
  if (!decl || decl.length === 0) return []
  return decl.map((tpl) => {
    const safeName = tpl.kind.replace(/[^A-Za-z0-9._-]+/g, "__")
    const bundlePath = join(versionDir, "templates", `${safeName}.js`)
    if (!existsSync(bundlePath)) {
      throw new Error(
        `pdf template '${tpl.kind}': expected emitted bundle at templates/${safeName}.js, but it is missing from the package`,
      )
    }
    return { kind: tpl.kind, source: readFileSync(bundlePath, "utf8") }
  })
}

/** Every scope the manifest requests must appear in the admin's grant list. */
function assertScopesGranted(requested: string[], granted: string[]): void {
  const missing = requested.filter((s) => !granted.includes(s))
  if (missing.length > 0) {
    throw new Error(
      `Install requires scopes the admin did not grant: ${missing.join(", ")}. Re-run with these scopes granted.`,
    )
  }
}

/**
 * Labels of Liaison's own pages. An outside app may not present itself under
 * one: a rail entry called "Settings" or "Security" that is really an app's UI
 * is a phishing surface (A12).
 */
const SYSTEM_LABELS = [
  "Settings",
  "Security",
  "Users",
  "Roles",
  "App store",
  "Connectors",
  "Home",
  "Chats",
]

/**
 * The manifest fields holding a catalog key (`labelKey`, `titleKey`, ...). A key
 * renders as the catalog's text, so an outside app naming `kernel.nav.settings`
 * would show Liaison's own label whatever its plain label says.
 */
const CATALOG_KEY_FIELDS = new Set([
  "labelKey",
  "titleKey",
  "descriptionKey",
  "helpKey",
  "archiveLabelKey",
  "disconnectBodyKey",
])

/**
 * A catalog key that belongs to the app named `name`: its own `apps.<name>.`
 * namespace, or the kernel keys the catalog holds for an app of that name (the
 * settings copy under `kernel.appSettings.<name>.` and its nav label). Those exist
 * only for a first-party app, whose name no outside app may take.
 */
function isOwnCatalogKey(name: string, key: string): boolean {
  return (
    key.startsWith(`apps.${name}.`) ||
    key.startsWith(`kernel.appSettings.${name}.`) ||
    key === `kernel.nav.${name}` ||
    key === `kernel.nav.app.${name}`
  )
}

/** Every catalog key the manifest names, with the path of the field naming it. */
function catalogKeyClaims(value: unknown, path: string, out: Array<[string, unknown]>): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) catalogKeyClaims(item, `${path}[${index}]`, out)
    return
  }
  if (value === null || typeof value !== "object") return
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === "" ? key : `${path}.${key}`
    if (CATALOG_KEY_FIELDS.has(key)) out.push([childPath, child])
    else catalogKeyClaims(child, childPath, out)
  }
}

/** The package's `app.manifest.json` as written (verifyAppPackage has parsed it already). */
function manifestFile(stagingDir: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(join(stagingDir, "app.manifest.json"), "utf8")))
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Every label the shell shows for an app, with the field it comes from: its
 * name and display name, rail entry, tabs, panels, contributions, slot panels
 * and settings sections.
 */
function shownLabels(m: Record<string, unknown>): Array<[string, unknown]> {
  const views = record(m.views)
  const activityBar = record(views.activityBar)
  const claims: Array<[string, unknown]> = [
    ["name", m.name],
    ["display name", m.displayName],
    ["activity-bar label", activityBar.label],
    ["tab label", record(activityBar.tabAction).label],
  ]
  for (const tab of Object.values(record(views.tabTypes)))
    claims.push(["tab label", record(tab).label])
  for (const panel of Object.values(record(views.panels))) {
    claims.push(["panel label", record(panel).label])
  }
  for (const contribution of Object.values(record(m.contributions))) {
    claims.push(["contribution label", record(contribution).label])
  }
  const slotLabels = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(slotLabels)
    else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (key === "label") claims.push(["slot label", child])
        else slotLabels(child)
      }
    }
  }
  slotLabels(m.slots)
  const sections = record(m.settings).sections
  for (const section of Array.isArray(sections) ? sections : []) {
    claims.push(["settings section title", record(section).title])
  }
  return claims
}

/** Publishers no outside app may name as its own, beside every first-party app's. */
const RESERVED_PUBLISHERS = ["Liaison"]

/**
 * As label skeletons: the name, display name and rail label of every first-party
 * app (`labels`), and its author and listing publisher with Liaison's own
 * (`publishers`).
 */
async function firstPartySkeletons(): Promise<{ labels: Set<string>; publishers: Set<string> }> {
  const labels = new Set<string>()
  const publishers = new Set<string>(RESERVED_PUBLISHERS.map(labelSkeleton))
  const add = (into: Set<string>, value: unknown) => {
    if (typeof value === "string" && value.trim() !== "") into.add(labelSkeleton(value))
  }
  for (const app of await discoverInTreeApps()) {
    add(labels, app.name)
    try {
      const manifest = JSON.parse(readFileSync(app.manifestPath, "utf8"))
      add(labels, manifest.displayName)
      add(labels, manifest.views?.activityBar?.label)
      add(publishers, manifest.author)
      add(publishers, manifest.listing?.publisher)
    } catch {
      // discoverInTreeApps already parsed it; an unreadable file keeps its name only.
    }
  }
  for (const entry of listCatalog()) {
    add(labels, entry.name)
    add(labels, entry.displayName)
    add(publishers, entry.author)
    add(publishers, entry.listing?.publisher)
  }
  return { labels, publishers }
}

/** Does `publisher`, or one of its words, read as a reserved publisher? */
function claimsReservedPublisher(publisher: string, reserved: Set<string>): boolean {
  if (reserved.has(labelSkeleton(publisher))) return true
  return publisher
    .normalize("NFKC")
    .split(/[\s\p{P}]+/u)
    .some((word) => word !== "" && reserved.has(labelSkeleton(word)))
}

/**
 * Reject a package named `kernel` (which the platform treats as itself in the
 * tool bridge and in user-data erasure) or after another kernel-owned key of
 * the org and user settings (an app's settings live at `settings.<app name>`,
 * so `integrations` would write the kernel's own state), or squatting the name of a first-party
 * catalog app. The image's own catalog tarball is exempt from the second rule:
 * it is the thing that name belongs to.
 *
 * An outside app (anything but the image's own catalog tarball) also may not
 * present itself as a first-party app or a Liaison page: every label the shell
 * shows for it is compared by skeleton (case, spacing, punctuation, accents,
 * invisible characters and look-alike letters aside) against first-party app
 * names and labels and the system labels, and every catalog key it names must
 * be under its own `apps.<name>.` namespace (A12).
 */
async function assertNameNotReserved(
  manifest: VerifyResult["manifest"],
  sha256: string,
  stagingDir: string,
): Promise<void> {
  const { name, version } = manifest
  if (isReservedSettingsNamespace(name)) {
    throw new Error(`Cannot install '${name}': that name is reserved by the platform.`)
  }
  // An app's tabs live at `/<name>`: named after a page route, it would own that page.
  if (isReservedWebRouteSegment(name)) {
    throw new Error(`Cannot install '${name}': that name is a Liaison page route.`)
  }
  if (isCatalogArtifact(name, version, sha256)) return
  if (listCatalog().some((e) => e.name === name)) {
    throw new Error(
      `Cannot install '${name}': it is the name of a first-party catalog app, and this package is not that app's own release.`,
    )
  }
  // The runtime registers views, contributions and settings from the file on disk; the
  // validated package manifest keeps only the distribution fields.
  const file = manifestFile(stagingDir)
  const keys: Array<[string, unknown]> = []
  catalogKeyClaims(file, "", keys)
  for (const [field, key] of keys) {
    if (typeof key === "string" && isOwnCatalogKey(name, key)) continue
    throw new Error(
      `Cannot install '${name}': its ${field} '${String(key)}' is not under its own namespace apps.${name}.`,
    )
  }
  const system = new Set(SYSTEM_LABELS.map(labelSkeleton))
  const { labels: firstParty, publishers } = await firstPartySkeletons()
  for (const [field, value] of shownLabels({ ...file, name, displayName: manifest.displayName })) {
    if (typeof value !== "string" || value.trim() === "") continue
    const key = labelSkeleton(value)
    if (key === "") continue
    if (system.has(key)) {
      throw new Error(
        `Cannot install '${name}': its ${field} '${value}' is reserved for a Liaison system page.`,
      )
    }
    if (firstParty.has(key)) {
      throw new Error(
        `Cannot install '${name}': its ${field} '${value}' is reserved for a first-party app.`,
      )
    }
  }
  // The App store shows an outside app's publisher as self-declared; it still may not
  // declare Liaison or a first-party publisher.
  const claimedPublishers: Array<[string, unknown]> = [
    ["author", manifest.author],
    ["listing publisher", manifest.listing?.publisher],
  ]
  for (const [field, value] of claimedPublishers) {
    if (typeof value !== "string" || !claimsReservedPublisher(value, publishers)) continue
    throw new Error(
      `Cannot install '${name}': its ${field} '${value}' is reserved for a first-party publisher.`,
    )
  }
}

/** Refuse an icon the client would not show as written (S1). */
function assertIconClean(manifest: VerifyResult["manifest"]): void {
  const errors = appIconErrors(manifest)
  if (errors.length > 0) throw new Error(`Cannot install '${manifest.name}': ${errors.join("; ")}`)
}

/**
 * Every other app's tool this package may call: its `cross_app_calls` targets and
 * its legacy `dependencies.tools` list (which also authorizes dispatch to an
 * internal tool), as one set the admin approves.
 */
export function declaredCrossAppCalls(manifest: VerifyResult["manifest"]): string[] {
  const m = manifest as {
    cross_app_calls?: Array<{ target?: string }>
    dependencies?: { tools?: unknown[] }
  }
  const targets = [
    ...(m.cross_app_calls ?? []).map((c) => c.target),
    ...(m.dependencies?.tools ?? []),
  ].filter((t): t is string => typeof t === "string")
  return [...new Set(targets)]
}

function resolveGrantedCrossAppCalls(
  manifest: VerifyResult["manifest"],
  granted: string[] | undefined,
): string[] {
  const declared = declaredCrossAppCalls(manifest)
  if (granted === undefined) return declared
  const missing = declared.filter((t) => !granted.includes(t))
  if (missing.length > 0) {
    throw new Error(
      `Install requires cross-app calls the admin did not approve: ${missing.join(", ")}. Re-run with these approved.`,
    )
  }
  return declared.filter((t) => granted.includes(t))
}

export function declaredCapabilities(manifest: VerifyResult["manifest"]): string[] {
  return ((manifest as { capabilities?: string[] }).capabilities ?? []).slice()
}

/**
 * Capabilities are kernel primitives the app may call, and they are part of the admin
 * grant exactly like scopes: every declared one must be known to this platform and
 * granted. `undefined` is the trusted programmatic path (all declared).
 */
function resolveGrantedCapabilities(
  manifest: VerifyResult["manifest"],
  granted: string[] | undefined,
): string[] {
  const declared = declaredCapabilities(manifest)
  const known = new Set<string>(KNOWN_CAPABILITIES)
  const unknown = declared.filter((c) => !known.has(c))
  if (unknown.length > 0) {
    throw new Error(`Package declares unknown capabilities: ${unknown.join(", ")}`)
  }
  if (granted === undefined) return declared
  const missing = declared.filter((c) => !granted.includes(c))
  if (missing.length > 0) {
    throw new Error(
      `Install requires capabilities the admin did not grant: ${missing.join(", ")}. Re-run with these capabilities granted.`,
    )
  }
  // Store exactly what the manifest declares and the admin granted, nothing extra.
  return declared.filter((c) => granted.includes(c))
}

/**
 * Every trigger a package's schema declares, as `{table, name, body}`. Read from
 * the manifest file itself: the validated package manifest keeps only the
 * distribution fields, while the runtime registers tables (and their triggers)
 * from the file on disk.
 */
function declaredTriggers(
  stagingDir: string,
): Array<{ table: string; name: string; body: string }> {
  let raw: { schema?: Record<string, { triggers?: Record<string, unknown> }> }
  try {
    raw = JSON.parse(readFileSync(join(stagingDir, "app.manifest.json"), "utf8"))
  } catch {
    return []
  }
  const schema = raw.schema
  const out: Array<{ table: string; name: string; body: string }> = []
  for (const [table, def] of Object.entries(schema ?? {})) {
    for (const [name, trg] of Object.entries(def?.triggers ?? {})) {
      out.push({ table, name, body: String((trg as { body?: unknown })?.body ?? "") })
    }
  }
  return out
}

/**
 * Triggers are free-form PL/pgSQL that runs inside the writer's RLS transaction,
 * with the writer's database privileges, where the RLS context is a plain GUC the
 * trigger body can overwrite. So a package may ship them only when the platform
 * (its own catalog artifact) or the operator (a verified trusted-publisher
 * signature) vouches for it, and even then each body is statically reviewed.
 */
function assertTriggersAllowed(
  manifest: VerifyResult["manifest"],
  stagingDir: string,
  vouched: boolean,
): void {
  const triggers = declaredTriggers(stagingDir)
  if (triggers.length === 0) return
  if (!vouched) {
    throw new Error(
      `Package '${manifest.name}' declares database triggers (${triggers.map((t) => `${t.table}.${t.name}`).join(", ")}). ` +
        "Triggers run as SQL inside request transactions, so only first-party packages or packages signed by a trusted publisher may ship them.",
    )
  }
  const schemaName = `app_${manifest.name.replace(/-/g, "_")}`
  for (const t of triggers) reviewTriggerBody(t.body, schemaName, `${t.table}.${t.name}`)
}

/** The `schema` a package's manifest file declares (tables and their fields). */
function declaredSchema(stagingDir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(stagingDir, "app.manifest.json"), "utf8")).schema
  } catch {
    return undefined
  }
}

/**
 * The additive data rule (additive-schema.ts) for any package that differs from
 * the running one: a newer version, the same version rebuilt, or a deliberate
 * downgrade. A running manifest that cannot be read fails closed, except for the
 * image's own catalog artifact, whose repair after a container rebuild (files
 * gone, rows kept) is exactly that case.
 */
async function assertAdditiveOverRunning(
  name: string,
  runningVersion: string,
  nextVersion: string,
  sha256: string,
  stagingDir: string,
): Promise<void> {
  const [running] = await withSystemDb("install-running-sha", (db) =>
    db
      .select({ sha256: appsInstalled.sha256, manifestSchema: appsInstalled.manifestSchema })
      .from(appsInstalled)
      .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, runningVersion)))
      .limit(1),
  )
  if (running?.sha256 === sha256) return
  const manifest = readInstalledManifest(name, runningVersion)
  if (!manifest && running?.manifestSchema) {
    // The files are gone (an install root that was not kept), but the install
    // recorded the schema it declared: the rule is checked against that.
    assertAdditiveSchema(
      name,
      runningVersion,
      nextVersion,
      running.manifestSchema.schema,
      declaredSchema(stagingDir),
    )
    return
  }
  if (!manifest) {
    if (isCatalogArtifact(name, nextVersion, sha256)) {
      log.warn(
        { app: name, running: runningVersion, next: nextVersion },
        "Running app version has no manifest on disk and no recorded schema: repairing from the image's catalog without the additive check",
      )
      return
    }
    throw new Error(
      `Cannot move '${name}' from ${runningVersion} to ${nextVersion}: the running version's manifest cannot be read, so the additive data rule cannot be checked. Reinstall ${runningVersion} first.`,
    )
  }
  assertAdditiveSchema(
    name,
    runningVersion,
    nextVersion,
    manifest.schema,
    declaredSchema(stagingDir),
  )
}

function operator(installedBy: string): ActivationActor {
  return { id: installedBy, kind: "operator" }
}

/**
 * Activate the just-recorded version, then keep only the active version, the
 * one before it and any version a live process loads (versions-in-use.ts):
 * their files and rows stay, every other version of the app goes.
 * Runs after a failed activation too (the failed version is pruned with the rest)
 * and rethrows its error.
 */
async function activateAndPrune(
  name: string,
  version: string,
  actor: ActivationActor,
  placeAndRecord: () => Promise<void>,
): Promise<void> {
  // Placing the files and recording the row run inside the app's activation
  // lock, before the activation, so an uninstall or another activation of the
  // app never interleaves with them. The prune runs inside the lock after it,
  // success or not.
  await activateAppVersion(name, version, actor, {
    beforeActivate: placeAndRecord,
    afterSwitch: () => pruneOldVersions(name),
  })
}

async function pruneOldVersions(name: string): Promise<void> {
  const [pointer] = await withSystemDb("prune-app-versions", (db) =>
    db
      .select({ version: appsActiveVersion.version, previous: appsActiveVersion.previousVersion })
      .from(appsActiveVersion)
      .where(eq(appsActiveVersion.name, name))
      .limit(1),
  )
  // A version a live process loads (an old release beside a newer one, also
  // after a rolled-back deploy) stays too; unknown = keep everything.
  const inUse = await versionsInUse(name)
  if (!inUse) {
    log.warn({ app: name }, "Pruning old app versions skipped: the versions in use are unknown")
    return
  }
  const keep = [
    ...new Set([pointer?.version, pointer?.previous, ...inUse].filter((v): v is string => !!v)),
  ]
  const pruned = await withSystemDb("prune-app-version-rows", (db) =>
    db
      .delete(appsInstalled)
      .where(
        keep.length > 0
          ? and(eq(appsInstalled.name, name), notInArray(appsInstalled.version, keep))
          : eq(appsInstalled.name, name),
      )
      .returning({ version: appsInstalled.version }),
  )
  // Their stored packages go with the rows (a version kept stays stored).
  for (const row of pruned) {
    if (!keep.includes(row.version)) await deleteStoredPackage(name, row.version)
  }
  const appRoot = join(getInstallRoot(), name)
  if (!existsSync(appRoot)) return
  for (const entry of readdirSync(appRoot)) {
    // A transient dir is another unpack in progress (version-dir.ts); only a
    // stale one, left by a process that died, is removed.
    if (isTransientDir(entry)) continue
    if (!keep.includes(entry)) rmSync(join(appRoot, entry), { recursive: true, force: true })
  }
  sweepTransientDirs(appRoot)
}

/**
 * Install a `.liaisonapp` from a local tarball: verify, enforce grants, unpack
 * to `<installRoot>/<name>/<version>/`, and record the DB rows.
 */
export async function installAppFromTarball(opts: InstallOptions): Promise<InstallResult> {
  const verified = await verifyAppPackage(opts.tarballPath, {
    requireSignature: opts.requireSignature,
    cosignIdentityRegex: opts.cosignIdentityRegex,
    signatureBundlePath: opts.signatureBundlePath,
  })
  try {
    const { manifest } = verified
    // `packageManifestSchema` already enforces `trusted: z.literal(false).optional()`,
    // so this point is unreachable with `trusted: true`. No runtime coercion needed.

    assertHostApiCompatible(manifest)
    assertIconClean(manifest)
    await assertNotBundled(manifest.name)
    const ownerOrgId = ownOption(opts, "ownerOrgId") ?? null
    const workerModule = installWorkerModule(ownOption(opts, "workerModule"), ownerOrgId)
    await assertOrgOwnership(manifest.name, ownerOrgId, manifestFile(verified.stagingDir))
    await assertNameNotReserved(manifest, verified.sha256, verified.stagingDir)
    await assertTabRoutesOwned(manifest.name, manifestFile(verified.stagingDir))
    assertScopesGranted(manifest.scopes, opts.grantedScopes)
    const grantedCapabilities = resolveGrantedCapabilities(manifest, opts.grantedCapabilities)
    const grantedCrossAppCalls = resolveGrantedCrossAppCalls(manifest, opts.grantedCrossAppCalls)
    assertTriggersAllowed(
      manifest,
      verified.stagingDir,
      isCatalogArtifact(manifest.name, manifest.version, verified.sha256) ||
        !!verified.signatureBundle,
    )
    const uiApproval = opts.approveUiFullAccess
      ? { uiFullAccessApprovedBy: opts.installedBy, uiFullAccessApprovedAt: new Date() }
      : { uiFullAccessApprovedBy: null, uiFullAccessApprovedAt: null }
    // Installing over an active version switches to the new one, so it is held to
    // the upgrade rule: never to an OLDER version unless the admin asked for a
    // rollback. The same version re-installs in place; the image's own catalog
    // artifact may move either way (an image rollback ships an older catalog).
    const [active] = await withSystemDb("install-active-version", (db) =>
      db
        .select({ version: appsActiveVersion.version })
        .from(appsActiveVersion)
        .where(eq(appsActiveVersion.name, manifest.name))
        .limit(1),
    )
    if (
      ownOption(opts, "allowDowngrade") !== true &&
      !isCatalogArtifact(manifest.name, manifest.version, verified.sha256)
    ) {
      if (
        active &&
        active.version !== manifest.version &&
        !isNewerVersion(manifest.version, active.version)
      ) {
        throw new Error(
          `Refusing to install '${manifest.name}' ${manifest.version} over the active ${active.version}: the package is older. Pass allowDowngrade to roll back deliberately.`,
        )
      }
    }

    // The image's own catalog may move an app either way, except down from a
    // newer active version: during a rolling deploy that version was set by the
    // new release, and an old process must never undo it (an operator rolls
    // back deliberately with allowDowngrade).
    if (
      ownOption(opts, "allowDowngrade") !== true &&
      active &&
      isNewerVersion(active.version, manifest.version) &&
      isCatalogArtifact(manifest.name, manifest.version, verified.sha256)
    ) {
      throw new Error(
        `Refusing to install '${manifest.name}' ${manifest.version} from this image's catalog: the active ${active.version} is newer (set by a newer release). Pass allowDowngrade to roll back deliberately.`,
      )
    }

    if (active) {
      await assertAdditiveOverRunning(
        manifest.name,
        active.version,
        manifest.version,
        verified.sha256,
        verified.stagingDir,
      )
    }

    // Stored once for the instance (package-store.ts): every other process
    // materialises the version from it. A store that refuses it fails the
    // install with no half state (a catalog repair goes on, `storeBestEffort`).
    const placeAndRecord = () =>
      withStoredPackage(
        {
          name: manifest.name,
          version: manifest.version,
          tarballPath: opts.tarballPath,
          bestEffort: opts.storeBestEffort,
        },
        () => recordInstall(),
      )
    const recordInstall = async () => {
      const installRoot = getInstallRoot()
      const versionDir = join(installRoot, manifest.name, manifest.version)
      placeVersionDir(installRoot, manifest.name, manifest.version, verified.stagingDir)
      const manifestSchema = { schema: declaredSchema(verified.stagingDir) ?? null }

      // PDF templates are sandboxed (run in QuickJS, host replays a validated
      // draw-command list), so ANY app may ship them. Persist the emitted sandbox
      // bundle TEXT (not the manifest's .ts path) so registry-rehydrate can warm
      // the in-memory registry on boot.
      const pdfTemplates = readPdfTemplateBundles(manifest, versionDir)

      await withSystemDb("install-app", async (db) => {
        // A new custom app takes one of the org's `customApps`, under the org's
        // cap lock, in the transaction that writes its row.
        if (ownerOrgId !== null) {
          const [own] = await db
            .select({ name: appsInstalled.name })
            .from(appsInstalled)
            .where(and(eq(appsInstalled.name, manifest.name), eq(appsInstalled.orgId, ownerOrgId)))
            .limit(1)
          if (!own) await assertCustomAppRoom(db, ownerOrgId)
        }
        // Idempotent per (name, version): a re-install of the SAME version
        // overwrites the row in place (documented contract). Without this, a single
        // `config apply` that lists one app across several entries (e.g. `social`
        // once per OAuth connection) throws a duplicate-key error on the second
        // entry when the run also performs a version upgrade -- the first entry has
        // already inserted the new (name, version) row.
        await db
          .insert(appsInstalled)
          .values({
            name: manifest.name,
            version: manifest.version,
            sourceUrl: opts.sourceUrl ?? opts.tarballPath,
            updateUrl: manifest.updateUrl ?? null,
            sha256: verified.sha256,
            signatureBundle: verified.signatureBundle ?? null,
            grantedScopes: opts.grantedScopes,
            grantedConnections: opts.grantedConnections ?? [],
            grantedCapabilities,
            grantedCrossAppCalls,
            ...uiApproval,
            installedBy: opts.installedBy,
            pdfTemplates,
            manifestSchema,
            orgId: ownerOrgId,
            ...workerModule,
          })
          .onConflictDoUpdate({
            target: [appsInstalled.name, appsInstalled.version],
            set: {
              sourceUrl: opts.sourceUrl ?? opts.tarballPath,
              updateUrl: manifest.updateUrl ?? null,
              sha256: verified.sha256,
              signatureBundle: verified.signatureBundle ?? null,
              grantedScopes: opts.grantedScopes,
              grantedConnections: opts.grantedConnections ?? [],
              grantedCapabilities,
              grantedCrossAppCalls,
              ...uiApproval,
              installedBy: opts.installedBy,
              pdfTemplates,
              manifestSchema,
              ...workerModule,
            },
          })
      })
      // The install row (grants, vouchers, owner) changed: getDefaultApps reads it again.
      invalidateAppOrgScope()
      bumpCatalogGeneration()
    }

    await activateAndPrune(
      manifest.name,
      manifest.version,
      opts.actor ?? operator(opts.installedBy),
      placeAndRecord,
    )
    return { name: manifest.name, version: manifest.version }
  } finally {
    rmSync(verified.stagingDir, { recursive: true, force: true })
  }
}

/** The install row's Workers module columns: both set (checked), or both NULL. */
function installWorkerModule(
  given: InstallOptions["workerModule"],
  ownerOrgId: string | null,
): { workerSha256: string | null; workerModule: Uint8Array | null } {
  if (!given) return { workerSha256: null, workerModule: null }
  if (ownerOrgId === null) {
    throw new Error("A Workers module is recorded for an organisation's custom app only")
  }
  if (!/^[0-9a-f]{64}$/.test(given.sha256)) throw new Error("Workers module sha256 is malformed")
  const actual = createHash("sha256").update(given.bytes).digest("hex")
  if (actual !== given.sha256) {
    throw new Error("Workers module bytes do not match their sha256")
  }
  return { workerSha256: given.sha256, workerModule: given.bytes }
}

/**
 * Install an org's custom app from package bytes held by the server (the app
 * builder's publish, modules/app-builder/publish.ts): the bytes go to a temp
 * file and through exactly the path `POST /custom/install` takes
 * (`installAppFromTarball` with the org as owner, unsigned, the 30 s health
 * gate and switch-back of the activation), with the grants given and never a
 * session-trusted interface: its ui.js only ever runs framed.
 */
export async function installAppFromBytes(opts: {
  bytes: Uint8Array
  ownerOrgId: string
  installedBy: string
  grantedScopes: string[]
  grantedConnections: string[]
  grantedCapabilities: string[]
  grantedCrossAppCalls: string[]
  sourceUrl: string
  /** The Workers module the same build produced (see InstallOptions.workerModule). */
  workerModule?: { sha256: string; bytes: Uint8Array }
}): Promise<InstallResult> {
  const dir = mkdtempSync(join(tmpdir(), "liaison-app-bytes-"))
  try {
    const tarballPath = join(dir, "package.liaisonapp")
    writeFileSync(tarballPath, opts.bytes)
    return await installAppFromTarball({
      tarballPath,
      installedBy: opts.installedBy,
      grantedScopes: opts.grantedScopes,
      grantedConnections: opts.grantedConnections,
      grantedCapabilities: opts.grantedCapabilities,
      grantedCrossAppCalls: opts.grantedCrossAppCalls,
      approveUiFullAccess: false,
      requireSignature: false,
      sourceUrl: opts.sourceUrl,
      ownerOrgId: opts.ownerOrgId,
      ...(opts.workerModule ? { workerModule: opts.workerModule } : {}),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Preview an upgrade: verify the new package, diff its scopes against the
 * currently-granted scopes, and return the diff. Pure — no disk or DB mutation.
 */
export async function previewUpgrade(opts: PreviewUpgradeOptions): Promise<PreviewUpgradeResult> {
  const verified = await verifyAppPackage(opts.tarballPath, {
    requireSignature: opts.requireSignature,
    cosignIdentityRegex: opts.cosignIdentityRegex,
    signatureBundlePath: opts.signatureBundlePath,
  })
  try {
    const { manifest } = verified
    if (manifest.name !== opts.name) {
      throw new Error(`Upgrade package is for '${manifest.name}', not '${opts.name}'`)
    }
    const current = await withSystemDb("preview-upgrade", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, opts.name)),
    )
    if (current.length === 0) {
      throw new Error(`Cannot upgrade '${opts.name}': not installed`)
    }
    const activeRows = await withSystemDb("preview-upgrade-scopes", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, opts.name)),
    )
    const active = activeRows.find((r) => r.version === current[0].version)
    const grantedScopes = active?.grantedScopes ?? []
    const newScopes = manifest.scopes.filter((s) => !grantedScopes.includes(s))
    const removedScopes = grantedScopes.filter((s) => !manifest.scopes.includes(s))
    // A grandfathered install (NULL grant) was running every capability it declared
    // at the time; nothing it still declares is "new" for it.
    const declared = declaredCapabilities(manifest)
    const grantedCaps = active?.grantedCapabilities
    const newCapabilities = grantedCaps ? declared.filter((c) => !grantedCaps.includes(c)) : []
    const grantedCalls = active?.grantedCrossAppCalls
    const newCrossAppCalls = grantedCalls
      ? declaredCrossAppCalls(manifest).filter((t) => !grantedCalls.includes(t))
      : []
    return {
      hasUiBundle: existsSync(join(verified.stagingDir, "ui.js")),
      signatureVerified: !!verified.signatureBundle,
      newCapabilities,
      newCrossAppCalls,
      newScopes,
      removedScopes,
      previouslyGranted: grantedScopes,
      manifest,
    }
  } finally {
    rmSync(verified.stagingDir, { recursive: true, force: true })
  }
}

/**
 * Apply an upgrade: unpack the new version beside the running one, record its
 * row, then activate it (activation.ts: pointer swap, live re-registration,
 * health gate, switch-back on failure). The version that ran before stays on
 * disk as the previous version; older ones are pruned.
 */
export async function applyUpgrade(opts: ApplyUpgradeOptions): Promise<InstallResult> {
  const verified = await verifyAppPackage(opts.tarballPath, {
    requireSignature: opts.requireSignature,
    cosignIdentityRegex: opts.cosignIdentityRegex,
    signatureBundlePath: opts.signatureBundlePath,
  })
  try {
    const { manifest } = verified
    ;(manifest as { trusted?: boolean }).trusted = false
    if (manifest.name !== opts.name) {
      throw new Error(`Upgrade package is for '${manifest.name}', not '${opts.name}'`)
    }
    assertHostApiCompatible(manifest)
    assertIconClean(manifest)
    await assertNotBundled(manifest.name)
    // An org's custom app upgrades under the same rules and stays that org's.
    const upgradeOwner = await currentOwnerOf(manifest.name)
    await assertOrgOwnership(manifest.name, upgradeOwner, manifestFile(verified.stagingDir))
    await assertNameNotReserved(manifest, verified.sha256, verified.stagingDir)
    await assertTabRoutesOwned(manifest.name, manifestFile(verified.stagingDir))
    // Every manifest scope — old or new — must be in the granted set. If a new
    // scope is missing, the caller (CLI / admin UI) must re-prompt and retry.
    const missing = manifest.scopes.filter((s) => !opts.grantedScopes.includes(s))
    if (missing.length > 0) {
      throw new Error(
        `Upgrade requires new scopes not granted: ${missing.join(", ")}. Grant them and retry.`,
      )
    }

    const installRoot = getInstallRoot()
    const current = await withSystemDb("apply-upgrade-current", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, opts.name)),
    )
    if (current.length === 0) {
      throw new Error(`Cannot upgrade '${opts.name}': not installed`)
    }
    const oldVersion = current[0].version
    if (
      ownOption(opts, "allowDowngrade") !== true &&
      !isNewerVersion(manifest.version, oldVersion)
    ) {
      throw new Error(
        `Refusing to upgrade '${opts.name}' from ${oldVersion} to ${manifest.version}: the package is not newer. A replayed older signed package would reintroduce fixed defects (pass allowDowngrade to roll back deliberately).`,
      )
    }
    await assertAdditiveOverRunning(
      manifest.name,
      oldVersion,
      manifest.version,
      verified.sha256,
      verified.stagingDir,
    )
    const grantedCapabilities = resolveGrantedCapabilities(manifest, opts.grantedCapabilities)
    const grantedCrossAppCalls = resolveGrantedCrossAppCalls(manifest, opts.grantedCrossAppCalls)
    assertTriggersAllowed(
      manifest,
      verified.stagingDir,
      isCatalogArtifact(manifest.name, manifest.version, verified.sha256) ||
        !!verified.signatureBundle,
    )
    // An approval covers the exact bytes the admin looked at: a new version needs a
    // new one (a signed or first-party package needs none).
    const uiApproval = opts.approveUiFullAccess
      ? { uiFullAccessApprovedBy: opts.installedBy, uiFullAccessApprovedAt: new Date() }
      : { uiFullAccessApprovedBy: null, uiFullAccessApprovedAt: null }

    // Stored once for the instance (package-store.ts), unpacked alongside the
    // old version and recorded, inside the app's activation lock. An upgrade
    // whose package cannot be stored fails before anything is placed.
    const recordUpgrade = async () => {
      const newVersionDir = join(installRoot, manifest.name, manifest.version)
      const placed = placeVersionDir(
        installRoot,
        manifest.name,
        manifest.version,
        verified.stagingDir,
      )

      // Persist the new version's emitted sandbox PDF template bundles (sandboxed
      // execution → any app may ship them).
      const pdfTemplates = readPdfTemplateBundles(manifest, newVersionDir)

      // Record the new version's row (in place when this version was kept as the
      // previous one); the running version keeps its own.
      const row = {
        sourceUrl: opts.sourceUrl ?? opts.tarballPath,
        updateUrl: manifest.updateUrl ?? null,
        sha256: verified.sha256,
        signatureBundle: verified.signatureBundle ?? null,
        grantedScopes: opts.grantedScopes,
        grantedConnections: opts.grantedConnections ?? [],
        grantedCapabilities,
        grantedCrossAppCalls,
        ...uiApproval,
        installedBy: opts.installedBy,
        pdfTemplates,
        manifestSchema: { schema: declaredSchema(verified.stagingDir) ?? null },
        orgId: upgradeOwner,
      }
      try {
        await withSystemDb("apply-upgrade-row", (db) =>
          db
            .insert(appsInstalled)
            .values({ name: manifest.name, version: manifest.version, ...row })
            .onConflictDoUpdate({ target: [appsInstalled.name, appsInstalled.version], set: row }),
        )
      } catch (e) {
        // Recording failed: remove the version dir this call wrote (never one that
        // was already there, which a process may be loading); the old stays intact.
        if (placed === "placed") rmSync(newVersionDir, { recursive: true, force: true })
        throw e
      }
      bumpCatalogGeneration()
    }

    await activateAndPrune(
      manifest.name,
      manifest.version,
      opts.actor ?? operator(opts.installedBy),
      () =>
        withStoredPackage(
          { name: manifest.name, version: manifest.version, tarballPath: opts.tarballPath },
          recordUpgrade,
        ),
    )
    return { name: manifest.name, version: manifest.version }
  } finally {
    rmSync(verified.stagingDir, { recursive: true, force: true })
  }
}

export interface UninstallOptions {
  name: string
}

/** Uninstall an app: remove all its DB rows and its install directory. */
export async function uninstallApp(opts: UninstallOptions): Promise<void> {
  // Bundled (in-tree) apps ship with the distribution and re-register on every
  // server start — they have no `appsInstalled` row, so this DELETE would remove
  // nothing, yet `unregisterAppEverywhere` below would still tear down their live
  // handlers (a runtime DoS until restart) and the route would return a misleading
  // success. Reject symmetrically with the install path (`assertNotBundled`); the
  // admin UI already hides Uninstall for bundled rows.
  const bundled = await discoverInTreeApps()
  if (bundled.some((a) => a.name === opts.name)) {
    throw new HTTPException(409, {
      message: `Cannot uninstall '${opts.name}': it is a bundled app (part of the distribution; it re-registers on restart). Bundled apps are not uninstallable.`,
    })
  }

  // Defense-in-depth path containment: the route validates `:name`, but assert
  // the resolved install dir stays under the install root before any rmSync —
  // a crafted name must never delete a tree outside `<installRoot>/<name>/`.
  const installRoot = getInstallRoot()
  const appDir = join(installRoot, opts.name)
  if (!resolve(appDir).startsWith(resolve(installRoot) + sep)) {
    throw new Error(`Refusing to uninstall '${opts.name}': path escapes the install root`)
  }
  // Under the app's activation lock: an install or activation of the app in
  // flight anywhere finishes first, and none starts until this one is done.
  await withAppActivationLock(opts.name, async () => {
    await withSystemDb("uninstall-app", async (db) => {
      await db.delete(appsInstalled).where(eq(appsInstalled.name, opts.name))
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, opts.name))
    })
    invalidateAppOrgScope()
    bumpCatalogGeneration()
    // Its cron fan-out schedulers go with it (best effort; the leader's
    // reconcile removes any left behind).
    const { removeAppCronFanout } = await import("~/infra/jobs/fanout-runtime")
    await removeAppCronFanout(opts.name)

    // Tear down every in-memory registry the runtime populated for this app
    // (tool/webhook/external-search handlers, declaredEmits, entity/view/slot/
    // contribution/attention/connection registries, and event subscriptions).
    // Without this, an uninstall leaves stale handlers wired into the live
    // process — webhooks keep dispatching, declaredEmits keep validating, and a
    // reinstall stacks duplicate subscriptions. Dynamically imported to avoid a
    // static import cycle (runtime.ts is a heavy module).
    try {
      const { unregisterAppEverywhere } = await import("~/modules/apps/runtime")
      await unregisterAppEverywhere(opts.name)
    } catch (err) {
      log.warn({ err, app: opts.name }, "Failed to fully unregister app from in-memory registries")
    }

    rmSync(appDir, { recursive: true, force: true })
    await deleteStoredPackages(opts.name)
  })
  // After the lock's transaction committed: every other server process
  // unregisters it and deletes its own files (activation.ts
  // syncActiveVersionsFromDb reads the database; no payload).
  announceActiveVersions(opts.name)
  log.info({ app: opts.name }, "Uninstalled app")
}
