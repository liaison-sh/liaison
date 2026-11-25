// SPDX-License-Identifier: FSL-1.1-ALv2
// Attach to invoice on the dated sheet: it lists this project's draft invoices, and picking one
// exports the month's sheet as a PDF and files it on that draft, as the person.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TimesheetData } from "~/modules/projects/TimesheetView"
import { TimesheetView } from "~/modules/projects/TimesheetView"

const tool = vi.hoisted(() => ({ calls: [] as Array<[string, Record<string, unknown>]> }))
const answers = vi.hoisted(() => ({
  sheet: null as unknown,
  drafts: [] as unknown,
  exports: [] as unknown[],
  attach: { status: "completed" } as unknown,
}))
vi.mock("~/lib/run-tool", () => ({
  runTool: vi.fn(async (_api: unknown, name: string, params: Record<string, unknown>) => {
    tool.calls.push([name, params])
    if (name === "projects:timesheet_get") return answers.sheet
    if (name === "invoicing:documents_search") return answers.drafts
    if (name === "invoicing:document_attachment_add") return answers.attach
    return answers.exports.shift()
  }),
}))
vi.mock("~/modules/files/file-service", () => ({
  getDownloadUrl: vi.fn(async () => "about:blank"),
}))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => ({}) }))

const sheet = (over: Partial<TimesheetData> = {}): TimesheetData => ({
  projectId: "p1",
  projectName: "Maison Delorme",
  month: "2026-10",
  period: { from: "2026-10-01", to: "2026-10-31", label: "October 2026" },
  lines: [
    {
      entryId: "e1",
      date: "2026-10-01",
      person: "Ana",
      taskKey: "MD-1",
      task: "Brief",
      minutes: 180,
      hours: "3h",
    },
  ],
  totalMinutes: 180,
  total: "3h",
  coverage: { withEntries: 1, total: 1 },
  partial: false,
  coverageLine: "Real time entered on 1 of 1 tasks of October 2026.",
  note: "Not a legal working-time record, and it reminds nobody of anything.",
  ...over,
})

beforeEach(() => {
  tool.calls = []
  answers.sheet = sheet()
  answers.drafts = [
    { id: "d1", counterparty_name: "Maison Delorme", currency: "EUR", grand_total_minor: "626400" },
  ]
  answers.exports = []
  answers.attach = { status: "completed" }
})

describe("Attach to invoice", () => {
  it("Attach to invoice lists this project's drafts", async () => {
    render(() => <TimesheetView entityId="p1" />)
    await waitFor(() => screen.getByTestId("timesheet-view.attach"))
    const actions = screen.getByTestId("timesheet-view.actions")
    expect(actions.contains(screen.getByTestId("timesheet-view.attach"))).toBe(true)
    fireEvent.click(screen.getByTestId("timesheet-view.attach"))
    await waitFor(() =>
      expect(screen.getAllByTestId("timesheet-view.attach-draft")).toHaveLength(1),
    )
    expect(tool.calls.find(([n]) => n === "invoicing:documents_search")?.[1]).toEqual({
      project_id: "p1",
      type: "invoice",
      status: "draft",
    })
    expect(screen.getByTestId("timesheet-view.attach-draft").textContent).toContain(
      "Maison Delorme",
    )
  })

  it("picking a draft exports the sheet as a PDF and files that file on the draft", async () => {
    answers.exports = [{ fileId: "f1", filename: "sheet.pdf" }]
    render(() => <TimesheetView entityId="p1" />)
    await waitFor(() => screen.getByTestId("timesheet-view.attach"))
    fireEvent.click(screen.getByTestId("timesheet-view.attach"))
    await waitFor(() => screen.getByTestId("timesheet-view.attach-draft"))
    fireEvent.click(screen.getByTestId("timesheet-view.attach-draft"))
    await waitFor(() => screen.getByTestId("timesheet-view.attach-note"))
    expect(tool.calls.find(([n]) => n === "projects:timesheet_export")?.[1]).toMatchObject({
      projectId: "p1",
      month: "2026-10",
      format: "pdf",
    })
    expect(tool.calls.find(([n]) => n === "invoicing:document_attachment_add")?.[1]).toEqual({
      documentId: "d1",
      fileId: "f1",
      kind: "timesheet",
      partial: false,
    })
    expect(screen.getByTestId("timesheet-view.attach-note").textContent).toContain("attached")
  })

  it("a partial sheet asks once, then is filed marked partial", async () => {
    answers.sheet = sheet({ partial: true, coverage: { withEntries: 1, total: 2 } })
    answers.exports = [{ needsConfirm: true }, { fileId: "f2", filename: "sheet.pdf" }]
    render(() => <TimesheetView entityId="p1" />)
    await waitFor(() => screen.getByTestId("timesheet-view.attach"))
    fireEvent.click(screen.getByTestId("timesheet-view.attach"))
    await waitFor(() => screen.getByTestId("timesheet-view.attach-draft"))
    fireEvent.click(screen.getByTestId("timesheet-view.attach-draft"))
    await waitFor(() => screen.getByTestId("timesheet-view.attach-confirm"))
    expect(tool.calls.some(([n]) => n === "invoicing:document_attachment_add")).toBe(false)
    fireEvent.click(screen.getByTestId("timesheet-view.attach-anyway"))
    await waitFor(() => screen.getByTestId("timesheet-view.attach-note"))
    expect(tool.calls.find(([n]) => n === "invoicing:document_attachment_add")?.[1]).toMatchObject({
      fileId: "f2",
      partial: true,
    })
  })

  it("a project with no draft says how to make one and attaches nothing", async () => {
    answers.drafts = []
    render(() => <TimesheetView entityId="p1" />)
    await waitFor(() => screen.getByTestId("timesheet-view.attach"))
    fireEvent.click(screen.getByTestId("timesheet-view.attach"))
    const none = await screen.findByTestId("timesheet-view.attach-none")
    expect(none.textContent).toContain("planned vs done card")
    expect(tool.calls.some(([n]) => n === "projects:timesheet_export")).toBe(false)
  })

  it("a refused attach says why and keeps the drafts to pick from", async () => {
    answers.exports = [{ fileId: "f1", filename: "sheet.pdf" }]
    answers.attach = { status: "error", error: { message: "The invoice was already sent." } }
    render(() => <TimesheetView entityId="p1" />)
    await waitFor(() => screen.getByTestId("timesheet-view.attach"))
    fireEvent.click(screen.getByTestId("timesheet-view.attach"))
    await waitFor(() => screen.getByTestId("timesheet-view.attach-draft"))
    fireEvent.click(screen.getByTestId("timesheet-view.attach-draft"))
    const note = await screen.findByTestId("timesheet-view.attach-note")
    expect(note.textContent).toContain("already sent")
    expect(screen.getByTestId("timesheet-view.attach-draft")).toBeTruthy()
  })
})
