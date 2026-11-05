// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Documents: the template list (admins only), the inline "New
// template" form (rich text, or a PDF form whose refusal shows inline), and a
// template's page: Content (insert a field at the cursor, a body refusal shown
// on the block it names, save round trip), Fields & mapping (save round trip)
// and Preview (blanks listed).
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("~/modules/files/file-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/files/file-service")>()
  return {
    ...actual,
    createUploadSession: vi.fn(async () => ({
      id: "session-1",
      targetApp: "kernel",
      targetEntityType: "document_template",
      targetEntityId: null,
    })),
    uploadFile: vi.fn(async () => ({
      id: "staged-1",
      filename: "form.pdf",
      sizeBytes: 10,
      mimeType: "application/pdf",
      thumbnailKey: null,
    })),
    moveFilesToParent: vi.fn(async () => ({ moved: 1 })),
    listFiles: vi.fn(async () => []),
  }
})

import { getSettingsSections, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import { moveFilesToParent } from "~/modules/files/file-service"
import { visibleSettingsSections } from "~/modules/settings/visible-settings-sections"
import { ApiProvider } from "~/modules/shell/ApiContext"
import DocumentsSettings from "./DocumentsSettings"
import DocumentTemplateDetail from "./DocumentTemplateDetail"

const RICH = "11111111-1111-4111-8111-111111111111"
const FORM = "22222222-2222-4222-8222-222222222222"

function signIn(scopes: string[]): void {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "Alex Rivera",
      roles: [],
      scopes,
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  setTokens(`${header}.${body}.fake`, "refresh")
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

const RECORD_TYPES = [
  {
    app: "shipping",
    entity: "shipment",
    recordType: "shipping:shipment",
    label: "Shipment",
    fields: [
      { path: "order.name", label: "Order", type: "string" },
      { path: "tracking_number", label: "Tracking number", type: "string" },
      { path: "lines.sku", label: "SKU", type: "string", repeat: "lines" },
    ],
  },
]

function richTemplate(blocks: unknown[] = [{ type: "paragraph", text: "Hello  !" }]) {
  return {
    id: RICH,
    name: "Thank you letter",
    kind: "rich_text",
    recordType: "shipping:shipment",
    fileId: null,
    body: { page: { size: "A4" }, blocks },
    fields: [],
    mapping: {},
    enabled: true,
    updatedAt: "2026-11-01T10:00:00.000Z",
    archivedAt: null,
  }
}

function formTemplate() {
  return {
    id: FORM,
    name: "Customs form",
    kind: "pdf_form",
    recordType: "shipping:shipment",
    fileId: "file-1",
    fields: [
      { name: "order_no", type: "text", page: 0 },
      { name: "tracking", type: "text", page: 0 },
    ],
    mapping: { order_no: { path: "order.name" } },
    enabled: false,
    updatedAt: "2026-11-02T10:00:00.000Z",
    archivedAt: null,
  }
}

type Handler = (url: string, init: RequestInit | undefined) => Response | undefined

function mockFetch(handler: Handler = () => undefined) {
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const custom = handler(url, init)
    if (custom) return custom
    const method = init?.method ?? "GET"
    if (url.endsWith("/documents/record-types")) return json({ data: RECORD_TYPES })
    if (url.endsWith("/document-templates") && method === "GET")
      return json({ data: [richTemplate(), formTemplate()] })
    if (url.endsWith(`/document-templates/${RICH}`) && method === "GET")
      return json({ data: richTemplate() })
    if (url.endsWith(`/document-templates/${FORM}`) && method === "GET")
      return json({ data: formTemplate() })
    return json({ data: {} })
  })
  vi.stubGlobal("fetch", fn)
  return fn
}

function callsTo(fn: ReturnType<typeof mockFetch>, suffix: string, method: string) {
  return fn.mock.calls.filter(
    ([u, init]) => String(u).endsWith(suffix) && (init?.method ?? "GET") === method,
  )
}

function renderAt(path: string, Page: typeof DocumentsSettings) {
  window.history.pushState({}, "", path)
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <Page />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

beforeEach(() => {
  signIn(["kernel:org:admin", "kernel:files:read"])
})

afterEach(() => {
  cleanup()
  clearAuth()
  vi.unstubAllGlobals()
})

describe("the Documents list", () => {
  it("lists every template with its kind, record type and status", async () => {
    mockFetch()
    renderAt("/settings/admin/documents", DocumentsSettings)
    const row = await screen.findByTestId(`documents-row-${RICH}`)
    expect(row.textContent).toContain("Thank you letter")
    expect(row.textContent).toContain("Rich text")
    expect(row.textContent).toContain("Shipment")
    const form = screen.getByTestId(`documents-row-${FORM}`)
    expect(form.textContent).toContain("PDF form")
    expect(screen.getByTestId(`documents-row-status-${FORM}`).textContent).toBe("Turned off")
    expect(screen.getByTestId("documents-agent-hint").textContent).toContain(
      "Ask your agent to design a document from an example",
    )
  })

  it("shows nothing to a member without kernel:org:admin, and no Settings row", async () => {
    signIn(["kernel:files:read"])
    const fn = mockFetch()
    renderAt("/settings/admin/documents", DocumentsSettings)
    await Promise.resolve()
    expect(screen.queryByTestId("documents-settings")).toBeNull()
    expect(callsTo(fn, "/document-templates", "GET")).toHaveLength(0)

    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    expect(getSettingsSections().some((s) => s.id === "kernel:documents")).toBe(true)
    expect(visibleSettingsSections().some((s) => s.id === "kernel:documents")).toBe(false)
    signIn(["kernel:org:admin"])
    expect(visibleSettingsSections().some((s) => s.id === "kernel:documents")).toBe(true)
  })

  it("creates a rich text template and opens its page", async () => {
    const created = { ...richTemplate([]), id: "33333333-3333-4333-8333-333333333333" }
    const fn = mockFetch((url, init) =>
      url.endsWith("/document-templates") && init?.method === "POST"
        ? json({ data: created }, 201)
        : undefined,
    )
    renderAt("/settings/admin/documents", DocumentsSettings)
    fireEvent.click(await screen.findByTestId("documents-new"))
    fireEvent.input(screen.getByTestId("documents-new-name"), {
      target: { value: "Thank you letter" },
    })
    await waitFor(() =>
      expect(
        screen.getByTestId("documents-new-record-type").querySelectorAll("option"),
      ).toHaveLength(2),
    )
    fireEvent.change(screen.getByTestId("documents-new-record-type"), {
      target: { value: "shipping:shipment" },
    })
    fireEvent.click(screen.getByTestId("documents-new-create"))
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/settings/admin/documents/${created.id}`),
    )
    const [, init] = callsTo(fn, "/document-templates", "POST")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "rich_text",
      name: "Thank you letter",
      recordType: "shipping:shipment",
      body: { page: { size: "A4" }, blocks: [] },
    })
  })

  it("shows the server's refusal of an uploaded PDF inline", async () => {
    mockFetch((url, init) =>
      url.endsWith("/document-templates") && init?.method === "POST"
        ? json(
            {
              error: {
                code: "encrypted",
                message: "The PDF is encrypted; upload an unprotected copy",
              },
            },
            422,
          )
        : undefined,
    )
    renderAt("/settings/admin/documents", DocumentsSettings)
    fireEvent.click(await screen.findByTestId("documents-new"))
    fireEvent.click(screen.getByTestId("documents-new-kind-pdf_form"))
    fireEvent.input(screen.getByTestId("documents-new-name"), { target: { value: "Customs" } })
    const file = new File([new Uint8Array([37, 80, 68, 70])], "form.pdf", {
      type: "application/pdf",
    })
    fireEvent.change(screen.getByTestId("documents-new-file"), { target: { files: [file] } })
    fireEvent.click(screen.getByTestId("documents-new-create"))
    const error = await screen.findByTestId("documents-new-error")
    expect(error.textContent).toBe("The PDF is encrypted; upload an unprotected copy")
    expect(window.location.pathname).toBe("/settings/admin/documents")
  })

  it("stages an uploaded PDF, creates the form template from it and opens its page", async () => {
    const created = { ...formTemplate(), id: "77777777-7777-4777-8777-777777777777" }
    const fn = mockFetch((url, init) =>
      url.endsWith("/document-templates") && init?.method === "POST"
        ? json({ data: created }, 201)
        : undefined,
    )
    renderAt("/settings/admin/documents", DocumentsSettings)
    fireEvent.click(await screen.findByTestId("documents-new"))
    fireEvent.click(screen.getByTestId("documents-new-kind-pdf_form"))
    fireEvent.input(screen.getByTestId("documents-new-name"), { target: { value: "Customs" } })
    const file = new File([new Uint8Array([37, 80, 68, 70])], "form.pdf", {
      type: "application/pdf",
    })
    fireEvent.change(screen.getByTestId("documents-new-file"), { target: { files: [file] } })
    fireEvent.click(screen.getByTestId("documents-new-create"))
    await waitFor(() =>
      expect(window.location.pathname).toBe(`/settings/admin/documents/${created.id}`),
    )
    const [, init] = callsTo(fn, "/document-templates", "POST")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      kind: "pdf_form",
      name: "Customs",
      recordType: null,
      stagedFileId: "staged-1",
    })
  })
})

describe("a rich text template's Content tab", () => {
  it("inserts {{path}} at the cursor", async () => {
    mockFetch()
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    const area = (await screen.findByTestId("documents-block-0-text")) as HTMLTextAreaElement
    await waitFor(() =>
      expect(
        screen.getByTestId("documents-block-0-text-insert").querySelectorAll("option").length,
      ).toBeGreaterThan(1),
    )
    area.setSelectionRange(6, 6)
    fireEvent.change(screen.getByTestId("documents-block-0-text-insert"), {
      target: { value: "order.name" },
    })
    await waitFor(() => expect(area.value).toBe("Hello {{order.name}} !"))
  })

  it("offers a list block the fields of one row, relative to the row", async () => {
    mockFetch((url, init) =>
      url.endsWith(`/document-templates/${RICH}`) && (init?.method ?? "GET") === "GET"
        ? json({ data: richTemplate([{ type: "list", from: "lines", line: "" }]) })
        : undefined,
    )
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    const picker = await screen.findByTestId("documents-block-0-line-insert")
    await waitFor(() =>
      expect([...picker.querySelectorAll("option")].map((o) => o.value)).toEqual(["", "sku"]),
    )
  })

  it("shows a body refusal inline, on the block its path names", async () => {
    mockFetch((url, init) =>
      url.endsWith(`/document-templates/${RICH}`) && init?.method === "PATCH"
        ? json(
            {
              error: {
                code: "body_invalid",
                message: "The template body is not valid: blocks.0.text: a placeholder is {{path}}",
                field: "blocks.0.text",
                details: { field: "blocks.0.text" },
              },
            },
            422,
          )
        : undefined,
    )
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    fireEvent.input(await screen.findByTestId("documents-block-0-text"), {
      target: { value: "Hello {{ bad" },
    })
    fireEvent.click(screen.getByTestId("documents-content-save"))
    const blockError = await screen.findByTestId("documents-block-0-error")
    expect(blockError.textContent).toContain("blocks.0.text")
    expect(screen.getByTestId("documents-content-error").textContent).toContain(
      "The template body is not valid",
    )
  })

  it("saves the blocks and shows what the server kept", async () => {
    const fn = mockFetch((url, init) => {
      if (url.endsWith(`/document-templates/${RICH}`) && init?.method === "PATCH") {
        const sent = JSON.parse(String(init.body)) as { body: { blocks: unknown[] } }
        return json({ data: richTemplate(sent.body.blocks) })
      }
      return undefined
    })
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    await screen.findByTestId("documents-block-0")
    fireEvent.click(screen.getByTestId("documents-add-heading"))
    fireEvent.input(screen.getByTestId("documents-block-1-text"), {
      target: { value: "Dear {{order.name}}" },
    })
    fireEvent.click(screen.getByTestId("documents-block-1-up"))
    fireEvent.click(screen.getByTestId("documents-content-save"))
    await screen.findByTestId("documents-content-saved")
    const [, init] = callsTo(fn, `/document-templates/${RICH}`, "PATCH")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      body: {
        page: { size: "A4" },
        blocks: [
          { type: "heading", text: "Dear {{order.name}}", level: 1 },
          { type: "paragraph", text: "Hello  !" },
        ],
      },
    })
    expect((screen.getByTestId("documents-block-0-text") as HTMLTextAreaElement).value).toBe(
      "Dear {{order.name}}",
    )
  })
})

describe("a rich text template's blocks and images", () => {
  it("deletes a block inline", async () => {
    mockFetch((url, init) =>
      url.endsWith(`/document-templates/${RICH}`) && (init?.method ?? "GET") === "GET"
        ? json({
            data: richTemplate([
              { type: "paragraph", text: "First" },
              { type: "paragraph", text: "Second" },
            ]),
          })
        : undefined,
    )
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    await screen.findByTestId("documents-block-1")
    fireEvent.click(screen.getByTestId("documents-block-0-delete"))
    await waitFor(() => expect(screen.queryByTestId("documents-block-1")).toBeNull())
    expect((screen.getByTestId("documents-block-0-text") as HTMLTextAreaElement).value).toBe(
      "Second",
    )
  })

  it("uploads an image onto the template and adds an image block for it", async () => {
    vi.mocked(moveFilesToParent).mockClear()
    const fn = mockFetch((url, init) => {
      if (url.endsWith(`/document-templates/${RICH}`) && init?.method === "PATCH") {
        const sent = JSON.parse(String(init.body)) as { body: { blocks: unknown[] } }
        return json({ data: richTemplate(sent.body.blocks) })
      }
      return undefined
    })
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    await screen.findByTestId("documents-block-0")
    const file = new File([new Uint8Array([137, 80, 78, 71])], "stamp.png", { type: "image/png" })
    fireEvent.change(screen.getByTestId("documents-add-image-input"), {
      target: { files: [file] },
    })
    expect((await screen.findByTestId("documents-block-1-file")).textContent).toBe("staged-1")
    expect(vi.mocked(moveFilesToParent)).toHaveBeenCalledWith(expect.anything(), {
      sourceSessionId: "session-1",
      target: { app: "kernel", entityType: "document_template", entityId: RICH },
      fileIds: ["staged-1"],
    })
    fireEvent.click(screen.getByTestId("documents-content-save"))
    await screen.findByTestId("documents-content-saved")
    const [, init] = callsTo(fn, `/document-templates/${RICH}`, "PATCH")[0]!
    expect(JSON.parse(String(init?.body)).body.blocks[1]).toEqual({
      type: "image",
      fileId: "staged-1",
      width: 120,
      align: "left",
    })
  })
})

describe("archiving a template", () => {
  it("asks inline, archives, and goes back to the list", async () => {
    const fn = mockFetch((url, init) =>
      url.endsWith(`/document-templates/${RICH}/archive`) && init?.method === "POST"
        ? json({ data: { ...richTemplate(), archivedAt: "2026-11-04T08:00:00.000Z" } })
        : undefined,
    )
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    fireEvent.click(await screen.findByTestId("document-template-archive"))
    expect(callsTo(fn, `/document-templates/${RICH}/archive`, "POST")).toHaveLength(0)
    fireEvent.click(screen.getByTestId("document-template-archive-confirm"))
    await waitFor(() => expect(window.location.pathname).toBe("/settings/admin/documents"))
    expect(callsTo(fn, `/document-templates/${RICH}/archive`, "POST")).toHaveLength(1)
  })

  it("shows an archive refusal inline and stays on the page", async () => {
    mockFetch((url, init) =>
      url.endsWith(`/document-templates/${RICH}/archive`) && init?.method === "POST"
        ? json({ error: { code: "forbidden", message: "Only admins can archive" } }, 403)
        : undefined,
    )
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    fireEvent.click(await screen.findByTestId("document-template-archive"))
    fireEvent.click(screen.getByTestId("document-template-archive-confirm"))
    expect((await screen.findByTestId("document-template-details-error")).textContent).toBe(
      "Only admins can archive",
    )
    expect(window.location.pathname).toBe(`/settings/admin/documents/${RICH}`)
  })
})

describe("a PDF form template's Fields & mapping tab", () => {
  it("saves a mapping and round-trips it", async () => {
    const fn = mockFetch((url, init) => {
      if (url.endsWith(`/document-templates/${FORM}`) && init?.method === "PATCH") {
        const sent = JSON.parse(String(init.body)) as { mapping: Record<string, unknown> }
        return json({ data: { ...formTemplate(), mapping: sent.mapping } })
      }
      return undefined
    })
    renderAt(`/settings/admin/documents/${FORM}`, DocumentTemplateDetail)
    const source = await screen.findByTestId("documents-mapping-tracking-source")
    fireEvent.change(source, { target: { value: "path" } })
    fireEvent.change(await screen.findByTestId("documents-mapping-tracking-path"), {
      target: { value: "tracking_number" },
    })
    fireEvent.input(screen.getByTestId("documents-mapping-tracking-placeholder"), {
      target: { value: "Tracking number to fill" },
    })
    fireEvent.click(screen.getByTestId("documents-mapping-save"))
    await screen.findByTestId("documents-mapping-saved")
    const [, init] = callsTo(fn, `/document-templates/${FORM}`, "PATCH")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      mapping: {
        order_no: { path: "order.name" },
        tracking: { path: "tracking_number", placeholder: "Tracking number to fill" },
      },
    })
    expect((screen.getByTestId("documents-mapping-tracking-path") as HTMLSelectElement).value).toBe(
      "tracking_number",
    )
  })
})

describe("the Preview tab", () => {
  it("previews the sample and lists the fields that printed blank", async () => {
    const fn = mockFetch((url, init) =>
      url.endsWith(`/document-templates/${RICH}/preview`) && init?.method === "POST"
        ? json({
            data: {
              templateId: RICH,
              filename: "Thank you letter sample.pdf",
              byteSize: 4,
              blanks: [{ field: "tracking", label: "Tracking number", path: "tracking_number" }],
              sample: true,
              pdfBase64: btoa("%PDF"),
            },
          })
        : undefined,
    )
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    fireEvent.click(await screen.findByTestId("document-template-tab-preview"))
    fireEvent.click(screen.getByTestId("documents-preview-run"))
    const blank = await screen.findByTestId("documents-preview-blank-tracking")
    expect(blank.textContent).toContain("Tracking number")
    expect(screen.getByTestId("documents-preview-sample-note")).toBeInTheDocument()
    const [, init] = callsTo(fn, `/document-templates/${RICH}/preview`, "POST")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({})
  })

  it("previews one record by its id and shows a refusal inline", async () => {
    const fn = mockFetch((url, init) =>
      url.endsWith(`/document-templates/${RICH}/preview`) && init?.method === "POST"
        ? json({ error: { code: "record_not_found", message: "The record was not found" } }, 404)
        : undefined,
    )
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    fireEvent.click(await screen.findByTestId("document-template-tab-preview"))
    fireEvent.click(screen.getByTestId("documents-preview-mode-record"))
    fireEvent.input(screen.getByTestId("documents-preview-record-id"), {
      target: { value: "rec-9" },
    })
    fireEvent.click(screen.getByTestId("documents-preview-run"))
    expect((await screen.findByTestId("documents-preview-error")).textContent).toBe(
      "The record was not found",
    )
    const [, init] = callsTo(fn, `/document-templates/${RICH}/preview`, "POST")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({ recordId: "rec-9" })
  })
})

describe("the Rules tab", () => {
  it("lists the rules that ask for this template and adds one", async () => {
    const rule = {
      id: "44444444-4444-4444-8444-444444444444",
      recordType: "shipping:shipment",
      name: "Plates to the US",
      when: { sku: ["PLATE-1"], countryIso2: ["US"] },
      templateIds: [RICH, FORM],
      note: null,
      enabled: true,
    }
    const other = { ...rule, id: "55555555-5555-4555-8555-555555555555", templateIds: [FORM] }
    const fn = mockFetch((url, init) => {
      if (url.includes("/document-template-rules?recordType=shipping%3Ashipment"))
        return json({ data: [rule, other] })
      if (url.endsWith("/document-template-rules") && init?.method === "POST")
        return json({ data: { ...rule, id: "66666666-6666-4666-8666-666666666666" } }, 201)
      return undefined
    })
    renderAt(`/settings/admin/documents/${RICH}`, DocumentTemplateDetail)
    fireEvent.click(await screen.findByTestId("document-template-tab-rules"))
    const when = await screen.findByTestId(`documents-rule-${rule.id}-when`)
    expect(when.textContent).toBe("SKU is PLATE-1, and going to US")
    expect(screen.queryByTestId(`documents-rule-${other.id}`)).toBeNull()

    fireEvent.click(screen.getByTestId("documents-rules-add"))
    fireEvent.input(screen.getByTestId("documents-rules-new-name"), {
      target: { value: "Steel to Canada" },
    })
    fireEvent.input(screen.getByTestId("documents-rules-new-sku"), {
      target: { value: "A-1, b-2" },
    })
    fireEvent.input(screen.getByTestId("documents-rules-new-countryIso2"), {
      target: { value: "ca" },
    })
    fireEvent.click(screen.getByTestId("documents-rules-new-save"))
    await waitFor(() => expect(callsTo(fn, "/document-template-rules", "POST")).toHaveLength(1))
    const [, init] = callsTo(fn, "/document-template-rules", "POST")[0]!
    expect(JSON.parse(String(init?.body))).toEqual({
      recordType: "shipping:shipment",
      name: "Steel to Canada",
      when: { sku: ["A-1", "b-2"], countryIso2: ["CA"] },
      templateIds: [RICH],
      note: null,
      enabled: true,
    })
  })
})
