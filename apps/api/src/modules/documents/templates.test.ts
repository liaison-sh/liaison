// SPDX-License-Identifier: FSL-1.1-ALv2
//
// /api/document-templates (modules/documents/service.ts) on real Postgres and
// object storage. A PDF form template is made from the caller's staged upload
// (the files_upload_url path), through the isolated PDF intake: a refused PDF
// leaves no template and no file, a stored template file carries none of the
// upload's active content, the staged upload is gone. Only an org admin
// writes; every member who reads files reads; another organisation sees
// nothing (FORCE RLS); an archived template leaves the list. A rich_text
// template's body round-trips as stored and is bounded in size.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { eq } from "drizzle-orm"
import { PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib"
import { app } from "~/app"
import { sql } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { documentTemplates, organizations } from "~/db/schema/kernel"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import { handleFilesUploadUrl } from "~/modules/agent/tools/file-tools"
import { seedFileRow } from "~/seed/factories/files/file-row"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { BODY_MAX_BYTES } from "./service"

interface Actor {
  orgId: string
  userId: string
  token: string
}

let admin: Actor
let member: Actor
let otherAdmin: Actor

const FIXTURES = join(import.meta.dir, "__fixtures__")

async function actor(orgId: string, userId: string): Promise<Actor> {
  return { orgId, userId, token: await minimal.token(userId) }
}

async function call(who: Actor, method: string, path = "", body?: unknown): Promise<Response> {
  return app.request(`/api/document-templates${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${who.token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

interface TemplateJson {
  id: string
  name: string
  kind: string
  fileId: string | null
  body: Record<string, unknown> | null
  fields: Array<{ name: string; type: string }>
  mapping: Record<string, unknown>
  archivedAt: string | null
}

/** Stage `bytes` as `who`'s own upload, the way an agent's files_upload_url does. */
async function stage(who: Actor, bytes: Uint8Array, filename = "form.pdf"): Promise<string> {
  const result = await withRlsContext(
    { actorType: "user", userId: who.userId, orgId: who.orgId, scopes: ["*"], dimensionGrants: {} },
    (db) =>
      handleFilesUploadUrl(
        {
          filename,
          mimeType: "application/pdf",
          contentBase64: Buffer.from(bytes).toString("base64"),
        },
        { orgId: who.orgId, userId: who.userId, db, actorType: "user" },
      ),
  )
  if (!("fileId" in result)) throw new Error(`staging failed: ${JSON.stringify(result)}`)
  return result.fileId
}

/** A small AcroForm: a text field and a checkbox, plus active content when asked. */
async function formPdf(opts: { active?: boolean; extraField?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const page = doc.addPage([595, 842])
  const form = doc.getForm()
  form.createTextField("customer.name").addToPage(page, { x: 40, y: 760, width: 300, height: 24 })
  form.createCheckBox("terms").addToPage(page, { x: 40, y: 700, width: 14, height: 14 })
  if (opts.extraField) {
    form.createTextField(opts.extraField).addToPage(page, { x: 40, y: 640, width: 300, height: 24 })
  }
  if (opts.active) {
    const ctx = doc.context
    doc.catalog.set(
      PDFName.of("OpenAction"),
      ctx.obj({ S: "JavaScript", JS: PDFString.of("app.alert('opened')") }),
    )
    const widget = form.getTextField("customer.name").acroField.getWidgets()[0]
    widget?.dict.set(
      PDFName.of("AA"),
      ctx.obj({ K: ctx.obj({ S: "JavaScript", JS: PDFString.of("app.alert('typed')") }) }),
    )
  }
  return doc.save({ useObjectStreams: false })
}

async function templateRows(orgId: string): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM kernel.document_templates WHERE org_id = ${orgId}`
  return row?.n ?? 0
}

async function templateFileRows(orgId: string): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM kernel.files
    WHERE org_id = ${orgId} AND app = 'kernel' AND entity_type = 'document_template'`
  return row?.n ?? 0
}

async function fileExists(id: string): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM kernel.files WHERE id = ${id}`
  return rows.length > 0
}

beforeAll(async () => {
  await acquireTestLock()
  const { id: orgId } = await createTestOrg()
  admin = await actor(orgId, (await minimal.orgAdmin(orgId)).id)
  member = await actor(orgId, (await minimal.person(orgId)).id)
  const other = await minimal.secondOrg()
  otherAdmin = await actor(other.orgId, other.adminUserId)
  // The kernel.files SELECT policy is built from the registered parents at boot.
  await rebuildFilesSelectPolicy()
}, 180_000)

afterAll(async () => {
  await releaseTestLock()
})

describe("pdf_form templates from a staged upload", () => {
  it("refuses an encrypted PDF with its code and creates no template and no file", async () => {
    const staged = await stage(admin, readFileSync(join(FIXTURES, "encrypted.pdf")), "locked.pdf")
    const before = {
      rows: await templateRows(admin.orgId),
      files: await templateFileRows(admin.orgId),
    }
    const res = await call(admin, "POST", "", { name: "Locked", stagedFileId: staged })
    expect(res.status).toBe(422)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("encrypted")
    expect(await templateRows(admin.orgId)).toBe(before.rows)
    expect(await templateFileRows(admin.orgId)).toBe(before.files)
  }, 60_000)

  it("stores the sanitized PDF under the template, never the upload, and drops the staged file", async () => {
    const upload = await formPdf({ active: true })
    // Sanity: the upload really carries the active content.
    expect(Buffer.from(upload).toString("latin1")).toContain("/OpenAction")
    const staged = await stage(admin, upload)
    const res = await call(admin, "POST", "", {
      name: "Customs declaration",
      stagedFileId: staged,
      recordType: "shipping:shipment",
      mapping: { "customer.name": { path: "order.customer", placeholder: "Customer" } },
    })
    expect(res.status).toBe(201)
    const { data } = await json<{ data: TemplateJson }>(res)
    expect(data.kind).toBe("pdf_form")
    expect(data.fields.map((f) => f.name).sort()).toEqual(["customer.name", "terms"])
    expect(data.fileId).toBeTruthy()

    const [file] = await sql<
      Array<{ storage_key: string; entity_id: string; entity_type: string }>
    >`
      SELECT storage_key, entity_id, entity_type FROM kernel.files WHERE id = ${data.fileId}`
    expect(file?.entity_type).toBe("document_template")
    expect(file?.entity_id).toBe(data.id)
    const stored = (await getObjectBytes(file!.storage_key, { maxBytes: 10 * 1024 * 1024 })).bytes
    const raw = Buffer.from(stored).toString("latin1")
    for (const needle of ["/JS", "/OpenAction", "/AA", "app.alert"])
      expect(raw).not.toContain(needle)
    // Re-parse: no dictionary anywhere carries an action key.
    const reparsed = await PDFDocument.load(stored)
    for (const [, obj] of reparsed.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict) {
        for (const key of ["JS", "OpenAction", "AA"]) expect(obj.has(PDFName.of(key))).toBe(false)
      }
    }
    expect(reparsed.getForm().getFields().length).toBe(2)
    expect(await fileExists(staged)).toBe(false)
  }, 60_000)

  it("refuses a mapping that does not fit the fields", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ nope: { path: "a" } }, "nope"],
      [{ terms: { const: "yes" } }, "terms"],
      [{ "customer.name": { const: true } }, "customer.name"],
      [{ "customer.name": { image_file_id: crypto.randomUUID() } }, "customer.name"],
    ]
    for (const [mapping, field] of cases) {
      const staged = await stage(admin, await formPdf())
      const before = await templateRows(admin.orgId)
      const res = await call(admin, "POST", "", {
        name: "Bad mapping",
        stagedFileId: staged,
        mapping,
      })
      expect(res.status).toBe(422)
      const body = await json<{ error: { code: string; field?: string } }>(res)
      expect(body.error.code).toBe("mapping_invalid")
      expect(body.error.field).toBe(field)
      expect(await templateRows(admin.orgId)).toBe(before)
    }
  }, 120_000)

  it("replaces the file: new fields, the old file deleted, the mapping re-checked", async () => {
    const created = await json<{ data: TemplateJson }>(
      await call(admin, "POST", "", {
        name: "Replace me",
        stagedFileId: await stage(admin, await formPdf()),
      }),
    )
    const oldFileId = created.data.fileId
    const refused = await call(admin, "POST", `/${created.data.id}/file`, {
      stagedFileId: await stage(admin, await formPdf()),
      mapping: { missing: { path: "x" } },
    })
    expect(refused.status).toBe(422)

    const res = await call(admin, "POST", `/${created.data.id}/file`, {
      stagedFileId: await stage(admin, await formPdf({ extraField: "invoice.number" })),
      mapping: { "invoice.number": { path: "invoice.number" } },
    })
    expect(res.status).toBe(200)
    const { data } = await json<{ data: TemplateJson }>(res)
    expect(data.fields.map((f) => f.name)).toContain("invoice.number")
    expect(data.fileId).not.toBe(oldFileId)
    expect(await fileExists(oldFileId ?? "")).toBe(false)
  }, 120_000)

  it("a rich_text body cannot be set on a PDF form", async () => {
    const created = await json<{ data: TemplateJson }>(
      await call(admin, "POST", "", {
        name: "Form",
        stagedFileId: await stage(admin, await formPdf()),
      }),
    )
    const res = await call(admin, "PATCH", `/${created.data.id}`, { body: { blocks: [] } })
    expect(res.status).toBe(409)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("wrong_kind")
  }, 60_000)
})

describe("at the org's storage cap", () => {
  it("refuses a new template and a new file for one, and stores neither", async () => {
    // An org of its own: the cap below must not reach the other tests.
    const { orgId, adminUserId } = await minimal.secondOrg()
    const owner = await actor(orgId, adminUserId)
    const created = await call(owner, "POST", "", {
      name: "Before the cap",
      stagedFileId: await stage(owner, await formPdf()),
    })
    expect(created.status).toBe(201)
    const { data: template } = await json<{ data: TemplateJson }>(created)
    const forNew = await stage(owner, await formPdf())
    const forReplace = await stage(owner, await formPdf({ extraField: "customer.vat" }))

    // 1 GB cap, 1 GB stored: the uploads above were staged while there was room.
    await withSystemDb("template-quota-test-cap", (db) =>
      db
        .update(organizations)
        .set({ caps: { storageGb: 1 } })
        .where(eq(organizations.id, orgId)),
    )
    await seedFileRow({
      orgId,
      app: "kernel",
      entityType: "file_upload_session",
      entityId: randomUUID(),
      filename: "filler.bin",
      mimeType: "application/octet-stream",
      sizeBytes: 1024 * 1024 * 1024,
      storageKey: `template-quota-test/${randomUUID()}`,
      uploadedBy: owner.userId,
    })
    const before = { rows: await templateRows(orgId), files: await templateFileRows(orgId) }

    const refusedNew = await call(owner, "POST", "", { name: "Over", stagedFileId: forNew })
    expect(refusedNew.status).toBe(409)
    expect((await json<{ error: { code: string } }>(refusedNew)).error.code).toBe(
      "storage_quota_exceeded",
    )
    const refusedReplace = await call(owner, "POST", `/${template.id}/file`, {
      stagedFileId: forReplace,
    })
    expect(refusedReplace.status).toBe(409)
    expect((await json<{ error: { code: string } }>(refusedReplace)).error.code).toBe(
      "storage_quota_exceeded",
    )
    expect(await templateRows(orgId)).toBe(before.rows)
    expect(await templateFileRows(orgId)).toBe(before.files)
  }, 60_000)
})

describe("who may read and write", () => {
  it("a member without kernel:org:admin gets 403 on every write, and reads the list", async () => {
    const staged = await stage(member, await formPdf())
    expect((await call(member, "POST", "", { name: "Nope", stagedFileId: staged })).status).toBe(
      403,
    )
    expect(
      (await call(member, "POST", "", { kind: "rich_text", name: "Nope", body: {} })).status,
    ).toBe(403)
    const created = await json<{ data: TemplateJson }>(
      await call(admin, "POST", "", {
        kind: "rich_text",
        name: "Thank you note",
        body: { blocks: [] },
      }),
    )
    expect((await call(member, "PATCH", `/${created.data.id}`, { name: "x" })).status).toBe(403)
    expect((await call(member, "POST", `/${created.data.id}/archive`)).status).toBe(403)
    const list = await call(member, "GET")
    expect(list.status).toBe(200)
    const ids = (await json<{ data: TemplateJson[] }>(list)).data.map((t) => t.id)
    expect(ids).toContain(created.data.id)
  }, 60_000)

  it("another organisation cannot see or change a template (RLS)", async () => {
    const created = await json<{ data: TemplateJson }>(
      await call(admin, "POST", "", {
        kind: "rich_text",
        name: "Org A only",
        body: { blocks: [] },
      }),
    )
    const theirs = await json<{ data: TemplateJson[] }>(await call(otherAdmin, "GET"))
    expect(theirs.data.map((t) => t.id)).not.toContain(created.data.id)
    expect((await call(otherAdmin, "GET", `/${created.data.id}`)).status).toBe(404)
    expect((await call(otherAdmin, "PATCH", `/${created.data.id}`, { name: "Taken" })).status).toBe(
      404,
    )
    expect((await call(otherAdmin, "POST", `/${created.data.id}/archive`)).status).toBe(404)
    // The table itself, read under org B's RLS context with no filter at all.
    const visible = await withRlsContext(
      {
        actorType: "user",
        userId: otherAdmin.userId,
        orgId: otherAdmin.orgId,
        scopes: ["*"],
        dimensionGrants: {},
      },
      (db) =>
        db
          .select({ id: documentTemplates.id, orgId: documentTemplates.orgId })
          .from(documentTemplates),
    )
    expect(visible.every((r) => r.orgId === otherAdmin.orgId)).toBe(true)
    expect(visible.map((r) => r.id)).not.toContain(created.data.id)
    const [still] = await sql<Array<{ name: string }>>`
      SELECT name FROM kernel.document_templates WHERE id = ${created.data.id}`
    expect(still?.name).toBe("Org A only")
  }, 60_000)
})

describe("archive", () => {
  it("an archived template leaves the list, stays readable by id, and is not changed", async () => {
    const created = await json<{ data: TemplateJson }>(
      await call(admin, "POST", "", {
        kind: "rich_text",
        name: "Old letter",
        body: { blocks: [] },
      }),
    )
    const archived = await call(admin, "POST", `/${created.data.id}/archive`)
    expect(archived.status).toBe(200)
    expect((await json<{ data: TemplateJson }>(archived)).data.archivedAt).toBeTruthy()
    const list = await json<{ data: TemplateJson[] }>(await call(admin, "GET"))
    expect(list.data.map((t) => t.id)).not.toContain(created.data.id)
    const one = await json<{ data: TemplateJson }>(await call(admin, "GET", `/${created.data.id}`))
    expect(one.data.archivedAt).toBeTruthy()
    const patch = await call(admin, "PATCH", `/${created.data.id}`, { name: "Revived" })
    expect(patch.status).toBe(409)
    expect((await json<{ error: { code: string } }>(patch)).error.code).toBe("archived")
  }, 60_000)
})

describe("rich_text templates", () => {
  const body = {
    page: { size: "A4" },
    blocks: [
      { type: "heading", text: "Thank you, {{order.customer}}" },
      { type: "paragraph", text: "Łukawski 株式会社" },
    ],
  }

  it("creates and patches a body, returned as stored", async () => {
    const res = await call(admin, "POST", "", {
      kind: "rich_text",
      name: "Thank you note",
      recordType: "store:order",
      body,
    })
    expect(res.status).toBe(201)
    const created = (await json<{ data: TemplateJson }>(res)).data
    expect(created.kind).toBe("rich_text")
    expect(created.body).toEqual(body)
    expect(created.fileId).toBeNull()

    const next = { ...body, blocks: [{ type: "paragraph", text: "Second draft" }] }
    const patched = await call(admin, "PATCH", `/${created.id}`, { body: next, name: "Thanks" })
    expect(patched.status).toBe(200)
    const got = (await json<{ data: TemplateJson }>(await call(admin, "GET", `/${created.id}`)))
      .data
    expect(got.body).toEqual(next)
    expect(got.name).toBe("Thanks")
    // The list leaves bodies out.
    const listed = (await json<{ data: TemplateJson[] }>(await call(admin, "GET"))).data.find(
      (t) => t.id === created.id,
    )
    expect(listed).toBeTruthy()
    expect(listed && "body" in listed).toBe(false)
  }, 60_000)

  it("refuses a body over the size limit, on create and on patch", async () => {
    const big = { blocks: [{ type: "paragraph", text: "x".repeat(BODY_MAX_BYTES) }] }
    const before = await templateRows(admin.orgId)
    const res = await call(admin, "POST", "", { kind: "rich_text", name: "Too big", body: big })
    expect(res.status).toBe(413)
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("body_too_large")
    expect(await templateRows(admin.orgId)).toBe(before)

    const created = await json<{ data: TemplateJson }>(
      await call(admin, "POST", "", { kind: "rich_text", name: "Small", body: { blocks: [] } }),
    )
    const patch = await call(admin, "PATCH", `/${created.data.id}`, { body: big })
    expect(patch.status).toBe(413)
    const got = (
      await json<{ data: TemplateJson }>(await call(admin, "GET", `/${created.data.id}`))
    ).data
    expect(got.body).toEqual({ blocks: [] })
  }, 60_000)

  it("refuses a body the renderer cannot print, on create and on patch, naming the problem", async () => {
    const before = await templateRows(admin.orgId)
    const bad: Array<[unknown, string]> = [
      [{ blocks: [{ type: "script", text: "x" }] }, "blocks.0"],
      [{ page: { fontSize: 30 }, blocks: [] }, "page.fontSize"],
      [{ blocks: [{ type: "paragraph", text: "Hi {{name | upper}}" }] }, "blocks.0.text"],
      [{ blocks: [{ type: "paragraph" }] }, "blocks.0.text"],
    ]
    for (const [body, where] of bad) {
      const res = await call(admin, "POST", "", { kind: "rich_text", name: "Bad", body })
      expect(res.status).toBe(422)
      const err = (await json<{ error: { code: string; message: string } }>(res)).error
      expect(err.code).toBe("body_invalid")
      expect(err.message).toContain(where)
    }
    expect(await templateRows(admin.orgId)).toBe(before)

    const created = await json<{ data: TemplateJson }>(
      await call(admin, "POST", "", { kind: "rich_text", name: "Good", body }),
    )
    const patch = await call(admin, "PATCH", `/${created.data.id}`, {
      body: { blocks: [{ type: "list", from: "lines" }] },
    })
    expect(patch.status).toBe(422)
    expect((await json<{ error: { code: string } }>(patch)).error.code).toBe("body_invalid")
    const got = (
      await json<{ data: TemplateJson }>(await call(admin, "GET", `/${created.data.id}`))
    ).data
    expect(got.body).toEqual(body)
  }, 60_000)

  it("a rich_text template takes no field mapping (it has no form fields)", async () => {
    const created = await json<{ data: TemplateJson }>(
      await call(admin, "POST", "", { kind: "rich_text", name: "No map", body: { blocks: [] } }),
    )
    const res = await call(admin, "PATCH", `/${created.data.id}`, {
      mapping: { anything: { path: "a" } },
    })
    expect(res.status).toBe(422)
  }, 60_000)
})
