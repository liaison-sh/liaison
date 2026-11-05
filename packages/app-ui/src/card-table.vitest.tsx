// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CardTable DOM tests (vitest + jsdom + vite-plugin-solid — `bun test` cannot
// transform Solid JSX). The variant is chosen from `matchMedia`, so each test
// stubs it: `phone()` puts the component below the shell's 639 px phone tier,
// `desktop()` above it.
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CardTable, type CardTableColumn } from "./card-table"

interface Row {
  id: string
  name: string
  total: string
  email: string
  status: string
  date: string
  note: string
  sku: string
}

const ROWS: Row[] = [
  {
    id: "r1",
    name: "#1001",
    total: "189.50",
    email: "marie@example.com",
    status: "paid",
    date: "2 Sep",
    note: "gift wrap",
    sku: "SKU-1",
  },
  {
    id: "r2",
    name: "#1000",
    total: "139.00",
    email: "adrian@example.com",
    status: "refunded",
    date: "1 Sep",
    note: "no note",
    sku: "SKU-2",
  },
]

const COLUMNS: Array<CardTableColumn<Row>> = [
  { key: "name", header: "Order", role: "anchor", cell: (r) => r.name },
  {
    key: "total",
    header: "Total",
    role: "meta",
    numeric: true,
    align: "right",
    cell: (r) => r.total,
  },
  { key: "email", header: "Customer", role: "secondary", cell: (r) => r.email },
  { key: "status", header: "Status", role: "meta", cell: (r) => r.status },
  { key: "date", header: "Date", role: "meta", cell: (r) => r.date },
  { key: "note", header: "Note", role: "fold", cell: (r) => r.note },
  { key: "sku", header: "SKU", role: "fold", cell: (r) => r.sku },
]

// A `matchMedia` double that actually EVALUATES the query against a viewport
// width, and that really registers `change` listeners. A stub answering a fixed
// boolean to every query pins nothing: it would answer the same for
// `(max-width: 1px)`, so neither the kit's 639 px breakpoint nor its live
// re-evaluation on a resize is under test.
interface FakeMediaQueryList {
  media: string
  listeners: Set<(e: MediaQueryListEvent) => void>
  removed: number
}

let viewportWidth = 1024
const mediaLists: FakeMediaQueryList[] = []

function queryMatches(query: string): boolean {
  const max = /\(max-width:\s*(\d+)px\)/.exec(query)
  if (max) return viewportWidth <= Number(max[1])
  const min = /\(min-width:\s*(\d+)px\)/.exec(query)
  if (min) return viewportWidth >= Number(min[1])
  return false
}

function installMatchMedia(): void {
  mediaLists.length = 0
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      const list: FakeMediaQueryList = { media: query, listeners: new Set(), removed: 0 }
      mediaLists.push(list)
      return {
        media: query,
        get matches() {
          return queryMatches(query)
        },
        onchange: null,
        addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
          list.listeners.add(cb)
        },
        removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
          if (list.listeners.delete(cb)) list.removed += 1
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }
    },
  })
}

/** Resize the fake viewport and notify every live query, as a browser does. */
function setViewportWidth(width: number): void {
  viewportWidth = width
  for (const list of mediaLists) {
    for (const cb of Array.from(list.listeners)) {
      cb({ matches: queryMatches(list.media), media: list.media } as MediaQueryListEvent)
    }
  }
}

function stubMatchMedia(matches: boolean): void {
  viewportWidth = matches ? 390 : 1024
  installMatchMedia()
}

/** Install the double at an arbitrary width: the tablet tier is neither of the
 *  two shorthands below. */
function viewportWidthFor(width: number): void {
  viewportWidth = width
  installMatchMedia()
}

const phone = () => stubMatchMedia(true)
const desktop = () => stubMatchMedia(false)

afterEach(() => {
  vi.restoreAllMocks()
})

describe("CardTable — card variant (below 640px)", () => {
  beforeEach(phone)

  it("renders one card per row and no table", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    expect(screen.getAllByTestId("card-table-card")).toHaveLength(2)
    expect(document.querySelector("table")).toBeNull()
  })

  it("puts the anchor and the numeric meta on line 1, the secondary on line 2, the rest of the meta on line 3", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    const card = screen.getAllByTestId("card-table-card")[0] as HTMLElement
    const body = card.querySelector("[data-card-table-body]") ?? card
    const lines = Array.from(body.children) as HTMLElement[]

    // line 1: anchor (bold) + the first numeric meta, tabular figures.
    expect(lines[0]?.textContent).toContain("#1001")
    expect(lines[0]?.textContent).toContain("189.50")
    expect(lines[0]?.querySelector(".font-semibold")?.textContent).toBe("#1001")
    expect(lines[0]?.querySelector(".tabular-nums")?.textContent).toBe("189.50")

    // line 2: the secondary column only.
    expect(lines[1]?.textContent).toBe("marie@example.com")

    // line 3: the remaining meta cells, last one right aligned and muted.
    expect(lines[2]?.textContent).toContain("paid")
    expect(lines[2]?.textContent).toContain("2 Sep")
    const last = lines[2]?.lastElementChild as HTMLElement
    expect(last.textContent).toBe("2 Sep")
    expect(last.className).toContain("ml-auto")
    expect(last.className).toContain("text-text-tertiary")

    // fold columns are NOT painted until the card is expanded.
    expect(card.textContent).not.toContain("gift wrap")
    expect(screen.queryByTestId("card-table-fold")).toBeNull()
  })

  it("expands the fold columns into a label/value grid and collapses again", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    const chevron = screen.getAllByTestId("card-table-expand")[0] as HTMLElement
    expect(chevron.getAttribute("aria-expanded")).toBe("false")

    fireEvent.click(chevron)
    const fold = screen.getByTestId("card-table-fold")
    expect(fold.textContent).toContain("Note")
    expect(fold.textContent).toContain("gift wrap")
    expect(fold.textContent).toContain("SKU")
    expect(fold.textContent).toContain("SKU-1")
    // One card expanded, not all of them.
    expect(screen.getAllByTestId("card-table-fold")).toHaveLength(1)

    fireEvent.click(chevron)
    expect(screen.queryByTestId("card-table-fold")).toBeNull()
  })

  it("keeps a card expanded across a refetch that returns equal rows as new objects", () => {
    // A poll or a refetch hands back the same rows as FRESH objects. `<For>` is
    // keyed by identity, so every CardRow is rebuilt: fold state that lived in
    // the row collapsed under the operator's thumb mid read.
    const [rows, setRows] = createSignal(ROWS)
    render(() => <CardTable rows={rows()} rowKey={(r: Row) => r.id} columns={COLUMNS} />)
    fireEvent.click(screen.getAllByTestId("card-table-expand")[0] as HTMLElement)
    expect(screen.getByTestId("card-table-fold").textContent).toContain("gift wrap")

    setRows(ROWS.map((r) => ({ ...r })))

    const folds = screen.getAllByTestId("card-table-fold")
    expect(folds).toHaveLength(1)
    expect(folds[0]?.textContent).toContain("gift wrap")
    expect(
      (screen.getAllByTestId("card-table-expand")[0] as HTMLElement).getAttribute("aria-expanded"),
    ).toBe("true")
  })

  it("renders the app's detail panel inside the card it belongs to", () => {
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        renderDetail={(r) => (r.id === "r2" ? <p data-testid="demo-detail">{r.email}</p> : null)}
      />
    ))
    const cards = screen.getAllByTestId("card-table-card")
    expect(cards[0]?.querySelector('[data-testid="demo-detail"]')).toBeNull()
    // Adjacency: the panel lives INSIDE its own card, not after the list.
    expect(cards[1]?.querySelector('[data-testid="demo-detail"]')?.textContent).toBe(
      "adrian@example.com",
    )
    expect(screen.getAllByTestId("demo-detail")).toHaveLength(1)
  })

  it("hides the fold columns entirely when expandable is false", () => {
    render(() => (
      <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} expandable={false} />
    ))
    expect(screen.queryByTestId("card-table-expand")).toBeNull()
    expect(screen.getAllByTestId("card-table-card")[0]?.textContent).not.toContain("gift wrap")
  })

  it("renders row actions inside the expanded card and fires onSelect", () => {
    const onSelect = vi.fn()
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        actions={(r) => [{ label: `Refund ${r.name}`, onSelect }]}
      />
    ))
    expect(screen.queryByText("Refund #1001")).toBeNull()
    fireEvent.click(screen.getAllByTestId("card-table-expand")[0] as HTMLElement)
    const button = screen.getByText("Refund #1001")
    // 44px touch target on the card.
    expect((button as HTMLElement).className).toContain("min-h-11")
    fireEvent.click(button)
    expect(onSelect).toHaveBeenCalledTimes(1)
  })

  it("paints the headline number ONCE when columns are rebuilt on every read", () => {
    // A caller that maps its column declaration inside the JSX hands CardTable
    // a NEW array of NEW objects on every reactive read. The card must still
    // recognise the headline column, or the total is painted twice per card.
    const rebuilt = () => COLUMNS.map((c) => ({ ...c }))
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={rebuilt()} />)
    const card = screen.getAllByTestId("card-table-card")[0] as HTMLElement
    expect(card.textContent?.match(/189\.50/g)).toHaveLength(1)
  })

  it("gives the chevron a 44px touch target and a keyboard focus ring", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    const chevron = screen.getAllByTestId("card-table-expand")[0] as HTMLElement
    expect(chevron.className).toContain("min-h-11")
    expect(chevron.className).toContain("min-w-11")
    expect(chevron.className).toContain("focus-visible:ring-2")
    expect(chevron.className).toContain("focus-visible:ring-accent-tint")
  })

  it("draws a second chevron glyph when open, never a rotated one", () => {
    // An `<svg>` transforms about its top left corner, so `rotate-180` swung
    // the glyph out of its own box and the open card showed a clipped corner.
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    const chevron = screen.getAllByTestId("card-table-expand")[0] as HTMLElement
    const glyph = () => chevron.querySelector("path") as SVGPathElement
    expect(glyph().getAttribute("data-chevron")).toBe("down")
    const down = glyph().getAttribute("d")

    fireEvent.click(chevron)
    expect(glyph().getAttribute("data-chevron")).toBe("up")
    expect(glyph().getAttribute("d")).not.toBe(down)
    expect((chevron.querySelector("svg") as SVGElement).getAttribute("class")).not.toContain(
      "rotate-180",
    )
  })

  it("applies the app's per-row testid to the card, and keeps the kit handle resolvable", () => {
    // Every per-row oracle written against the old table addresses the row by
    // the app's own testid. On the card variant it used to be written to
    // `data-row-testid`, which no `getByTestId` can see, so the whole per-row
    // oracle surface went dark below 640 px.
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        rowTestid={(r) => `demo-row-${r.id}`}
      />
    ))
    const row = screen.getByTestId("demo-row-r1")
    expect(row.textContent).toContain("#1001")
    expect(screen.getByTestId("demo-row-r2")).toBeTruthy()
    // The kit's own handle still matches exactly once per row.
    expect(screen.getAllByTestId("card-table-card")).toHaveLength(2)
    expect(row.querySelector('[data-testid="card-table-card"]')).toBeTruthy()
  })

  it("puts the app's per-row state markers on the card root", () => {
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        rowAttrs={(r) => ({ "data-invalid": String(r.status === "refunded") })}
      />
    ))
    const cards = screen.getAllByTestId("card-table-card")
    expect(cards[0]?.getAttribute("data-invalid")).toBe("false")
    expect(cards[1]?.getAttribute("data-invalid")).toBe("true")
    expect(document.querySelectorAll('[data-invalid="true"]')).toHaveLength(1)
  })

  it("calls onRowClick when the card body is tapped, but not when the chevron is", () => {
    const onRowClick = vi.fn()
    render(() => (
      <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} onRowClick={onRowClick} />
    ))
    fireEvent.click(screen.getAllByTestId("card-table-card")[0] as HTMLElement)
    expect(onRowClick).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getAllByTestId("card-table-expand")[0] as HTMLElement)
    expect(onRowClick).toHaveBeenCalledTimes(1)
  })
})

describe("CardTable — table variant (640px and up)", () => {
  beforeEach(desktop)

  it("lists EVERY column header, folded ones included, and no cards", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    const headers = Array.from(document.querySelectorAll("th")).map((th) => th.textContent)
    expect(headers).toEqual(["Order", "Total", "Customer", "Status", "Date", "Note", "SKU"])
    expect(screen.queryAllByTestId("card-table-card")).toHaveLength(0)
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2)
  })

  it("keeps the row actions in a trailing table cell", () => {
    const onSelect = vi.fn()
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        actions={() => [{ label: "Refund", onSelect }]}
      />
    ))
    const headers = Array.from(document.querySelectorAll("th")).map((th) => th.textContent)
    expect(headers[headers.length - 1]).toBe("Actions")
    const firstRowCells = document.querySelectorAll("tbody tr:first-child td")
    expect(firstRowCells[firstRowCells.length - 1]?.textContent).toBe("Refund")
  })

  it("renders the app's detail panel as a full width row under its own row", () => {
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        actions={() => [{ label: "Refund", onSelect: () => {} }]}
        renderDetail={(r) => (r.id === "r1" ? <p data-testid="demo-detail">{r.email}</p> : null)}
      />
    ))
    const rows = Array.from(document.querySelectorAll("tbody tr"))
    // The detail row is the row IMMEDIATELY after the row it belongs to.
    expect(rows[0]?.getAttribute("data-row-key")).toBe("r1")
    expect(rows[1]?.getAttribute("data-testid")).toBe("card-table-detail")
    expect(rows[1]?.querySelector('[data-testid="demo-detail"]')?.textContent).toBe(
      "marie@example.com",
    )
    // Full width: every column plus the actions column.
    expect(rows[1]?.querySelector("td")?.getAttribute("colspan")).toBe(String(COLUMNS.length + 1))
    expect(rows[2]?.getAttribute("data-row-key")).toBe("r2")
    expect(screen.getAllByTestId("demo-detail")).toHaveLength(1)
  })

  it("puts the app's per-row state markers on the table row", () => {
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        rowAttrs={(r) => ({ "data-invalid": String(r.status === "refunded") })}
      />
    ))
    const rows = Array.from(document.querySelectorAll("tbody tr"))
    expect(rows[0]?.getAttribute("data-invalid")).toBe("false")
    expect(rows[1]?.getAttribute("data-invalid")).toBe("true")
    expect(document.querySelectorAll('[data-invalid="true"]')).toHaveLength(1)
  })

  it("applies the app's per-row testid to the table row", () => {
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        rowTestid={(r) => `demo-row-${r.id}`}
      />
    ))
    expect(screen.getByTestId("demo-row-r1")).toBeTruthy()
  })
})

describe("CardTable — empty", () => {
  it("renders the empty state and nothing else, at both widths", () => {
    for (const set of [phone, desktop]) {
      set()
      const { unmount } = render(() => (
        <CardTable
          rows={[]}
          rowKey={(r: Row) => r.id}
          columns={COLUMNS}
          emptyState={<p data-testid="demo-empty">No orders yet.</p>}
        />
      ))
      expect(screen.getByTestId("demo-empty").textContent).toBe("No orders yet.")
      expect(document.querySelector("table")).toBeNull()
      expect(screen.queryAllByTestId("card-table-card")).toHaveLength(0)
      unmount()
    }
  })
})

describe("CardTable — the breakpoint itself", () => {
  beforeEach(desktop)

  it("switches at the shell's 639 px phone tier, not at some other width", () => {
    setViewportWidth(640)
    const { unmount } = render(() => (
      <CardTable rows={ROWS} rowKey={(r: Row) => r.id} columns={COLUMNS} />
    ))
    expect(document.querySelector("table")).not.toBeNull()
    unmount()

    setViewportWidth(639)
    render(() => <CardTable rows={ROWS} rowKey={(r: Row) => r.id} columns={COLUMNS} />)
    expect(document.querySelector("table")).toBeNull()
    expect(screen.getAllByTestId("card-table-card")).toHaveLength(2)
  })

  it("flips variant on a live change event, in both directions", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r: Row) => r.id} columns={COLUMNS} />)
    expect(document.querySelector("table")).not.toBeNull()

    setViewportWidth(390)
    expect(document.querySelector("table")).toBeNull()
    expect(screen.getAllByTestId("card-table-card")).toHaveLength(2)

    setViewportWidth(1024)
    expect(document.querySelector("table")).not.toBeNull()
    expect(screen.queryAllByTestId("card-table-card")).toHaveLength(0)
  })

  it("removes its change listener when the table unmounts", () => {
    const { unmount } = render(() => (
      <CardTable rows={ROWS} rowKey={(r: Row) => r.id} columns={COLUMNS} />
    ))
    const list = mediaLists[0]
    expect(list?.listeners.size).toBe(1)

    unmount()

    expect(list?.listeners.size).toBe(0)
    expect(list?.removed).toBe(1)
  })
})

// A screenshot pass at 820 px found the fixed table squeezing its columns until
// the words broke mid-letter ("PAYMEN", "Unp") and the last column left the
// window. Between the phone card stack and a full desktop table the lowest
// priority columns come out, and what is left keeps a floor.
describe("CardTable — tablet tier (640 to 1023px)", () => {
  beforeEach(() => {
    viewportWidthFor(820)
  })

  it("drops the fold columns rather than squeezing every column", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    const headers = Array.from(document.querySelectorAll("th")).map((th) => th.textContent)
    // Note and SKU are the `fold` columns: the ones the card already hides.
    expect(headers).toEqual(["Order", "Total", "Customer", "Status", "Date"])
    // Still a table, not the phone card stack.
    expect(screen.queryAllByTestId("card-table-card")).toHaveLength(0)
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2)
  })

  it("keeps a per-column floor and scrolls the container rather than clipping", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    const table = document.querySelector("table") as HTMLTableElement
    // Five visible columns at 7.5rem each.
    expect(table.style.minWidth).toBe("37.5rem")
    expect((table.parentElement as HTMLElement).className).toContain("overflow-x-auto")
  })

  it("floors only the wrapping columns when asked, so a narrow pane keeps its actions in view", () => {
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        actions={() => [{ label: "Edit", onSelect: () => {} }]}
        floor="flexible"
      />
    ))
    const table = document.querySelector("table") as HTMLTableElement
    // Order, Customer, Status, Date wrap; Total (numeric) and the actions
    // column hold their content width and take no floor.
    expect(table.style.minWidth).toBe("30rem")
  })

  it("puts every column back once the viewport is wide enough for them", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    expect(Array.from(document.querySelectorAll("th")).map((th) => th.textContent)).toHaveLength(5)
    setViewportWidth(1280)
    expect(Array.from(document.querySelectorAll("th")).map((th) => th.textContent)).toEqual([
      "Order",
      "Total",
      "Customer",
      "Status",
      "Date",
      "Note",
      "SKU",
    ])
  })

  it("spans the detail row across the columns that are actually drawn", () => {
    render(() => (
      <CardTable
        rows={ROWS}
        rowKey={(r) => r.id}
        columns={COLUMNS}
        renderDetail={(r) => (r.id === "r1" ? <div>panel</div> : null)}
      />
    ))
    const detail = screen
      .getByTestId("card-table-detail")
      .querySelector("td") as HTMLTableCellElement
    expect(detail.getAttribute("colspan")).toBe("5")
  })
})

// `fit` is the escape hatch for a column whose cell is an ATOM: an amount, a
// status badge. Squeezed with the rest they read as a wrong number or as an
// empty cell under a header that promised something.
describe("CardTable — fitted columns", () => {
  const FITTED: Array<CardTableColumn<Row>> = [
    { key: "name", header: "Recipient", role: "anchor", cell: (r) => r.name },
    {
      key: "total",
      header: "Value",
      role: "meta",
      numeric: true,
      fit: true,
      align: "right",
      cell: (r) => `${r.total} EUR`,
    },
    { key: "status", header: "Tracking", role: "meta", fit: true, cell: (r) => r.status },
  ]

  beforeEach(desktop)

  it("gives a fitted column its content width and never lets it wrap", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={FITTED} />)
    const headers = Array.from(document.querySelectorAll("th"))
    expect(headers[1].className).toContain("w-px")
    expect(headers[1].className).toContain("whitespace-nowrap")
    expect(headers[2].className).toContain("w-px")
    // The anchor is NOT fitted: it absorbs whatever width is left.
    expect(headers[0].className).not.toContain("w-px")

    const cells = Array.from(document.querySelectorAll("tbody tr:first-child td"))
    expect(cells[1].className).toContain("w-px")
    expect(cells[1].className).toContain("whitespace-nowrap")
    expect(cells[1].className).toContain("tabular-nums")
    expect(cells[2].className).toContain("w-px")
    expect(cells[0].className).not.toContain("w-px")
    // And the whole value is on screen, not a prefix of it.
    expect(cells[1].textContent).toBe("189.50 EUR")
  })

  it("fits a numeric column even when it does not ask to be fitted", () => {
    render(() => <CardTable rows={ROWS} rowKey={(r) => r.id} columns={COLUMNS} />)
    const headers = Array.from(document.querySelectorAll("th"))
    // COLUMNS' second column is `total`, numeric and unfitted by declaration.
    expect(headers[1].className).toContain("w-px")
  })
})
