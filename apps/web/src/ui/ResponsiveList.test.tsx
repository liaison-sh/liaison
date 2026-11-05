// SPDX-License-Identifier: FSL-1.1-ALv2
import { render } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { ResponsiveList } from "~/ui/ResponsiveList"

interface Row {
  id: string
  subject: string
}

const items: Row[] = [
  { id: "1", subject: "First" },
  { id: "2", subject: "Second" },
  { id: "3", subject: "Third" },
]

function renderList() {
  return render(() => (
    <ResponsiveList
      items={items}
      renderRow={(item) => <span>{item.subject}</span>}
      renderCard={(item) => <strong>{item.subject}</strong>}
    />
  ))
}

describe("ResponsiveList", () => {
  it("renders both row and card markup for every item", () => {
    const { container } = renderList()
    expect(container.querySelectorAll('[data-responsive="row"]').length).toBe(3)
    expect(container.querySelectorAll('[data-responsive="card"]').length).toBe(3)
  })

  it("row markup carries the hidden md:table-row classes", () => {
    const { container } = renderList()
    for (const el of container.querySelectorAll('[data-responsive="row"]')) {
      expect(el.className).toContain("hidden")
      expect(el.className).toContain("md:table-row")
    }
  })

  it("card markup carries the md:hidden class", () => {
    const { container } = renderList()
    for (const el of container.querySelectorAll('[data-responsive="card"]')) {
      expect(el.className).toContain("md:hidden")
    }
  })

  it("renders the caller supplied row and card content", () => {
    const { container } = renderList()
    expect(container.querySelector('[data-responsive="row"]')?.textContent).toBe("First")
    expect(container.querySelector('[data-responsive="card"]')?.textContent).toBe("First")
  })

  // F6. At 820px `md:table-row` made each row an anonymous table cell, and a
  // table laid out automatically sizes that cell to its CONTENT: the ticket row
  // measured 2633px wide with its timestamp at x=2621, past the window, while
  // the list's own box reported no overflow, so nothing scrolled and nothing
  // folded. Fixed layout gives the cell the table's width, which is what makes
  // every `min-w-0 truncate` inside a row actually engage.
  it("lays the table out fixed, so a row can never be sized by its content", () => {
    const { container } = renderList()
    const root = container.querySelector('[data-responsive="list"]') as HTMLElement
    expect(root.className).toContain("md:table")
    expect(root.className).toContain("md:w-full")
    expect(root.className).toContain("md:table-fixed")
  })
})
