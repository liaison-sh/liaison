// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The drill panel's rows fit its width: the open action is an icon (named for readers), a date
// column holds its width while text columns wrap, and the rows scroll sideways inside their own
// box when a row is still wider, never the page.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BlockDrillPanel } from "./BlockDrillPanel"
import type { BlockRowsResult } from "./dashboards-client"

afterEach(cleanup)

const PAGE: BlockRowsResult = {
  ok: true,
  page: {
    columns: [
      { field: "title", label: "Title" },
      { field: "status", label: "Status" },
      { field: "assigneeName", label: "Handler" },
      { field: "dueDate", label: "Due", format: "date" },
    ],
    fields: ["title", "status", "assigneeName", "dueDate"],
    rows: [
      {
        title: "Unit SN125 no sound",
        status: "Needs replacement",
        assigneeName: "Tobias Braun",
        dueDate: "2026-11-20",
      },
    ],
    links: [{ kind: "entity", app: "projects", entityType: "task", id: "t-1" }],
    total: 1,
    offset: 0,
    limit: 50,
    nextOffset: null,
    truncated: false,
  },
}

describe("the drill panel's rows", () => {
  it("open a row from an icon named Open, every column on screen", async () => {
    render(() => (
      <BlockDrillPanel
        blockId="b1"
        blockTitle="Pipeline by Status"
        target={{ category: "Received" }}
        load={async () => PAGE}
        open={vi.fn()}
        onClose={vi.fn()}
        locale="en"
      />
    ))
    const open = await waitFor(() => screen.getByTestId("dashboard-drill-open-0"))
    expect(open.getAttribute("aria-label")).toBeTruthy()
    expect(open.textContent?.trim()).toBe("")
    const row = screen.getByTestId("dashboard-drill-row-0")
    expect(row.textContent).toContain("Tobias Braun")
    // The date holds its width (no wrap); the text columns may wrap.
    const cells = row.querySelectorAll("td")
    expect(cells[3]?.className).toContain("whitespace-nowrap")
    expect(cells[2]?.className).not.toContain("whitespace-nowrap")
    expect(screen.getByTestId("dashboard-drill-rows").className).toContain("overflow-x-auto")
  })
})
