// SPDX-License-Identifier: FSL-1.1-ALv2
//
// DataTable rowHref tests — bundled-app suites use bun:test (no jsdom), so
// the rendered <tr> (cursor-pointer class + onClick wiring) is exercised via
// Playwright (G6); here we pin the two testable surfaces directly:
//   - onRowClick()'s real navigation behavior (cmd/ctrl-click → window.open,
//     plain click → the host's `navigate`), driven against the real
//     @liaison/host shim the same way ContactDocumentsPanel.test.tsx does
//     (globalThis.__liaisonHost).
//   - the source wiring: `rowHref` prop declared, `cursor-pointer` applied
//     conditionally, onClick mirrors the shopify app's idiom.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { onRowClick } from "./DataTable"
import { orderGid } from "./loader"

const source = readFileSync(join(import.meta.dir, "DataTable.tsx"), "utf-8")

describe("DataTable source wiring (list → detail navigation, over CardTable)", () => {
  it("declares an optional rowHref prop returning string | null", () => {
    expect(source).toMatch(/rowHref\?:\s*\(row: R\) => string \| null/)
  })

  it("renders through the shared CardTable so every dashboard gets the phone card story", () => {
    expect(source).toContain('import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"')
    expect(source).toContain("<CardTable")
  })

  it("imports navigate from @liaison/host and wires row clicks through onRowClick", () => {
    expect(source).toContain('import { navigate } from "@liaison/host"')
    expect(source).toContain("onRowClick(href, e)")
  })
})

describe("rows a guided tour can point at", () => {
  // The demo's commerce tour rings the invoice of the order it watched arrive,
  // by the order's gid (how the Shopify app keys its rows).
  it("passes a per-row testid and per-row data attributes through to CardTable", () => {
    expect(source).toContain("rowTestid={props.rowTestid}")
    expect(source).toContain("props.rowData?.(row)")
  })

  it("names an order by its gid, whether the document stored the numeric id or the gid", () => {
    expect(orderGid("6111234567")).toBe("gid://shopify/Order/6111234567")
    expect(orderGid("gid://shopify/Order/6111234567")).toBe("gid://shopify/Order/6111234567")
  })
})

describe("onRowClick (real @liaison/host navigate, no jsdom)", () => {
  let navigateCalls: string[]
  let openCalls: Array<[string, string, string]>
  const realWindow = (globalThis as { window?: unknown }).window
  const realOpen = (globalThis as { open?: unknown }).open

  beforeEach(() => {
    navigateCalls = []
    openCalls = []
    const host = {
      invokeTool: async () => {
        throw new Error("not used in this test")
      },
      navigate: (path: string) => {
        navigateCalls.push(path)
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: global host slot the @liaison/host shim reads.
    ;(globalThis as any).__liaisonHost = host
    // biome-ignore lint/suspicious/noExplicitAny: window.open stub (DataTable's cmd/ctrl-click path).
    ;(globalThis as any).window = {
      open: (url: string, target: string, features: string) => {
        openCalls.push([url, target, features])
      },
    }
  })

  afterEach(() => {
    // biome-ignore lint/suspicious/noExplicitAny: restore/clear globals.
    ;(globalThis as any).__liaisonHost = undefined
    // biome-ignore lint/suspicious/noExplicitAny: restore window global.
    ;(globalThis as any).window = realWindow
    // biome-ignore lint/suspicious/noExplicitAny: restore open global.
    ;(globalThis as any).open = realOpen
  })

  it("plain click calls the host's navigate with the href", () => {
    onRowClick("/invoicing/document/doc-1", { metaKey: false, ctrlKey: false } as MouseEvent)
    expect(navigateCalls).toEqual(["/invoicing/document/doc-1"])
    expect(openCalls).toEqual([])
  })

  it("cmd-click opens a new tab instead of navigating in-app", () => {
    onRowClick("/invoicing/document/doc-1", { metaKey: true, ctrlKey: false } as MouseEvent)
    expect(navigateCalls).toEqual([])
    expect(openCalls).toEqual([["/invoicing/document/doc-1", "_blank", "noopener,noreferrer"]])
  })

  it("ctrl-click opens a new tab instead of navigating in-app", () => {
    onRowClick("/invoicing/document/doc-1", { metaKey: false, ctrlKey: true } as MouseEvent)
    expect(navigateCalls).toEqual([])
    expect(openCalls).toEqual([["/invoicing/document/doc-1", "_blank", "noopener,noreferrer"]])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Phone width (spec-responsive.md): CardTable itself renders a card stack
// below 640px, so DataTable's job is only to pick each column's ROLE
// (anchor/secondary/meta/fold) from the DashboardColumn hints. Full
// rendering behavior (including the real credit-note pairing/fold story) is
// exercised end-to-end in pair-split.test.ts.
// ─────────────────────────────────────────────────────────────────────────
describe("column role mapping", () => {
  it("picks the well-known identity column as the anchor, and folds the rest of a declaring array", () => {
    expect(source).toContain("chooseAnchorKey")
    expect(source).toContain('for (const key of ["number", "customer", "country"])')
  })

  it("keeps every non-anchor column visible (no fold) when nothing declares survivesPhone", () => {
    expect(source).toContain("anyDeclaresSurvival")
    expect(source).toMatch(/anyDeclaresSurvival && !c\.survivesPhone\s*\?\s*"fold"\s*:\s*"meta"/)
  })
})
