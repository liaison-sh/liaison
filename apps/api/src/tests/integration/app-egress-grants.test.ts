// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Outbound domains are part of an app's grant (modules/apps/egress-grants.ts,
// 0281): the sandbox reaches a host only when the manifest declares it AND the
// install row granted it. Catalog artifacts are granted at install (so an org
// created afterwards reaches them), an unvouched install or upgrade needs the
// admin's consent for every new domain, a revoke holds on the next run, the
// credential injection follows the narrowed per-connection list, the builder's
// pinned grant must be exactly the package's, and a grandfathered row (NULL)
// keeps every declared domain.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import type { RlsClient } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { expectedCustomAppName } from "~/modules/apps/app-org-scope"
import { installCatalogApp, resetCatalogCache } from "~/modules/apps/catalog"
import {
  DomainConsentError,
  DomainPinMismatchError,
  declaredDomains,
  EgressGrantsTestAccess,
  pendingDomains,
  resolveGrantedDomains,
  withDomainGrant,
} from "~/modules/apps/egress-grants"
import { applyUpgrade, installAppFromTarball, previewUpgrade } from "~/modules/apps/install-service"
import { resetInstallTrustCache } from "~/modules/apps/install-trust"
import { matchesConnectionHost } from "~/modules/apps/sandbox/bridge/fetch-auth"
import {
  type AppManifestForBridge,
  SandboxBridgeTestAccess,
} from "~/modules/apps/sandbox/bridge/shared"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { seedOrgRow } from "~/seed/factories/org/rows"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const CATALOG_APP = "egress-catalog-app"
const SIDELOAD_APP = "egress-sideload-app"
const SHOP_HOST = "egress-test.myshopify.com"

let orgId = ""
let adminId = ""
let catalogDir = ""
let installRoot = ""
let customApp = ""
const seen: string[] = []

const mockTx = {
  execute: async () => [],
  queueEvent: async () => {},
  transaction: (fn: (sp: unknown) => Promise<unknown>) => fn(mockTx),
} as unknown as RlsClient

function tarball(dir: string, name: string, version: string, extra: Record<string, unknown>) {
  const stage = mkdtempSync(join(tmpdir(), "egress-stage-"))
  writeFileSync(
    join(stage, "app.manifest.json"),
    JSON.stringify({
      name,
      version,
      packageFormat: 1,
      license: "MIT",
      scopes: [`${name}:items:read`],
      ...extra,
    }),
  )
  writeFileSync(join(stage, "bundle.js"), `// ${name} ${version} ${crypto.randomUUID()}\n`)
  const file = `${name}-${version}-${crypto.randomUUID().slice(0, 6)}.liaisonapp`
  spawnSync("tar", ["-czf", join(dir, file), "-C", stage, "app.manifest.json", "bundle.js"])
  rmSync(stage, { recursive: true, force: true })
  return file
}

/** One ctx.fetch through a fresh bridge (a new run), answered by the stub upstream. */
async function fetchAs(name: string, manifest: AppManifestForBridge, url: string, opts = {}) {
  resetInstallTrustCache(name)
  const bridge = createRpcBridge(name, adminId, orgId, mockTx, manifest)
  return (bridge.fetch(url, JSON.stringify(opts)) as Promise<string>).then(
    () => "reached",
    (err: Error & { code?: string }) => err.code ?? err.message,
  )
}

// A fresh token per call: an app's registration bumps the members' permission version.
const call = async (path: string, init: RequestInit = {}) =>
  app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${await minimal.token(adminId)}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  })

async function rowOf(name: string, version: string) {
  const rows = await withSystemDb("egress-test-row", (db) =>
    db.select().from(appsInstalled).where(eq(appsInstalled.name, name)),
  )
  return rows.find((r) => r.version === version)
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  adminId = (await minimal.orgAdmin(orgId)).id
  customApp = expectedCustomAppName("egress", orgId)
}, 60_000)

beforeEach(() => {
  catalogDir = mkdtempSync(join(tmpdir(), "egress-catalog-"))
  installRoot = mkdtempSync(join(tmpdir(), "egress-root-"))
  process.env.LIAISON_APP_CATALOG_DIR = catalogDir
  process.env.LIAISON_APPS_DIR = installRoot
  resetCatalogCache()
  seen.length = 0
  SandboxBridgeTestAccess.setFetchInterceptsHost(() => true)
  SandboxBridgeTestAccess.setFetch((async (url: string) => {
    seen.push(String(url))
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch)
})

afterEach(async () => {
  SandboxBridgeTestAccess.setFetch(null)
  SandboxBridgeTestAccess.setFetchInterceptsHost(null)
  EgressGrantsTestAccess.setLookup(null)
  for (const n of [CATALOG_APP, SIDELOAD_APP, customApp]) {
    await withSystemDb("egress-test-clean", async (db) => {
      await db.delete(appsInstalled).where(eq(appsInstalled.name, n))
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, n))
    })
    resetInstallTrustCache(n)
  }
  rmSync(catalogDir, { recursive: true, force: true })
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  resetCatalogCache()
})

afterAll(async () => {
  await releaseTestLock()
})

describe("the grant rules", () => {
  const manifest = {
    network: { allowedDomains: ["API.example.com", "*.cdn.example"] },
    connections: { shop: { allowedDomains: ["*.myshopify.com"] } },
  }

  it("declared domains come from network and every connection, normalised", () => {
    expect(declaredDomains(manifest)).toEqual([
      "*.cdn.example",
      "*.myshopify.com",
      "api.example.com",
    ])
    expect(pendingDomains(manifest, null)).toEqual([])
    expect(pendingDomains(manifest, ["api.example.com"])).toEqual([
      "*.cdn.example",
      "*.myshopify.com",
    ])
  })

  it("the framed screens' image and link hosts are declared domains: consent, newDomains, the pin", () => {
    const framed = {
      network: { allowedDomains: ["api.example.com"], imageHosts: ["IMG.example"], linkHosts: ["admin.example"] },
    }
    expect(declaredDomains(framed)).toEqual(["admin.example", "api.example.com", "img.example"])
    // An upgrade that only adds an image host asks for it.
    expect(pendingDomains(framed, ["api.example.com", "admin.example"])).toEqual(["img.example"])
    expect(() =>
      resolveGrantedDomains({ manifest: framed, granted: ["api.example.com"], vouched: false, what: "Install" }),
    ).toThrow(DomainConsentError)
    expect(() =>
      resolveGrantedDomains({ manifest: framed, granted: ["api.example.com"], vouched: false, exact: true, what: "Install" }),
    ).toThrow(DomainPinMismatchError)
    // The catalog and trusted publishers still get every one of them.
    expect(
      resolveGrantedDomains({ manifest: framed, granted: [], vouched: true, what: "Install" }),
    ).toEqual(["admin.example", "api.example.com", "img.example"])
  })

  it("an unvouched install needs consent for every domain; vouched and programmatic get all", () => {
    expect(() =>
      resolveGrantedDomains({
        manifest,
        granted: ["api.example.com"],
        vouched: false,
        what: "Install",
      }),
    ).toThrow(DomainConsentError)
    expect(
      resolveGrantedDomains({ manifest, granted: [], vouched: true, what: "Install" }),
    ).toHaveLength(3)
    expect(
      resolveGrantedDomains({ manifest, granted: undefined, vouched: false, what: "Install" }),
    ).toHaveLength(3)
    // An upgrade keeps what the running version holds; only the new ones are asked.
    expect(
      resolveGrantedDomains({
        manifest,
        granted: ["*.myshopify.com"],
        alreadyGranted: ["api.example.com", "*.cdn.example"],
        vouched: false,
        what: "Upgrade",
      }),
    ).toHaveLength(3)
  })

  it("the builder's pinned domains must be exactly the package's", () => {
    expect(() =>
      resolveGrantedDomains({
        manifest,
        granted: ["api.example.com", "*.cdn.example"],
        vouched: false,
        exact: true,
        what: "Install",
      }),
    ).toThrow(DomainPinMismatchError)
    expect(() =>
      resolveGrantedDomains({
        manifest,
        granted: [...declaredDomains(manifest), "extra.example"],
        vouched: false,
        exact: true,
        what: "Install",
      }),
    ).toThrow(DomainPinMismatchError)
  })

  it("a connection with no granted host takes its credential nowhere", () => {
    const m: AppManifestForBridge = {
      name: "creds",
      network: { allowedDomains: ["*.example.com"] },
      connections: { api: { type: "credentials", allowedDomains: ["api.example.com"] } },
    }
    const narrowed = withDomainGrant(m, ["*.example.com"])
    expect(matchesConnectionHost(m, "api", "https://api.example.com/x")).toBe(true)
    expect(matchesConnectionHost(narrowed, "api", "https://api.example.com/x")).toBe(false)
  })
})

describe("catalog installs", () => {
  it("are granted every declared domain, so an org created afterwards reaches them", async () => {
    const file = tarball(catalogDir, CATALOG_APP, "1.0.0", {
      network: { allowedDomains: ["*.myshopify.com"] },
    })
    writeFileSync(
      join(catalogDir, "catalog.json"),
      JSON.stringify([
        {
          name: CATALOG_APP,
          version: "1.0.0",
          file,
          scopes: [`${CATALOG_APP}:items:read`],
          connections: [],
        },
      ]),
    )
    await installCatalogApp({ orgId, name: CATALOG_APP, installedBy: adminId, register: false })
    expect((await rowOf(CATALOG_APP, "1.0.0"))?.grantedDomains).toEqual(["*.myshopify.com"])
    // A vouched artifact through the consent path is granted all too.
    await installAppFromTarball({
      tarballPath: join(catalogDir, file),
      installedBy: adminId,
      grantedScopes: [`${CATALOG_APP}:items:read`],
      grantedDomains: [],
      requireSignature: false,
    })
    expect((await rowOf(CATALOG_APP, "1.0.0"))?.grantedDomains).toEqual(["*.myshopify.com"])

    // A new org after the install (a row only: createTestOrg would truncate the install).
    const later = await seedOrgRow({
      id: crypto.randomUUID(),
      name: "Later Org",
      slug: `later-${crypto.randomUUID().slice(0, 8)}`,
    })
    resetInstallTrustCache(CATALOG_APP)
    const bridge = createRpcBridge(CATALOG_APP, "system", later, mockTx, {
      name: CATALOG_APP,
      network: { allowedDomains: ["*.myshopify.com"] },
    })
    await bridge.fetch(`https://${SHOP_HOST}/admin/api/graphql.json`, "{}")
    expect(seen).toEqual([`https://${SHOP_HOST}/admin/api/graphql.json`])
  })
})

describe("an unvouched app", () => {
  it("a URL-installed custom app's upgrade adding a domain is refused egress until consent", async () => {
    const v1 = tarball(installRoot, customApp, "1.0.0", {
      network: { allowedDomains: ["one.example.com"] },
    })
    const base = {
      installedBy: adminId,
      grantedScopes: [`${customApp}:items:read`],
      requireSignature: false,
      ownerOrgId: orgId,
    }
    await expect(
      installAppFromTarball({ ...base, tarballPath: join(installRoot, v1), grantedDomains: [] }),
    ).rejects.toThrow(DomainConsentError)
    await installAppFromTarball({
      ...base,
      tarballPath: join(installRoot, v1),
      grantedDomains: ["one.example.com"],
    })
    const v2Manifest: AppManifestForBridge = {
      name: customApp,
      network: { allowedDomains: ["one.example.com", "two.example.com"] },
    }
    const v2 = tarball(installRoot, customApp, "1.1.0", { network: v2Manifest.network })
    const preview = await previewUpgrade({
      name: customApp,
      tarballPath: join(installRoot, v2),
      requireSignature: false,
    })
    expect(preview.newDomains).toEqual(["two.example.com"])
    const upgrade = { ...base, name: customApp, tarballPath: join(installRoot, v2) }
    await expect(applyUpgrade({ ...upgrade, grantedDomains: [] })).rejects.toThrow(
      /outbound domains the admin did not approve: two\.example\.com/,
    )
    // Still on 1.0.0: the new host is not reachable.
    expect(await fetchAs(customApp, v2Manifest, "https://two.example.com/x")).toMatch(
      /Domain not in allowlist/,
    )
    await applyUpgrade({ ...upgrade, grantedDomains: preview.newDomains })
    expect((await rowOf(customApp, "1.1.0"))?.grantedDomains).toEqual([
      "one.example.com",
      "two.example.com",
    ])
    expect(await fetchAs(customApp, v2Manifest, "https://two.example.com/x")).toBe("reached")
  })

  it("a revoke takes effect on the next run, and a grant brings the host back", async () => {
    const manifest: AppManifestForBridge = {
      name: SIDELOAD_APP,
      network: { allowedDomains: ["a.example.com", "b.example.com"] },
    }
    const file = tarball(installRoot, SIDELOAD_APP, "1.0.0", { network: manifest.network })
    await installAppFromTarball({
      tarballPath: join(installRoot, file),
      installedBy: adminId,
      grantedScopes: [`${SIDELOAD_APP}:items:read`],
      grantedDomains: ["a.example.com", "b.example.com"],
      requireSignature: false,
    })
    expect(await fetchAs(SIDELOAD_APP, manifest, "https://a.example.com/x")).toBe("reached")

    const revoked = await call(`/api/apps/${SIDELOAD_APP}/outbound`, {
      method: "POST",
      body: JSON.stringify({ revoke: ["a.example.com"] }),
    })
    expect(revoked.status).toBe(200)
    // The next run, with no cache reset of its own: the route reset it.
    const bridge = createRpcBridge(SIDELOAD_APP, adminId, orgId, mockTx, manifest)
    await expect(bridge.fetch("https://a.example.com/x", "{}")).rejects.toThrow(
      /Domain not in allowlist/,
    )
    expect(await fetchAs(SIDELOAD_APP, manifest, "https://b.example.com/x")).toBe("reached")

    const access = (await (await call(`/api/apps/${SIDELOAD_APP}/outbound`)).json()) as {
      data: { granted: string[]; pending: string[]; canManage: boolean }
    }
    expect(access.data).toMatchObject({
      granted: ["b.example.com"],
      pending: ["a.example.com"],
      canManage: true,
    })
    const undeclared = await call(`/api/apps/${SIDELOAD_APP}/outbound`, {
      method: "POST",
      body: JSON.stringify({ grant: ["evil.example.net"] }),
    })
    expect(undeclared.status).toBe(400)
    await call(`/api/apps/${SIDELOAD_APP}/outbound`, {
      method: "POST",
      body: JSON.stringify({ grant: ["a.example.com"] }),
    })
    expect(await fetchAs(SIDELOAD_APP, manifest, "https://a.example.com/x")).toBe("reached")
  })

  it("a grandfathered row (NULL) keeps every declared domain", async () => {
    const manifest: AppManifestForBridge = {
      name: SIDELOAD_APP,
      network: { allowedDomains: ["a.example.com"] },
    }
    const file = tarball(installRoot, SIDELOAD_APP, "1.0.0", { network: manifest.network })
    await installAppFromTarball({
      tarballPath: join(installRoot, file),
      installedBy: adminId,
      grantedScopes: [`${SIDELOAD_APP}:items:read`],
      grantedDomains: ["a.example.com"],
      requireSignature: false,
    })
    await withSystemDb("egress-test-null", (db) =>
      db
        .update(appsInstalled)
        .set({ grantedDomains: null })
        .where(eq(appsInstalled.name, SIDELOAD_APP)),
    )
    expect(await fetchAs(SIDELOAD_APP, manifest, "https://a.example.com/x")).toBe("reached")
    // Its upgrade asks only for what the old version did not declare.
    const v2 = tarball(installRoot, SIDELOAD_APP, "1.1.0", {
      network: { allowedDomains: ["a.example.com", "c.example.com"] },
    })
    const preview = await previewUpgrade({
      name: SIDELOAD_APP,
      tarballPath: join(installRoot, v2),
      requireSignature: false,
    })
    expect(preview.newDomains).toEqual(["c.example.com"])
  })

  it("injects no credential to an ungranted connection host, even one the network grant covers", async () => {
    const manifest: AppManifestForBridge = {
      name: SIDELOAD_APP,
      network: { allowedDomains: ["*.example.com"] },
      connections: { api: { type: "credentials", allowedDomains: ["api.example.com"] } },
    }
    EgressGrantsTestAccess.setLookup(async () => ["*.example.com"])
    const bridge = createRpcBridge(SIDELOAD_APP, adminId, orgId, mockTx, manifest)
    const result = await (
      bridge.fetch(
        "https://api.example.com/x",
        JSON.stringify({ auth: { connection: "api", scheme: "basic", fields: ["key", "secret"] } }),
      ) as Promise<string>
    ).then(
      () => "reached",
      (err: Error & { code?: string }) => err.code ?? err.message,
    )
    expect(result).toBe("credential_host_not_allowed")
    expect(seen).toEqual([])
  })
})
