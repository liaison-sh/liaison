// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PDF template install persistence + rehydrate.
//
// PDF templates are now SANDBOXED: a template runs in the QuickJS app sandbox
// and emits a validated JSON draw-command list the host replays against pdf-lib
// (no untrusted host code). So ANY app — first- or third-party — may ship a PDF
// template. At install the installer persists the emitted SANDBOX BUNDLE text
// (the `templates/<safeName>.js` artifact freeze-app writes, which sets
// `globalThis.renderTemplate`) into `apps_installed.pdf_templates[].source`,
// and a scoped post-install registration / the boot-time rehydrate warms the
// in-memory PDF registry from that column.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { getTemplate, PdfRegistryTestAccess } from "~/modules/pdf/registry"
import { loadAppTemplates } from "~/modules/pdf/registry-rehydrate"
import { createTestOrg } from "~/tests/helpers/org"

const ADMIN = "00000000-0000-0000-0000-000000000001"
const APP = "test-tpl-installer"
// The persisted/registered value is the emitted sandbox bundle text — a module
// that sets `globalThis.renderTemplate`. (The manifest `source` is a .ts path;
// the installer reads the emitted .js and persists its contents.)
const BUNDLE_SOURCE = `globalThis.renderTemplate = (data) => ([
  { op: "setMetadata", title: (data && data.title) || "Untitled" },
  { op: "addPage", width: 595, height: 842 },
]);`

/** Build a fake .liaisonapp tarball, optionally declaring a sandboxed PDF template. */
function makeTarball(name: string, version: string, opts: { withTemplates: boolean }): string {
  const work = mkdtempSync(join(tmpdir(), "install-tpl-"))
  const stage = join(work, "stage")
  mkdirSync(stage, { recursive: true })
  const manifest: Record<string, unknown> = {
    name,
    version,
    packageFormat: 1,
    license: "MIT",
    scopes: [`${name}:items:read`],
  }
  const entries = ["app.manifest.json", "bundle.js"]
  if (opts.withTemplates) {
    mkdirSync(join(stage, "templates"), { recursive: true })
    manifest.capabilities = ["pdf.render"]
    // The manifest `source` is a relative .ts path; the freeze step emits the
    // bundle at templates/<safeName>.js (safeName = kind with non-portable
    // chars → "__"). The installer reads that .js, NOT the .ts path.
    manifest.pdf_templates = [{ kind: `${name}:invoice_v1`, source: "templates/invoice.ts" }]
    const safeName = `${name}:invoice_v1`.replace(/[^A-Za-z0-9._-]+/g, "__")
    writeFileSync(join(stage, "templates", `${safeName}.js`), BUNDLE_SOURCE)
    entries.push(`templates/${safeName}.js`)
  }
  writeFileSync(join(stage, "app.manifest.json"), JSON.stringify(manifest))
  writeFileSync(join(stage, "bundle.js"), "// noop\n")
  const tar = join(work, `${name}-${version}.liaisonapp`)
  spawnSync("tar", ["-czf", tar, "-C", stage, ...entries])
  return tar
}

async function cleanupRows(name: string): Promise<void> {
  await withSystemDb("install-tpl-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, name))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, name))
  })
}

let installRoot: string
beforeEach(() => {
  installRoot = mkdtempSync(join(tmpdir(), "install-tpl-root-"))
  process.env.LIAISON_APPS_DIR = installRoot
  PdfRegistryTestAccess.clear()
})
afterEach(async () => {
  rmSync(installRoot, { recursive: true, force: true })
  await cleanupRows(APP)
})

describe("install-service — PDF template persistence + rehydrate", () => {
  it("ALLOWS an installed (trusted:false) app to declare a sandboxed pdf template", async () => {
    // Sandboxed templates run only in QuickJS and the host replays a validated
    // command list — no host code execution — so any app may ship one.
    await expect(
      installAppFromTarball({
        tarballPath: makeTarball(APP, "1.0.0", { withTemplates: true }),
        installedBy: ADMIN,
        grantedScopes: [`${APP}:items:read`],
        requireSignature: false,
      }),
    ).resolves.toBeDefined()
  })

  it("persists the emitted sandbox bundle as pdf_templates[].source", async () => {
    await createTestOrg()
    await installAppFromTarball({
      tarballPath: makeTarball(APP, "1.0.0", { withTemplates: true }),
      installedBy: ADMIN,
      grantedScopes: [`${APP}:items:read`],
      requireSignature: false,
    })
    const [row] = await withSystemDb("read-install", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, APP)),
    )
    expect(row).toBeDefined()
    expect(row.pdfTemplates).toHaveLength(1)
    expect(row.pdfTemplates[0]).toMatchObject({ kind: `${APP}:invoice_v1` })
    expect(row.pdfTemplates[0].source).toContain("globalThis.renderTemplate")

    // The scoped post-install registration warms the registry for installed orgs.
    expect(getTemplate(APP, `${APP}:invoice_v1`)).toContain("globalThis.renderTemplate")
  })

  it("an activation replaces the app's templates instance-wide, with no org registered", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball(APP, "1.0.0", { withTemplates: true }),
      installedBy: ADMIN,
      grantedScopes: [`${APP}:items:read`],
      requireSignature: false,
    })
    expect(getTemplate(APP, `${APP}:invoice_v1`)).toContain("globalThis.renderTemplate")
    // 1.1.0 drops the template: the switch evicts the app's kinds.
    await installAppFromTarball({
      tarballPath: makeTarball(APP, "1.1.0", { withTemplates: false }),
      installedBy: ADMIN,
      grantedScopes: [`${APP}:items:read`],
      requireSignature: false,
    })
    expect(getTemplate(APP, `${APP}:invoice_v1`)).toBeUndefined()
  })

  it("installs a template-free app and persists an empty pdf_templates array", async () => {
    await installAppFromTarball({
      tarballPath: makeTarball(APP, "1.0.0", { withTemplates: false }),
      installedBy: ADMIN,
      grantedScopes: [`${APP}:items:read`],
      requireSignature: false,
    })
    const [row] = await withSystemDb("read-install", (db) =>
      db.select().from(appsInstalled).where(eq(appsInstalled.name, APP)),
    )
    expect(row).toBeDefined()
    expect(row.pdfTemplates).toEqual([])
  })

  it("a registry miss loads the sandbox bundle persisted on the active install row", async () => {
    await createTestOrg()
    const kind = `${APP}:invoice_v1`
    await withSystemDb("seed-install", async (db) => {
      await db.insert(appsInstalled).values({
        name: APP,
        version: "1.0.0",
        sourceUrl: "in-tree",
        sha256: "a".repeat(64),
        grantedScopes: [],
        grantedConnections: [],
        installedBy: ADMIN,
        pdfTemplates: [{ kind, source: BUNDLE_SOURCE }],
      })
      await db.insert(appsActiveVersion).values({ name: APP, version: "1.0.0" })
    })

    PdfRegistryTestAccess.clear()
    expect(getTemplate(APP, kind)).toBeUndefined()

    await loadAppTemplates(APP)
    expect(getTemplate(APP, kind)).toContain("globalThis.renderTemplate")
  })
})
