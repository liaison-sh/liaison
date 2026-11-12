// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE APP FRAME HOST: an app's screens on an origin of their own
// (LIAISON_APP_FRAME_ORIGIN_TEMPLATE, lib/app-frame-host.ts).
//
// A request whose host the frame template names (`<app>--<org>.<domain>`) is
// answered here and nowhere else (the gate in app.ts runs before every route;
// lib/server.ts serves such a host no web app and no socket). The host serves
// exactly one thing, `GET /frame/<version>?t=<token>`: the frame document of that
// app, for that org (and the app's pages, `/page/...`, app-pages.ts). Everything else (`/`, `/api/*`, `/api/auth/*`, `/assets/*`,
// webhooks, the bridge) is 404. No cookie is read or set here, and the org's
// own cookies are host-only (`__Host-`), so none ever reaches this host.
//
// The token is minted by the authenticated app list for the request's OWN org
// (never a parameter), names this frame host, the app and version, and the
// page's origin. This route refuses a token for another host, app or org, an
// app the org cannot see, a version that is not the active one, and an app no
// one vouched for. The document then carries:
// - `frame-ancestors <the page's origin>` and no X-Frame-Options;
// - the frame policy (no network, no frame, no form: `connect-src 'none'`), the
//   images of the hosts the manifest declares (`network.imageHosts`);
// - `sandbox allow-scripts allow-forms allow-same-origin`: the frame host's own
//   origin (its storage), which is the point; it is emitted nowhere else;
// - the page's origin baked in, the only window the runtime posts to or hears.
//
// ui.js is NOT served here: the page fetches it from its own origin and hands it
// to the frame, as for every frame.

import { createHmac, randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { appFrameDocument, appFramePolicy } from "@liaison/shared"
import { eq } from "drizzle-orm"
import type { Context } from "hono"
import * as jose from "jose"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion } from "~/db/schema/kernel/apps-installed"
import {
  APP_FRAME_HOST_PATH,
  appFrameHostFor,
  appFrameOriginOf,
  framedFirstPartyApps,
} from "~/lib/app-frame-host"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { type HostBinding, orgIdForSlug } from "~/lib/org-host"
import { instanceAppOrigin, orgPublicBaseUrlForSlug, orgSlugById } from "~/lib/org-public-url"
import { appFrameRuntime } from "~/modules/apps/app-frame"
import { appVisibleToOrg } from "~/modules/apps/app-org-scope"
import { frameHostPageRest, serveAppPageRequest } from "~/modules/apps/app-pages"
import { getInstallRoot } from "~/modules/apps/discover-apps"
import { grantedSubset } from "~/modules/apps/egress-grants"
import { getInstallTrust } from "~/modules/apps/install-trust"
import { orgPrivateBundleRefusedFor } from "~/modules/apps/ui-bundle-routes"

const AUDIENCE = "app-frame"
const WINDOW_SECONDS = 30 * 60

/** A key of its own: a frame token never verifies as a session or a bundle token. */
function frameTokenKey(): Uint8Array {
  return new Uint8Array(
    createHmac("sha256", env.JWT_SECRET).update("liaison:app-frame-token:v1").digest(),
  )
}

export interface AppFrameClaims {
  app: string
  version: string
  /** The frame host the token is for (lowercase, with port). */
  host: string
  /** The page's origin: the frame's only ancestor and only correspondent. */
  parent: string
  org: string
}

export async function signAppFrameToken(claims: AppFrameClaims): Promise<string> {
  const windowStart = Math.floor(Date.now() / 1000 / WINDOW_SECONDS) * WINDOW_SECONDS
  return new jose.SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(windowStart)
    .setExpirationTime(windowStart + 2 * WINDOW_SECONDS)
    .setAudience(AUDIENCE)
    .sign(frameTokenKey())
}

export async function verifyAppFrameToken(
  token: string | undefined,
): Promise<AppFrameClaims | null> {
  if (!token) return null
  try {
    const { payload } = await jose.jwtVerify(token, frameTokenKey(), { audience: AUDIENCE })
    const { app, version, host, parent, org } = payload as Record<string, unknown>
    if (
      typeof app !== "string" ||
      typeof version !== "string" ||
      typeof host !== "string" ||
      typeof parent !== "string" ||
      typeof org !== "string"
    ) {
      return null
    }
    return { app, version, host, parent, org }
  } catch {
    return null
  }
}

/**
 * The page's origin for an org: its own host with org hosts, else the instance's
 * web origin. Never read from the request: the frame names only this ancestor.
 */
function pageOriginFor(slug: string): string {
  if (env.LIAISON_ORG_HOST_TEMPLATE) return new URL(orgPublicBaseUrlForSlug(slug)).origin
  return new URL(instanceAppOrigin()).origin
}

/**
 * The frame URL of `app@version` on its own origin for the minting request's org,
 * or null when this app keeps the opaque frame there (no template, or a label too
 * long to be a host, logged).
 */
export async function mintAppFrameUrl(
  orgId: string,
  app: string,
  version: string,
): Promise<string | null> {
  const slug = await orgSlugById(orgId)
  if (!slug) return null
  const host = appFrameHostFor(app, slug)
  if (!host) {
    if (env.LIAISON_APP_FRAME_ORIGIN_TEMPLATE) {
      log.warn(
        { app, orgId },
        "app frame host cannot be named (label over 63 characters): the app keeps the opaque frame",
      )
    }
    return null
  }
  const token = await signAppFrameToken({
    app,
    version,
    host,
    parent: pageOriginFor(slug),
    org: orgId,
  })
  return `${appFrameOriginOf(host)}/frame/${encodeURIComponent(version)}?t=${encodeURIComponent(token)}`
}

/** Whether a listed app is framed on its own origin (not first-party, or named in LIAISON_FRAMED_APPS). */
export function framesOnOwnOrigin(app: string, firstParty: boolean): boolean {
  return !firstParty || framedFirstPartyApps().has(app)
}

interface DeclaredHosts {
  /** `https://host` image sources (`network.imageHosts`). */
  imageSources: string[]
  /** Hosts an `openExternal` may open: every host the manifest declares (fetch domains,
   *  connection domains, image hosts, `network.linkHosts`), `*.` patterns kept. */
  linkHosts: string[]
}

const declaredHostsCache = new Map<string, DeclaredHosts>()

function hostList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((h): h is string => typeof h === "string").map((h) => h.trim().toLowerCase())
    : []
}

/** The hosts the installed manifest of `app@version` declares; empty when it is not installed. */
export function manifestDeclaredHosts(app: string, version: string): DeclaredHosts {
  const key = `${app}@${version}`
  const hit = declaredHostsCache.get(key)
  if (hit) return hit
  const installRoot = getInstallRoot()
  const file = join(installRoot, app, version, "app.manifest.json")
  let hosts: DeclaredHosts = { imageSources: [], linkHosts: [] }
  if (resolve(file).startsWith(resolve(installRoot) + sep) && existsSync(file)) {
    try {
      const manifest = JSON.parse(readFileSync(file, "utf8")) as {
        network?: { allowedDomains?: unknown; imageHosts?: unknown; linkHosts?: unknown }
        connections?: Record<string, { allowedDomains?: unknown }>
      }
      const images = hostList(manifest.network?.imageHosts)
      const links = new Set([
        ...hostList(manifest.network?.allowedDomains),
        ...Object.values(manifest.connections ?? {}).flatMap((c) => hostList(c?.allowedDomains)),
        ...images,
        ...hostList(manifest.network?.linkHosts),
      ])
      hosts = {
        imageSources: images.map((h) => `https://${h}`),
        linkHosts: [...links].filter((h) => /^(\*\.)?[a-z0-9.-]+$/.test(h)),
      }
    } catch {
      hosts = { imageSources: [], linkHosts: [] }
    }
  }
  if (declaredHostsCache.size > 1_000) declaredHostsCache.clear()
  declaredHostsCache.set(key, hosts)
  return hosts
}

/**
 * The declared hosts of `app@version` narrowed to the running install's domain
 * grant (egress-grants.ts): an image or link host nobody consented to is neither
 * an img-src of the frame nor a host `openExternal` opens. The catalog and
 * trusted publishers are granted every declared domain, so nothing changes for them.
 */
export async function grantedDeclaredHosts(app: string, version: string): Promise<DeclaredHosts> {
  const declared = manifestDeclaredHosts(app, version)
  const { grantedDomains } = await getInstallTrust(app)
  if (grantedDomains === null) return declared
  const images = grantedSubset(
    declared.imageSources.map((s) => s.slice("https://".length)),
    grantedDomains,
  )
  return {
    imageSources: images.map((h) => `https://${h}`),
    linkHosts: grantedSubset(declared.linkHosts, grantedDomains),
  }
}

const notFound = () =>
  new Response(JSON.stringify({ error: { message: "Not found", code: "APP_FRAME_HOST" } }), {
    status: 404,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  })

/** The frame-host gate's answer: the frame document, or 404 for anything else. */
export async function serveAppFrameHost(
  c: Context,
  binding: Extract<HostBinding, { kind: "app-frame" }>,
): Promise<Response> {
  // An app page (app-pages.ts) on the app's own origin: its document, script and
  // route calls, bound to this host's app and org.
  const pageRest = frameHostPageRest(c.req.path)
  if (pageRest !== null) {
    const orgId = await orgIdForSlug(binding.slug)
    if (!orgId) return notFound()
    return serveAppPageRequest(
      c,
      pageRest,
      { kind: "frame", app: binding.app, orgId },
      appFrameOriginOf(binding.host),
    )
  }
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return notFound()
  const version = APP_FRAME_HOST_PATH.exec(c.req.path)?.[1]
  if (!version) return notFound()
  const claims = await verifyAppFrameToken(c.req.query("t"))
  // The token names this very host, app and version, and the host's org.
  if (
    !claims ||
    claims.host !== binding.host ||
    claims.app !== binding.app ||
    claims.version !== version
  ) {
    return notFound()
  }
  const orgId = await orgIdForSlug(binding.slug)
  if (!orgId || orgId !== claims.org) return notFound()
  if (!(await appVisibleToOrg(binding.app, orgId))) return notFound()
  if (await orgPrivateBundleRefusedFor(orgId, binding.app, version)) return notFound()
  const [active] = await withSystemDb("app-frame-host-active", (db) =>
    db
      .select({ version: appsActiveVersion.version })
      .from(appsActiveVersion)
      .where(eq(appsActiveVersion.name, binding.app)),
  )
  if (active?.version !== version) return notFound()
  const trust = await getInstallTrust(binding.app)
  if (trust.uiTrust === null) return notFound()
  if (!framesOnOwnOrigin(binding.app, trust.uiTrust === "first-party")) return notFound()
  const runtime = await appFrameRuntime()
  if (runtime === null) {
    return new Response(JSON.stringify({ error: { message: "This server has no app frame" } }), {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    })
  }
  return appFrameHostResponse(runtime, {
    parentOrigin: claims.parent,
    imgSources: (await grantedDeclaredHosts(binding.app, version)).imageSources,
  })
}

/** The policy of a frame document on an app's own origin, as a response header. */
export function appFrameHostPolicy(
  nonce: string,
  options: { parentOrigin: string; imgSources: readonly string[] },
): string {
  return `${appFramePolicy(nonce, { imgSources: options.imgSources })}; frame-ancestors ${options.parentOrigin}; sandbox allow-scripts allow-forms allow-same-origin`
}

export function appFrameHostResponse(
  runtimeText: string,
  options: { parentOrigin: string; imgSources: readonly string[] },
): Response {
  const nonce = randomBytes(18).toString("hex")
  return new Response(appFrameDocument(runtimeText, nonce, options), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": appFrameHostPolicy(nonce, options),
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  })
}
