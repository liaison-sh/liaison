// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Links out of Liaison go through the host (`app.openExternal`): a screen framed
// on its own origin has no popups, so `target="_blank"` and `window.open` do
// nothing there. The invoice chip opens invoicing's record through the host too.
import { afterEach, describe, expect, it, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { onOutsideLinkClick, openOutside, screenFramed } from "./external-link"

const g = globalThis as Record<string, unknown>

afterEach(() => {
  delete g.__liaisonHost
  delete g.__LIAISON_TEST_APP_NAME
})

describe("outside links", () => {
  it("in a frame, the host opens them for this app", async () => {
    const openExternal = mock(async () => {})
    g.__LIAISON_TEST_APP_NAME = "shopify"
    g.__liaisonHost = { framed: true, openExternal }
    const event = { preventDefault: mock(() => {}) } as unknown as MouseEvent
    onOutsideLinkClick(event, "https://shop.myshopify.com/admin/orders")
    expect(event.preventDefault).toHaveBeenCalled()
    expect(openExternal).toHaveBeenCalledWith("shopify", "https://shop.myshopify.com/admin/orders")
    openOutside(null)
    expect(openExternal).toHaveBeenCalledTimes(1)
  })

  it("a refusal by the host is logged, never thrown at the click", async () => {
    g.__LIAISON_TEST_APP_NAME = "shopify"
    g.__liaisonHost = { framed: true, openExternal: async () => Promise.reject(new Error("no")) }
    const warn = mock(() => {})
    const original = console.warn
    console.warn = warn
    try {
      openOutside("https://evil.test/")
      await new Promise((r) => setTimeout(r, 0))
      expect(warn).toHaveBeenCalled()
    } finally {
      console.warn = original
    }
  })

  it("knows when its screen is framed", () => {
    g.__liaisonHost = { framed: true }
    expect(screenFramed()).toBe(true)
    g.__liaisonHost = {}
    expect(screenFramed()).toBe(false)
  })

  it("no screen opens an outside page or another app's route by itself", () => {
    for (const file of ["home.tsx", "lists.tsx", "sidebar.tsx", "panels/index.tsx"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8")
      // Only a Cmd/Ctrl-click on a Liaison row (lists.tsx onRowClick) opens a browser tab itself.
      const opens = (src.match(/window\.open\(/g) ?? []).length
      expect({ file, opens }).toEqual({ file, opens: file === "lists.tsx" ? 1 : 0 })
      expect({ file, invoicing: src.includes("navigate(`/invoicing/") }).toEqual({
        file,
        invoicing: false,
      })
      // Every `_blank` link, literal or conditional, has its click routed to the host.
      const blank = (src.match(/target=(?:"_blank"|\{[^}]*"_blank")/g) ?? []).length
      const handled = (src.match(/onOutsideLinkClick\(e, /g) ?? []).length
      expect({ file, blank }).toEqual({ file, blank: handled })
    }
    const lists = readFileSync(join(import.meta.dir, "lists.tsx"), "utf8")
    expect(lists).toContain('app.openRecord("invoicing", "document", link.invoice_id)')
    // Its Cmd/Ctrl-click tab is the page's only: framed, the row opens in place.
    expect(lists).toContain("if ((e.metaKey || e.ctrlKey) && !screenFramed()) {")
  })
})
