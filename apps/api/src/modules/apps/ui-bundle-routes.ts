// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16.5 — Plugin app UI bundle serving route.
//
// Serves `<installRoot>/<name>/<version>/ui.js`, with an authoritative
// active-version DB check and path-containment guard. The route is mounted
// outside the bearer-auth chain (a browser `import()` cannot send a header), so
// access is decided here: a first-party bundle ships with the product and is
// public, while any other installed app's bundle needs the short-lived URL token
// the authenticated app list hands out (`ui-bundle-token.ts`).
//
// Beside it, `statement.json`, `statement.sig` and `manifest.json` of a SIGNED
// first-party app (the catalog took the release artifact): the desktop shell
// verifies them against its pinned keys before it runs the bundle in its main
// page, and registers the app from that verified manifest. `manifest.json` is
// the package's own `app.manifest.json` bytes, the ones the statement hashes.
// Served under the same guards, for a first-party install only; 404 for every
// other app.
//
// And the frame document a browser tab runs an outside app's interface in
// (`frame`, app-frame.ts): served for the active version of a vouched-for app
// that is not first-party, against the same token as its `ui.js`.
import { existsSync, statSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { and, eq } from "drizzle-orm"
import { type Context, Hono } from "hono"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { users } from "~/db/schema/kernel"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { orgIdForSlug, requestHostBinding } from "~/lib/org-host"
import { appFrameResponse, appFrameRuntime } from "~/modules/apps/app-frame"
import { appOwnerOrg, customAppNameKey } from "~/modules/apps/app-org-scope"
import { catalogStatement } from "~/modules/apps/catalog"
import { getInstallRoot } from "~/modules/apps/discover-apps"
import { getInstallTrust } from "~/modules/apps/install-trust"
import { boundHost, verifyUiBundleToken } from "~/modules/apps/ui-bundle-token"
import { orgSuspendedOrClosed } from "~/modules/cloud/billing-status"

const NAME_RE = /^[a-z][a-z0-9-]*$/
const VERSION_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/

const notFound = { error: { message: "Not found" } }

/**
 * An org's custom app (app-org-scope.ts) serves its bundle, frame and files
 * only on its own org's host, to a live org, and only with an interface
 * approval recorded by an admin of that org: never in another tenant's origin,
 * on a cell host, or on a deployment without org hosts. Any other app: false.
 */
async function orgPrivateBundleRefused(
  c: Context,
  name: string,
  version: string,
): Promise<boolean> {
  const binding = requestHostBinding(c)
  const hostOrg = binding.kind === "org" ? await orgIdForSlug(binding.slug) : null
  return orgPrivateBundleRefusedFor(hostOrg, name, version)
}

/**
 * `orgPrivateBundleRefused` for a known serving org (the org whose host, or whose
 * app frame host, the request came to; null when it names none).
 */
export async function orgPrivateBundleRefusedFor(
  servingOrg: string | null,
  name: string,
  version: string,
): Promise<boolean> {
  const owner = await appOwnerOrg(name)
  if (owner === null) return customAppNameKey(name) !== null
  if (servingOrg === null || servingOrg !== owner) return true
  if (await orgSuspendedOrClosed(owner)) return true
  const [approval] = await withSystemDb("ui-bundle-owner-approval", (db) =>
    db
      .select({ orgId: users.orgId })
      .from(appsInstalled)
      .innerJoin(users, eq(users.id, appsInstalled.uiFullAccessApprovedBy))
      .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, version)))
      .limit(1),
  )
  return approval?.orgId !== owner
}

export const uiBundleRoutes = new Hono<AppEnv>()
  // Every refusal here (not installed, not vouched for, wrong host, a token for
  // another app, a suspended org) can change minutes later, and the URL of the
  // next valid request is often the same (the token is stable within its
  // window). Without a cache header a CDN in front of the server keeps a `.js`
  // 404 for hours and the interface stays missing after the install or the
  // approval. The 200 already carries its own `private` header.
  .use("*", async (c, next) => {
    await next()
    if (c.res.status >= 400) c.res.headers.set("Cache-Control", "no-store")
  })
  .get("/:name/:version/:file{statement\\.json|statement\\.sig|manifest\\.json}", async (c) => {
    const name = c.req.param("name")
    const version = c.req.param("version")
    if (!NAME_RE.test(name) || !VERSION_RE.test(version)) {
      return c.json({ error: { message: "Invalid app name or version" } }, 400)
    }
    if (await orgPrivateBundleRefused(c, name, version)) return c.json(notFound, 404)
    const active = await withSystemDb("ui-statement-active", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, name)),
    )
    if (active.length === 0 || active[0].version !== version) return c.json(notFound, 404)
    // First-party only: the install dir is byte-identical to the image's catalog
    // tarball, which is the artifact the statement names.
    const trust = await getInstallTrust(name)
    if (trust.uiTrust !== "first-party" || !trust.installed) return c.json(notFound, 404)
    const signed = catalogStatement(name, version)
    if (!signed) return c.json(notFound, 404)
    const headers = {
      "Cache-Control": "private, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "same-origin",
    }
    if (c.req.param("file") === "manifest.json") {
      const installRoot = getInstallRoot()
      const manifestPath = join(installRoot, name, version, "app.manifest.json")
      if (!resolve(manifestPath).startsWith(resolve(installRoot) + sep)) {
        return c.json(notFound, 404)
      }
      if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
        return c.json(notFound, 404)
      }
      return c.body(new Uint8Array(await Bun.file(manifestPath).arrayBuffer()), 200, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      })
    }
    if (c.req.param("file") === "statement.json") {
      return c.body(new Uint8Array(signed.statement), 200, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
      })
    }
    return c.body(signed.signature, 200, {
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
    })
  })
  .get("/:name/:version/frame", async (c) => {
    const name = c.req.param("name")
    const version = c.req.param("version")
    if (!NAME_RE.test(name) || !VERSION_RE.test(version)) {
      return c.json({ error: { message: "Invalid app name or version" } }, 400)
    }
    if (await orgPrivateBundleRefused(c, name, version)) return c.json(notFound, 404)
    const active = await withSystemDb("ui-frame-active", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, name)),
    )
    if (active.length === 0 || active[0].version !== version) return c.json(notFound, 404)
    // An outside app someone vouched for: a first-party app runs in the page, and
    // an app nobody vouched for has no interface at all.
    const trust = await getInstallTrust(name)
    if (trust.uiTrust === null || trust.uiTrust === "first-party") return c.json(notFound, 404)
    if (!(await verifyUiBundleToken(c.req.query("t"), name, version, boundHost(c)))) {
      return c.json(notFound, 404)
    }
    const runtime = await appFrameRuntime()
    if (runtime === null) {
      return c.json({ error: { message: "This server has no app frame" } }, 503)
    }
    return appFrameResponse(runtime)
  })
  .get("/:name/:version/ui.js", async (c) => {
    const name = c.req.param("name")
    const version = c.req.param("version")
    if (!NAME_RE.test(name) || !VERSION_RE.test(version)) {
      return c.json({ error: { message: "Invalid app name or version" } }, 400)
    }
    if (await orgPrivateBundleRefused(c, name, version)) return c.json(notFound, 404)
    // Defense-in-depth: containment check against any future regex-escape bug.
    const installRoot = getInstallRoot()
    const filePath = join(installRoot, name, version, "ui.js")
    if (!resolve(filePath).startsWith(resolve(installRoot) + sep)) {
      return c.json({ error: { message: "Path escapes install root" } }, 400)
    }
    // Authoritative version pin: refuse any version that is not the active row.
    // Stale URLs in client caches 404 cleanly after an upgrade.
    const active = await withSystemDb("ui-bundle-active", (db) =>
      db.select().from(appsActiveVersion).where(eq(appsActiveVersion.name, name)),
    )
    if (active.length === 0 || active[0].version !== version) {
      return c.json({ error: { message: "Not found" } }, 404)
    }
    // The bundle runs in the web origin with the user's session, so it is served only
    // when the platform, the operator (trusted-publisher signature) or an admin
    // (recorded approval) vouched for it. Anything else reads as not found, exactly
    // like an app without an interface.
    const trust = await getInstallTrust(name)
    if (trust.uiTrust === null) {
      return c.json({ error: { message: "Not found" } }, 404)
    }
    // Anything but a first-party bundle is served against the capability token the
    // authenticated app list issued for this exact app and version; without it the
    // app reads as not installed, so its presence cannot be probed anonymously.
    const tokened = trust.uiTrust !== "first-party"
    if (tokened && !(await verifyUiBundleToken(c.req.query("t"), name, version, boundHost(c)))) {
      return c.json({ error: { message: "Not found" } }, 404)
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return c.json({ error: { message: "Not found" } }, 404)
    }
    // UI bundles are small (<100KB typical) — load fully rather than streaming
    // through Hono's response adapter, which has cross-version edge cases for
    // BunFile bodies.
    const buf = await Bun.file(filePath).arrayBuffer()
    return c.body(buf, 200, {
      // Only a first-party bundle is a module anything imports (a browser tab's
      // page, a shell that verified it). Any other app's bundle is text the
      // page hands to the app's frame: as plain text under nosniff, this origin
      // refuses to run it as a script, whatever loads it.
      "Content-Type": tokened
        ? "text/plain; charset=utf-8"
        : "application/javascript; charset=utf-8",
      // `private`: the bytes are only servable while the trust above holds, so a
      // shared cache must not keep handing them out after an approval is revoked.
      "Cache-Control": tokened ? "private, max-age=300" : "private, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "same-origin",
    })
  })
