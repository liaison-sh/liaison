// SPDX-License-Identifier: FSL-1.1-ALv2
//
// POST /api/documents/print (modules/documents/print.ts) on real Postgres and
// object storage. A test app declares a printable entity whose record tool is
// a readOnly, ungated in-process tool and whose fileParent is a kernel table
// (a contact stands in for the record). The kernel reads the record through
// that tool, fills the org's PDF form template, and stores the PDF on the
// record: a missing value prints as a grey placeholder and is listed in
// `blanks`; a list with more rows than the template has slots refuses and
// stores nothing; a caller without the parent's write scope gets 403. A
// rich_text template prints its blocks the same way (grey blanks, one line
// per list row, only its own images), and another organisation can neither
// print with this org's templates nor print this org's records.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { inflateSync } from "node:zlib"
import {
  PDFArray,
  PDFDocument,
  type PDFDocument as PDFDocumentType,
  PDFName,
  PDFRawStream,
  PDFRef,
} from "pdf-lib"
import { z } from "zod"
import { app } from "~/app"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import { handleFilesUploadUrl } from "~/modules/agent/tools/file-tools"
import {
  entityRegistry,
  manifestFileParentRegistry,
  type PrintDeclaration,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { attachFileToParent } from "~/modules/files/attach"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { extractPdfText } from "../pdf/pdf-text"
import { assertRowsFit, readRecordPath } from "./print"
import { RICH_TEXT_MAX_LIST_ROWS } from "./rich-text"

interface Actor {
  orgId: string
  userId: string
  token: string
}

const APP = "printfixture"
const ENTITY = "customer"

const DECLARATION: PrintDeclaration = {
  recordTool: "record_get",
  idParam: "customer_id",
  label: "Customer",
  fields: [
    { path: "name", label: "Name", type: "string" },
    { path: "tracking_number", label: "Tracking number", type: "string" },
    { path: "lines.sku", label: "SKU", type: "string", repeat: "lines" },
  ],
}

let admin: Actor
let member: Actor
let otherAdmin: Actor
let otherRecordId: string
let recordId: string
let record: Record<string, unknown> = {}
let toolCalls: unknown[] = []
let formTemplateId: string
let richTextTemplateId: string
let foreignImageTemplateId: string

// A 1x1 PNG.
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
)

/** Stage an image and attach it to a template, as the template's settings upload does. */
async function templateImage(who: Actor, templateId: string): Promise<string> {
  const staged = await stage(who, PNG, "stamp.png", "image/png")
  const attached = await withRlsContext(
    { actorType: "user", userId: who.userId, orgId: who.orgId, scopes: ["*"], dimensionGrants: {} },
    (rlsTx) =>
      attachFileToParent(
        {
          sourceFileId: staged,
          target: { app: "kernel", entityType: "document_template", entityId: templateId },
        },
        {
          rlsTx,
          privileged: (reason, fn) => withPrivilegedDb(who.orgId, reason, fn),
          orgId: who.orgId,
          userId: who.userId,
          scopes: ["*"],
          actorType: "user",
        },
      ),
  )
  return attached.id
}

function imageCount(doc: PDFDocumentType): number {
  let n = 0
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Subtype")) === PDFName.of("Image"))
      n += 1
  }
  return n
}

async function storedBytes(fileId: string): Promise<Uint8Array> {
  const [file] = await sql<Array<{ storage_key: string }>>`
    SELECT storage_key FROM kernel.files WHERE id = ${fileId}`
  return (await getObjectBytes(file!.storage_key, { maxBytes: 10 * 1024 * 1024 })).bytes
}

async function actor(orgId: string, userId: string): Promise<Actor> {
  return { orgId, userId, token: await minimal.token(userId) }
}

async function call(who: Actor, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${who.token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

async function stage(
  who: Actor,
  bytes: Uint8Array,
  filename = "form.pdf",
  mimeType = "application/pdf",
): Promise<string> {
  const result = await withRlsContext(
    { actorType: "user", userId: who.userId, orgId: who.orgId, scopes: ["*"], dimensionGrants: {} },
    (db) =>
      handleFilesUploadUrl(
        {
          filename,
          mimeType,
          contentBase64: Buffer.from(bytes).toString("base64"),
        },
        { orgId: who.orgId, userId: who.userId, db, actorType: "user" },
      ),
  )
  if (!("fileId" in result)) throw new Error(`staging failed: ${JSON.stringify(result)}`)
  return result.fileId
}

/** A form with a name, a tracking number and two SKU rows. */
async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const page = doc.addPage([595, 842])
  const form = doc.getForm()
  form.createTextField("name").addToPage(page, { x: 40, y: 760, width: 300, height: 24 })
  form.createTextField("tracking").addToPage(page, { x: 40, y: 700, width: 300, height: 24 })
  form.createTextField("sku_1").addToPage(page, { x: 40, y: 640, width: 300, height: 24 })
  form.createTextField("sku_2").addToPage(page, { x: 40, y: 600, width: 300, height: 24 })
  return doc.save({ useObjectStreams: false })
}

function pageContent(doc: PDFDocumentType): string {
  const contents = doc.getPage(0).node.Contents()
  const parts = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
  return parts
    .map((part) => {
      const stream = part instanceof PDFRef ? doc.context.lookup(part) : part
      if (!(stream instanceof PDFRawStream)) return ""
      const filter = stream.dict.get(PDFName.of("Filter"))?.toString()
      const raw = Buffer.from(stream.contents)
      return (filter === "/FlateDecode" ? inflateSync(raw) : raw).toString("latin1")
    })
    .join("\n")
}

async function filesOnRecord(): Promise<number> {
  const [row] = await sql<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM kernel.files
    WHERE org_id = ${admin.orgId} AND app = ${APP} AND entity_type = ${ENTITY}
      AND entity_id = ${recordId}`
  return row?.n ?? 0
}

interface PrintJson {
  files: Array<{
    templateId: string
    fileId: string
    filename: string
    blanks: Array<{ field: string; label: string; path?: string }>
  }>
  merged: { fileId: string; pageCount: number } | null
}

beforeAll(async () => {
  await acquireTestLock()
  const { id: orgId } = await createTestOrg()
  admin = await actor(orgId, (await minimal.orgAdmin(orgId)).id)
  member = await actor(orgId, (await minimal.person(orgId)).id)
  await ensureAppsForOrg(orgId)

  recordId = await minimal.contact(orgId, `print-${crypto.randomUUID()}@example.com`)

  const other = await minimal.secondOrg()
  const otherOrgId = other.orgId
  otherAdmin = await actor(otherOrgId, other.adminUserId)
  await ensureAppsForOrg(otherOrgId)
  otherRecordId = await minimal.contact(otherOrgId, `print-${crypto.randomUUID()}@example.com`)

  // The test app, in both orgs: a printable entity on a kernel table, written by org admins only.
  for (const id of [orgId, otherOrgId]) {
    entityRegistry.set([id, APP, ENTITY], {
      labelField: "name",
      handlePrefix: "",
      print: DECLARATION,
    })
    manifestFileParentRegistry.set([id, APP, ENTITY], {
      schemaRef: "kernel",
      tableName: "contacts",
      joinOn: "id",
      readScope: "kernel:contacts:read",
      writeScope: "kernel:org:admin",
    })
    toolRegistry.set([id, APP, "record_get"], {
      appName: APP,
      name: "record_get",
      description: "The customer as a printable record",
      requiredScopes: ["kernel:files:read"],
      readOnly: true,
      params: z.object({ customer_id: z.string() }),
      handler: async (params: unknown) => {
        toolCalls.push(params)
        return record
      },
    } as never)
  }
  // The merge reads the printed files under the caller's RLS: the policy must know the parent.
  await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })

  const staged = await stage(admin, await formPdf())
  const created = await call(admin, "POST", "/api/document-templates", {
    name: "Packing list",
    stagedFileId: staged,
    recordType: `${APP}:${ENTITY}`,
    mapping: {
      name: { path: "name" },
      tracking: { path: "tracking_number", placeholder: "Tracking number to fill" },
      sku_1: { path: "lines.0.sku" },
      sku_2: { path: "lines.1.sku" },
    },
  })
  expect(created.status).toBe(201)
  formTemplateId = ((await created.json()) as { data: { id: string } }).data.id

  const rich = await call(admin, "POST", "/api/document-templates", {
    kind: "rich_text",
    name: "Thank you letter",
    body: { blocks: [] },
    recordType: `${APP}:${ENTITY}`,
  })
  expect(rich.status).toBe(201)
  richTextTemplateId = ((await rich.json()) as { data: { id: string } }).data.id
  const stamp = await templateImage(admin, richTextTemplateId)
  const patched = await call(admin, "PATCH", `/api/document-templates/${richTextTemplateId}`, {
    body: {
      page: { size: "A4", fontSize: 10 },
      blocks: [
        { type: "heading", text: "Thank you, {{name}}" },
        { type: "paragraph", text: "Your parcel {{tracking_number}} is on its way." },
        { type: "list", from: "lines", line: "{{sku}}" },
        { type: "image", fileId: stamp, width: 60, align: "right" },
      ],
    },
  })
  expect(patched.status).toBe(200)

  // A second template whose body points at the first template's image.
  const foreign = await call(admin, "POST", "/api/document-templates", {
    kind: "rich_text",
    name: "Borrowed stamp",
    body: {
      blocks: [
        { type: "paragraph", text: "x" },
        { type: "image", fileId: stamp },
      ],
    },
    recordType: `${APP}:${ENTITY}`,
  })
  expect(foreign.status).toBe(201)
  foreignImageTemplateId = ((await foreign.json()) as { data: { id: string } }).data.id
}, 180_000)

afterAll(async () => {
  for (const id of [admin.orgId, otherAdmin.orgId]) {
    entityRegistry.delete([id, APP, ENTITY])
    manifestFileParentRegistry.delete([id, APP, ENTITY])
    toolRegistry.delete([id, APP, "record_get"])
  }
  await rebuildFilesSelectPolicy()
  await releaseTestLock()
})

describe("record paths", () => {
  it("indexes arrays by number and reads own properties only", () => {
    const r = { lines: [{ hts: "7326" }], order: { name: "#1" } }
    expect(readRecordPath(r, "lines.0.hts")).toBe("7326")
    expect(readRecordPath(r, "order.name")).toBe("#1")
    expect(readRecordPath(r, "lines.1.hts")).toBeUndefined()
    expect(readRecordPath(r, "constructor")).toBeUndefined()
    expect(readRecordPath(r, "order.__proto__")).toBeUndefined()
    expect(readRecordPath(r, "lines.length")).toBeUndefined()
  })

  it("refuses more rows than mapped slots and accepts a template that prints no rows", () => {
    const mapping = { a: { path: "lines.0.sku" }, b: { path: "lines.1.sku" } }
    const three = { lines: [{ sku: "A" }, { sku: "B" }, { sku: "C" }] }
    expect(() => assertRowsFit({ id: "t", name: "T", mapping }, DECLARATION, three)).toThrow(
      /3 rows/,
    )
    expect(() =>
      assertRowsFit({ id: "t", name: "T", mapping: { a: { path: "name" } } }, DECLARATION, three),
    ).not.toThrow()
  })
})

describe("POST /api/documents/print", () => {
  it("lists the record type and its templates", async () => {
    const types = await call(member, "GET", "/api/documents/record-types")
    expect(types.status).toBe(200)
    const { data } = (await types.json()) as {
      data: Array<{ recordType: string; label: string; fields: unknown[] }>
    }
    const mine = data.find((t) => t.recordType === `${APP}:${ENTITY}`)
    expect(mine?.label).toBe("Customer")
    expect(mine?.fields).toHaveLength(3)

    const list = await call(member, "GET", `/api/documents/templates?app=${APP}&entity=${ENTITY}`)
    expect(list.status).toBe(200)
    const ids = ((await list.json()) as { data: Array<{ id: string }> }).data.map((t) => t.id)
    expect(ids).toContain(formTemplateId)
  })

  it("prints the record onto the template, a missing value as a grey placeholder listed in blanks", async () => {
    record = { name: "Acme Łukawski", tracking_number: null, lines: [{ sku: "SKU-A" }] }
    toolCalls = []
    const res = await call(admin, "POST", "/api/documents/print", {
      app: APP,
      entity: ENTITY,
      recordId,
      templateIds: [formTemplateId],
      merge: true,
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: PrintJson }
    // The record came from the app's own tool, called with the record id.
    expect(toolCalls).toEqual([{ customer_id: recordId }])
    expect(data.files).toHaveLength(1)
    const printed = data.files[0]!
    expect(printed.filename).toBe("Packing list Acme Łukawski.pdf")
    const blankFields = printed.blanks.map((b) => b.field).sort()
    expect(blankFields).toEqual(["sku_2", "tracking"])
    expect(printed.blanks.find((b) => b.field === "tracking")).toEqual({
      field: "tracking",
      label: "Tracking number",
      path: "tracking_number",
    })

    const [file] = await sql<Array<{ storage_key: string; entity_id: string; app: string }>>`
      SELECT storage_key, entity_id, app FROM kernel.files WHERE id = ${printed.fileId}`
    expect(file?.app).toBe(APP)
    expect(file?.entity_id).toBe(recordId)
    const bytes = (await getObjectBytes(file!.storage_key, { maxBytes: 10 * 1024 * 1024 })).bytes
    const text = await extractPdfText(bytes)
    expect(text).toContain("Acme Łukawski")
    expect(text).toContain("SKU-A")
    expect(text).toContain("Tracking number to fill")
    expect(text).not.toContain("null")
    const doc = await PDFDocument.load(bytes)
    expect(doc.getForm().getFields()).toHaveLength(0)
    expect(pageContent(doc)).toContain("0.55 0.55 0.55 rg")

    expect(data.merged?.pageCount).toBe(1)
  }, 60_000)

  it("refuses three rows into two slots with too_many_rows and stores no file", async () => {
    record = { name: "Acme", lines: [{ sku: "A" }, { sku: "B" }, { sku: "C" }] }
    const before = await filesOnRecord()
    const res = await call(admin, "POST", "/api/documents/print", {
      app: APP,
      entity: ENTITY,
      recordId,
      templateIds: [formTemplateId],
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("too_many_rows")
    expect(body.error.message).toContain("3 rows")
    expect(await filesOnRecord()).toBe(before)
  }, 60_000)

  it("refuses a caller without the record's file write scope with 403, before reading the record", async () => {
    record = { name: "Acme", lines: [] }
    toolCalls = []
    const before = await filesOnRecord()
    const res = await call(member, "POST", "/api/documents/print", {
      app: APP,
      entity: ENTITY,
      recordId,
      templateIds: [formTemplateId],
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("forbidden")
    expect(toolCalls).toHaveLength(0)
    expect(await filesOnRecord()).toBe(before)
  })

  it("prints a rich_text template: grey blanks, one line per row, its own image", async () => {
    record = {
      name: "Acme Łukawski",
      tracking_number: "",
      lines: [{ sku: "SKU-A" }, { sku: "SKU-B" }, { sku: "SKU-C" }],
    }
    toolCalls = []
    const res = await call(admin, "POST", "/api/documents/print", {
      app: APP,
      entity: ENTITY,
      recordId,
      templateIds: [richTextTemplateId],
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: PrintJson }
    expect(toolCalls).toEqual([{ customer_id: recordId }])
    const printed = data.files[0]!
    expect(printed.filename).toBe("Thank you letter Acme Łukawski.pdf")
    expect(printed.blanks).toEqual([
      { field: "tracking_number", label: "Tracking number", path: "tracking_number" },
    ])
    const bytes = await storedBytes(printed.fileId)
    const text = await extractPdfText(bytes)
    expect(text).toContain("Thank you, Acme Łukawski")
    expect(text).toContain("[Tracking number]")
    for (const sku of ["SKU-A", "SKU-B", "SKU-C"]) expect(text).toContain(sku)
    expect(text).not.toContain("null")
    expect(text).not.toContain("undefined")
    const doc = await PDFDocument.load(bytes)
    expect(pageContent(doc)).toContain("0.55 0.55 0.55 rg")
    expect(imageCount(doc)).toBeGreaterThan(0)
  }, 60_000)

  it("skips an image that belongs to another template", async () => {
    record = { name: "Acme", lines: [] }
    const res = await call(admin, "POST", "/api/documents/print", {
      app: APP,
      entity: ENTITY,
      recordId,
      templateIds: [foreignImageTemplateId],
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: PrintJson }
    const doc = await PDFDocument.load(await storedBytes(data.files[0]!.fileId))
    expect(imageCount(doc)).toBe(0)
  }, 60_000)

  it(`refuses a list over ${RICH_TEXT_MAX_LIST_ROWS} rows with too_many_rows and stores nothing`, async () => {
    record = {
      name: "Acme",
      lines: Array.from({ length: RICH_TEXT_MAX_LIST_ROWS + 1 }, (_, i) => ({ sku: `S${i}` })),
    }
    const before = await filesOnRecord()
    const res = await call(admin, "POST", "/api/documents/print", {
      app: APP,
      entity: ENTITY,
      recordId,
      templateIds: [richTextTemplateId],
    })
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string; templateId?: string } }
    expect(body.error.code).toBe("too_many_rows")
    expect(body.error.templateId).toBe(richTextTemplateId)
    expect(await filesOnRecord()).toBe(before)
  }, 60_000)

  it("another organisation cannot print with this org's templates, nor print this org's records", async () => {
    record = { name: "Acme", lines: [] }
    toolCalls = []
    const withOurTemplate = await call(otherAdmin, "POST", "/api/documents/print", {
      app: APP,
      entity: ENTITY,
      recordId: otherRecordId,
      templateIds: [richTextTemplateId],
    })
    expect(withOurTemplate.status).toBe(404)
    expect(((await withOurTemplate.json()) as { error: { code: string } }).error.code).toBe(
      "template_not_found",
    )
    const ourRecord = await call(otherAdmin, "POST", "/api/documents/print", {
      app: APP,
      entity: ENTITY,
      recordId,
      templateIds: [richTextTemplateId],
    })
    expect(ourRecord.status).toBe(404)
    expect(((await ourRecord.json()) as { error: { code: string } }).error.code).toBe(
      "record_not_found",
    )
    expect(toolCalls).toHaveLength(0)
    const list = await call(
      otherAdmin,
      "GET",
      `/api/documents/templates?app=${APP}&entity=${ENTITY}`,
    )
    expect(list.status).toBe(200)
    expect(((await list.json()) as { data: unknown[] }).data).toEqual([])
  }, 60_000)

  it("refuses a record type that declares no print", async () => {
    const res = await call(admin, "POST", "/api/documents/print", {
      app: APP,
      entity: "nothing",
      recordId,
      templateIds: [formTemplateId],
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "record_type_not_printable",
    )
  })

  it("takes no data from the caller", async () => {
    const res = await call(admin, "POST", "/api/documents/print", {
      app: APP,
      entity: ENTITY,
      recordId,
      templateIds: [formTemplateId],
      data: { name: "Injected" },
    })
    expect(res.status).toBe(400)
  })
})

interface PreviewJson {
  templateId: string
  filename: string
  byteSize: number
  blanks: Array<{ field: string; label: string; path?: string }>
  sample: boolean
  pdfBase64: string
}

describe("POST /api/document-templates/:id/preview", () => {
  it("previews the sample record: declared labels as values, nothing read, nothing stored", async () => {
    toolCalls = []
    const before = await filesOnRecord()
    const res = await call(
      admin,
      "POST",
      `/api/document-templates/${richTextTemplateId}/preview`,
      {},
    )
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: PreviewJson }
    expect(data.sample).toBe(true)
    expect(data.filename).toBe("Thank you letter sample.pdf")
    expect(toolCalls).toEqual([])
    expect(await filesOnRecord()).toBe(before)
    const bytes = Buffer.from(data.pdfBase64, "base64")
    expect(data.byteSize).toBe(bytes.byteLength)
    const text = await extractPdfText(bytes)
    // The same render as the agent's preview: "Sample <label>" values, SAMPLE on every page.
    expect(text).toContain("Thank you, Sample Name")
    expect(text).toContain("Your parcel Sample Tracking number is on its way.")
    expect(text).toContain("SAMPLE")
    expect(text.split("SKU").length - 1).toBeGreaterThanOrEqual(2)
    expect(data.blanks).toEqual([])
  }, 60_000)

  it("previews a real record through its record tool and lists its blanks, storing nothing", async () => {
    record = { name: "Acme", tracking_number: "", lines: [{ sku: "SKU-A" }] }
    toolCalls = []
    const before = await filesOnRecord()
    const res = await call(admin, "POST", `/api/document-templates/${formTemplateId}/preview`, {
      recordId,
    })
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: PreviewJson }
    expect(data.sample).toBe(false)
    expect(toolCalls).toEqual([{ customer_id: recordId }])
    expect(await filesOnRecord()).toBe(before)
    expect(data.blanks.map((b) => b.field).sort()).toEqual(["sku_2", "tracking"])
    const text = await extractPdfText(Buffer.from(data.pdfBase64, "base64"))
    expect(text).toContain("Acme")
    expect(text).toContain("Tracking number to fill")
    expect(text).not.toContain("SAMPLE")
  }, 60_000)

  it("a record the caller does not see is refused before its record tool runs", async () => {
    toolCalls = []
    const res = await call(admin, "POST", `/api/document-templates/${formTemplateId}/preview`, {
      recordId: crypto.randomUUID(),
    })
    expect(res.status).toBe(404)
    expect(toolCalls).toEqual([])
  }, 60_000)

  it("is for org admins only", async () => {
    const res = await call(
      member,
      "POST",
      `/api/document-templates/${richTextTemplateId}/preview`,
      {},
    )
    expect(res.status).toBe(403)
  })

  it("another organisation cannot preview this org's template", async () => {
    const res = await call(
      otherAdmin,
      "POST",
      `/api/document-templates/${richTextTemplateId}/preview`,
      {},
    )
    expect(res.status).toBe(404)
  })
})

describe("body validation errors name their path", () => {
  it("a 422 body_invalid carries the path of the first problem", async () => {
    const res = await call(admin, "PATCH", `/api/document-templates/${richTextTemplateId}`, {
      body: {
        blocks: [
          { type: "paragraph", text: "ok" },
          { type: "paragraph", text: "{{ bad" },
        ],
      },
    })
    expect(res.status).toBe(422)
    const json = (await res.json()) as {
      error: { code: string; field?: string; details?: { field?: string } }
    }
    expect(json.error.code).toBe("body_invalid")
    expect(json.error.details?.field).toBe("blocks.1.text")
  })
})
