// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Catalog sources for the App store. Two kinds:
//
//   - the BAKED catalog (catalog.ts): first-party `.liaisonapp` tarballs shipped in the
//     image. Same trust boundary as the server binary, so the one-click install grants the
//     app's own declared scopes and connections.
//   - a REGISTRY (`LIAISON_APP_REGISTRY_URL`): an https `index.json` of store listings and
//     package URLs. No registry server ships with Liaison; anyone can host one. A registry
//     package takes the URL-install trust path: downloaded through the SSRF-safe fetch,
//     verified by the cosign policy (publisher-signed or admin-approved), installed only
//     after the consent screen (preflight) with the scopes the admin grants. Never
//     auto-granted: the one-click catalog install refuses it.
//
// Listings are mandatory for both (owner rule: every listed app is source-available and
// carries no price). A registry that cannot be reached leaves the baked catalog listed with
// the calm notice `registry_unreachable`.
import {
  type AppKind,
  type AppListing,
  appKindSchema,
  appListingSchema,
  listingDeclarationErrors,
} from "@liaison/app-sdk"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { env } from "~/lib/env"
import { appsLogger as log } from "~/lib/logger"
import { fetchWithPinnedHost } from "~/lib/outbound-fetch"
import { ownOption } from "~/lib/safe-path"
import {
  bakedCatalogPackage,
  installCatalogApp,
  installedAppVersions,
  listCatalog,
} from "~/modules/apps/catalog"
import type { InstallResult } from "~/modules/apps/install-service"
import { assertCanManageInstanceApps } from "~/modules/apps/operator-org"

export type CatalogSourceId = "baked" | "registry"

/** One app a catalog source offers. */
export interface CatalogListing {
  name: string
  displayName?: string
  description?: string
  version: string
  kind?: AppKind
  license?: string
  author?: string
  /** Absent only on a baked entry built before listings existed. */
  listing?: AppListing
  /** Scopes the package requests (a registry install asks the admin for each). */
  scopes: string[]
  source: CatalogSourceId
  /** Registry entries: the package URL the URL install (preflight + consent) takes. */
  packageUrl?: string
}

/** How a catalog app's package is obtained, and under which trust path it installs. */
export type CatalogPackage =
  | {
      /** First-party, in-image: installs with the app's own scopes and connections. */
      source: "baked"
      tarballPath: string
      grantedScopes: string[]
      grantedConnections: string[]
    }
  | {
      /** Third-party: the URL install path, signature policy and explicit consent. */
      source: "registry"
      url: string
    }

export interface CatalogSource {
  id: CatalogSourceId
  list(): Promise<CatalogListing[]>
  fetchPackage(name: string, version: string): Promise<CatalogPackage>
}

/** The image's own catalog (`catalog.json` beside the baked tarballs). */
export class BakedCatalogSource implements CatalogSource {
  readonly id = "baked" as const

  async list(): Promise<CatalogListing[]> {
    return listCatalog().map((e) => ({
      name: e.name,
      ...(e.displayName ? { displayName: e.displayName } : {}),
      ...(e.description ? { description: e.description } : {}),
      version: e.version,
      ...(e.kind ? { kind: e.kind } : {}),
      ...(e.license ? { license: e.license } : {}),
      ...(e.author ? { author: e.author } : {}),
      ...(e.listing ? { listing: e.listing } : {}),
      scopes: e.scopes,
      source: "baked" as const,
    }))
  }

  async fetchPackage(name: string, version: string): Promise<CatalogPackage> {
    const { tarballPath, grantedScopes, grantedConnections } = bakedCatalogPackage(name, version)
    return { source: "baked", tarballPath, grantedScopes, grantedConnections }
  }
}

/**
 * Parse a registry (or registry package) URL: https only. `allowHttp` admits plain http,
 * for the loopback fixture registry of the tests only (the default is on in tests only).
 */
export function parseRegistryUrl(raw: string, opts: { allowHttp: boolean }): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`App registry URL is not a URL: ${raw}`)
  }
  const ok =
    url.protocol === "https:" || (ownOption(opts, "allowHttp") === true && url.protocol === "http:")
  if (!ok) throw new Error(`App registry URL must use https: ${url.origin}`)
  if (url.username || url.password) {
    throw new Error("App registry URL must not carry credentials")
  }
  return url
}

const MAX_INDEX_BYTES = 2 * 1024 * 1024
const MAX_INDEX_ENTRIES = 1000
const FETCH_TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 5 * 60 * 1000

const registryIndexSchema = z.object({
  apps: z.array(z.unknown()).max(MAX_INDEX_ENTRIES),
})

const registryEntrySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[\w.]+)?$/),
  displayName: z.string().min(1).max(80).optional(),
  description: z.string().max(2000).optional(),
  kind: appKindSchema.optional(),
  license: z.string().min(1).max(200),
  author: z.string().min(1).max(120).optional(),
  listing: z.unknown(),
  packageUrl: z.string().min(1).max(2048),
  scopes: z.array(z.string().max(200)).max(500).default([]),
})

async function readJsonWithLimit(res: Response, limit: number): Promise<unknown> {
  const declared = Number(res.headers.get("content-length") ?? "")
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`registry index is larger than ${limit} bytes`)
  }
  if (!res.body) throw new Error("registry index has no body")
  const chunks: Uint8Array[] = []
  let received = 0
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > limit) {
      await reader.cancel().catch(() => {})
      throw new Error(`registry index is larger than ${limit} bytes`)
    }
    chunks.push(value)
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

// Successful registry reads, per index URL. A failure is never cached: the next request
// retries, and the App store shows the notice meanwhile.
const registryCache = new Map<string, { at: number; entries: CatalogListing[] }>()

/** Drop the cached registry indexes (tests swap registries between cases). */
export function resetRegistryCache(): void {
  registryCache.clear()
}

/** A remote registry: `index.json` of `{ apps: [...] }` entries (docs/app-package-format.md). */
export class RegistryCatalogSource implements CatalogSource {
  readonly id = "registry" as const
  private readonly allowHttp: boolean

  constructor(
    private readonly indexUrl: string,
    opts: { allowHttp?: boolean } = {},
  ) {
    this.allowHttp = ownOption(opts, "allowHttp") ?? env.NODE_ENV === "test"
  }

  async list(): Promise<CatalogListing[]> {
    const url = parseRegistryUrl(this.indexUrl, { allowHttp: this.allowHttp })
    const hit = registryCache.get(url.href)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.entries

    const res = await fetchWithPinnedHost(
      url,
      {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
      // Every hop is SSRF-validated (https, public address); the loopback fixture
      // registry passes in tests only.
      { maxRedirects: 3, allowPrivateHostsInTest: this.allowHttp },
    )
    if (!res.ok) {
      await res.body?.cancel().catch(() => {})
      throw new Error(`registry index answered ${res.status}`)
    }
    const index = registryIndexSchema.parse(await readJsonWithLimit(res, MAX_INDEX_BYTES))

    const entries: CatalogListing[] = []
    const seen = new Set<string>()
    for (const raw of index.apps) {
      const entry = this.toListing(raw)
      if (!entry || seen.has(entry.name)) continue
      seen.add(entry.name)
      entries.push(entry)
    }
    registryCache.set(url.href, { at: Date.now(), entries })
    return entries
  }

  /** A valid, listed registry entry, or null (logged) for one the store must not show. */
  private toListing(raw: unknown): CatalogListing | null {
    const parsed = registryEntrySchema.safeParse(raw)
    const name =
      raw && typeof raw === "object" && "name" in raw ? String(raw.name).slice(0, 80) : "?"
    if (!parsed.success) {
      log.warn(
        { app: name, issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) },
        "App registry: dropping an invalid entry",
      )
      return null
    }
    const e = parsed.data
    const listingErrors =
      e.listing === undefined
        ? ["listing: a registry entry needs a store listing"]
        : listingDeclarationErrors({ listing: e.listing, license: e.license })
    if (listingErrors.length > 0) {
      log.warn({ app: e.name, issues: listingErrors }, "App registry: dropping an unlisted entry")
      return null
    }
    const listing = appListingSchema.parse(e.listing)
    let packageUrl: string
    try {
      packageUrl = parseRegistryUrl(e.packageUrl, { allowHttp: this.allowHttp }).href
    } catch (err) {
      log.warn({ app: e.name, err }, "App registry: dropping an entry with an unsafe package URL")
      return null
    }
    return {
      name: e.name,
      ...(e.displayName ? { displayName: e.displayName } : {}),
      ...(e.description ? { description: e.description } : {}),
      version: e.version,
      ...(e.kind ? { kind: e.kind } : {}),
      license: e.license,
      ...(e.author ? { author: e.author } : {}),
      listing,
      scopes: e.scopes,
      source: "registry",
      packageUrl,
    }
  }

  async fetchPackage(name: string, version: string): Promise<CatalogPackage> {
    const entry = (await this.list()).find((e) => e.name === name && e.version === version)
    if (!entry?.packageUrl) {
      throw new HTTPException(404, {
        message: `The app registry has no '${name}' at version ${version}`,
      })
    }
    return { source: "registry", url: entry.packageUrl }
  }
}

/** The configured registry source, or null when `LIAISON_APP_REGISTRY_URL` is unset. */
export function registrySourceFromEnv(): RegistryCatalogSource | null {
  const url = env.LIAISON_APP_REGISTRY_URL?.trim()
  return url ? new RegistryCatalogSource(url) : null
}

export type CatalogNotice = "registry_unreachable"

/** A catalog app with its install state on this instance. */
export type CatalogAppWithState = CatalogListing & {
  installed: boolean
  installedVersion?: string
}

/** The registry's listings, or the notice when it cannot be read (never throws). */
async function readRegistry(): Promise<{ entries: CatalogListing[]; notice?: CatalogNotice }> {
  const registry = registrySourceFromEnv()
  if (!registry) return { entries: [] }
  try {
    return { entries: await registry.list() }
  } catch (err) {
    log.warn({ err }, "App registry unreachable: listing the baked catalog only")
    return { entries: [], notice: "registry_unreachable" }
  }
}

/**
 * Every catalog source merged for the App store (`GET /api/apps/catalog`): the baked
 * catalog first, then the registry's apps the image does not bake (a name both carry is
 * the first-party one), each with its install state.
 */
export async function listMergedCatalog(): Promise<{
  apps: CatalogAppWithState[]
  notice?: CatalogNotice
}> {
  const baked = await new BakedCatalogSource().list()
  const registry = await readRegistry()
  const bakedNames = new Set(baked.map((e) => e.name))
  const merged = [...baked, ...registry.entries.filter((e) => !bakedNames.has(e.name))]
  const installedVersion =
    merged.length === 0 ? new Map<string, string>() : await installedAppVersions()
  const apps = merged.map((e) => {
    const version = installedVersion.get(e.name)
    return {
      ...e,
      installed: version !== undefined,
      ...(version !== undefined ? { installedVersion: version } : {}),
    }
  })
  return registry.notice ? { apps, notice: registry.notice } : { apps }
}

// App names are kebab-case (same shape the package schema enforces). Validating
// a name before it reaches any DB lookup or filesystem path blocks traversal
// (`../`, URL-encoded separators) into the install root.
const APP_NAME_RE = /^[a-z][a-z0-9-]*$/
export function assertValidAppName(name: string): string {
  if (!APP_NAME_RE.test(name)) {
    throw new HTTPException(400, { message: "invalid app name" })
  }
  return name
}

/**
 * The App store's one-click install of a first-party catalog app, with every
 * rule the route applies after its `kernel:apps:admin` check: a valid name, the
 * instance operator's org on a multi-tenant instance, never a registry app
 * (that one goes through the URL install's consent screen), and a 404 naming
 * the catalog for an unknown name. `POST /catalog/:name/install` and
 * `kernel:enable_app` both install through it.
 */
export async function installFromCatalog(opts: {
  orgId: string
  name: string
  installedBy: string
}): Promise<InstallResult> {
  const name = assertValidAppName(opts.name)
  await assertCanManageInstanceApps(opts.orgId)
  await refuseOneClickRegistryInstall(name)
  return installCatalogApp({ orgId: opts.orgId, name, installedBy: opts.installedBy })
}

/**
 * The one-click catalog install grants an app its own scopes, which only an app baked in
 * the image may have. A registry app is refused here with the way to install it: the URL
 * install, whose consent screen asks the admin for each scope. Returns quietly for any
 * other name (the baked install then installs it, or 404s).
 */
export async function refuseOneClickRegistryInstall(name: string): Promise<void> {
  if (listCatalog().some((e) => e.name === name)) return
  const { entries } = await readRegistry()
  const entry = entries.find((e) => e.name === name)
  if (!entry?.packageUrl) return
  throw new HTTPException(409, {
    message:
      `'${name}' comes from the app registry, so it is not installed in one click: use ` +
      `"Install from URL" with ${entry.packageUrl}, which shows the permissions it asks for ` +
      "so you can grant them.",
  })
}
