// SPDX-License-Identifier: FSL-1.1-ALv2
// The Notion import tab, state by state: no permission (a sentence, not a
// broken button), a file refused before upload, a refusal of the server read as
// a reason, the preview with "Only me" first and another choice checked again,
// the run followed to its report, a report that never says "everything came
// across" while an item is only counted, a reopened tab back on its run, and
// Undo saying what it kept and why. English and French, desktop and phone.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { resetImportRunStore } from "~/modules/imports/import-run-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { setShellTier } from "~/tests/helpers/shell-tier"
import KnowledgeImportView, { resetKnowledgeImport } from "./KnowledgeImportView"
import { resetKnowledgeStore } from "./knowledge-store"

const auth = vi.hoisted(() => ({ scopes: new Set<string>() }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/auth/auth-store")>()),
  hasScope: (s: string) => auth.scopes.has(s),
  userFromToken: () => ({ userId: "amina", orgId: "o1", name: "Amina Cherif", scopes: [] }),
}))

const upload = vi.hoisted(() => ({ calls: 0 }))
vi.mock("~/modules/imports/upload-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/imports/upload-client")>()),
  uploadImportFile: async (
    _api: unknown,
    _file: File,
    opts?: { onProgress?: (f: number) => void },
  ) => {
    upload.calls++
    opts?.onProgress?.(1)
    return "file-1"
  },
}))

const ALL = ["kernel:imports:run", "kernel:imports:read", "kernel:imports:undo"]
const zip = () => new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])], "Export.zip")

interface Run {
  id: string
  kindSet: string[]
  sourceLabel: string
  status: string
  dryRun: boolean
  counts: Record<string, { created: number; skipped: number; failed: number }>
  errors: Array<Record<string, unknown>>
  report: Record<string, unknown>
  createdAt: string
  finishedAt: string | null
  startedBy: string
}

const run = (over: Partial<Run> = {}): Run => ({
  id: "run-1",
  kindSet: ["knowledge.collection", "knowledge.document"],
  sourceLabel: "builtin:notion:u:amina",
  status: "done",
  dryRun: false,
  counts: {
    "knowledge.collection": { created: 3, skipped: 0, failed: 0 },
    "knowledge.document": { created: 8, skipped: 0, failed: 0 },
  },
  errors: [],
  report: { filesCopied: 2, linksResolved: 5 },
  createdAt: "2026-11-25T10:00:00Z",
  finishedAt: "2026-11-25T10:01:00Z",
  startedBy: "amina",
  ...over,
})

const preview = (over: Record<string, unknown> = {}) => ({
  previewId: "pv-1",
  counts: {
    "knowledge.collection": { created: 3, skipped: 0, failed: 0 },
    "knowledge.document": { created: 8, skipped: 0, failed: 0 },
  },
  errorRate: 0,
  errors: [],
  named: {
    losses: [
      { what: "web image (https://images.example.com/skyline.png)", where: "Onboarding" },
      { what: "link to a page not in the export (Old pricing)", where: "Policies" },
    ],
    lossesNotListed: 0,
    missingFiles: [],
    attachmentsMissing: 0,
    filesToCopy: 2,
    entries: { markdown: 8, csv: 2, html: 0, other: 2 },
  },
  ...over,
})

function makeApi(
  opts: { runs?: Run[]; preview?: unknown; previewError?: unknown; afterStart?: Run } = {},
) {
  let current: Run | undefined = opts.runs?.[0]
  const api = {
    get: vi.fn(async (path: string) => {
      if (path === "/imports") return opts.runs ?? []
      if (path.startsWith("/imports/")) return current ?? opts.afterStart
      if (path === "/knowledge/documents/d-kept") return { id: "d-kept", title: "Visit checklist" }
      if (path.startsWith("/knowledge/documents/")) throw new ApiError("Not found", 404)
      if (path === "/knowledge/collections/tree") return []
      return {}
    }),
    post: vi.fn(async (path: string, body?: { params?: { access?: string } }) => {
      if (path === "/imports/previews") {
        if (opts.previewError) throw opts.previewError
        return opts.preview ?? preview()
      }
      if (path === "/imports/previews/pv-1/start") {
        current = opts.afterStart ?? run()
        return { runId: current.id, status: "queued" }
      }
      if (path.endsWith("/undo")) {
        current = { ...(current ?? run()), status: "undone" }
        return {
          deleted: 9,
          refused: [
            { table: "app_knowledge.documents", id: "d-kept", reason: "changed_after_import" },
            { table: "kernel.files", id: "f1", reason: "still_referenced" },
          ],
        }
      }
      return body
    }),
    getEnvelope: vi.fn(async () => ({ data: [] })),
  }
  return api
}

function renderView(api: ReturnType<typeof makeApi>, locale: "en" | "fr" = "en") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api as never}>
        <KnowledgeImportView entityId="import" />
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

async function choose(file: File) {
  fireEvent.change(screen.getByTestId("knowledge-import-file"), { target: { files: [file] } })
}

beforeEach(() => {
  auth.scopes = new Set(ALL)
  upload.calls = 0
})

afterEach(() => {
  resetKnowledgeImport()
  resetImportRunStore()
  resetKnowledgeStore()
  setShellTier("desktop")
  localStorage.clear()
})

describe("who may import", () => {
  it("without the Imports permission: a sentence saying who to ask, no file picker", () => {
    auth.scopes = new Set()
    renderView(makeApi())
    expect(screen.getByTestId("knowledge-import-no-scope").textContent).toContain(
      "Ask an administrator",
    )
    expect(screen.queryByTestId("knowledge-import-choose")).toBeNull()
  })
})

describe("refusals are readable", () => {
  it("a PDF is refused before any upload", async () => {
    renderView(makeApi())
    await choose(new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "Export.pdf"))
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-import-refusal").textContent).toContain("PDF"),
    )
    expect(upload.calls).toBe(0)
  })

  it("a password zip: the server's reason, in words", async () => {
    const err = new ApiError("English", 400, "invalid_source", undefined, {
      reason: "zip_encrypted",
    })
    renderView(makeApi({ previewError: err }))
    await choose(zip())
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-import-refusal").textContent).toContain("password"),
    )
  })

  it("a zip bomb, in French", async () => {
    const err = new ApiError("English", 400, "invalid_source", undefined, {
      reason: "zip_ratio_exceeded",
    })
    renderView(makeApi({ previewError: err }), "fr")
    await choose(zip())
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-import-refusal").getAttribute("data-reason")).toBe(
        "zipBomb",
      ),
    )
    expect(screen.getByTestId("knowledge-import-refusal").textContent).not.toContain("expands")
  })

  it("an HTML export is told to export again as Markdown", async () => {
    const none = { "knowledge.document": { created: 0, skipped: 0, failed: 0 } }
    const html = preview({
      counts: none,
      named: {
        ...preview().named,
        losses: [],
        entries: { markdown: 0, csv: 0, html: 9, other: 1 },
      },
    })
    renderView(makeApi({ preview: html }))
    await choose(zip())
    await waitFor(() =>
      expect(screen.getByTestId("knowledge-import-refusal").textContent).toContain(
        "Markdown & CSV",
      ),
    )
  })
})

describe("preview", () => {
  it("counts, named losses, Only me first; another choice is checked again", async () => {
    const api = makeApi()
    renderView(api)
    await choose(zip())
    await waitFor(() => screen.getByTestId("knowledge-import-preview"))
    expect(screen.getByTestId("knowledge-import-count-pages").textContent).toContain("8")
    expect(screen.getByTestId("knowledge-import-count-folders").textContent).toContain("3")
    expect(screen.getByTestId("knowledge-import-count-files").textContent).toContain("2")
    const losses = screen.getByTestId("knowledge-import-preview-losses")
    expect(losses.textContent).toContain("https://images.example.com/skyline.png")
    expect(losses.textContent).toContain("Old pricing")
    expect(
      (screen.getByTestId("knowledge-import-access-private") as HTMLInputElement).checked,
    ).toBe(true)
    expect(screen.getByTestId("knowledge-import-access").textContent).toContain("their folders")
    expect(api.post.mock.calls[0]?.[1]).toMatchObject({
      builtin: "notion-export",
      params: { access: "private" },
    })

    fireEvent.click(screen.getByTestId("knowledge-import-access-edit"))
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2))
    expect(api.post.mock.calls[1]?.[1]).toMatchObject({ params: { access: "edit" } })
    expect(screen.getByTestId("knowledge-import-start").textContent).toContain("Import 8 pages")
  })
})

describe("import and report", () => {
  it("starts, follows the run and shows what it made and what did not come across", async () => {
    const done = run({
      report: {
        filesCopied: 2,
        linksResolved: 5,
        losses: [{ what: "embed (https://v.example/1)", where: "Launch" }],
      },
    })
    renderView(makeApi({ afterStart: done }))
    await choose(zip())
    await waitFor(() => screen.getByTestId("knowledge-import-preview"))
    fireEvent.click(screen.getByTestId("knowledge-import-start"))
    await waitFor(() => screen.getByTestId("knowledge-import-report"))
    expect(screen.getByTestId("knowledge-import-made-pages").textContent).toContain("8")
    expect(screen.getByTestId("knowledge-import-report-losses").textContent).toContain("Launch")
    expect(screen.queryByTestId("knowledge-import-everything")).toBeNull()
  })

  it("done is never shown with hidden losses: items only counted are said", async () => {
    renderView(makeApi({ runs: [run({ report: { losses: [], lossesNotListed: 3 } })] }))
    await waitFor(() => screen.getByTestId("knowledge-import-report"))
    expect(screen.queryByTestId("knowledge-import-everything")).toBeNull()
    expect(screen.getByTestId("knowledge-import-lost-count").textContent).toContain("3")
    expect(screen.getByTestId("knowledge-import-report-losses-not-listed").textContent).toContain(
      "3",
    )
  })

  it("files the runner could not read and failed records count too", async () => {
    renderView(
      makeApi({
        runs: [
          run({
            counts: { "knowledge.document": { created: 4, skipped: 0, failed: 1 } },
            report: { attachmentsMissing: 2, missingFiles: [] },
          }),
        ],
      }),
    )
    await waitFor(() => screen.getByTestId("knowledge-import-report"))
    expect(screen.queryByTestId("knowledge-import-everything")).toBeNull()
    expect(screen.getByTestId("knowledge-import-lost-count").textContent).toContain("3")
  })

  it("a clean run says everything came across", async () => {
    renderView(makeApi({ runs: [run()] }))
    await waitFor(() => screen.getByTestId("knowledge-import-everything"))
  })

  it("a reopened tab is back on the running import", async () => {
    renderView(makeApi({ runs: [run({ status: "running" })] }))
    await waitFor(() => screen.getByTestId("knowledge-import-progress"))
    expect(screen.getByTestId("knowledge-import-progress").textContent).toContain("close this tab")
  })

  it("a report put away is not shown again", async () => {
    localStorage.setItem("liaison:knowledge-notion-import:dismissed:amina", "run-1")
    renderView(makeApi({ runs: [run()] }))
    await new Promise((r) => setTimeout(r, 50))
    expect(screen.getByTestId("knowledge-import-upload")).toBeTruthy()
  })
})

describe("undo", () => {
  it("asks inline, then says how many went and what was kept, and why", async () => {
    renderView(makeApi({ runs: [run()] }))
    await waitFor(() => screen.getByTestId("knowledge-import-undo"))
    fireEvent.click(screen.getByTestId("knowledge-import-undo"))
    expect(screen.getByTestId("knowledge-import-undo-section").textContent).toContain("is kept")
    fireEvent.click(screen.getByTestId("knowledge-import-undo-confirm"))
    await waitFor(() => screen.getByTestId("knowledge-import-undone"))
    expect(screen.getByTestId("knowledge-import-undone").textContent).toContain("9")
    expect(screen.getByTestId("knowledge-import-kept").textContent).toContain(
      "Visit checklist: changed since the import",
    )
    expect(screen.getByTestId("knowledge-import-kept-other").textContent).toContain("1")
  })

  it("without the Undo permission: a sentence instead of the button", async () => {
    auth.scopes = new Set(["kernel:imports:run", "kernel:imports:read"])
    renderView(makeApi({ runs: [run()] }))
    await waitFor(() => screen.getByTestId("knowledge-import-undo-no-scope"))
    expect(screen.queryByTestId("knowledge-import-undo")).toBeNull()
  })
})

describe("phone", () => {
  it("full-width actions with 44 px targets", async () => {
    setShellTier("phone")
    renderView(makeApi())
    await choose(zip())
    await waitFor(() => screen.getByTestId("knowledge-import-preview"))
    expect(screen.getByTestId("knowledge-import-start").className).toContain("min-h-11")
    expect(screen.getByTestId("knowledge-import").className).toContain("px-4")
  })
})
