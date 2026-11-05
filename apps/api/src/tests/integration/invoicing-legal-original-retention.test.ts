// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Real-database proof of the kernel `immutable` table flag on the invoicing app's legal originals
// (manifest `schema.legal_originals.immutable`): a recorded legal original is write-once (a null
// column may be filled once, a set value never changes), the row cannot be deleted within the
// retention period by any role, and the kernel file delete path (the one `DELETE /files/:id`
// calls) refuses its file. A superuser operator session can lift it for an org deletion.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as dsql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { deleteFile, FileServiceError } from "~/modules/files/service"
import { acquireTestLock, releaseTestLock, superuserUrlForTestDb } from "~/tests/route-test-setup"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")

function bundledDescriptor(name: string): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", name, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  const version = (manifest.version as string) ?? "0.1.0"
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(REPO_ROOT, "bundled-apps", name, version, "bundle.js"),
  }
}

const ORG = "00000000-0000-4000-8000-0000000e7101"
const USER = "00000000-0000-4000-8000-0000000e7102"

async function insertOriginal(at = new Date()): Promise<{ id: string; fileId: string }> {
  const recordedAt = at.toISOString()
  const id = randomUUID()
  const fileId = randomUUID()
  await sql`INSERT INTO app_invoicing.legal_originals (id, org_id, document_id, kind, file_id, sha256, byte_size, recorded_at, created_at)
    VALUES (${id}, ${ORG}, ${randomUUID()}, 'issued_pdf', NULL, ${"a".repeat(64)}, 1234, ${recordedAt}, ${recordedAt})`
  await sql`INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
    VALUES (${fileId}, ${ORG}, 'invoicing', 'legal_original', ${id}, 'invoice-1.pdf', 'application/pdf', 1234, ${`orgs/${ORG}/invoicing/legal_original/${id}/x/invoice-1.pdf`})`
  return { id, fileId }
}

/** postgres.js queries run only when `.then` is called; `expect(...).rejects` must get a real
 *  promise or the query never executes. */
async function run(q: PromiseLike<unknown>): Promise<void> {
  await q
}

const SCOPES = ["invoicing:documents:write", "invoicing:documents:read"]

/** The kernel file delete as the test user: privileged row read, the user's own RLS transaction. */
function deleteAsUser(fileId: string): Promise<void> {
  return withRlsContext(
    { actorType: "user", userId: USER, orgId: ORG, scopes: SCOPES, dimensionGrants: {} },
    (rlsTx) =>
      deleteFile(fileId, {
        orgId: ORG,
        userId: USER,
        scopes: SCOPES,
        rlsTx,
        privileged: (reason, fn) => withPrivilegedDb(ORG, reason, fn),
      }),
  )
}

describe("legal originals: kernel immutability and retention", () => {
  beforeAll(async () => {
    await acquireTestLock()
    process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Legal Original Retention Org', 'legal-original-retention-org')
      ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, password_hash, name, status)
      VALUES (${USER}, ${ORG}, 'retention@test.com', 'hash', 'Retention Tester', 'active')
      ON CONFLICT (id) DO NOTHING`
    await initSandboxPool()
    await initWorkerPool()
    await registerApps([bundledDescriptor("invoicing") as never], ORG)
  }, 60_000)

  afterAll(async () => {
    await shutdownWorkerPool()
    await shutdownSandboxPool()
    resetAppRegistries()
    await releaseTestLock()
  })

  it("a null column can be filled once; a set value never changes", async () => {
    const { id, fileId } = await insertOriginal()
    await sql`UPDATE app_invoicing.legal_originals SET file_id = ${fileId} WHERE id = ${id}`
    const rows = await sql<
      Array<{ file_id: string }>
    >`SELECT file_id FROM app_invoicing.legal_originals WHERE id = ${id}`
    expect(rows[0]?.file_id).toBe(fileId)
    await expect(
      run(
        sql`UPDATE app_invoicing.legal_originals SET sha256 = ${"b".repeat(64)} WHERE id = ${id}`,
      ),
    ).rejects.toThrow(/immutable_row: legal_originals\.sha256/)
    await expect(
      run(sql`UPDATE app_invoicing.legal_originals SET file_id = ${randomUUID()} WHERE id = ${id}`),
    ).rejects.toThrow(/immutable_row/)
  })

  it("the row cannot be deleted within ten years, by the app role or a privileged session", async () => {
    const { id } = await insertOriginal()
    await expect(
      run(sql`DELETE FROM app_invoicing.legal_originals WHERE id = ${id}`),
    ).rejects.toThrow(/immutable_retention/)
    const err = await withPrivilegedDb(ORG, "test:retention", (tx) =>
      tx.execute(dsql`DELETE FROM app_invoicing.legal_originals WHERE id = ${id}`),
    ).then(
      () => null,
      (e: unknown) => e as Error & { cause?: unknown },
    )
    // Drizzle wraps the database error ("Failed query: ...") and keeps it as the cause.
    expect(`${err?.message} ${String(err?.cause)}`).toMatch(/immutable_retention/)
  })

  it("the kernel file delete path refuses a legal original's file (RETAINED, HTTP 409 on DELETE /files/:id)", async () => {
    const { fileId } = await insertOriginal()
    let err: unknown
    try {
      await deleteAsUser(fileId)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(FileServiceError)
    expect((err as FileServiceError).code).toBe("RETAINED")
    const still = await sql`SELECT 1 FROM kernel.files WHERE id = ${fileId}`
    expect(still.length).toBe(1)
  })

  it("after the retention period both the row and its file can go", async () => {
    const old = new Date(Date.now() - 11 * 365.25 * 24 * 3600 * 1000)
    const { id, fileId } = await insertOriginal(old)
    await deleteAsUser(fileId)
    expect((await sql`SELECT 1 FROM kernel.files WHERE id = ${fileId}`).length).toBe(0)
    await sql`DELETE FROM app_invoicing.legal_originals WHERE id = ${id}`
    expect((await sql`SELECT 1 FROM app_invoicing.legal_originals WHERE id = ${id}`).length).toBe(0)
  })

  it("an operator superuser session with the override can delete (whole-organisation removal)", async () => {
    const { id } = await insertOriginal()
    const superUrl = superuserUrlForTestDb()
    if (!superUrl)
      throw new Error("a superuser URL for the test database is required for this test")
    const { default: postgres } = await import("postgres")
    const su = postgres(superUrl, { max: 1 })
    try {
      await su.begin(async (tx) => {
        await tx`SET LOCAL liaison.retention_override = 'on'`
        await tx`DELETE FROM app_invoicing.legal_originals WHERE id = ${id}`
      })
    } finally {
      await su.end()
    }
    expect((await sql`SELECT 1 FROM app_invoicing.legal_originals WHERE id = ${id}`).length).toBe(0)
  })

  it("the standalone Factur-X XML copy is write-once and retained like the legal original, file included", async () => {
    const id = randomUUID()
    const fileId = randomUUID()
    await sql`INSERT INTO app_invoicing.facturx_files (id, org_id, document_id, file_id, sha256, profile, generated_at)
      VALUES (${id}, ${ORG}, ${randomUUID()}, NULL, ${"c".repeat(64)}, 'EN 16931', now())`
    await sql`INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key)
      VALUES (${fileId}, ${ORG}, 'invoicing', 'facturx_xml', ${id}, 'factur-x.xml', 'text/xml', 321, ${`orgs/${ORG}/invoicing/facturx_xml/${id}/x/factur-x.xml`})`
    // The file id is filled once, then nothing changes.
    await sql`UPDATE app_invoicing.facturx_files SET file_id = ${fileId} WHERE id = ${id}`
    await expect(
      run(sql`UPDATE app_invoicing.facturx_files SET sha256 = ${"d".repeat(64)} WHERE id = ${id}`),
    ).rejects.toThrow(/immutable_row: facturx_files\.sha256/)
    await expect(
      run(sql`DELETE FROM app_invoicing.facturx_files WHERE id = ${id}`),
    ).rejects.toThrow(/immutable_retention/)
    let err: unknown
    try {
      await deleteAsUser(fileId)
    } catch (e) {
      err = e
    }
    expect((err as FileServiceError).code).toBe("RETAINED")
    expect((await sql`SELECT 1 FROM kernel.files WHERE id = ${fileId}`).length).toBe(1)
  })

  it("the override is ignored for a non-superuser role", async () => {
    const { id } = await insertOriginal()
    await expect(
      sql.begin(async (tx) => {
        await tx`SET LOCAL liaison.retention_override = 'on'`
        await tx`DELETE FROM app_invoicing.legal_originals WHERE id = ${id}`
      }),
    ).rejects.toThrow(/immutable_retention/)
  })
})
