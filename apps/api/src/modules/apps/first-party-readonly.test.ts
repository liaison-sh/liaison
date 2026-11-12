// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Scope taint lets a `readOnly` tool run on a tainted turn, and runtime.ts honours that mark
// only when the platform, never the manifest, vouches for the app. Bundled apps install
// through the `.liaisonapp` route and run sandboxed (`trusted: false`), so the voucher for
// them is the catalog itself: an installed artifact whose sha256 equals the tarball baked
// into the image is first-party. In-tree apps ship in the image source tree and are
// first-party by construction, sandboxed or not. A sideloaded app, an artifact that differs
// from the baked one, and a manifest that claims the flag for itself all stay ignored.
//
// Harness mirrors catalog.test.ts: a self-made tarball in a temp catalog dir.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { and, eq, inArray } from "drizzle-orm"
import { sql } from "~/db/connection"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { checkToolScopeTaint, UNDECLARED_WRITE_TARGET } from "~/modules/agent/scopes/scope-taint"
import { resetAppRegistries, toolRegistry } from "~/modules/apps/app-registries"
import { installCatalogApp, resetCatalogCache } from "~/modules/apps/catalog"
import type { DiscoveredApp } from "~/modules/apps/discover-apps"
import {
  ensureAppsForOrg,
  getDefaultApps,
  installedAppDescriptor,
  reloadInstalledApps,
} from "~/modules/apps/init"
import { installAppFromTarball } from "~/modules/apps/install-service"

/** The refusal shape, whatever scopes the turn happened to carry (the message names them). */
const taintBlocked = (writeTargetTable: string) =>
  expect.objectContaining({
    ok: false,
    code: "E_SCOPE_TAINT_BLOCKED",
    writeTargetTable,
    reason: "scope_taint_blocked",
  })

/** Any non-empty scope list makes a turn tainted, per `checkToolScopeTaint`. */
const TAINTED_SCOPES = ["a:b:read"]

const TEST_ORG = "00000000-0000-0000-0000-0000000fa101"
const TEST_USER = "00000000-0000-0000-0000-0000000fa102"
const CATALOG_APP = "fp-catalog-app"
const SIDELOAD_APP = "fp-sideload-app"
const VERSION = "0.1.0"

let catalogDir: string
let installRoot: string

/** A minimal `.liaisonapp` with one readOnly read tool and one unmarked write tool. */
function writeTarball(
  dir: string,
  name: string,
  bundleComment: string,
  extraManifest: Record<string, unknown> = {},
  extraFiles: Record<string, string> = {},
  writeItemsExtra: Record<string, unknown> = {},
): string {
  const file = `${name}-${VERSION}-${crypto.randomUUID().slice(0, 6)}.liaisonapp`
  const stage = mkdtempSync(join(tmpdir(), "fp-stage-"))
  const manifest = {
    ...extraManifest,
    name,
    version: VERSION,
    packageFormat: 1,
    license: "MIT",
    scopes: [`${name}:items:read`, `${name}:items:write`],
    tools: {
      list_items: {
        description: "List items",
        requiredScopes: [`${name}:items:read`],
        readOnly: true,
        handler: "listItems",
      },
      write_items: {
        description: "Write items",
        requiredScopes: [`${name}:items:write`],
        handler: "writeItems",
        ...writeItemsExtra,
      },
    },
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  // The comment makes two tarballs of the same name and version differ byte-wise.
  writeFileSync(
    join(stage, "bundle.js"),
    `// ${bundleComment}\nfunction listItems() { return {} }\nfunction writeItems() { return {} }\n`,
  )
  for (const [rel, body] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(stage, rel)), { recursive: true })
    writeFileSync(join(stage, rel), body)
  }
  spawnSync("tar", [
    "-czf",
    join(dir, file),
    "-C",
    stage,
    "app.manifest.json",
    "bundle.js",
    ...Object.keys(extraFiles),
  ])
  rmSync(stage, { recursive: true, force: true })
  return file
}

function writeCatalogIndex(file: string): void {
  writeFileSync(
    join(catalogDir, "catalog.json"),
    JSON.stringify([
      {
        name: CATALOG_APP,
        version: VERSION,
        file,
        scopes: [`${CATALOG_APP}:items:read`, `${CATALOG_APP}:items:write`],
        connections: [],
      },
    ]),
  )
}

// A catalog app that ships every kind of file the runtime loads from an install dir: the
// manifest, bundle.js (handlers and sandboxed summarizers), ui.js and a PDF template bundle.
const TEMPLATE_FILE = `templates/${CATALOG_APP}__invoice_v1.js`
const RICH_MANIFEST = {
  capabilities: ["pdf.render"],
  pdf_templates: [{ kind: `${CATALOG_APP}:invoice_v1`, source: "templates/invoice.ts" }],
}
const RICH_FILES = {
  "ui.js": "export const view = 'baked ui'\n",
  [TEMPLATE_FILE]: "globalThis.renderTemplate = () => []\n",
}

function bakeRichCatalog(): string {
  resetCatalogCache()
  const file = writeTarball(
    catalogDir,
    CATALOG_APP,
    "baked into the image",
    RICH_MANIFEST,
    RICH_FILES,
  )
  writeCatalogIndex(file)
  return file
}

const installedFile = (rel: string) => join(installRoot, CATALOG_APP, VERSION, rel)

const readOnlyOf = (app: string, tool: string) => toolRegistry.get([TEST_ORG, app, tool])?.readOnly

beforeEach(async () => {
  catalogDir = mkdtempSync(join(tmpdir(), "fp-catalog-dir-"))
  installRoot = mkdtempSync(join(tmpdir(), "fp-install-root-"))
  process.env.LIAISON_APP_CATALOG_DIR = catalogDir
  process.env.LIAISON_APPS_DIR = installRoot
  resetCatalogCache()

  writeCatalogIndex(writeTarball(catalogDir, CATALOG_APP, "baked into the image"))

  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${TEST_ORG}, 'First Party Test Org', 'first-party-test-org')
    ON CONFLICT (id) DO NOTHING`
  await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
    VALUES (${TEST_USER}, ${TEST_ORG}, 'first-party@test.com', 'hash', 'First Party', 'active')
    ON CONFLICT (id) DO NOTHING`
})

afterEach(async () => {
  rmSync(catalogDir, { recursive: true, force: true })
  rmSync(installRoot, { recursive: true, force: true })
  delete process.env.LIAISON_APP_CATALOG_DIR
  delete process.env.LIAISON_APPS_DIR
  resetCatalogCache()
  await withSystemDb("first-party-test-cleanup", async (db) => {
    await db.delete(appsInstalled).where(inArray(appsInstalled.name, [CATALOG_APP, SIDELOAD_APP]))
    await db
      .delete(appsActiveVersion)
      .where(inArray(appsActiveVersion.name, [CATALOG_APP, SIDELOAD_APP]))
  })
  for (const app of [CATALOG_APP, SIDELOAD_APP]) {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "app_${app.replace(/-/g, "_")}" CASCADE`)
  }
  await sql`DELETE FROM kernel.apps WHERE name IN (${CATALOG_APP}, ${SIDELOAD_APP})`
  resetAppRegistries()
  await sql`DELETE FROM kernel.users WHERE org_id = ${TEST_ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${TEST_ORG}`
})

describe("first-party trust for readOnly", () => {
  it("keeps a first-party write's sink reader scope, and only inside the app's own namespace", async () => {
    const underscored = CATALOG_APP.replace(/-/g, "_")
    resetCatalogCache()
    writeCatalogIndex(
      writeTarball(
        catalogDir,
        CATALOG_APP,
        "baked with a sink",
        {},
        {},
        {
          writesToTable: `app_${underscored}.items`,
          sinkReadScope: `${CATALOG_APP}:items:read`,
        },
      ),
    )
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: CATALOG_APP, installedBy: TEST_USER })
    const write = toolRegistry.get([TEST_ORG, CATALOG_APP, "write_items"])
    expect(write?.writesToTable).toBe(`app_${underscored}.items`)
    expect(write?.sinkReadScope).toBe(`${CATALOG_APP}:items:read`)
  })

  it("drops a sink reader scope naming another app's namespace", async () => {
    const underscored = CATALOG_APP.replace(/-/g, "_")
    resetCatalogCache()
    writeCatalogIndex(
      writeTarball(
        catalogDir,
        CATALOG_APP,
        "baked with a foreign sink",
        {},
        {},
        {
          writesToTable: `app_${underscored}.items`,
          sinkReadScope: "kernel:threads:read",
        },
      ),
    )
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: CATALOG_APP, installedBy: TEST_USER })
    const write = toolRegistry.get([TEST_ORG, CATALOG_APP, "write_items"])
    expect(write?.writesToTable).toBe(`app_${underscored}.items`)
    expect(write?.sinkReadScope).toBeUndefined()
  })

  it("honours readOnly on a sandboxed app installed from the image's own catalog", async () => {
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: CATALOG_APP, installedBy: TEST_USER })
    expect(readOnlyOf(CATALOG_APP, "list_items")).toBe(true)
    expect(readOnlyOf(CATALOG_APP, "write_items")).toBeUndefined()
  })

  it("ignores readOnly on a sideloaded third-party app", async () => {
    await ensureAppsForOrg(TEST_ORG)
    const sideDir = mkdtempSync(join(tmpdir(), "fp-sideload-"))
    try {
      const file = writeTarball(sideDir, SIDELOAD_APP, "third party")
      await installAppFromTarball({
        tarballPath: join(sideDir, file),
        installedBy: TEST_USER,
        grantedScopes: [`${SIDELOAD_APP}:items:read`, `${SIDELOAD_APP}:items:write`],
        grantedConnections: [],
        requireSignature: false,
      })
      await reloadInstalledApps(TEST_ORG)
      expect(toolRegistry.get([TEST_ORG, SIDELOAD_APP, "list_items"])).toBeDefined()
      expect(readOnlyOf(SIDELOAD_APP, "list_items")).toBeUndefined()
    } finally {
      rmSync(sideDir, { recursive: true, force: true })
    }
  })

  // A first-party catalog name is reserved for that app's own release: an upload of other
  // bytes under it is refused before anything is copied, so it can neither register as the
  // catalog app nor leave files behind under the catalog's recorded sha256. (Files changed on
  // disk by any other means are the `tampers` cases below.)
  const RESERVED = "is the name of a first-party catalog app"

  it("refuses a look-alike upload under the catalog app's name", async () => {
    await ensureAppsForOrg(TEST_ORG)
    const otherDir = mkdtempSync(join(tmpdir(), "fp-lookalike-"))
    try {
      const file = writeTarball(otherDir, CATALOG_APP, "look-alike, not the baked artifact")
      await expect(
        installAppFromTarball({
          tarballPath: join(otherDir, file),
          installedBy: TEST_USER,
          grantedScopes: [`${CATALOG_APP}:items:read`, `${CATALOG_APP}:items:write`],
          grantedConnections: [],
          requireSignature: false,
        }),
      ).rejects.toThrow(RESERVED)
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  it("a refused upload over the installed catalog app leaves its files and its readOnly trust as they were", async () => {
    const baked = bakeRichCatalog()
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: CATALOG_APP, installedBy: TEST_USER })
    expect(readOnlyOf(CATALOG_APP, "list_items")).toBe(true)
    const badDir = mkdtempSync(join(tmpdir(), "fp-swapped-"))
    try {
      // The genuine manifest, byte for byte, with other handler code.
      const file = writeTarball(badDir, CATALOG_APP, "swapped handlers", RICH_MANIFEST)
      await expect(
        installAppFromTarball({
          tarballPath: join(badDir, file),
          installedBy: TEST_USER,
          grantedScopes: [`${CATALOG_APP}:items:read`, `${CATALOG_APP}:items:write`],
          grantedConnections: [],
          requireSignature: false,
        }),
      ).rejects.toThrow(RESERVED)
      const bakedManifest = spawnSync("tar", [
        "-xzOf",
        join(catalogDir, baked),
        "app.manifest.json",
      ]).stdout
      expect(readFileSync(installedFile("app.manifest.json")).equals(bakedManifest)).toBe(true)
      expect(readFileSync(installedFile("bundle.js"), "utf8")).not.toContain("swapped handlers")
      resetAppRegistries()
      await reloadInstalledApps(TEST_ORG)
      expect(toolRegistry.get([TEST_ORG, CATALOG_APP, "list_items"])).toBeDefined()
      expect(readOnlyOf(CATALOG_APP, "list_items")).toBe(true)
    } finally {
      rmSync(badDir, { recursive: true, force: true })
    }
  })

  const tampers: Array<[string, () => void]> = [
    [
      "bundle.js, the handlers and summarizers",
      () =>
        writeFileSync(
          installedFile("bundle.js"),
          "function listItems() { return { swapped: true } }\nfunction writeItems() { return {} }\n",
        ),
    ],
    [
      "the PDF template bundle",
      () => writeFileSync(installedFile(TEMPLATE_FILE), "globalThis.renderTemplate = () => [1]\n"),
    ],
    ["ui.js", () => writeFileSync(installedFile("ui.js"), "export const view = 'swapped'\n")],
    [
      "an extra file the tarball does not carry",
      () => writeFileSync(installedFile("summarizers.js"), "function summarize() {}\n"),
    ],
    ["a missing file the tarball carries", () => unlinkSync(installedFile("ui.js"))],
  ]
  for (const [what, tamper] of tampers) {
    it(`ignores readOnly when the install dir differs from the catalog artifact: ${what}`, async () => {
      bakeRichCatalog()
      await ensureAppsForOrg(TEST_ORG)
      await installCatalogApp({ orgId: TEST_ORG, name: CATALOG_APP, installedBy: TEST_USER })
      expect(readOnlyOf(CATALOG_APP, "list_items")).toBe(true)
      tamper()
      resetAppRegistries()
      await reloadInstalledApps(TEST_ORG)
      expect(toolRegistry.get([TEST_ORG, CATALOG_APP, "list_items"])).toBeDefined()
      expect(readOnlyOf(CATALOG_APP, "list_items")).toBeUndefined()
    })
  }

  it("honours readOnly after a reboot on a genuine install that ships ui.js and a PDF template", async () => {
    bakeRichCatalog()
    await ensureAppsForOrg(TEST_ORG)
    await installCatalogApp({ orgId: TEST_ORG, name: CATALOG_APP, installedBy: TEST_USER })
    resetAppRegistries()
    await reloadInstalledApps(TEST_ORG)
    expect(readOnlyOf(CATALOG_APP, "list_items")).toBe(true)
    expect(readOnlyOf(CATALOG_APP, "write_items")).toBeUndefined()
  })

  it("never takes the first-party flag from the manifest itself", () => {
    const dir = join(installRoot, "self-claim", VERSION)
    mkdirSync(dir, { recursive: true })
    const manifestPath = join(dir, "app.manifest.json")
    writeFileSync(
      manifestPath,
      JSON.stringify({ name: "self-claim", version: VERSION, _firstParty: true, trusted: true }),
    )
    const app: DiscoveredApp = {
      name: "self-claim",
      version: VERSION,
      manifestPath,
      bundlePath: join(dir, "bundle.js"),
      source: "installed",
    }
    const desc = installedAppDescriptor(app)
    expect(desc.trusted).toBe(false)
    expect(desc._firstParty).toBe(false)
  })

  // An install whose artifact carried a cosign bundle the OPERATOR's own trusted-publisher
  // identity signed is an install the org vouched for at install time. `verifyAppPackage`
  // only ever returns a `signatureBundle` after `cosign verify-blob` succeeded against a
  // non-wildcard `LIAISON_TRUSTED_APP_PUBLISHERS` regex, so the persisted
  // `apps_installed.signature_bundle` IS that proof — the tests below patch the row rather
  // than run cosign, which no unit suite can do.
  async function markPublisherSigned(name: string): Promise<void> {
    await withSystemDb("first-party-test-sign", (db) =>
      db
        .update(appsInstalled)
        .set({ signatureBundle: '{"cosign":"verified"}' })
        .where(and(eq(appsInstalled.name, name), eq(appsInstalled.version, VERSION))),
    )
  }

  async function installSideload(
    dir: string,
    comment: string,
    writeItemsExtra: Record<string, unknown> = {},
  ): Promise<void> {
    const file = writeTarball(dir, SIDELOAD_APP, comment, {}, {}, writeItemsExtra)
    await installAppFromTarball({
      tarballPath: join(dir, file),
      installedBy: TEST_USER,
      grantedScopes: [`${SIDELOAD_APP}:items:read`, `${SIDELOAD_APP}:items:write`],
      grantedConnections: [],
      requireSignature: false,
    })
  }

  it("a trusted non-catalog install keeps its readOnly tools read only under scope taint", async () => {
    await ensureAppsForOrg(TEST_ORG)
    const dir = mkdtempSync(join(tmpdir(), "fp-signed-"))
    try {
      await installSideload(dir, "signed by the operator's trusted publisher")
      await markPublisherSigned(SIDELOAD_APP)
      resetAppRegistries()
      await reloadInstalledApps(TEST_ORG)
      const read = toolRegistry.get([TEST_ORG, SIDELOAD_APP, "list_items"])
      expect(read).toBeDefined()
      expect(read?.readOnly).toBe(true)
      // The claim only ever covers the tools that made it: an unmarked write tool
      // stays an undeclared write and stays refused on a tainted turn.
      expect(readOnlyOf(SIDELOAD_APP, "write_items")).toBeUndefined()
      expect(checkToolScopeTaint(TAINTED_SCOPES, read ?? {})).toBeNull()
      expect(
        checkToolScopeTaint(
          TAINTED_SCOPES,
          toolRegistry.get([TEST_ORG, SIDELOAD_APP, "write_items"]) ?? {},
        ),
      ).toEqual(taintBlocked(UNDECLARED_WRITE_TARGET))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("an untrusted install's sink reader scope is ignored, so its write is never judged by readers it claims", async () => {
    await ensureAppsForOrg(TEST_ORG)
    const dir = mkdtempSync(join(tmpdir(), "fp-unsigned-sink-"))
    const table = `app_${SIDELOAD_APP.replace(/-/g, "_")}.items`
    try {
      await installSideload(dir, "third party claiming its readers", {
        writesToTable: table,
        sinkReadScope: `${SIDELOAD_APP}:items:read`,
      })
      resetAppRegistries()
      await reloadInstalledApps(TEST_ORG)
      const write = toolRegistry.get([TEST_ORG, SIDELOAD_APP, "write_items"])
      expect(write?.writesToTable).toBe(table)
      expect(write?.sinkReadScope).toBeUndefined()
      // Its claim is stripped, so the dispatch has no readers to judge it by: the plain rule
      // refuses it, and the dispatch parks it for approval (rule 8), never runs it inline.
      expect(checkToolScopeTaint(TAINTED_SCOPES, write ?? {})).toEqual(taintBlocked(table))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("an untrusted install's readOnly claim is still ignored", async () => {
    await ensureAppsForOrg(TEST_ORG)
    const dir = mkdtempSync(join(tmpdir(), "fp-unsigned-"))
    try {
      await installSideload(dir, "third party, nobody vouched")
      const rows = await withSystemDb("first-party-test-rows", (db) =>
        db.select().from(appsInstalled).where(eq(appsInstalled.name, SIDELOAD_APP)),
      )
      expect(rows[0]?.signatureBundle).toBeNull()
      resetAppRegistries()
      await reloadInstalledApps(TEST_ORG)
      const read = toolRegistry.get([TEST_ORG, SIDELOAD_APP, "list_items"])
      expect(read).toBeDefined()
      expect(read?.readOnly).toBeUndefined()
      expect(checkToolScopeTaint(TAINTED_SCOPES, read ?? {})).toEqual(
        taintBlocked(UNDECLARED_WRITE_TARGET),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("flags every in-tree app first-party, sandboxed ones included", async () => {
    const apps = await getDefaultApps()
    const connector = apps.find((a) => a.name === "api-connector")
    const tickets = apps.find((a) => a.name === "tickets")
    expect(connector?.trusted).toBe(false)
    expect(connector?._firstParty).toBe(true)
    expect(tickets?._firstParty).toBe(true)
  })
})
