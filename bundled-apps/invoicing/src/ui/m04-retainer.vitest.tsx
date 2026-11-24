// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The retainer terms, rendered: a section of the schedule editor (no screen of its own) with the
// project, the hours included a month, the rate above them and the rollover; a retainer never
// offers "By itself"; a prepaid retainer carries its warning; the save sends the terms the
// schedule tools take; the list says the hours included, never time spent.
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const updates: Array<Record<string, unknown>> = []
let stored: Record<string, unknown> = {}
/** What the server adds to a save: to its answer, and to the row it then lists. */
let server: { answer?: Record<string, unknown>; row?: Record<string, unknown> } = {}
const [LINE, LINE_EDITED] = ["Monthly retainer, {period}", "design"]
const PROJECT = "44444444-4444-4444-8444-444444444444"

const row = (over: Record<string, unknown> = {}) => ({
  id: "sched-1",
  issuer_profile_id: "issuer-1",
  contact_id: "contact-1",
  status: "active",
  repeats: "month",
  billing_day: "last",
  covers: "period_ended",
  issue_mode: "review",
  paid_by: "transfer",
  due_rule: "days_30",
  language: "en",
  lines: [{ description: LINE, qty: 1, unit_price_minor: 450000, vat_bp: 2000 }],
  next_issue_on: "2026-11-30",
  next_draft_on: "2026-11-27",
  retainer_project_id: PROJECT,
  retainer_minutes: 2400,
  retainer_overage_rate_minor: 12000,
  retainer_rollover: "none",
  version: 1,
  ...over,
})

vi.mock("@liaison/host", () => ({
  hostLocale: () => "en",
  navigate: () => {},
  onEntityChange: () => () => {},
  fetch: async (path: string) =>
    path.startsWith("/api/projects")
      ? { items: [{ id: PROJECT, name: "Maison Sorel retainer" }], nextCursor: null }
      : { id: "contact-1", name: "Claire Vidal", company: "Maison Sorel", email: null },
  app: {
    createResource,
    tabLabel: () => {},
    invokeTool: async (tool: string, params: Record<string, unknown>) => {
      if (tool === "recurring_list")
        return { rows: [structuredClone(stored)], nextCursor: null, nextRun: null }
      if (tool === "settings_issuer_profile_list")
        return { items: [{ id: "issuer-1", legal_name: "Maison Nord SARL", country: "FR" }] }
      if (tool === "recurring_schedule_update") {
        updates.push(params)
        stored = { ...stored, ...params, ...server.row, version: Number(stored.version) + 1 }
        return { status: "completed", id: "sched-1", version: stored.version, ...server.answer }
      }
      throw new Error(`unexpected tool ${tool}`)
    },
  },
}))

const { ScheduleEditor, draftFromRow, retainerListLine } = await import("./ScheduleEditor")

beforeEach(() => {
  stored = row()
  server = {}
  updates.length = 0
})
afterEach(() => cleanup())

const open = () =>
  render(() => <ScheduleEditor initial={draftFromRow("sched-1", structuredClone(stored))} />)

describe("retainer terms in the schedule editor", () => {
  it("the retainer terms are a section of the schedule editor", async () => {
    open()
    const editor = screen.getByTestId("schedule-editor")
    const section = screen.getByTestId("schedule-retainer")
    expect(editor.contains(section)).toBe(true)
    expect((screen.getByTestId("schedule-retainer-on") as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId("schedule-retainer-hours") as HTMLInputElement).value).toBe("40")
    expect((screen.getByTestId("schedule-retainer-rate") as HTMLInputElement).value).toBe("120")
    await waitFor(() =>
      expect((screen.getByTestId("schedule-retainer-project") as HTMLSelectElement).value).toBe(
        PROJECT,
      ),
    )
  })

  it("a retainer never offers issuing by itself", () => {
    open()
    expect(screen.queryByTestId("schedule-mode-auto")).toBeNull()
    expect(screen.getByTestId("schedule-mode-review")).toBeTruthy()
  })

  it("a prepaid retainer shows its warning", () => {
    stored = row({ covers: "period_ahead" })
    open()
    expect(screen.getByTestId("schedule-retainer-prepaid").textContent).toContain("accountant")
  })

  it("a period-ended retainer shows no prepaid warning", () => {
    open()
    expect(screen.queryByTestId("schedule-retainer-prepaid")).toBeNull()
  })

  it("saving changed hours sends the included minutes the schedule tools take", async () => {
    open()
    fireEvent.input(screen.getByTestId("schedule-retainer-hours"), { target: { value: "45" } })
    fireEvent.click(screen.getByTestId("schedule-save"))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toMatchObject({ id: "sched-1", retainer_minutes: 2700 })
    expect(updates[0]).not.toHaveProperty("lines")
  })

  it("a renewed retainer shows its month's terms and the renewal, and a line's text keeps the fee", async () => {
    stored = row({
      retainer_minutes: 2640,
      lines: [{ description: LINE, qty: 1, unit_price_minor: 495000, vat_bp: 2000 }],
      retainer_terms_month: "2026-12",
      retainer_terms: [
        {
          from: "2026-12",
          retainer_minutes: 2640,
          retainer_overage_rate_minor: "12500",
          lines: [],
          agreement_id: "agreement-1",
          agreement_number: "AG-2026-017",
        },
      ],
    })
    open()
    const terms = screen.getByTestId("schedule-retainer-terms").textContent
    expect(terms).toContain("Renewed by AG-2026-017 from December 2026")
    expect(terms).toContain("are those of December 2026")
    fireEvent.input(
      screen.getByTestId("schedule-line-0").querySelector("input") as HTMLInputElement,
      {
        target: { value: LINE_EDITED },
      },
    )
    fireEvent.click(screen.getByTestId("schedule-save"))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toMatchObject({
      terms_month: "2026-12",
      lines: [{ description: LINE_EDITED, unit_price_minor: 495000 }],
    })
  })

  it("turning the retainer off clears its terms", async () => {
    open()
    fireEvent.click(screen.getByTestId("schedule-retainer-on"))
    expect(screen.queryByTestId("schedule-retainer-hours")).toBeNull()
    fireEvent.click(screen.getByTestId("schedule-save"))
    await waitFor(() => expect(updates).toHaveLength(1))
    expect(updates[0]).toMatchObject({
      retainer_minutes: null,
      retainer_project_id: null,
      retainer_overage_rate_minor: null,
    })
  })

  it("turned off, it says the last retainer month, the run's first one and a signed renewal dropped", async () => {
    server = {
      answer: {
        retainerOff: {
          last_month: "2026-12",
          run_from: "2027-01",
          dropped: [{ agreement_number: "AG-2026-017", from: "2027-03" }],
        },
      },
      row: { retainer_until: "2026-12", retainer_run_from: "2027-01" },
    }
    open()
    expect(screen.queryByTestId("schedule-retainer-off")).toBeNull()
    fireEvent.click(screen.getByTestId("schedule-retainer-on"))
    fireEvent.click(screen.getByTestId("schedule-save"))
    const off =
      "December 2026 is the last retainer month: it and any earlier month not invoiced yet are billed from the project's card. The month-end run bills from January 2027."
    await waitFor(() =>
      expect(screen.getByTestId("schedule-note").textContent).toBe(
        `Saved. ${off} AG-2026-017, signed from March 2027, no longer applies.`,
      ),
    )
    // The version it was read at goes with it, and the page keeps saying it.
    expect(updates[0]).toMatchObject({ expected_version: 1 })
    expect(screen.getByTestId("schedule-retainer-off").textContent).toBe(off)
  })

  it("a draft retainer names no month: a change there applies at once", () => {
    stored = row({ status: "draft" })
    open()
    expect(screen.queryByTestId("schedule-retainer-terms")).toBeNull()
  })

  it("a plain schedule shows the section switched off", () => {
    stored = row({ retainer_minutes: null, retainer_project_id: null })
    open()
    expect((screen.getByTestId("schedule-retainer-on") as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByTestId("schedule-retainer-hours")).toBeNull()
  })

  it("the list says the hours included a month, and nothing on a plain schedule", () => {
    expect(retainerListLine(row())).toBe("Retainer, 40 h included a month")
    expect(retainerListLine(row({ retainer_minutes: null }))).toBeNull()
  })
})
