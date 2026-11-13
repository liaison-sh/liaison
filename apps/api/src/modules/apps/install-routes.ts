// SPDX-License-Identifier: FSL-1.1-ALv2
// Hono routes for runtime app install / upgrade / uninstall and the registry
// listing consumed by the `liaison app` CLI and the admin UI.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AppRegistryEntry } from "@liaison/app-sdk"
import { and, eq } from "drizzle-orm"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import type { AppEnv } from "~/app"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { customAppsEnabled } from "~/lib/edition"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { fetchWithPinnedHost, UnsafeOutboundUrlError } from "~/lib/outbound-fetch"
import { readStreamCapped } from "~/lib/read-capped-body"
import { success } from "~/lib/response"
import { requireScope } from "~/middleware/require-scope"
import {
  AppActivationError,
  isNewerVersion as isVersionNewer,
  listAppVersionStates,
  readInstalledManifest,
  rollbackApp,
} from "~/modules/apps/activation"
import {
  appOwnerOrg,
  appVisibleToOrg,
  CustomAppDisabledError,
  customAppOrgKey,
  expectedCustomAppName,
  isCustomAppDisabled,
  isOrgPrivateApp,
} from "~/modules/apps/app-org-scope"
import {
  assertValidAppName,
  installFromCatalog,
  listMergedCatalog,
} from "~/modules/apps/catalog-sources"
import { isCoreApp } from "~/modules/apps/core/registry"
import { discoverInTreeApps, getInstallRoot } from "~/modules/apps/discover-apps"
import {
  declaredDomains,
  grantedSubset,
  normalizeDomain,
  pendingDomains,
} from "~/modules/apps/egress-grants"
import {
  applyUpgrade,
  installAppFromTarball,
  previewUpgrade,
  uninstallApp,
} from "~/modules/apps/install-service"
import { getInstallTrust, resetInstallTrustCache } from "~/modules/apps/install-trust"
import {
  assertCanManageInstanceApps,
  canManageInstanceApps,
  requireInstanceOperator,
} from "~/modules/apps/operator-org"
import { otherWorkspacesWithApp } from "~/modules/apps/org-app-admin"
import { peekOrgAppState, primeOrgApps } from "~/modules/apps/org-apps"
import {
  isMatchAllIdentityRegex,
  MAX_PACKAGE_BYTES,
  MAX_SIGNATURE_BUNDLE_BYTES,
  verifyAppPackage,
} from "~/modules/apps/verify-package"
import { writeAuditLog } from "~/modules/audit/service"

export const installRoutes = new Hono<AppEnv>()

// Runtime app management is instance-wide while `kernel:apps:admin` is org-scoped,
// so on a multi-tenant instance (demo mode, managed edition) every route that
// changes the installs is also confined to the instance operator's org
// (operator-org.ts); a single-org self-host is not restricted. It is mounted per route, never with
// `use("*")`: this router shares the `/api/apps` prefix with every app's own
// routes, and a wildcard here would run in front of all of them.

/** Production default: require signed packages. Local dev can opt out. */
function requireSignatureDefault(): boolean {
  return env.LIAISON_REQUIRE_APP_SIGNATURE !== "false"
}

function trustedPublisherRegex(): string | undefined {
  return env.LIAISON_TRUSTED_APP_PUBLISHERS || undefined
}

/**
 * Resolve the signature-verification config for an install/upgrade request and
 * fail LOUDLY on the operator-trap misconfiguration: signature verification is
 * required (`LIAISON_REQUIRE_APP_SIGNATURE !== "false"`) but no usable trusted-
 * publisher identity is configured (`LIAISON_TRUSTED_APP_PUBLISHERS` empty or a
 * `.*` wildcard, which `verifyAppPackage` also refuses). Without this guard the
 * downstream verifier throws a bare `Error`, which the error handler flattens to
 * an opaque 500 — pushing operators to disable signing entirely (the security
 * control). Instead, surface an actionable 400 that names the env var to set.
 */
function resolveSignatureConfig(): { requireSignature: boolean; cosignIdentityRegex?: string } {
  const requireSignature = requireSignatureDefault()
  const cosignIdentityRegex = trustedPublisherRegex()
  if (requireSignature && (!cosignIdentityRegex || isMatchAllIdentityRegex(cosignIdentityRegex))) {
    throw new HTTPException(400, {
      message:
        "App signature verification is required but no trusted publisher is configured. " +
        "Set LIAISON_TRUSTED_APP_PUBLISHERS to a cosign certificate-identity regex " +
        "(e.g. 'https://github.com/your-org/.*'; it is matched against the WHOLE identity, " +
        "anchored as ^(?:...)$) — a match-everything wildcard is refused. " +
        "To run an unsigned/dev instance instead, set LIAISON_REQUIRE_APP_SIGNATURE=false. " +
        "Do not disable signing just to work around this message.",
    })
  }
  return { requireSignature, cosignIdentityRegex }
}

/**
 * The signature rule of an app's upgrade: an org's custom app is the org's own
 * code under the tenant boundary (app-org-scope.ts), never a trusted
 * publisher's, so it needs no signature; any other app keeps the instance rule.
 */
async function signatureConfigFor(
  name: string,
): Promise<{ requireSignature: boolean; cosignIdentityRegex?: string }> {
  return (await isOrgPrivateApp(name)) ? { requireSignature: false } : resolveSignatureConfig()
}

/**
 * The gate of the routes that act on ONE installed app by name. An org's
 * custom app is managed by its own org alone: any other org, the
 * operator's included, gets 404 as if it did not exist. Every other app keeps
 * the instance-operator rule (`requireInstanceOperator`).
 */
const requireAppManager = createMiddleware<AppEnv>(async (c, next) => {
  const name = c.req.param("name") ?? ""
  if (await isOrgPrivateApp(name)) {
    if ((await appOwnerOrg(name)) !== c.get("orgId")) {
      throw new HTTPException(404, { message: `App '${name}' is not installed` })
    }
  } else {
    await assertCanManageInstanceApps(c.get("orgId"))
  }
  await next()
})

/** Fetch a `.liaisonapp` (or its sibling cosign signature) via the shared
 *  outbound-fetch layer — DNS pinning, private-IP block, manual redirect
 *  re-validation, and IMDS protection are all implemented in `fetchWithPinnedHost`.
 *  We translate its SSRF errors to HTTP 400 so the CLI surfaces a clean 400. */
async function safeFetch(url: string): Promise<Response> {
  try {
    // A test run serves its packages from loopback (no effect outside NODE_ENV=test).
    return await fetchWithPinnedHost(url, { method: "GET" }, { allowPrivateHostsInTest: true })
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new HTTPException(400, { message: err.message })
    }
    throw err
  }
}

/** Read a response body into a Buffer, refusing as soon as it exceeds `limit` bytes. */
async function readBodyWithLimit(res: Response, limit: number, what: string): Promise<Buffer> {
  const tooLarge = () =>
    new HTTPException(413, { message: `${what} is too large (limit ${limit} bytes)` })
  const declared = Number(res.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {})
    throw tooLarge()
  }
  if (!res.body) return Buffer.alloc(0)
  const bytes = await readStreamCapped(res.body, limit)
  if (!bytes) throw tooLarge()
  return bytes
}

/**
 * Download a `.liaisonapp` from a URL into a fresh temp dir, along with its
 * detached cosign signature (`<url>.cosign.bundle`) if the publisher provides
 * one. The URL and every redirect hop are SSRF-validated. Caller cleans up `dir`.
 */
async function downloadTarball(
  url: string,
): Promise<{ path: string; signaturePath?: string; dir: string }> {
  const res = await safeFetch(url)
  if (!res.ok) {
    throw new HTTPException(400, {
      message: `Failed to download package from ${url}: ${res.status}`,
    })
  }
  const dir = mkdtempSync(join(tmpdir(), "liaison-dl-"))
  try {
    return await writeDownload(dir, url, res)
  } catch (err) {
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}

async function writeDownload(
  dir: string,
  url: string,
  res: Response,
): Promise<{ path: string; signaturePath?: string; dir: string }> {
  const path = join(dir, "package.liaisonapp")
  writeFileSync(path, await readBodyWithLimit(res, MAX_PACKAGE_BYTES, "Package"))

  // Detached signature is a sibling artifact: `<url>.cosign.bundle`. Absence is
  // not an error here — `verifyAppPackage` enforces the require-signature policy.
  let signaturePath: string | undefined
  const sigRes = await safeFetch(`${url}.cosign.bundle`).catch(() => null)
  if (sigRes?.ok) {
    signaturePath = `${path}.cosign.bundle`
    writeFileSync(
      signaturePath,
      await readBodyWithLimit(sigRes, MAX_SIGNATURE_BUNDLE_BYTES, "Signature bundle"),
    )
  }
  return { path, signaturePath, dir }
}

/** A request's `grantedDomains`: strings only (anything else consents to nothing). */
function strictDomains(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === "string") : []
}

// POST /install — install from a URL with admin-granted scopes.
installRoutes.post(
  "/install",
  requireScope("kernel:apps:admin"),
  requireInstanceOperator,
  async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: string
      grantedScopes?: string[]
      grantedConnections?: string[]
      grantedCapabilities?: string[]
      grantedCrossAppCalls?: string[]
      grantedDomains?: string[]
      approveUiFullAccess?: boolean
      allowDowngrade?: boolean
    }
    if (!body.url) {
      throw new HTTPException(400, { message: "url is required" })
    }
    // Fail fast on the signature-required-but-no-publisher misconfiguration BEFORE
    // downloading, so the operator gets the actionable 400 instead of an opaque 500.
    const sig = resolveSignatureConfig()
    const { path, signaturePath, dir } = await downloadTarball(body.url)
    try {
      const result = await installAppFromTarball({
        tarballPath: path,
        installedBy: c.get("userId"),
        grantedScopes: body.grantedScopes ?? [],
        grantedConnections: body.grantedConnections ?? [],
        // Explicit list from the admin dialog: a missing field grants nothing.
        grantedCapabilities: body.grantedCapabilities ?? [],
        grantedCrossAppCalls: body.grantedCrossAppCalls ?? [],
        // The outbound domains consented to: a missing field consents to none.
        grantedDomains: strictDomains(body.grantedDomains),
        approveUiFullAccess: body.approveUiFullAccess === true,
        allowDowngrade: body.allowDowngrade === true,
        requireSignature: sig.requireSignature,
        cosignIdentityRegex: sig.cosignIdentityRegex,
        signatureBundlePath: signaturePath,
        sourceUrl: body.url,
      })
      return success(c, result)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

/**
 * Organisations' own custom apps are off on this server (LIAISON_CUSTOM_APPS,
 * lib/edition.ts customAppsEnabled): `/custom/*` answers 404, as if absent.
 * Custom apps already installed keep running; only new installs stop.
 */
const requireCustomApps = createMiddleware<AppEnv>(async (_c, next) => {
  if (!customAppsEnabled()) throw new HTTPException(404, { message: "Not found" })
  await next()
})

// GET /custom/namespace — the name this org's custom apps carry: `<name>-o<orgKey>`.
installRoutes.get(
  "/custom/namespace",
  requireCustomApps,
  requireScope("kernel:apps:admin"),
  async (c) => {
    const orgId = c.get("orgId")
    const orgKey = customAppOrgKey(orgId)
    return success(c, {
      orgKey,
      suffix: `-o${orgKey}`,
      example: expectedCustomAppName("my-app", orgId),
    })
  },
)

// POST /custom/install — an org admin installs (or re-installs, or moves to a
// newer version of) a custom app for their own org only (every edition).
// No instance-operator gate: the app is org-private, held to the org-level
// declarations, the name rule and the org's `customApps` cap
// (installAppFromTarball `ownerOrgId`), and invisible to every other org.
installRoutes.post(
  "/custom/install",
  requireCustomApps,
  requireScope("kernel:apps:admin"),
  async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      url?: string
      grantedScopes?: string[]
      grantedConnections?: string[]
      grantedCapabilities?: string[]
      grantedCrossAppCalls?: string[]
      grantedDomains?: string[]
      approveUiFullAccess?: boolean
    }
    if (!body.url) throw new HTTPException(400, { message: "url is required" })
    const orgId = c.get("orgId")
    const userId = c.get("userId")
    const { path, dir } = await downloadTarball(body.url)
    try {
      const result = await installAppFromTarball({
        tarballPath: path,
        installedBy: userId,
        grantedScopes: body.grantedScopes ?? [],
        grantedConnections: body.grantedConnections ?? [],
        grantedCapabilities: body.grantedCapabilities ?? [],
        grantedCrossAppCalls: body.grantedCrossAppCalls ?? [],
        // The outbound domains consented to: a missing field consents to none.
        grantedDomains: strictDomains(body.grantedDomains),
        // The interface runs only on this org's own host, approved by this org's admin.
        approveUiFullAccess: body.approveUiFullAccess === true,
        requireSignature: false,
        sourceUrl: body.url,
        ownerOrgId: orgId,
      })
      await withPrivilegedDb(orgId, "custom-app-install-audit", (db) =>
        writeAuditLog(db, {
          orgId,
          actorId: userId,
          actorType: "user",
          app: result.name,
          entityType: "app_install",
          action: "app.custom.installed",
          metadata: { version: result.version },
        }),
      )
      return success(c, result)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

// GET /catalog — the App store listings: the first-party apps baked into this image,
// then a configured registry's (LIAISON_APP_REGISTRY_URL), each with its `source` and
// installed-state: `{ apps, notice? }`, notice "registry_unreachable" when the registry
// could not be read (the baked apps are still listed).
installRoutes.get("/catalog", requireScope("kernel:apps:admin"), async (c) => {
  return success(c, await listMergedCatalog())
})

// GET /install-permission — whether this org may install, upgrade and remove apps
// (requireInstanceOperator's own rule), so Settings > Apps shows those controls only where
// they work instead of offering buttons the server refuses with a 403.
installRoutes.get("/install-permission", requireScope("kernel:apps:admin"), async (c) => {
  return success(c, { canManageInstalls: await canManageInstanceApps(c.get("orgId")) })
})

// POST /catalog/:name/install — one-click install of a first-party catalog app
// from its baked-in tarball. No URL, no signature (first-party, in-image), and
// the app's own declared scopes/connections are granted in full. Hot-registers
// the app so it surfaces immediately for the operator org.
installRoutes.post(
  "/catalog/:name/install",
  requireScope("kernel:apps:admin"),
  requireInstanceOperator,
  async (c) => {
    // Registry apps install through the URL path's consent screen, never in one click.
    const result = await installFromCatalog({
      orgId: c.get("orgId"),
      name: c.req.param("name"),
      installedBy: c.get("userId"),
    })
    return success(c, result)
  },
)

// POST /preflight — download + verify a package and return its manifest,
// WITHOUT installing. Drives the admin install dialog's scope-grant step.
installRoutes.post(
  "/preflight",
  requireScope("kernel:apps:admin"),
  requireInstanceOperator,
  async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { url?: string }
    if (!body.url) {
      throw new HTTPException(400, { message: "url is required" })
    }
    const sig = resolveSignatureConfig()
    const { path, signaturePath, dir } = await downloadTarball(body.url)
    try {
      const verified = await verifyAppPackage(path, {
        requireSignature: sig.requireSignature,
        cosignIdentityRegex: sig.cosignIdentityRegex,
        signatureBundlePath: signaturePath,
      })
      try {
        return success(c, {
          ...verified.manifest,
          // What the admin dialog needs to ask for "interface runs with your session".
          hasUiBundle: existsSync(join(verified.stagingDir, "ui.js")),
          signatureVerified: !!verified.signatureBundle,
          // The hosts the install asks consent for (network + connections, egress-grants.ts).
          outboundDomains: declaredDomains(
            JSON.parse(readFileSync(join(verified.stagingDir, "app.manifest.json"), "utf8")),
          ),
        })
      } finally {
        rmSync(verified.stagingDir, { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

// POST /:name/upgrade/preview — fetch the update channel, return the scope diff.
installRoutes.post(
  "/:name/upgrade/preview",
  requireScope("kernel:apps:admin"),
  requireAppManager,
  async (c) => {
    const name = assertValidAppName(c.req.param("name"))
    const active = await withSystemDb("upgrade-preview-row", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, name)),
    )
    if (active.length === 0) {
      throw new HTTPException(404, { message: `App '${name}' is not installed` })
    }
    const rows = await withSystemDb("upgrade-preview-installed", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, name)),
    )
    const activeRow = rows.find((r) => r.version === active[0].version)
    if (!activeRow?.updateUrl) {
      throw new HTTPException(404, {
        message: `App '${name}' has no update channel — re-install with a new package to update it`,
      })
    }
    const sig = await signatureConfigFor(name)
    const { path, signaturePath, dir } = await downloadTarball(activeRow.updateUrl)
    try {
      const preview = await previewUpgrade({
        name,
        tarballPath: path,
        requireSignature: sig.requireSignature,
        cosignIdentityRegex: sig.cosignIdentityRegex,
        signatureBundlePath: signaturePath,
      })
      // Up to date when the channel does not serve a strictly newer version —
      // an equal OR older version must not trigger a (down)grade.
      if (!isVersionNewer(preview.manifest.version, active[0].version)) {
        return success(c, { upToDate: true, version: active[0].version })
      }
      return success(c, {
        upToDate: false,
        version: preview.manifest.version,
        manifest: {
          ...preview.manifest,
          hasUiBundle: preview.hasUiBundle,
          signatureVerified: preview.signatureVerified,
        },
        newScopes: preview.newScopes,
        newCapabilities: preview.newCapabilities,
        newCrossAppCalls: preview.newCrossAppCalls,
        newDomains: preview.newDomains,
        removedScopes: preview.removedScopes,
        previouslyGranted: preview.previouslyGranted,
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

// POST /:name/upgrade/apply — re-download from the update channel and apply.
installRoutes.post(
  "/:name/upgrade/apply",
  requireScope("kernel:apps:admin"),
  requireAppManager,
  async (c) => {
    const name = assertValidAppName(c.req.param("name"))
    const body = (await c.req.json().catch(() => ({}))) as {
      grantedScopes?: string[]
      grantedConnections?: string[]
      grantedCapabilities?: string[]
      grantedCrossAppCalls?: string[]
      grantedDomains?: string[]
      approveUiFullAccess?: boolean
      allowDowngrade?: boolean
    }
    const active = await withSystemDb("upgrade-apply-row", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, name)),
    )
    if (active.length === 0) {
      throw new HTTPException(404, { message: `App '${name}' is not installed` })
    }
    const rows = await withSystemDb("upgrade-apply-installed", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, name)),
    )
    const activeRow = rows.find((r) => r.version === active[0].version)
    if (!activeRow?.updateUrl) {
      throw new HTTPException(404, { message: `App '${name}' has no update channel` })
    }
    const sig = await signatureConfigFor(name)
    const { path, signaturePath, dir } = await downloadTarball(activeRow.updateUrl)
    try {
      const result = await applyUpgrade({
        name,
        tarballPath: path,
        installedBy: c.get("userId"),
        grantedScopes: body.grantedScopes ?? [],
        grantedConnections: body.grantedConnections ?? [],
        grantedCapabilities: body.grantedCapabilities ?? [],
        grantedCrossAppCalls: body.grantedCrossAppCalls ?? [],
        // The outbound domains consented to: a missing field consents to none.
        grantedDomains: strictDomains(body.grantedDomains),
        approveUiFullAccess: body.approveUiFullAccess === true,
        allowDowngrade: body.allowDowngrade === true,
        requireSignature: sig.requireSignature,
        cosignIdentityRegex: sig.cosignIdentityRegex,
        signatureBundlePath: signaturePath,
        sourceUrl: activeRow.updateUrl,
      })
      return success(c, result)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

// POST /:name/rollback — make the app's previous version the active one again (S9),
// through the same health gate as an upgrade. Instance-wide, so instance operator
// only (A10). A version marked noRollback refuses it.
installRoutes.post(
  "/:name/rollback",
  requireScope("kernel:apps:admin"),
  requireAppManager,
  async (c) => {
    const name = assertValidAppName(c.req.param("name"))
    const userId = c.get("userId")
    try {
      const result = await rollbackApp(name, { id: userId, kind: "operator" })
      // The audit entry belongs to the caller's org (the auth context).
      await withPrivilegedDb(c.get("orgId"), "app-rollback-audit", (db) =>
        writeAuditLog(db, {
          orgId: c.get("orgId"),
          actorId: userId,
          actorType: "user",
          app: name,
          entityType: "app_install",
          action: "app.rolled_back",
          metadata: { version: result.version, from: result.previousVersion },
        }),
      )
      return success(c, { name, ...result })
    } catch (err) {
      if (err instanceof AppActivationError) {
        // Not installed at all: 404. Anything else (no previous version, a security
        // release, a previous version that failed its gate): the app keeps running
        // `runningVersion`, and the message says why.
        throw new HTTPException(
          err.code === "version_missing" && err.runningVersion === null ? 404 : 409,
          { message: err.message },
        )
      }
      throw err
    }
  },
)

// POST /:name/ui-approval — record (or withdraw) the admin's approval that this app's
// interface runs in the web origin with full access to their session. Only meaningful
// for an installed app with a ui.js that is neither first-party nor publisher-signed.
installRoutes.post(
  "/:name/ui-approval",
  requireScope("kernel:apps:admin"),
  requireAppManager,
  async (c) => {
    const name = assertValidAppName(c.req.param("name"))
    const body = (await c.req.json().catch(() => ({}))) as { approved?: boolean }
    if (typeof body.approved !== "boolean") {
      throw new HTTPException(400, { message: "approved (boolean) is required" })
    }
    const trust = await getInstallTrust(name)
    if (!trust.installed || !trust.version) {
      throw new HTTPException(404, { message: `App '${name}' is not installed` })
    }
    const version = trust.version
    const userId = c.get("userId")
    const orgId = c.get("orgId")
    await withSystemDb("app-ui-approval", async (db) => {
      await db
        .update(appsInstalled)
        .set(
          body.approved
            ? { uiFullAccessApprovedBy: userId, uiFullAccessApprovedAt: new Date() }
            : { uiFullAccessApprovedBy: null, uiFullAccessApprovedAt: null },
        )
        .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, version)))
      // The approval lets third-party code run with users' sessions: it goes on the
      // audit timeline as well as on the install row.
      await writeAuditLog(db, {
        orgId,
        actorId: userId,
        actorType: "user",
        app: name,
        entityType: "app_install",
        action: body.approved ? "app.ui_full_access.approved" : "app.ui_full_access.withdrawn",
        metadata: { version },
      })
    })
    resetInstallTrustCache(name)
    log.info({ app: name, version, approved: body.approved, by: userId }, "App UI approval changed")
    return success(c, { name, version, uiFullAccessApproved: body.approved })
  },
)

/** The outbound access of an installed app's active version (egress-grants.ts). */
async function outboundAccess(name: string) {
  const trust = await getInstallTrust(name)
  if (!trust.installed || !trust.version) return null
  const manifest = readInstalledManifest(name, trust.version) ?? {}
  const declared = declaredDomains(manifest)
  return {
    name,
    version: trust.version,
    declared,
    /** null = grandfathered: every declared domain. */
    granted: trust.grantedDomains === null ? null : grantedSubset(declared, trust.grantedDomains),
    pending: pendingDomains(manifest, trust.grantedDomains),
  }
}

// GET /:name/outbound — the hosts an installed app may reach: what its active
// version declares, what is granted, and what still waits for consent. Any admin
// of an org that sees the app may read it; `canManage` says whether this caller
// may change it (the instance operator for an instance app, the owning org's
// admin for a custom app).
installRoutes.get("/:name/outbound", requireScope("kernel:apps:admin"), async (c) => {
  const name = assertValidAppName(c.req.param("name"))
  const orgId = c.get("orgId")
  const custom = await isOrgPrivateApp(name)
  if (custom && (await appOwnerOrg(name)) !== orgId) {
    throw new HTTPException(404, { message: `App '${name}' is not installed` })
  }
  const access = await outboundAccess(name)
  if (!access) throw new HTTPException(404, { message: `App '${name}' is not installed` })
  return success(c, {
    ...access,
    canManage: custom ? true : await canManageInstanceApps(orgId),
  })
})

// POST /:name/outbound — grant pending domains or revoke granted ones on the
// active version's install row: { grant?: string[], revoke?: string[] }. Only
// declared domains can be granted. Takes effect on the app's next run (this
// process at once, the others within the install-trust cache's few seconds).
installRoutes.post(
  "/:name/outbound",
  requireScope("kernel:apps:admin"),
  requireAppManager,
  async (c) => {
    const name = assertValidAppName(c.req.param("name"))
    const body = (await c.req.json().catch(() => ({}))) as { grant?: unknown; revoke?: unknown }
    const grant = strictDomains(body.grant).map(normalizeDomain)
    const revoke = new Set(strictDomains(body.revoke).map(normalizeDomain))
    if (grant.length === 0 && revoke.size === 0) {
      throw new HTTPException(400, { message: "grant or revoke (domain lists) is required" })
    }
    const access = await outboundAccess(name)
    if (!access) throw new HTTPException(404, { message: `App '${name}' is not installed` })
    const undeclared = grant.filter((d) => !access.declared.includes(d))
    if (undeclared.length > 0) {
      throw new HTTPException(400, {
        message: `Not declared by ${name} ${access.version}: ${undeclared.join(", ")}`,
      })
    }
    const before = access.granted ?? access.declared
    const next = access.declared.filter(
      (d) => (before.includes(d) || grant.includes(d)) && !revoke.has(d),
    )
    const userId = c.get("userId")
    const orgId = c.get("orgId")
    await withSystemDb("app-outbound-grant", async (db) => {
      await db
        .update(appsInstalled)
        .set({ grantedDomains: next })
        .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, access.version)))
      await writeAuditLog(db, {
        orgId,
        actorId: userId,
        actorType: "user",
        app: name,
        entityType: "app_install",
        action: "app.outbound_domains.changed",
        metadata: {
          version: access.version,
          granted: next.filter((d) => !before.includes(d)),
          revoked: before.filter((d) => !next.includes(d)),
        },
      })
    })
    resetInstallTrustCache(name)
    log.info(
      { app: name, version: access.version, granted: next, by: userId },
      "App outbound domains changed",
    )
    return success(c, {
      ...access,
      granted: next,
      pending: access.declared.filter((d) => !next.includes(d)),
    })
  },
)

// DELETE /:name — uninstall an app.
installRoutes.delete("/:name", requireScope("kernel:apps:admin"), requireAppManager, async (c) => {
  // An app the operator disabled stays until the operator enables it (or the org purge).
  if (await isCustomAppDisabled(c.req.param("name"))) {
    throw new CustomAppDisabledError(c.req.param("name"))
  }
  const name = assertValidAppName(c.req.param("name"))
  // An app another workspace still has added stays installed (A4): its
  // admins remove it there first.
  const others = await otherWorkspacesWithApp(c.get("orgId"), name)
  if (others > 0) {
    throw new HTTPException(409, {
      message: `${name} is still added in ${others} other workspace${others === 1 ? "" : "s"}. It can be uninstalled once ${others === 1 ? "it removes" : "they remove"} it.`,
    })
  }
  await uninstallApp({ name })
  return success(c, { uninstalled: name })
})

/**
 * The publisher an installed app's manifest names (`author`), so the App store
 * page of an app without a listing still says who published it (A12).
 */
function installedAuthor(name: string, version: string): { author?: string } {
  try {
    const manifest = JSON.parse(
      readFileSync(join(getInstallRoot(), name, version, "app.manifest.json"), "utf8"),
    ) as { author?: unknown }
    return typeof manifest.author === "string" && manifest.author.trim() !== ""
      ? { author: manifest.author.trim() }
      : {}
  } catch {
    return {}
  }
}

/**
 * What a rollback would do (S9): the previous version, only while its files are
 * still on disk, and whether the active version is a security release that
 * refuses one (A10).
 */
function rollbackFields(
  state: Awaited<ReturnType<typeof listAppVersionStates>>[number] | undefined,
): Pick<AppRegistryEntry, "previousVersion" | "noRollback"> {
  if (!state) return {}
  return {
    ...(state.previousVersion && state.previousOnDisk
      ? { previousVersion: state.previousVersion }
      : {}),
    ...(state.noRollback ? { noRollback: true } : {}),
  }
}

/** Interface-trust fields shown in the app's settings. */
async function uiStatusFor(row: typeof appsInstalled.$inferSelect) {
  const trust = await getInstallTrust(row.name)
  return {
    grantedCapabilities: row.grantedCapabilities ?? undefined,
    grantedCrossAppCalls: row.grantedCrossAppCalls ?? undefined,
    hasUiBundle: existsSync(join(getInstallRoot(), row.name, row.version, "ui.js")),
    uiTrust: trust.uiTrust,
    uiFullAccessApproved: trust.uiApproved,
    uiFullAccessApprovedAt: row.uiFullAccessApprovedAt?.toISOString(),
  }
}

// GET / — list bundled + installed apps (the registry view). Admin-gated: the
// listing exposes each installed app's granted scopes and install metadata.
installRoutes.get("/", requireScope("kernel:apps:admin"), async (c) => {
  const bundled = await discoverInTreeApps()
  const bundledNames = new Set(bundled.map((a) => a.name))

  const installedRows = await withSystemDb("apps-list", (db) => db.select().from(appsInstalled))
  const activeRows = await withSystemDb("apps-list-active", (db) =>
    db.select().from(appsActiveVersion),
  )
  const activeByName = new Map(activeRows.map((r) => [r.name, r.version]))
  const versionStates = new Map((await listAppVersionStates()).map((v) => [v.name, v]))

  const entries: AppRegistryEntry[] = []

  for (const app of bundled) {
    entries.push({
      name: app.name,
      version: app.version,
      source: "in-tree",
      status: "active",
      core: isCoreApp({ name: app.name }),
    })
  }

  // One entry per installed app's active version (or each row if no pointer).
  const orgId = c.get("orgId")
  for (const row of installedRows) {
    if (activeByName.get(row.name) !== row.version) continue
    // Another org's custom app is not installed, as far as this org can tell.
    if (!(await appVisibleToOrg(row.name, orgId))) continue
    const shadowed = bundledNames.has(row.name)
    entries.push({
      name: row.name,
      version: row.version,
      source: "installed",
      status: shadowed ? "shadowed-by-bundled" : "active",
      statusMessage: shadowed
        ? "A bundled app of the same name takes precedence — this install is inactive"
        : undefined,
      core: false,
      ...installedAuthor(row.name, row.version),
      grantedScopes: row.grantedScopes,
      updateUrl: row.updateUrl ?? undefined,
      installedAt: row.installedAt?.toISOString(),
      ...(shadowed ? {} : await uiStatusFor(row)),
      ...rollbackFields(versionStates.get(row.name)),
    })
  }

  log.debug({ count: entries.length }, "Listed app registry")
  // The workspace's state of each app (S18): On, Off or removed. The full
  // per-workspace view (access, dependents) is GET /api/org/apps.
  await primeOrgApps(orgId)
  return success(
    c,
    entries.map((e) => ({ ...e, orgStatus: peekOrgAppState(orgId, e.name)?.status ?? "active" })),
  )
})
