// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An uploaded PDF frozen as an agreement's next version, through the real path:
// the agreements app registered from its manifest, a person's own upload, the
// person's prepare in the sandbox, and the `upload-freeze` job the system runs
// for a check that outlasted the tool call. The job reads the uploaded file
// under the same row rules as everything else: no privileged read.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sql as dsql } from "drizzle-orm"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { dispatchAppJobWithContext } from "~/infra/jobs/job-context"
import { JobsTestAccess } from "~/infra/jobs/jobs"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import { handleFilesUploadUrl } from "~/modules/agent/tools/file-tools"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { PRICE, plainPdf } from "~/modules/pdf-render/fixtures.testutil"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
} from "~/tests/security/portal-doors/fixture"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const SCOPES = ["agreements:agreements:read", "agreements:agreements:write"]
const kernel = (table: string) => sql(`${schemaRef("kernel")}.${table}`)
const app = (table: string) => sql(`${schemaRef("app_agreements")}.${table}`)

let w: DoorWorld

function descriptor(): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", "agreements", "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    _bundlePath: join(
      REPO_ROOT,
      "bundled-apps",
      "agreements",
      String(manifest.version),
      "bundle.js",
    ),
  }
}

type Out = { data?: Record<string, any>; error?: { code: string; message: string } }

function person(): UserContext {
  return {
    actorType: "user",
    userId: w.admin.userId,
    orgId: w.orgId,
    scopes: [...SCOPES, "kernel:files:read"],
    dimensionGrants: {},
  }
}

async function asPerson(tool: string, params: unknown): Promise<Out> {
  return (await executeToolCore({
    toolName: `agreements:${tool}`,
    orgId: w.orgId,
    actor: person(),
    params,
    origin: "human-ui",
  } as never)) as Out
}

/** The person's own upload, as their client makes it (files_upload_url, inline bytes). */
async function upload(bytes: Uint8Array, filename: string): Promise<string> {
  const out = await withRlsContext(person(), (db) =>
    handleFilesUploadUrl(
      {
        filename,
        mimeType: "application/pdf",
        contentBase64: Buffer.from(bytes).toString("base64"),
      },
      { orgId: w.orgId, userId: w.admin.userId, db, actorType: "user" },
    ),
  )
  if (!("fileId" in out) || !out.fileId) throw new Error(`upload failed: ${JSON.stringify(out)}`)
  return out.fileId
}

/** A draft agreement whose next version is the uploaded file. */
async function draftWithUpload(title: string, bytes: Uint8Array) {
  const created = await asPerson("agreement_create", {
    kind: "msa",
    title,
    company_id: w.companyA,
    source: { body: { blocks: [{ type: "paragraph", text: "Replaced by the upload." }] } },
  })
  expect(created.error).toBeUndefined()
  const id = created.data?.agreement?.id as string
  const fileId = await upload(bytes, `${title}.pdf`)
  const updated = await asPerson("agreement_update", { id, file_id: fileId })
  expect(updated.error).toBeUndefined()
  return { id, fileId }
}

async function versionsOf(agreementId: string) {
  return (await sql`
    SELECT id, sha256, source_kind, file_id, status FROM ${app("agreement_versions")}
     WHERE agreement_id = ${agreementId} ORDER BY number`) as unknown as Array<{
    id: string
    sha256: string
    source_kind: string
    file_id: string | null
    status: string
  }>
}

async function frozenBytes(fileId: string): Promise<Buffer> {
  const [row] = (await sql`
    SELECT storage_key FROM ${kernel("files")} WHERE id = ${fileId}`) as unknown as Array<{
    storage_key: string
  }>
  return Buffer.from(
    (await getObjectBytes(row?.storage_key as string, { maxBytes: 8 * 1024 * 1024 })).bytes,
  )
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  w = await createDoorWorld()
  await ensureAppsForOrg(w.orgId)
  await initSandboxPool()
  await initWorkerPool()
  const { failedApps } = await registerApps([descriptor() as never], w.orgId)
  expect(failedApps).toEqual([])
  await primeOrgApps(w.orgId, 0)
  // Production builds the files row policy from the installed catalog; this app is
  // registered from its manifest, so the policy is built from the registry's parents.
  await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
}, 300_000)

afterAll(async () => {
  await rebuildFilesSelectPolicy()
  forgetOrgApps(w.orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  if (w) {
    await sql`DELETE FROM ${kernel("files")} WHERE org_id = ${w.orgId}`
    await sql`DELETE FROM ${kernel("file_upload_sessions")} WHERE org_id = ${w.orgId}`
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("an uploaded PDF frozen as an agreement version", () => {
  it("the person's prepare freezes the uploaded bytes as they are", async () => {
    const bytes = plainPdf({ contents: PRICE("12000") })
    const { id } = await draftWithUpload("Upload by hand", bytes)

    const prepared = await asPerson("agreement_prepare", { id })
    expect(prepared.error).toBeUndefined()
    expect(prepared.data?.status).toBe("ok")

    const [version] = await versionsOf(id)
    const sha = createHash("sha256").update(bytes).digest("hex")
    expect(version?.source_kind).toBe("uploaded")
    expect(version?.sha256).toBe(sha)
    expect(version?.file_id).toBeTruthy()
    expect((await frozenBytes(version?.file_id as string)).equals(Buffer.from(bytes))).toBe(true)
  }, 120_000)

  it("a check that outlasted the tool call is finished by the job, which reads the upload under row rules", async () => {
    const bytes = plainPdf({ contents: PRICE("34000") })
    const { id } = await draftWithUpload("Upload by the job", bytes)
    // What the tool call leaves when the check outlasts its deadline.
    await sql`UPDATE ${app("agreement_drafts")} SET upload_state = 'checking' WHERE agreement_id = ${id}`

    const handler = JobsTestAccess.getHandler("agreements", "upload-freeze")
    if (!handler) throw new Error("upload-freeze is not registered")
    await dispatchAppJobWithContext(
      handler,
      { orgId: w.orgId },
      { actorType: "system", orgId: w.orgId, purpose: "job", scopes: ["agreements:*"] },
      "session",
    )

    const versions = await versionsOf(id)
    expect(versions).toHaveLength(1)
    const sha = createHash("sha256").update(bytes).digest("hex")
    expect(versions[0]?.status).toBe("frozen")
    expect(versions[0]?.sha256).toBe(sha)
    expect((await frozenBytes(versions[0]?.file_id as string)).equals(Buffer.from(bytes))).toBe(
      true,
    )
    const [draft] = (await sql`
      SELECT upload_state, upload_file_id FROM ${app("agreement_drafts")}
       WHERE agreement_id = ${id}`) as unknown as Array<{
      upload_state: string | null
      upload_file_id: string | null
    }>
    expect(draft?.upload_state).toBeNull()
    expect(draft?.upload_file_id).toBeNull()
  }, 120_000)

  it("the kept upload is read by whoever reads the agreement, and hidden when the agreement is closed", async () => {
    const { id } = await draftWithUpload("Upload kept", plainPdf())
    const count = (userId: string) =>
      withRlsContext(
        { actorType: "user", userId, orgId: w.orgId, scopes: SCOPES, dimensionGrants: {} },
        async (db) => {
          const rows = (await db.execute(
            dsql`SELECT count(*)::int AS n FROM ${dsql.raw(schemaRef("kernel"))}.files
                  WHERE app = 'agreements' AND entity_type = 'agreement' AND entity_id = ${id}`,
          )) as unknown as Array<{ n: number }>
          return Number(rows[0]?.n ?? 0)
        },
      )
    expect(await count(w.member.userId)).toBe(1)
    await sql`UPDATE ${app("agreements")} SET org_access = 'none' WHERE id = ${id}`
    expect(await count(w.member.userId)).toBe(0)
  }, 120_000)
})
