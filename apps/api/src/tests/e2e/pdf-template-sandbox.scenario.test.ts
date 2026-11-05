// SPDX-License-Identifier: FSL-1.1-ALv2
// ---------------------------------------------------------------------------
// Sandboxed PDF template DSL — E2E (non-first-party install → render).
//
// Proves the full safe path end-to-end:
//   - a NON-first-party `.liaisonapp` declaring a sandboxed PDF template freezes
//     + installs (no host-RCE guard rejection) and the emitted bundle is
//     persisted + registered;
//   - `renderPdf` runs the template in the QuickJS sandbox and replays its
//     draw-command list to a valid PDF;
//   - a template whose `renderTemplate` returns a NON-DrawCommand[] (unknown op)
//     fails CLOSED at the host replay zod boundary — `render_failed` and NO file
//     row is written. No host code ran the template.
//
// Per M3: drive `installAppFromTarball` directly (the pattern
// install-service-pdf-templates.test.ts uses) rather than guessing an HTTP
// route. The template fixtures return raw command arrays inline (no
// @liaison/app-sdk import) so the freeze Bun.build stays self-contained in a
// tmp app dir.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { appsActiveVersion, appsInstalled } from "~/db/schema/kernel/apps-installed"
import { files } from "~/db/schema/kernel/files"
import { installAppFromTarball } from "~/modules/apps/install-service"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { PdfRegistryTestAccess } from "~/modules/pdf/registry"
import { getFileBytes, renderPdf } from "~/modules/pdf/render"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { freezeApp } from "../../../../../scripts/freeze-app"

const ADMIN = "00000000-0000-0000-0000-000000000001"
const APP = "thirdparty-pdf-e2e"

// A WELL-FORMED template: returns a valid DrawCommand[] (renders to a 1-page PDF).
const GOOD_TEMPLATE = `export function renderTemplate(data: { title: string }) {
  return [
    { op: "setMetadata", title: data.title },
    { op: "embedFont", ref: "f", standardFont: "Helvetica" },
    { op: "addPage", width: 595, height: 842 },
    { op: "drawText", page: 0, text: data.title, x: 40, y: 800, size: 14, font: "f" },
  ]
}`

// A MALFORMED template: returns commands with an UNKNOWN op — the host replayer
// must reject it at the zod boundary (fail-closed) without executing any code.
const BAD_TEMPLATE = `export function renderTemplate() {
  return [
    { op: "execShell", cmd: "rm -rf /" },
  ]
}`

/** Build + freeze a non-first-party `.liaisonapp` with one sandboxed template. */
async function freezeApp_(name: string, templateSrc: string): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "pdf-e2e-app-"))
  const appDir = join(work, "apps/api/src/apps", name)
  mkdirSync(appDir, { recursive: true })
  writeFileSync(
    join(appDir, "app.manifest.json"),
    JSON.stringify({
      name,
      version: "1.0.0",
      packageFormat: 1,
      license: "MIT",
      scopes: [`${name}:items:read`],
      capabilities: ["pdf.render"],
      pdf_templates: [{ kind: `${name}:doc_v1`, source: "templates/doc.ts" }],
    }),
  )
  writeFileSync(join(appDir, "handlers.ts"), "export const handlers = {}\n")
  mkdirSync(join(appDir, "templates"), { recursive: true })
  writeFileSync(join(appDir, "templates", "doc.ts"), templateSrc)
  const { tarballPath } = await freezeApp({ appName: name, repoRoot: work, outDir: work })
  return tarballPath
}

async function cleanupRows(name: string): Promise<void> {
  await withSystemDb("pdf-e2e-cleanup", async (db) => {
    await db.delete(appsInstalled).where(eq(appsInstalled.name, name))
    await db.delete(appsActiveVersion).where(eq(appsActiveVersion.name, name))
  })
}

describe("sandboxed PDF template DSL — non-first-party install → render (e2e)", () => {
  let installRoot: string
  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
  }, 60_000)
  afterAll(async () => {
    await shutdownSandboxPool()
    await releaseTestLock()
  })
  beforeEach(() => {
    installRoot = mkdtempSync(join(tmpdir(), "pdf-e2e-root-"))
    process.env.LIAISON_APPS_DIR = installRoot
    PdfRegistryTestAccess.clear()
  })
  afterEach(async () => {
    rmSync(installRoot, { recursive: true, force: true })
    await cleanupRows(APP)
  })

  it("installs a non-first-party sandboxed template and renders a valid PDF", async () => {
    const { id: orgId } = await createTestOrg()
    const tarball = await freezeApp_(APP, GOOD_TEMPLATE)
    await installAppFromTarball({
      tarballPath: tarball,
      installedBy: ADMIN,
      grantedScopes: [`${APP}:items:read`],
      requireSignature: false,
    })

    // Nothing loads at boot: the render loads the persisted bundle on its miss.
    PdfRegistryTestAccess.clear()

    const result = await renderPdf(null, {
      orgId,
      callingAppId: APP,
      template_kind: `${APP}:doc_v1`,
      data: { title: "Third-Party Invoice" },
      pdf_a3: false,
    })
    expect(result.file_id).toBeDefined()
    expect(result.byte_size).toBeGreaterThan(0)
    expect(result.page_count).toBeGreaterThanOrEqual(1)
    const bytes = await getFileBytes(null, result.file_id)
    expect(Buffer.from(bytes.slice(0, 4)).toString()).toBe("%PDF")
  })

  it("fails closed at the host replay boundary when the template emits an unknown op", async () => {
    const { id: orgId } = await createTestOrg()
    const tarball = await freezeApp_(APP, BAD_TEMPLATE)
    await installAppFromTarball({
      tarballPath: tarball,
      installedBy: ADMIN,
      grantedScopes: [`${APP}:items:read`],
      requireSignature: false,
    })
    PdfRegistryTestAccess.clear()

    await expect(
      renderPdf(null, {
        orgId,
        callingAppId: APP,
        template_kind: `${APP}:doc_v1`,
        data: {},
        pdf_a3: false,
      }),
    ).rejects.toMatchObject({ code: "render_failed" })

    // No file row was written — the malformed command list never produced bytes.
    const rows = await withSystemDb("pdf-e2e-files", (db) =>
      db.select().from(files).where(eq(files.app, APP)),
    )
    expect(rows).toHaveLength(0)
  })
})
