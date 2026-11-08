// SPDX-License-Identifier: FSL-1.1-ALv2
//
// PrintDocuments DOM tests (vitest + jsdom). The host is mocked at the
// `@liaison/host` seam: the control must reach the kernel through it, never a
// raw fetch.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => {
  const fetch = vi.fn()
  // The bound `app` calls as the SDK runs them on a host without the typed calls
  // (in the page): straight to the kernel routes, for the app that bundles this
  // control ("shop" here).
  const app = {
    listDocumentTemplates: (entity: string) =>
      fetch(`/api/documents/templates?app=shop&entity=${encodeURIComponent(entity)}`),
    printDocuments: (r: { entity: string; id: string; templateIds: string[]; merge?: boolean }) =>
      fetch("/api/documents/print", {
        method: "POST",
        body: JSON.stringify({
          app: "shop",
          entity: r.entity,
          recordId: r.id,
          templateIds: r.templateIds,
          ...(r.merge ? { merge: true } : {}),
        }),
      }),
    // Framed or not, as a test sets it; `opened` records what the host was asked to open.
    framed: false,
    opened: [] as Array<[string, string]>,
    openFile: async (fileId: string, name: string) => {
      if (!app.framed) return false
      app.opened.push([fileId, name])
      return true
    },
    opensFiles: () => app.framed,
  }
  return { fetch, app, fetchBlob: vi.fn(), openFile: vi.fn(), hostLocale: vi.fn(() => "en") }
})
vi.mock("@liaison/host", () => host)

import { PrintDocuments } from "./print-documents"

const T1 = "11111111-1111-4111-8111-111111111111"
const T2 = "22222222-2222-4222-8222-222222222222"
const TEMPLATES = [
  { id: T1, name: "Commercial invoice", kind: "pdf_form", enabled: true },
  { id: T2, name: "Packing list", kind: "rich_text", enabled: true },
]

function stubTemplates(list: unknown[] = TEMPLATES): void {
  host.fetch.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/documents/templates")) return list
    throw new Error(`unexpected ${path}`)
  })
}

async function openPanel(): Promise<void> {
  await open()
}

async function open(): Promise<void> {
  fireEvent.click(screen.getByTestId("print-documents-toggle"))
  await waitFor(() => expect(host.fetch).toHaveBeenCalled())
}

function printBody(): Record<string, unknown> {
  const call = host.fetch.mock.calls.find((c) => c[0] === "/api/documents/print")
  const body: unknown = (call?.[1] as RequestInit | undefined)?.body
  if (typeof body !== "string") throw new Error("print was not called with a JSON body")
  return JSON.parse(body)
}

beforeEach(() => {
  host.fetch.mockReset()
  host.fetchBlob.mockReset()
  host.openFile.mockReset()
  host.openFile.mockResolvedValue(true)
  host.fetchBlob.mockResolvedValue(new Blob(["x"], { type: "application/pdf" }))
  host.hostLocale.mockReturnValue("en")
})
afterEach(() => vi.restoreAllMocks())

describe("PrintDocuments", () => {
  it("lists the templates of the record type through host.fetch", async () => {
    stubTemplates()
    render(() => <PrintDocuments app="shop" entity="shipment" recordId="rec-1" />)
    await open()
    expect(host.fetch).toHaveBeenCalledWith("/api/documents/templates?app=shop&entity=shipment")
    expect(await screen.findByTestId(`print-documents-row-${T1}`)).toBeTruthy()
    expect(screen.getByTestId(`print-documents-row-${T2}`)).toBeTruthy()
    expect(screen.queryByTestId("print-documents-modal")).toBeNull()
  })

  it("pre-ticks and badges the needed templates only", async () => {
    stubTemplates()
    render(() => (
      <PrintDocuments app="shop" entity="shipment" recordId="rec-1" neededTemplateIds={[T1]} />
    ))
    await open()
    const needed = (await screen.findByTestId(`print-documents-check-${T1}`)) as HTMLInputElement
    const other = screen.getByTestId(`print-documents-check-${T2}`) as HTMLInputElement
    expect(needed.checked).toBe(true)
    expect(other.checked).toBe(false)
    expect(screen.getByTestId(`print-documents-needed-${T1}`)).toBeTruthy()
    expect(screen.queryByTestId(`print-documents-needed-${T2}`)).toBeNull()
  })

  it("prints the ticked ids, opens the file and warns about blanks", async () => {
    host.fetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/documents/templates")) return TEMPLATES
      if (path === "/api/documents/print") {
        expect(init?.method).toBe("POST")
        return {
          files: [
            {
              templateId: T1,
              templateName: "Commercial invoice",
              fileId: "file-1",
              filename: "invoice.pdf",
              byteSize: 10,
              blanks: [
                { field: "awb", label: "AWB" },
                { field: "hts", label: "HTS code" },
              ],
            },
          ],
          merged: null,
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    render(() => (
      <PrintDocuments app="shop" entity="shipment" recordId="rec-1" neededTemplateIds={[T1]} />
    ))
    await open()
    await screen.findByTestId(`print-documents-row-${T1}`)
    fireEvent.click(screen.getByTestId("print-documents-print"))
    const warn = await screen.findByTestId("print-documents-blanks")
    expect(warn.textContent).toContain("These fields were empty and print as blanks")
    expect(warn.textContent).toContain("AWB")
    expect(warn.textContent).toContain("HTS code")
    expect(printBody()).toEqual({
      app: "shop",
      entity: "shipment",
      recordId: "rec-1",
      templateIds: [T1],
    })
    await waitFor(() => expect(host.openFile).toHaveBeenCalled())
    expect(host.fetchBlob).toHaveBeenCalledWith("/api/files/file-1/inline")
  })

  it("offers the one-PDF option only with two or more ticked", async () => {
    stubTemplates()
    render(() => <PrintDocuments app="shop" entity="shipment" recordId="rec-1" />)
    await open()
    await screen.findByTestId(`print-documents-row-${T1}`)
    fireEvent.click(screen.getByTestId(`print-documents-check-${T1}`))
    expect(screen.queryByTestId("print-documents-print-merged")).toBeNull()
    fireEvent.click(screen.getByTestId(`print-documents-check-${T2}`))
    expect(screen.getByTestId("print-documents-print-merged")).toBeTruthy()
  })

  it("sends merge:true and opens the merged file", async () => {
    host.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/documents/templates")) return TEMPLATES
      return {
        files: [
          {
            templateId: T1,
            templateName: "A",
            fileId: "f1",
            filename: "a.pdf",
            byteSize: 1,
            blanks: [],
          },
          {
            templateId: T2,
            templateName: "B",
            fileId: "f2",
            filename: "b.pdf",
            byteSize: 1,
            blanks: [],
          },
        ],
        merged: { fileId: "fm", filename: "all.pdf", byteSize: 2, pageCount: 2 },
      }
    })
    render(() => (
      <PrintDocuments app="shop" entity="shipment" recordId="rec-1" neededTemplateIds={[T1, T2]} />
    ))
    await open()
    await screen.findByTestId(`print-documents-row-${T1}`)
    fireEvent.click(screen.getByTestId("print-documents-print-merged"))
    await waitFor(() => expect(host.fetchBlob).toHaveBeenCalledWith("/api/files/fm/inline"))
    expect(printBody().merge).toBe(true)
    expect(screen.queryByTestId("print-documents-blanks")).toBeNull()
  })

  it("shows a print failure inline", async () => {
    host.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/documents/templates")) return TEMPLATES
      throw new Error("Template is not printable")
    })
    render(() => (
      <PrintDocuments app="shop" entity="shipment" recordId="rec-1" neededTemplateIds={[T1]} />
    ))
    await open()
    await screen.findByTestId(`print-documents-row-${T1}`)
    fireEvent.click(screen.getByTestId("print-documents-print"))
    const err = await screen.findByTestId("print-documents-error")
    expect(err.textContent).toContain("Template is not printable")
  })

  it("shows the empty state when the type has no templates", async () => {
    stubTemplates([])
    render(() => <PrintDocuments app="shop" entity="shipment" recordId="rec-1" />)
    await open()
    const empty = await screen.findByTestId("print-documents-empty")
    expect(empty.textContent).toContain(
      "No templates for this kind of record yet — ask your agent to make one",
    )
    expect(screen.queryByTestId("print-documents-print")).toBeNull()
  })

  it("speaks French and accepts label overrides", async () => {
    host.hostLocale.mockReturnValue("fr")
    stubTemplates([])
    render(() => (
      <PrintDocuments app="shop" entity="shipment" recordId="rec-1" labels={{ title: "Papiers" }} />
    ))
    expect(screen.getByTestId("print-documents-toggle").textContent).toContain("Papiers")
    await open()
    expect((await screen.findByTestId("print-documents-empty")).textContent).toContain(
      "Aucun modèle",
    )
  })
})

describe("PrintDocuments in a frame", () => {
  it("lets the host open the printed file by id: no tab of its own, no bytes fetched", async () => {
    host.app.framed = true
    host.app.opened = []
    const open = vi.spyOn(window, "open")
    host.fetch.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/documents/templates")) return TEMPLATES
      if (path === "/api/documents/print") {
        return {
          files: [{ fileId: "file-1", filename: "invoice.pdf", templateId: T1, blanks: [] }],
          merged: null,
        }
      }
      throw new Error(`unexpected ${path}`)
    })
    try {
      render(() => (
        <PrintDocuments app="shop" entity="shipment" recordId="rec-1" neededTemplateIds={[T1]} />
      ))
      await openPanel()
      await screen.findByTestId(`print-documents-row-${T1}`)
      fireEvent.click(screen.getByTestId("print-documents-print"))
      await waitFor(() => expect(host.app.opened).toEqual([["file-1", "invoice.pdf"]]))
      expect(open).not.toHaveBeenCalled()
      expect(host.fetchBlob).not.toHaveBeenCalled()
    } finally {
      host.app.framed = false
    }
  })
})
