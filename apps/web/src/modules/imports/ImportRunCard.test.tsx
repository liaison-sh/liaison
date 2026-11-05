// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))

import { ApiError } from "~/lib/api-error"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import ImportRunCard from "./ImportRunCard"
import { type ImportRun, importRunStore, resetImportRunStore } from "./import-run-store"

let seq = 0
function run(over: Partial<ImportRun> = {}): ImportRun {
  seq += 1
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    kindSet: ["tickets.category", "tickets.ticket"],
    sourceLabel: "jira",
    status: "running",
    dryRun: false,
    counts: {
      "tickets.category": { created: 2, skipped: 0, failed: 0 },
      "tickets.ticket": { created: 40, skipped: 3, failed: 1 },
    },
    errors: [
      {
        kind: "tickets.ticket",
        error: "invalid record: /subject: must NOT have fewer than 1 characters",
        at: "page 2, record 4 emitted",
      },
    ],
    report: {},
    createdAt: "2026-10-26T10:00:00Z",
    finishedAt: null,
    ...over,
  }
}

function mount(props: { runId?: string; approvalRequestId?: string }) {
  return render(() => (
    <I18nProvider>
      <ImportRunCard {...props} />
    </I18nProvider>
  ))
}

describe("ImportRunCard", () => {
  beforeEach(() => {
    for (const fn of Object.values(apiMocks)) fn.mockReset()
    resetImportRunStore()
  })

  it("shows the status, the counts per kind and the refused records of a running import, without Undo", async () => {
    const r = run()
    apiMocks.get.mockResolvedValue(r)
    mount({ runId: r.id })
    expect(await screen.findByTestId(`import-run-card-${r.id}`)).toBeInTheDocument()
    expect(screen.getByTestId("import-run-card-status")).toHaveTextContent("Running")
    expect(screen.getByTestId("import-run-card-kind-tickets.ticket")).toHaveTextContent("40")
    expect(screen.getByTestId("import-run-card-kind-tickets.ticket")).toHaveTextContent("1")
    expect(screen.getByTestId("import-run-card-errors")).toHaveTextContent("page 2, record 4")
    expect(screen.queryByTestId("import-run-card-undo")).toBeNull()
  })

  it("follows the run live: an import_run event re-reads it, and a finished run offers Undo", async () => {
    const r = run()
    apiMocks.get.mockResolvedValueOnce(r)
    mount({ runId: r.id })
    await screen.findByTestId(`import-run-card-${r.id}`)
    apiMocks.get.mockResolvedValueOnce({ ...r, status: "done", report: { attachmentsMissing: 2 } })
    importRunStore.handleEvent(apiMocks as never, { id: r.id, status: "done" })
    await waitFor(() =>
      expect(screen.getByTestId("import-run-card-status")).toHaveTextContent("Done"),
    )
    expect(screen.getByTestId("import-run-card-report")).toHaveTextContent("2")
    // Undo, then the card shows what it did.
    apiMocks.post.mockResolvedValueOnce({
      deleted: 46,
      refused: [{ table: "app_tickets.tickets", id: "x", reason: "has_new_children" }],
    })
    apiMocks.get.mockResolvedValueOnce({
      ...r,
      status: "undone",
      report: { undo: { deleted: 46, refused: [{}] } },
    })
    fireEvent.click(screen.getByTestId("import-run-card-undo"))
    // Undo asks first: nothing is sent until the person confirms.
    expect(apiMocks.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("import-run-card-undo-confirm"))
    await waitFor(() =>
      expect(screen.getByTestId("import-run-card-status")).toHaveTextContent("Undone"),
    )
    expect(apiMocks.post).toHaveBeenCalledWith(`/imports/${r.id}/undo`, undefined, {
      suppressGlobalError: true,
    })
    expect(screen.getByTestId("import-run-card-undo-result")).toHaveTextContent("46")
  })

  it("under an approval, shows nothing until the approved run exists, then the run", async () => {
    const r = run({ status: "queued" })
    apiMocks.get.mockResolvedValueOnce([])
    mount({ approvalRequestId: "11111111-1111-4111-8111-111111111111" })
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalled())
    expect(apiMocks.get.mock.calls[0]?.[0]).toBe(
      "/imports?approvalRequestId=11111111-1111-4111-8111-111111111111",
    )
    expect(screen.queryByTestId(`import-run-card-${r.id}`)).toBeNull()
    apiMocks.get.mockResolvedValueOnce([r])
    importRunStore.handleEvent(apiMocks as never, { id: r.id, status: "queued" })
    expect(await screen.findByTestId(`import-run-card-${r.id}`)).toBeInTheDocument()
  })

  it("a final event that lands while a read is on its way still ends on the final status, with Undo", async () => {
    const r = run()
    apiMocks.get.mockResolvedValueOnce(r)
    mount({ runId: r.id })
    await screen.findByTestId(`import-run-card-${r.id}`)
    // A progress event starts a read the server answers late, with "running".
    let answerStale: (row: ImportRun) => void = () => undefined
    apiMocks.get.mockImplementationOnce(
      () => new Promise<ImportRun>((resolve) => (answerStale = resolve)),
    )
    importRunStore.handleEvent(apiMocks as never, { id: r.id, status: "running" })
    // The run finishes while that read is pending.
    apiMocks.get.mockResolvedValueOnce({ ...r, status: "done" })
    importRunStore.handleEvent(apiMocks as never, { id: r.id, status: "done" })
    answerStale({ ...r, status: "running" })
    await waitFor(() =>
      expect(screen.getByTestId("import-run-card-status")).toHaveTextContent("Done"),
    )
    expect(screen.getByTestId("import-run-card-undo")).toBeInTheDocument()
    expect(apiMocks.get).toHaveBeenCalledTimes(3)
  })

  it("Undo can be cancelled, and a refusal reads as a translated sentence, not the server's text", async () => {
    const r = run({ status: "done" })
    apiMocks.get.mockResolvedValueOnce(r)
    mount({ runId: r.id })
    await screen.findByTestId(`import-run-card-${r.id}`)
    fireEvent.click(screen.getByTestId("import-run-card-undo"))
    fireEvent.click(screen.getByTestId("import-run-card-undo-cancel"))
    expect(screen.queryByTestId("import-run-card-undo-confirm")).toBeNull()
    expect(apiMocks.post).not.toHaveBeenCalled()

    apiMocks.post.mockRejectedValueOnce(
      new ApiError("run 1234 is being undone by another request", 409, "locked"),
    )
    fireEvent.click(screen.getByTestId("import-run-card-undo"))
    fireEvent.click(screen.getByTestId("import-run-card-undo-confirm"))
    const error = await screen.findByTestId("import-run-card-error")
    expect(error).toHaveTextContent("already being undone")
    expect(error).not.toHaveTextContent("run 1234")
  })

  it("Undo of an import that was already undone says so, never that it hasn't finished", async () => {
    const r = run({ status: "done" })
    apiMocks.get.mockResolvedValueOnce(r)
    mount({ runId: r.id })
    await screen.findByTestId(`import-run-card-${r.id}`)
    apiMocks.post.mockRejectedValueOnce(
      new ApiError("this import was already undone", 409, "already_undone"),
    )
    fireEvent.click(screen.getByTestId("import-run-card-undo"))
    fireEvent.click(screen.getByTestId("import-run-card-undo-confirm"))
    const error = await screen.findByTestId("import-run-card-error")
    expect(error).toHaveTextContent("This import was already undone: nothing is left to undo.")
  })
})
