// SPDX-License-Identifier: FSL-1.1-ALv2
// S22/A11: the ticket ID prefixes block of the Tickets settings page. One
// "segment by" select, one code per known value of that field, a live preview,
// and a save through the gated `idSegment.set` tool (never the org PATCH).
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  api: { get: vi.fn(), patch: vi.fn(), post: vi.fn() } as any,
  runTool: vi.fn(),
  stored: { by: "audience", codes: { b2b: "B2B" } } as unknown,
  setResult: {} as unknown,
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
vi.mock("~/lib/run-tool", () => ({ runTool: (...a: unknown[]) => state.runTool(...a) }))

import { TicketsIdSegments } from "./TicketsIdSegments"

const setCalls = () => state.runTool.mock.calls.filter((c) => c[1] === "tickets:idSegment.set")

describe("TicketsIdSegments", () => {
  beforeEach(() => {
    state.stored = { by: "audience", codes: { b2b: "B2B" } }
    state.setResult = { idSegment: {}, reindexed: 0 }
    state.runTool = vi.fn(async (_api: unknown, tool: string) => {
      if (tool === "tickets:idSegment.get") return { idSegment: state.stored, examples: {} }
      if (tool === "tickets:idSegment.set") return state.setResult
      if (tool === "tickets:teams.list") return [{ team: "Paris", openCount: 1, totalCount: 2 }]
      if (tool === "tickets:categories.list") return [{ id: "c1", name: "Livraison" }]
      if (tool === "tickets:inboxes.list") return [{ id: "i1", name: "Support FR" }]
      return []
    })
  })

  it("hydrates the stored setting from idSegment.get and previews the id", async () => {
    render(() => <TicketsIdSegments />)
    const select = (await screen.findByTestId("tickets-id-segment-by")) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe("audience"))
    expect((screen.getByTestId("tickets-id-segment-code-b2b") as HTMLInputElement).value).toBe(
      "B2B",
    )
    expect((screen.getByTestId("tickets-id-segment-code-b2c") as HTMLInputElement).value).toBe("")
    expect(screen.getByTestId("tickets-id-segment-preview").textContent).toContain("ticket-B2B-123")
    expect(state.api.get).not.toHaveBeenCalled()
  })

  it("the preview follows the codes as they are typed, uppercased", async () => {
    state.stored = { by: "none", codes: {} }
    render(() => <TicketsIdSegments />)
    const select = (await screen.findByTestId("tickets-id-segment-by")) as HTMLSelectElement
    expect(screen.getByTestId("tickets-id-segment-preview").textContent).toContain("ticket-123")
    fireEvent.change(select, { target: { value: "audience" } })
    const b2c = (await screen.findByTestId("tickets-id-segment-code-b2c")) as HTMLInputElement
    fireEvent.input(b2c, { target: { value: "b2c" } })
    await waitFor(() =>
      expect(screen.getByTestId("tickets-id-segment-preview").textContent).toContain(
        "ticket-B2C-123",
      ),
    )
    expect(b2c.value).toBe("B2C")
  })

  it("save calls idSegment.set with the whole setting, never PATCH /org", async () => {
    render(() => <TicketsIdSegments />)
    const b2c = (await screen.findByTestId("tickets-id-segment-code-b2c")) as HTMLInputElement
    await waitFor(() =>
      expect((screen.getByTestId("tickets-id-segment-code-b2b") as HTMLInputElement).value).toBe(
        "B2B",
      ),
    )
    fireEvent.input(b2c, { target: { value: "B2C" } })
    fireEvent.click(screen.getByTestId("tickets-id-segment-save"))
    await waitFor(() => expect(setCalls()).toHaveLength(1))
    expect(setCalls()[0][2]).toEqual({ by: "audience", codes: { b2b: "B2B", b2c: "B2C" } })
    expect(await screen.findByTestId("tickets-id-segment-saved")).toBeTruthy()
    expect(state.api.patch).not.toHaveBeenCalled()
  })

  it("a set parked for approval says so instead of Saved", async () => {
    state.setResult = { blocked: { approvalRequestId: "ap-1" } }
    render(() => <TicketsIdSegments />)
    await screen.findByTestId("tickets-id-segment-code-b2b")
    fireEvent.click(screen.getByTestId("tickets-id-segment-save"))
    expect(await screen.findByTestId("tickets-id-segment-pending")).toBeTruthy()
    expect(screen.queryByTestId("tickets-id-segment-saved")).toBeNull()
  })

  it("a duplicate code is refused before any request", async () => {
    render(() => <TicketsIdSegments />)
    const b2c = (await screen.findByTestId("tickets-id-segment-code-b2c")) as HTMLInputElement
    fireEvent.input(b2c, { target: { value: "B2B" } })
    fireEvent.click(screen.getByTestId("tickets-id-segment-save"))
    expect(await screen.findByTestId("tickets-id-segment-error")).toBeTruthy()
    expect(setCalls()).toHaveLength(0)
  })

  it("offers one code per team, category or inbox in use", async () => {
    state.stored = { by: "none", codes: {} }
    render(() => <TicketsIdSegments />)
    const select = (await screen.findByTestId("tickets-id-segment-by")) as HTMLSelectElement
    fireEvent.change(select, { target: { value: "team" } })
    expect(await screen.findByTestId("tickets-id-segment-code-Paris")).toBeTruthy()
    fireEvent.change(select, { target: { value: "category" } })
    expect(await screen.findByTestId("tickets-id-segment-code-c1")).toBeTruthy()
    expect(screen.getByText("Livraison")).toBeTruthy()
    fireEvent.change(select, { target: { value: "inbox" } })
    expect(await screen.findByTestId("tickets-id-segment-code-i1")).toBeTruthy()
    // Switching the field starts from no codes: keys of another field mean nothing here.
    fireEvent.click(screen.getByTestId("tickets-id-segment-save"))
    await waitFor(() => expect(setCalls()).toHaveLength(1))
    expect(setCalls()[0][2]).toEqual({ by: "inbox", codes: {} })
  })
})
