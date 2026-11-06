// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { PdfRegistryTestAccess, registerTemplate } from "./registry"
import { getFileBytes, PdfRenderTestAccess, renderPdf } from "./render"
import { TEST_FIXTURE_SOURCE as fixtureSource } from "./templates/test-fixture"

// Templates run in the QuickJS app sandbox (no host code execution) and emit a
// draw-command list the host replays. A bundle that THROWS so the sandbox
// surfaces the error → `enqueue` maps it to `render_failed`.
const BAD_FIXTURE_SOURCE = `globalThis.renderTemplate = () => { throw new Error("boom"); };`
// A bundle whose renderTemplate burns ~500ms sandbox-side (QuickJS has no
// setTimeout) then returns commands, so the per-org-cap test races 11 in-flight
// renders. The runtime interrupt handler still bounds it under the deadline.
const SLOW_FIXTURE_SOURCE = `
globalThis.renderTemplate = (data) => {
  var end = Date.now() + 500;
  while (Date.now() < end) { /* spin */ }
  return [
    { op: "addPage", width: 300, height: 200 },
  ];
};
`

describe("pdf.render (K2)", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await initSandboxPool()
  }, 60_000)
  afterAll(async () => {
    await shutdownSandboxPool()
    await releaseTestLock()
  })
  beforeEach(() => {
    // Skip Ghostscript normalisation by default — test environments do not
    // ship `gs`. The `pdf_a3: true` path is exercised explicitly below.
    PdfRegistryTestAccess.clear()
  })
  afterEach(() => {
    delete process.env.GS_BIN
  })

  test("renders a registered template and stores the bytes under the calling app", async () => {
    const { id: orgId } = await createTestOrg()
    registerTemplate("invoicing", "invoicing:test_v1", fixtureSource)
    const { file_id, byte_size, page_count } = await renderPdf(null, {
      orgId,
      callingAppId: "invoicing",
      template_kind: "invoicing:test_v1",
      data: { title: "Hello" },
      pdf_a3: false,
    })
    expect(byte_size).toBeGreaterThan(100)
    expect(page_count).toBe(1)
    const bytes = await getFileBytes(null, file_id)
    expect(Buffer.from(bytes.slice(0, 4)).toString()).toBe("%PDF")
  })

  test("uses a caller-supplied filename (sanitised) instead of the template-kind name", async () => {
    const { id: orgId } = await createTestOrg()
    registerTemplate("invoicing", "invoicing:invoice_v1", fixtureSource)
    // A real invoice number, plus unsafe chars + a redundant .pdf the host must fold.
    const withName = await renderPdf(null, {
      orgId,
      callingAppId: "invoicing",
      template_kind: "invoicing:invoice_v1",
      data: { title: "Hi" },
      pdf_a3: false,
      filename: "invoice-EMB-2026-8201.pdf",
    })
    expect(withName.filename).toBe("invoice-EMB-2026-8201.pdf")
    expect(withName.filename).not.toBe("invoicing_invoice_v1.pdf")

    // Omitting filename still yields the kind-based fallback (back-compat).
    const noName = await renderPdf(null, {
      orgId,
      callingAppId: "invoicing",
      template_kind: "invoicing:invoice_v1",
      data: { title: "Hi" },
      pdf_a3: false,
    })
    expect(noName.filename).toBe("invoicing_invoice_v1.pdf")

    // Path traversal + unsafe chars are stripped, extension forced once.
    const dirty = await renderPdf(null, {
      orgId,
      callingAppId: "invoicing",
      template_kind: "invoicing:invoice_v1",
      data: { title: "Hi" },
      pdf_a3: false,
      filename: "../../etc/Facture n°42 (final).PDF",
    })
    // basename only (no traversal), every unsafe char -> "_", single ".pdf".
    expect(dirty.filename).toBe("Facture_n_42__final_.pdf")
  })

  test("rejects unknown template_kind with template_not_found", async () => {
    const { id: orgId } = await createTestOrg()
    await expect(
      renderPdf(null, {
        orgId,
        callingAppId: "invoicing",
        template_kind: "invoicing:nope",
        data: {},
        pdf_a3: false,
      }),
    ).rejects.toMatchObject({ code: "template_not_found" })
  })

  // An org created after this process registered the app's templates (a new
  // workspace) renders from the persisted active version, not template_not_found.
  test("an org created after registration renders from the persisted templates", async () => {
    const appId = `pdflazy${randomUUID().slice(0, 8)}`
    const kind = `${appId}:test_v1`
    // The org first: creating a test org truncates the org tables, and
    // apps_installed carries an org column (org-private apps) since 0266.
    const { id: orgId } = await createTestOrg()
    await withSystemDb("test-pdf-lazy", async (db) => {
      await db.execute(sql`INSERT INTO kernel.apps_installed
        (name, version, source_url, sha256, installed_by, pdf_templates)
        VALUES (${appId}, '1.0.0', 'test://pdf-lazy', 'x', ${randomUUID()}::uuid,
          ${JSON.stringify([{ kind, source: fixtureSource }])}::jsonb)`)
      await db.execute(sql`INSERT INTO kernel.apps_active_version (name, version)
        VALUES (${appId}, '1.0.0')`)
    })
    try {
      const { page_count } = await renderPdf(null, {
        orgId,
        callingAppId: appId,
        template_kind: kind,
        data: { title: "Hello" },
        pdf_a3: false,
      })
      expect(page_count).toBe(1)
    } finally {
      await withSystemDb("test-pdf-lazy-cleanup", async (db) => {
        await db.execute(sql`DELETE FROM kernel.apps_active_version WHERE name = ${appId}`)
        await db.execute(sql`DELETE FROM kernel.apps_installed WHERE name = ${appId}`)
      })
    }
  })

  test("returns render_failed when template throws", async () => {
    const { id: orgId } = await createTestOrg()
    registerTemplate("invoicing", "invoicing:bad_v1", BAD_FIXTURE_SOURCE)
    await expect(
      renderPdf(null, {
        orgId,
        callingAppId: "invoicing",
        template_kind: "invoicing:bad_v1",
        data: {},
        pdf_a3: false,
      }),
    ).rejects.toMatchObject({ code: "render_failed" })
  })

  test("rejects output above the configured cap with output_too_large", async () => {
    // Render a normal hello-world PDF (~400 bytes) under an artificially low
    // cap (200 bytes). The production cap is 10MB (`DEFAULT_MAX_PDF_BYTES`);
    // the override exists for tests because pdf-lib's Flate compression
    // makes generating a >10MB PDF prohibitively expensive in unit tests
    // without changing the semantics of the cap check.
    PdfRenderTestAccess.setMaxPdfBytes(200)
    try {
      const { id: orgId } = await createTestOrg()
      registerTemplate("invoicing", "invoicing:test_v1", fixtureSource)
      await expect(
        renderPdf(null, {
          orgId,
          callingAppId: "invoicing",
          template_kind: "invoicing:test_v1",
          data: { title: "Hi" },
          pdf_a3: false,
        }),
      ).rejects.toMatchObject({ code: "output_too_large" })
    } finally {
      PdfRenderTestAccess.setMaxPdfBytes(undefined)
    }
  })

  test("falls back to non-PDF/A-3 when Ghostscript missing (GS_BIN /nonexistent)", async () => {
    process.env.GS_BIN = "/nonexistent"
    const { id: orgId } = await createTestOrg()
    registerTemplate("invoicing", "invoicing:test_v1", fixtureSource)
    const result = await renderPdf(null, {
      orgId,
      callingAppId: "invoicing",
      template_kind: "invoicing:test_v1",
      data: { title: "Hi" },
      pdf_a3: true,
    })
    expect(result).toMatchObject({ pdf_a3_normalized: false })
    expect(result.byte_size).toBeGreaterThan(100)
  })

  test("returns render_overloaded when per-org inflight exceeds 10", async () => {
    // Use 11 distinct app IDs to ensure the per-app cap (5) is never hit — only
    // the per-org cap (10) is exercised. All render under the same orgId.
    const { id: orgId } = await createTestOrg()
    const appIds = Array.from({ length: 11 }, (_, i) => `app_${i}`)
    for (const appId of appIds) {
      registerTemplate(appId, `${appId}:slow_v1`, SLOW_FIXTURE_SOURCE)
    }
    const calls = appIds.map((appId) =>
      renderPdf(null, {
        orgId,
        callingAppId: appId,
        template_kind: `${appId}:slow_v1`,
        data: {},
        pdf_a3: false,
      }),
    )
    const results = await Promise.allSettled(calls)
    const overloaded = results.filter(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" && (r.reason as { code?: string })?.code === "render_overloaded",
    )
    // At least one call should hit the per-org cap (10 concurrent limit).
    expect(overloaded.length).toBeGreaterThanOrEqual(1)
  }, 10_000)
  test("native PDF/A-3B: attachment embedded, parent honoured, sha256 of the stored bytes returned", async () => {
    const { id: orgId } = await createTestOrg()
    registerTemplate("invoicing", "invoicing:test_v1", fixtureSource)
    const parentId = randomUUID()
    const xml = new TextEncoder().encode("<x/>")
    const r = await renderPdf(null, {
      orgId,
      callingAppId: "invoicing",
      template_kind: "invoicing:test_v1",
      data: { title: "FA-1" },
      pdfa: "3b",
      attachments: [{ name: "factur-x.xml", mime: "text/xml", bytes: xml, afRelationship: "Data" }],
      parent: { entityType: "legal_original", entityId: parentId },
    })
    expect(r.pdfa).toBe("3b")
    expect(r.pdf_a3_normalized).toBe(true)
    expect(r.parent_entity_type).toBe("legal_original")
    expect(r.parent_entity_id).toBe(parentId)
    const bytes = await getFileBytes(null, r.file_id)
    expect(r.sha256).toBe(createHash("sha256").update(bytes).digest("hex"))
    expect(Buffer.from(bytes).includes(Buffer.from("factur-x.xml"))).toBe(true)
    const row = await withSystemDb("test:pdfa-parent", async (tx) => {
      const rs = await tx.execute(
        sql`SELECT entity_type, entity_id::text AS entity_id FROM kernel.files WHERE id = ${r.file_id}::uuid`,
      )
      return (rs as unknown as Array<{ entity_type: string; entity_id: string }>)[0]
    })
    expect(row).toEqual({ entity_type: "legal_original", entity_id: parentId })
  })

  test("default parent stays pdf / the file id; attachments without pdfa are refused", async () => {
    const { id: orgId } = await createTestOrg()
    registerTemplate("invoicing", "invoicing:test_v1", fixtureSource)
    const r = await renderPdf(null, {
      orgId,
      callingAppId: "invoicing",
      template_kind: "invoicing:test_v1",
      data: {},
      pdf_a3: false,
    })
    expect(r.parent_entity_type).toBe("pdf")
    expect(r.parent_entity_id).toBe(r.file_id)
    expect(r.pdfa).toBeNull()
    await expect(
      renderPdf(null, {
        orgId,
        callingAppId: "invoicing",
        template_kind: "invoicing:test_v1",
        data: {},
        attachments: [
          { name: "a.xml", mime: "text/xml", bytes: new Uint8Array([60]), afRelationship: "Data" },
        ],
      }),
    ).rejects.toThrow(/need pdfa/)
  })
})
