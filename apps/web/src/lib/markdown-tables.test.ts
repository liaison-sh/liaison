// SPDX-License-Identifier: FSL-1.1-ALv2
//
// F6. In a 340px dock tab a markdown table broke per character: a cell reading
// "RETURNED" rendered as "RE TUR NE D". The table had `width: 100%` and
// inherited the prose `word-break: break-word`, so the only place it could put
// the overflow was inside the words.
import { describe, expect, it } from "vitest"
import { TABLE_WRAP_CLASS, wrapMarkdownTables, wrapTableElements } from "~/lib/markdown-tables"

const TABLE_HTML =
  "<p>before</p><table><thead><tr><th>Status</th></tr></thead>" +
  "<tbody><tr><td>RETURNED</td></tr></tbody></table><p>after</p>"

describe("wrapMarkdownTables", () => {
  it("puts the table in a horizontally scrollable wrapper", () => {
    const out = wrapMarkdownTables(TABLE_HTML)
    const doc = new DOMParser().parseFromString(out, "text/html")

    const table = doc.querySelector("table") as HTMLTableElement
    const wrap = table.parentElement as HTMLElement
    expect(wrap.tagName.toLowerCase()).toBe("div")
    expect(wrap.classList.contains(TABLE_WRAP_CLASS)).toBe(true)
    expect(wrap.style.overflowX).toBe("auto")
    expect(wrap.style.maxWidth).toBe("100%")
  })

  it("stops every cell wrapping, so a word is never broken per character", () => {
    const doc = new DOMParser().parseFromString(wrapMarkdownTables(TABLE_HTML), "text/html")
    const cells = Array.from(doc.querySelectorAll("th, td")) as HTMLElement[]
    expect(cells.length).toBe(2)
    for (const cell of cells) expect(cell.style.whiteSpace).toBe("nowrap")
  })

  it("lets the table keep its own width instead of being squeezed to the column", () => {
    const doc = new DOMParser().parseFromString(wrapMarkdownTables(TABLE_HTML), "text/html")
    const table = doc.querySelector("table") as HTMLElement
    expect(table.style.width).toBe("max-content")
    expect(table.style.minWidth).toBe("100%")
  })

  it("leaves prose with no table untouched", () => {
    const html = "<p>plain</p>"
    expect(wrapMarkdownTables(html)).toBe(html)
  })

  it("is idempotent: a second pass adds no second wrapper", () => {
    const once = wrapMarkdownTables(TABLE_HTML)
    const twice = wrapMarkdownTables(once)
    expect(twice).toBe(once)
    const doc = new DOMParser().parseFromString(twice, "text/html")
    expect(doc.querySelectorAll(`.${TABLE_WRAP_CLASS}`).length).toBe(1)
  })
})

describe("wrapTableElements", () => {
  it("picks up cells appended after the wrapper already exists", () => {
    const root = document.createElement("div")
    root.innerHTML = "<table><tbody><tr><td>A</td></tr></tbody></table>"
    wrapTableElements(root)

    const body = root.querySelector("tbody") as HTMLElement
    const row = document.createElement("tr")
    row.innerHTML = "<td>RETURNED</td>"
    body.appendChild(row)
    wrapTableElements(root)

    const cells = Array.from(root.querySelectorAll("td")) as HTMLElement[]
    expect(cells.map((c) => c.style.whiteSpace)).toEqual(["nowrap", "nowrap"])
    expect(root.querySelectorAll(`.${TABLE_WRAP_CLASS}`).length).toBe(1)
  })
})
