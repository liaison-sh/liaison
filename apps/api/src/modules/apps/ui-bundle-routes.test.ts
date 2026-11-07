// SPDX-License-Identifier: FSL-1.1-ALv2
// HTTP-level tests for `GET /api/apps/:name/:version/ui.js` and the signed
// statement files served beside it.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appFramePolicy } from "@liaison/shared"
import { eq } from "drizzle-orm"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { env } from "~/lib/env"
import { resetAppFrameRuntime } from "~/modules/apps/app-frame"
import { manifestRegistry } from "~/modules/apps/app-registries"
import { resetCatalogCache } from "~/modules/apps/catalog"
import { resetInstallTrustCache } from "~/modules/apps/install-trust"
import { signUiBundleToken } from "~/modules/apps/ui-bundle-token"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG = "00000000-0000-4000-8000-0000000ab001"
const USER = "00000000-0000-4000-8000-0000000ab002"

let adminToken: string

async function token(): Promise<string> {
  return signAccessToken(
    {
      userId: USER,
      orgId: ORG,
      name: "UI Bundle Admin",
      authVersion: 1,
      permissionVersion: 1,
      scopes: ["kernel:apps:admin"],
      dimensionGrants: {},
    },
    env.JWT_SECRET,
  )
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${adminToken}` },
  })
}

let installRoot: string

/** The bundle URL as the authenticated app list hands it out: with the capability token. */
async function tokenedUrl(name: string, version: string): Promise<string> {
  return `/api/apps/${name}/${version}/ui.js?t=${encodeURIComponent(await signUiBundleToken(name, version))}`
}

/** The install record the UI route's trust check reads. */
async function seedInstalled(
  name: string,
  version: string,
  trust: { approved?: boolean; signed?: boolean },
): Promise<void> {
  await withSystemDb("ui-route-test:seed-installed", (db) =>
    db
      .insert(appsInstalled)
      .values({
        name,
        version,
        sourceUrl: "https://example.test/app.liaisonapp",
        sha256: "0".repeat(64),
        installedBy: USER,
        ...(trust.signed ? { signatureBundle: "{}" } : {}),
        ...(trust.approved
          ? { uiFullAccessApprovedBy: USER, uiFullAccessApprovedAt: new Date() }
          : {}),
      })
      .onConflictDoNothing(),
  )
  resetInstallTrustCache(name)
}

beforeAll(async () => {
  await acquireTestLock()
  await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG}, 'UI Bundle Org', 'ui-bundle-org')`
  await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER}, ${ORG}, 'uibd@test.com', 'UIBD')`
  adminToken = await token()
})

afterAll(async () => {
  await sql`DELETE FROM kernel.audit_log WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE id = ${USER}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  await releaseTestLock()
})

describe("GET /api/apps/:name/:version/ui.js", () => {
  beforeEach(async () => {
    installRoot = mkdtempSync(join(tmpdir(), "ui-route-test-"))
    process.env.LIAISON_APPS_DIR = installRoot
    for (const v of ["1.2.3", "9.9.9"]) {
      const dir = join(installRoot, "fixture-app", v)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "ui.js"), `export const SettingsPanel = () => null /* v=${v} */`)
      writeFileSync(join(dir, "app.manifest.json"), JSON.stringify({ name: "fixture-app" }))
      writeFileSync(join(dir, "bundle.js"), `export const x = 1`)
    }
    await withSystemDb("ui-route-test:seed-active", (db) =>
      db
        .insert(appsActiveVersion)
        .values({ name: "fixture-app", version: "1.2.3" })
        .onConflictDoNothing(),
    )
    await seedInstalled("fixture-app", "1.2.3", { approved: true })
  })

  afterEach(async () => {
    rmSync(installRoot, { recursive: true, force: true })
    delete process.env.LIAISON_APPS_DIR
    await withSystemDb("ui-route-test:clear-active", (db) =>
      db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, "fixture-app")),
    )
    await withSystemDb("ui-route-test:clear-other", (db) =>
      db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, "other-app")),
    )
    for (const n of ["fixture-app", "other-app"]) {
      await withSystemDb("ui-route-test:clear-installed", (db) =>
        db.delete(appsInstalled).where(eq(appsInstalled.name, n)),
      )
      resetInstallTrustCache(n)
    }
  })

  it("returns an outside app's bundle as plain text, never a script this origin would run", async () => {
    const res = await app.request(await tokenedUrl("fixture-app", "1.2.3"))
    expect(res.status).toBe(200)
    // The page only reads its text for the frame; with nosniff, a <script> or
    // import() of it in this origin is refused.
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    expect(res.headers.get("cache-control")).toContain("private")
    const body = await res.text()
    expect(body).toContain("SettingsPanel")
    expect(body).toContain("/* v=1.2.3 */")
  })

  it("404s a non-first-party bundle without the URL token, and with a token for another app or version", async () => {
    expect((await app.request("/api/apps/fixture-app/1.2.3/ui.js")).status).toBe(404)
    expect((await app.request("/api/apps/fixture-app/1.2.3/ui.js?t=garbage")).status).toBe(404)
    const wrongVersion = await signUiBundleToken("fixture-app", "9.9.9")
    expect(
      (await app.request(`/api/apps/fixture-app/1.2.3/ui.js?t=${encodeURIComponent(wrongVersion)}`))
        .status,
    ).toBe(404)
    const wrongApp = await signUiBundleToken("other-app", "1.2.3")
    expect(
      (await app.request(`/api/apps/fixture-app/1.2.3/ui.js?t=${encodeURIComponent(wrongApp)}`))
        .status,
    ).toBe(404)
  })

  it("the authenticated app list hands the URL out with a token that loads the bundle", async () => {
    const t = await signUiBundleToken("fixture-app", "1.2.3")
    expect(t.length).toBeGreaterThan(20)
    expect((await app.request(await tokenedUrl("fixture-app", "1.2.3"))).status).toBe(200)
  })

  it("returns 404 for a name that doesn't match any installed app", async () => {
    const res = await authed("/api/apps/no-such-app/1.0.0/ui.js")
    expect(res.status).toBe(404)
  })

  it("never lets a cache keep a refusal: every 404 and 400 is no-store", async () => {
    for (const path of [
      "/api/apps/fixture-app/1.2.3/ui.js",
      "/api/apps/fixture-app/1.2.3/ui.js?t=garbage",
      "/api/apps/no-such-app/1.0.0/ui.js",
      "/api/apps/fixture-app/9.9.9/ui.js",
    ]) {
      const res = await app.request(path)
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.headers.get("cache-control")).toBe("no-store")
    }
    const ok = await app.request(await tokenedUrl("fixture-app", "1.2.3"))
    expect(ok.status).toBe(200)
    expect(ok.headers.get("cache-control")).not.toBe("no-store")
  })

  it("rejects path-traversal in :name (URL-encoded slash)", async () => {
    const res = await authed("/api/apps/..%2F..%2Fetc/1.0.0/ui.js")
    expect([400, 404]).toContain(res.status)
  })

  it("rejects an :name that fails the kebab-case regex (positive regex test)", async () => {
    const res = await authed("/api/apps/UPPERCASE/1.0.0/ui.js")
    expect(res.status).toBe(400)
  })

  it("rejects :version that is not the active row (active = 1.2.3, request = 9.9.9)", async () => {
    const res = await authed("/api/apps/fixture-app/9.9.9/ui.js")
    expect(res.status).toBe(404)
  })

  it("isolates ui.js per app — two apps with the same filename do not clobber", async () => {
    const dir = join(installRoot, "other-app", "1.0.0")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "ui.js"), `export const OtherPanel = () => null /* other */`)
    writeFileSync(join(dir, "app.manifest.json"), JSON.stringify({ name: "other-app" }))
    writeFileSync(join(dir, "bundle.js"), `export const x = 1`)
    await withSystemDb("ui-route-test:seed-other-active", (db) =>
      db
        .insert(appsActiveVersion)
        .values({ name: "other-app", version: "1.0.0" })
        .onConflictDoNothing(),
    )
    await seedInstalled("other-app", "1.0.0", { approved: true })
    const a = await app.request(await tokenedUrl("fixture-app", "1.2.3"))
    const b = await app.request(await tokenedUrl("other-app", "1.0.0"))
    expect(await a.text()).toContain("SettingsPanel")
    expect(await b.text()).toContain("OtherPanel")
  })

  // S16, A23: a browser tab runs an outside app's interface in a sandboxed
  // frame whose document the server serves, its policy as a response header.
  describe("the frame document (GET /api/apps/:name/:version/frame)", () => {
    const RUNTIME = "window.frameRuntime = '</script>'"
    let publicDir: string
    let priorPublicDir: string | undefined

    async function tokenedFrame(name: string, version: string): Promise<string> {
      return `/api/apps/${name}/${version}/frame?t=${encodeURIComponent(await signUiBundleToken(name, version))}`
    }

    beforeEach(() => {
      publicDir = mkdtempSync(join(tmpdir(), "frame-route-public-"))
      writeFileSync(join(publicDir, "app-frame-runtime.js"), RUNTIME)
      priorPublicDir = process.env.LIAISON_PUBLIC_DIR
      process.env.LIAISON_PUBLIC_DIR = publicDir
      resetAppFrameRuntime()
    })

    afterEach(() => {
      rmSync(publicDir, { recursive: true, force: true })
      if (priorPublicDir === undefined) delete process.env.LIAISON_PUBLIC_DIR
      else process.env.LIAISON_PUBLIC_DIR = priorPublicDir
      resetAppFrameRuntime()
    })

    it("serves the frame runtime under a fresh nonce, the frame policy as a response header", async () => {
      const res = await app.request(await tokenedFrame("fixture-app", "1.2.3"))
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
      const html = await res.text()
      const nonce = /<script nonce="([0-9a-f]{36})">/.exec(html)?.[1]
      expect(nonce).toBeDefined()
      expect(res.headers.get("content-security-policy")).toBe(
        `${appFramePolicy(nonce as string)}; frame-ancestors 'self'; sandbox allow-scripts allow-forms`,
      )
      // Framed by the page only; never cached, never referring, never sniffed.
      expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN")
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("referrer-policy")).toBe("no-referrer")
      expect(res.headers.get("x-content-type-options")).toBe("nosniff")
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin")
      // The runtime is the one script, and cannot close its own element.
      expect(html).toContain("window.frameRuntime = '<\\/script>'")
      expect(html.match(/<script\b/g)).toHaveLength(1)
      // Each response its own nonce.
      const again = await (await app.request(await tokenedFrame("fixture-app", "1.2.3"))).text()
      expect(/<script nonce="([0-9a-f]{36})">/.exec(again)?.[1]).not.toBe(nonce)
    })

    it("404s an unknown app, a version that is not the active one, and a missing or foreign token", async () => {
      expect((await app.request(await tokenedFrame("no-such-app", "1.0.0"))).status).toBe(404)
      expect((await app.request(await tokenedFrame("fixture-app", "9.9.9"))).status).toBe(404)
      expect((await app.request("/api/apps/fixture-app/1.2.3/frame")).status).toBe(404)
      const foreign = await signUiBundleToken("other-app", "1.2.3")
      expect(
        (await app.request(`/api/apps/fixture-app/1.2.3/frame?t=${encodeURIComponent(foreign)}`))
          .status,
      ).toBe(404)
    })

    it("404s an install nobody vouched for", async () => {
      await withSystemDb("frame-route-test:unvouched", (db) =>
        db.delete(appsInstalled).where(eq(appsInstalled.name, "fixture-app")),
      )
      await seedInstalled("fixture-app", "1.2.3", {})
      expect((await app.request(await tokenedFrame("fixture-app", "1.2.3"))).status).toBe(404)
    })

    it("answers 503 when this server bundles no frame runtime", async () => {
      rmSync(join(publicDir, "app-frame-runtime.js"))
      resetAppFrameRuntime()
      const prior = env.NODE_ENV
      ;(env as { NODE_ENV: string }).NODE_ENV = "production"
      try {
        expect((await app.request(await tokenedFrame("fixture-app", "1.2.3"))).status).toBe(503)
      } finally {
        ;(env as { NODE_ENV: string }).NODE_ENV = prior
      }
    })
  })

  // The bundle is JS that runs in the web origin with the user's session, so
  // it is served only for a first-party, publisher-signed or admin-approved install.
  describe("interface trust gate", () => {
    it("404s the bundle of an install nobody vouched for", async () => {
      await withSystemDb("ui-route-test:unvouched", (db) =>
        db.delete(appsInstalled).where(eq(appsInstalled.name, "fixture-app")),
      )
      await seedInstalled("fixture-app", "1.2.3", {})
      const res = await app.request("/api/apps/fixture-app/1.2.3/ui.js")
      expect(res.status).toBe(404)
    })

    it("404s when the active version has no install record at all", async () => {
      await withSystemDb("ui-route-test:norecord", (db) =>
        db.delete(appsInstalled).where(eq(appsInstalled.name, "fixture-app")),
      )
      resetInstallTrustCache("fixture-app")
      const res = await app.request("/api/apps/fixture-app/1.2.3/ui.js")
      expect(res.status).toBe(404)
    })

    it("serves it for a package signed by the operator's trusted publisher", async () => {
      await withSystemDb("ui-route-test:signed", (db) =>
        db.delete(appsInstalled).where(eq(appsInstalled.name, "fixture-app")),
      )
      await seedInstalled("fixture-app", "1.2.3", { signed: true })
      const res = await app.request(await tokenedUrl("fixture-app", "1.2.3"))
      expect(res.status).toBe(200)
    })

    it("records and withdraws an explicit admin approval through the approval route", async () => {
      await withSystemDb("ui-route-test:unvouched2", (db) =>
        db.delete(appsInstalled).where(eq(appsInstalled.name, "fixture-app")),
      )
      await seedInstalled("fixture-app", "1.2.3", {})
      expect((await app.request("/api/apps/fixture-app/1.2.3/ui.js")).status).toBe(404)

      const approve = await authed("/api/apps/fixture-app/ui-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      })
      expect(approve.status).toBe(200)
      expect((await app.request(await tokenedUrl("fixture-app", "1.2.3"))).status).toBe(200)
      const [row] = await withSystemDb("ui-route-test:read-approval", (db) =>
        db.select().from(appsInstalled).where(eq(appsInstalled.name, "fixture-app")),
      )
      expect(row?.uiFullAccessApprovedBy).toBe(USER)
      expect(row?.uiFullAccessApprovedAt).toBeInstanceOf(Date)
      const audited =
        await sql`SELECT action FROM kernel.audit_log WHERE org_id = ${ORG} AND app = 'fixture-app' AND action = 'app.ui_full_access.approved'`
      expect(audited.length).toBeGreaterThan(0)

      const withdraw = await authed("/api/apps/fixture-app/ui-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false }),
      })
      expect(withdraw.status).toBe(200)
      expect((await app.request(await tokenedUrl("fixture-app", "1.2.3"))).status).toBe(404)
    })

    it("the app list keeps an unvouched app but without its interface, and tokens a vouched one", async () => {
      manifestRegistry.set([ORG, "fixture-app"], {
        name: "fixture-app",
        uiBundleUrl: "/api/apps/fixture-app/1.2.3/ui.js",
      })
      try {
        const list = async () => {
          const res = await authed("/api/apps/manifests")
          expect(res.status).toBe(200)
          const body = (await res.json()) as {
            data: Array<{ name: string; uiBundleUrl: string | null }>
          }
          return body.data.find((d) => d.name === "fixture-app")
        }
        const approved = await list()
        expect(approved?.uiBundleUrl).toMatch(/^\/api\/apps\/fixture-app\/1\.2\.3\/ui\.js\?t=/)

        await withSystemDb("ui-route-test:unvouched3", (db) =>
          db.delete(appsInstalled).where(eq(appsInstalled.name, "fixture-app")),
        )
        await seedInstalled("fixture-app", "1.2.3", {})
        const unvouched = await list()
        expect(unvouched).toBeDefined()
        expect(unvouched?.uiBundleUrl).toBeNull()
      } finally {
        manifestRegistry.delete([ORG, "fixture-app"])
      }
    })

    it("a bundle token is not a session credential", async () => {
      const t = await signUiBundleToken("fixture-app", "1.2.3")
      const res = await app.request("/api/apps/manifests", {
        headers: { Authorization: `Bearer ${t}` },
      })
      expect(res.status).toBe(401)
    })

    it("refuses an unauthenticated approval", async () => {
      const res = await app.request("/api/apps/fixture-app/ui-approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      })
      expect([401, 403]).toContain(res.status)
    })
  })
})

// Signed first-party apps (P3): the catalog keeps each signed artifact's statement
// and signature, and the server serves them beside ui.js so a shell can verify the
// bundle before running it in its main page. Same guards as ui.js, first-party only.
describe("GET /api/apps/:name/:version/statement.json|.sig|manifest.json", () => {
  const NAME = "signed-fixture"
  const VERSION = "2.0.0"
  const STATEMENT = '{"v":1}'
  const SIG = "c2lnbmF0dXJl"
  let catalogDir: string
  let priorCatalogDir: string | undefined

  /** A catalog with this app's tarball (+ statement when `signed`), installed byte-identically. */
  async function bake(signed: boolean): Promise<void> {
    const stage = mkdtempSync(join(tmpdir(), "signed-stage-"))
    writeFileSync(
      join(stage, "app.manifest.json"),
      JSON.stringify({ name: NAME, version: VERSION }),
    )
    writeFileSync(join(stage, "ui.js"), "export const Panel = () => null\n")
    writeFileSync(join(stage, "bundle.js"), "export const x = 1\n")
    const file = `${NAME}-${VERSION}.liaisonapp`
    const tar = Bun.spawnSync([
      "tar",
      "-czf",
      join(catalogDir, file),
      "-C",
      stage,
      "app.manifest.json",
      "ui.js",
      "bundle.js",
    ])
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString())
    const tarballSha = createHash("sha256")
      .update(readFileSync(join(catalogDir, file)))
      .digest("hex")
    const dir = join(installRoot, NAME, VERSION)
    mkdirSync(dir, { recursive: true })
    for (const f of ["app.manifest.json", "ui.js", "bundle.js"]) {
      writeFileSync(join(dir, f), readFileSync(join(stage, f)))
    }
    rmSync(stage, { recursive: true, force: true })
    const statement = JSON.stringify({
      v: 1,
      name: NAME,
      version: VERSION,
      sha256: { package: tarballSha },
    })
    if (signed) {
      writeFileSync(join(catalogDir, `${NAME}-${VERSION}.statement.json`), statement)
      writeFileSync(join(catalogDir, `${NAME}-${VERSION}.statement.sig`), SIG)
    }
    writeFileSync(
      join(catalogDir, "catalog.json"),
      JSON.stringify([
        {
          name: NAME,
          version: VERSION,
          file,
          scopes: [],
          connections: [],
          ...(signed
            ? {
                signed: {
                  statement: `${NAME}-${VERSION}.statement.json`,
                  signature: `${NAME}-${VERSION}.statement.sig`,
                },
              }
            : {}),
        },
      ]),
    )
    resetCatalogCache()
    await withSystemDb("signed-route-test:seed", async (db) => {
      await db
        .insert(appsActiveVersion)
        .values({ name: NAME, version: VERSION })
        .onConflictDoNothing()
      await db
        .insert(appsInstalled)
        .values({
          name: NAME,
          version: VERSION,
          sourceUrl: `catalog:${NAME}`,
          sha256: tarballSha,
          installedBy: USER,
        })
        .onConflictDoNothing()
    })
    resetInstallTrustCache()
  }

  beforeEach(() => {
    installRoot = mkdtempSync(join(tmpdir(), "signed-route-install-"))
    catalogDir = mkdtempSync(join(tmpdir(), "signed-route-catalog-"))
    process.env.LIAISON_APPS_DIR = installRoot
    priorCatalogDir = process.env.LIAISON_APP_CATALOG_DIR
    process.env.LIAISON_APP_CATALOG_DIR = catalogDir
  })

  afterEach(async () => {
    rmSync(installRoot, { recursive: true, force: true })
    rmSync(catalogDir, { recursive: true, force: true })
    delete process.env.LIAISON_APPS_DIR
    if (priorCatalogDir === undefined) delete process.env.LIAISON_APP_CATALOG_DIR
    else process.env.LIAISON_APP_CATALOG_DIR = priorCatalogDir
    await withSystemDb("signed-route-test:clear", async (db) => {
      await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, NAME))
      await db.delete(appsInstalled).where(eq(appsInstalled.name, NAME))
    })
    resetCatalogCache()
    resetInstallTrustCache()
  })

  it("serves the statement and signature of a signed first-party app, no auth needed", async () => {
    await bake(true)
    const ui = await app.request(`/api/apps/${NAME}/${VERSION}/ui.js`)
    expect(ui.status).toBe(200)
    // A first-party bundle is a module the page (or a verifying shell) runs.
    expect(ui.headers.get("content-type")).toBe("application/javascript; charset=utf-8")
    const statement = await app.request(`/api/apps/${NAME}/${VERSION}/statement.json`)
    expect(statement.status).toBe(200)
    expect(statement.headers.get("content-type")).toMatch(/application\/json/)
    const body = JSON.parse(await statement.text())
    expect(body).toMatchObject({ v: 1, name: NAME, version: VERSION })
    const sig = await app.request(`/api/apps/${NAME}/${VERSION}/statement.sig`)
    expect(sig.status).toBe(200)
    expect(await sig.text()).toBe(SIG)
    // The manifest the statement hashes: the package's own app.manifest.json, byte for byte.
    const manifest = await app.request(`/api/apps/${NAME}/${VERSION}/manifest.json`)
    expect(manifest.status).toBe(200)
    expect(manifest.headers.get("content-type")).toMatch(/application\/json/)
    expect(await manifest.text()).toBe(
      readFileSync(join(installRoot, NAME, VERSION, "app.manifest.json"), "utf8"),
    )
  })

  it("404s both for an unsigned first-party app (built locally)", async () => {
    await bake(false)
    expect((await app.request(`/api/apps/${NAME}/${VERSION}/ui.js`)).status).toBe(200)
    expect((await app.request(`/api/apps/${NAME}/${VERSION}/statement.json`)).status).toBe(404)
    expect((await app.request(`/api/apps/${NAME}/${VERSION}/statement.sig`)).status).toBe(404)
    expect((await app.request(`/api/apps/${NAME}/${VERSION}/manifest.json`)).status).toBe(404)
  })

  it("404s for a version that is not the active one, and when the install is not the catalog's", async () => {
    await bake(true)
    expect((await app.request(`/api/apps/${NAME}/9.9.9/statement.json`)).status).toBe(404)
    writeFileSync(join(installRoot, NAME, VERSION, "ui.js"), "export const Other = 1\n")
    resetInstallTrustCache()
    expect((await app.request(`/api/apps/${NAME}/${VERSION}/statement.json`)).status).toBe(404)
  })

  it("the app list marks a first-party app `firstParty: true`, signed or not, and no other", async () => {
    manifestRegistry.set([ORG, NAME], {
      name: NAME,
      version: VERSION,
      uiBundleUrl: `/api/apps/${NAME}/${VERSION}/ui.js`,
    })
    try {
      const entry = async () => {
        const res = await authed("/api/apps/manifests")
        const body = (await res.json()) as {
          data: Array<{ name: string; firstParty?: boolean }>
        }
        return body.data.find((d) => d.name === NAME)
      }
      await bake(false)
      expect((await entry())?.firstParty).toBe(true)
      // Bytes that are not the catalog's: an outside app now.
      writeFileSync(join(installRoot, NAME, VERSION, "ui.js"), "export const Other = 1\n")
      await withSystemDb("signed-route-test:approve", (db) =>
        db
          .update(appsInstalled)
          .set({ uiFullAccessApprovedBy: USER, uiFullAccessApprovedAt: new Date() })
          .where(eq(appsInstalled.name, NAME)),
      )
      resetInstallTrustCache()
      expect((await entry())?.firstParty).toBeUndefined()
    } finally {
      manifestRegistry.delete([ORG, NAME])
    }
  })

  it("serves no frame document for a first-party app, which a browser runs in the page", async () => {
    await bake(true)
    const t = await signUiBundleToken(NAME, VERSION)
    expect(
      (await app.request(`/api/apps/${NAME}/${VERSION}/frame?t=${encodeURIComponent(t)}`)).status,
    ).toBe(404)
  })

  it("the app list marks a signed first-party app `signed: true`, and only that one", async () => {
    manifestRegistry.set([ORG, NAME], {
      name: NAME,
      version: VERSION,
      uiBundleUrl: `/api/apps/${NAME}/${VERSION}/ui.js`,
    })
    try {
      const entry = async () => {
        const res = await authed("/api/apps/manifests")
        const body = (await res.json()) as { data: Array<{ name: string; signed?: boolean }> }
        return body.data.find((d) => d.name === NAME)
      }
      await bake(true)
      expect((await entry())?.signed).toBe(true)
      writeFileSync(join(catalogDir, "catalog.json"), "[]")
      resetCatalogCache()
      resetInstallTrustCache()
      expect((await entry())?.signed).toBeUndefined()
    } finally {
      manifestRegistry.delete([ORG, NAME])
    }
  })
})
