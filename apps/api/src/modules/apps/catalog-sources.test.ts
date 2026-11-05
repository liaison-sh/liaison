// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Catalog sources: the baked catalog plus a remote registry (LIAISON_APP_REGISTRY_URL),
// merged by GET /api/apps/catalog. The registry is a fixture server on loopback (the
// test-only http allowance); pins:
//   - registry listings merge beside the baked ones, each tagged with its `source`;
//   - an entry the registry serves without a valid listing, or with a price, is dropped;
//   - the baked entry wins a name both sources carry (first-party trust);
//   - a registry package is never auto-granted: the one-click catalog install refuses it
//     and points at the URL install (preflight + explicit consent), and nothing installs;
//   - registry down -> the baked list with notice "registry_unreachable";
//   - a plain-http registry URL is refused outside tests.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { resetCatalogCache } from "~/modules/apps/catalog"
import {
  BakedCatalogSource,
  listMergedCatalog,
  parseRegistryUrl,
  RegistryCatalogSource,
  resetRegistryCache,
} from "~/modules/apps/catalog-sources"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000c5701"
const USER = "00000000-0000-4000-8000-0000000c5702"
const BAKED = "catsrc-baked-app"
const REMOTE = "catsrc-remote-app"

const LISTING = {
  publisher: "Example Labs",
  category: "Operations",
  icon: "send",
  summary: "Ship parcels from one place.",
  sourceRepository: "https://github.com/example/shipping",
}

let catalogDir: string
let adminToken: string
let server: ReturnType<typeof Bun.serve> | null = null
let registryBase = ""
let prevRegistryUrl: string | undefined

function index(base: string) {
  return {
    apps: [
      {
        name: REMOTE,
        version: "1.2.0",
        displayName: "Remote Shipping",
        description: "Ships parcels.",
        kind: "app",
        license: "Apache-2.0",
        author: "Example Labs",
        listing: LISTING,
        packageUrl: `${base}/packages/${REMOTE}-1.2.0.liaisonapp`,
        // More than the app strictly needs: the admin must consent to each one.
        scopes: [`${REMOTE}:parcels:read`, `${REMOTE}:parcels:write`, `${REMOTE}:billing:write`],
      },
      // Same name as the baked app: the baked (first-party) entry wins.
      {
        name: BAKED,
        version: "9.9.9",
        license: "MIT",
        listing: LISTING,
        packageUrl: `${base}/packages/${BAKED}-9.9.9.liaisonapp`,
        scopes: [],
      },
      // No listing: a registry entry must be listed, so it is dropped.
      {
        name: "catsrc-unlisted",
        version: "1.0.0",
        license: "MIT",
        packageUrl: `${base}/packages/u.liaisonapp`,
        scopes: [],
      },
      // A price under the listing: refused.
      {
        name: "catsrc-priced",
        version: "1.0.0",
        license: "MIT",
        listing: { ...LISTING, pricing: { monthly: 9 } },
        packageUrl: `${base}/packages/p.liaisonapp`,
        scopes: [],
      },
    ],
  }
}

function writeBakedCatalog(): void {
  const stage = mkdtempSync(join(tmpdir(), "catsrc-stage-"))
  const manifest = {
    name: BAKED,
    version: "0.1.0",
    packageFormat: 1,
    license: "MIT",
    scopes: [`${BAKED}:items:read`],
    listing: { ...LISTING, category: "Support", icon: "ticket" },
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(stage, "bundle.js"), "// noop\n")
  const file = `${BAKED}-0.1.0.liaisonapp`
  spawnSync("tar", ["-czf", join(catalogDir, file), "-C", stage, "app.manifest.json", "bundle.js"])
  rmSync(stage, { recursive: true, force: true })
  writeFileSync(
    join(catalogDir, "catalog.json"),
    JSON.stringify([
      {
        name: BAKED,
        description: "A baked catalog app",
        version: "0.1.0",
        license: "MIT",
        listing: manifest.listing,
        file,
        scopes: manifest.scopes,
        connections: [],
      },
    ]),
  )
}

function startRegistry(): void {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/index.json") return Response.json(index(registryBase))
      return new Response("not found", { status: 404 })
    },
  })
  registryBase = `http://127.0.0.1:${server.port}`
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${adminToken}` },
  })
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'Catalog Sources Org', 'catalog-sources-org') ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'catsrc@test.com', 'Catalog Admin') ON CONFLICT (id) DO NOTHING`
  adminToken = await signAccessToken(
    {
      userId: USER,
      orgId: ORG,
      name: "Catalog Admin",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel:apps:admin"],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
  prevRegistryUrl = env.LIAISON_APP_REGISTRY_URL
})

afterAll(async () => {
  env.LIAISON_APP_REGISTRY_URL = prevRegistryUrl
  await sql`DELETE FROM kernel.apps_installed WHERE name LIKE 'catsrc-%'`
  await sql`DELETE FROM kernel.apps_active_version WHERE name LIKE 'catsrc-%'`
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

beforeEach(() => {
  catalogDir = mkdtempSync(join(tmpdir(), "catsrc-catalog-"))
  process.env.LIAISON_APP_CATALOG_DIR = catalogDir
  resetCatalogCache()
  resetRegistryCache()
  writeBakedCatalog()
  startRegistry()
  env.LIAISON_APP_REGISTRY_URL = `${registryBase}/index.json`
})

afterEach(() => {
  server?.stop(true)
  server = null
  rmSync(catalogDir, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  resetCatalogCache()
  resetRegistryCache()
})

describe("catalog sources", () => {
  it("merges the registry's listings beside the baked ones, tagged with their source", async () => {
    const { apps, notice } = await listMergedCatalog()
    expect(notice).toBeUndefined()
    expect(apps.map((a) => [a.name, a.source])).toEqual([
      [BAKED, "baked"],
      [REMOTE, "registry"],
    ])
    const remote = apps.find((a) => a.name === REMOTE)
    expect(remote).toMatchObject({
      version: "1.2.0",
      displayName: "Remote Shipping",
      license: "Apache-2.0",
      listing: LISTING,
      packageUrl: `${registryBase}/packages/${REMOTE}-1.2.0.liaisonapp`,
      installed: false,
    })
    // The baked entry keeps its own version and listing: the registry's copy of the name lost.
    expect(apps.find((a) => a.name === BAKED)).toMatchObject({ version: "0.1.0", source: "baked" })
  })

  it("drops registry entries with no listing or with a price under the listing", async () => {
    const registry = new RegistryCatalogSource(`${registryBase}/index.json`)
    const names = (await registry.list()).map((e) => e.name)
    expect(names).toContain(REMOTE)
    expect(names).not.toContain("catsrc-unlisted")
    expect(names).not.toContain("catsrc-priced")
  })

  it("never auto-grants a registry package: it is a URL install with explicit consent", async () => {
    const registry = new RegistryCatalogSource(`${registryBase}/index.json`)
    expect(await registry.fetchPackage(REMOTE, "1.2.0")).toEqual({
      source: "registry",
      url: `${registryBase}/packages/${REMOTE}-1.2.0.liaisonapp`,
    })
    // The baked source is the only one that grants the app's own scopes.
    const baked = await new BakedCatalogSource().fetchPackage(BAKED, "0.1.0")
    expect(baked).toMatchObject({ source: "baked", grantedScopes: [`${BAKED}:items:read`] })

    const res = await authed(`/api/apps/catalog/${REMOTE}/install`, { method: "POST" })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toContain("Install from URL")
    expect(body.error.message).toContain(`${REMOTE}-1.2.0.liaisonapp`)
    const rows = await sql`SELECT 1 FROM kernel.apps_installed WHERE name = ${REMOTE}`
    expect(rows.length).toBe(0)
  })

  it("GET /api/apps/catalog returns the merged listings", async () => {
    const res = await authed("/api/apps/catalog")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { apps: Array<{ name: string; source: string }>; notice?: string }
    }
    expect(body.data.notice).toBeUndefined()
    expect(body.data.apps.map((a) => `${a.name}:${a.source}`)).toEqual([
      `${BAKED}:baked`,
      `${REMOTE}:registry`,
    ])
  })

  it("falls back to the baked catalog with a notice when the registry is unreachable", async () => {
    server?.stop(true)
    server = null
    const { apps, notice } = await listMergedCatalog()
    expect(notice).toBe("registry_unreachable")
    expect(apps.map((a) => a.name)).toEqual([BAKED])

    const res = await authed("/api/apps/catalog")
    const body = (await res.json()) as { data: { apps: unknown[]; notice?: string } }
    expect(res.status).toBe(200)
    expect(body.data.notice).toBe("registry_unreachable")
    expect(body.data.apps).toHaveLength(1)
  })

  it("lists only the baked catalog, with no notice, when no registry is configured", async () => {
    env.LIAISON_APP_REGISTRY_URL = undefined
    const { apps, notice } = await listMergedCatalog()
    expect(notice).toBeUndefined()
    expect(apps.map((a) => a.source)).toEqual(["baked"])
  })
})

describe("parseRegistryUrl", () => {
  it("accepts an https registry URL", () => {
    expect(parseRegistryUrl("https://apps.example.com/index.json", { allowHttp: false }).href).toBe(
      "https://apps.example.com/index.json",
    )
  })

  it("refuses a plain-http registry URL outside tests", () => {
    expect(() =>
      parseRegistryUrl("http://apps.example.com/index.json", { allowHttp: false }),
    ).toThrow("https")
  })

  it("refuses a non-web scheme even in tests", () => {
    expect(() => parseRegistryUrl("file:///etc/passwd", { allowHttp: true })).toThrow("https")
  })

  it("a registry source built on an http URL outside tests refuses to list", async () => {
    const registry = new RegistryCatalogSource("http://apps.example.com/index.json", {
      allowHttp: false,
    })
    await expect(registry.list()).rejects.toThrow("https")
  })
})
