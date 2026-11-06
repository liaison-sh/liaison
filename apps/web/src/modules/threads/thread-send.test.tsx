// SPDX-License-Identifier: FSL-1.1-ALv2
import { createRoot } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openRecordOf, setOpenRecord, trackOpenRecord } from "~/modules/shell/open-record"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { makeTabId, openTab, resetTabStore } from "~/modules/shell/tab-store"
import { currentViewForTurn } from "./thread-send"

vi.mock("~/framework/app-registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("~/framework/app-registry")>()
  return {
    ...real,
    getTabType: (type: string) => ({ id: type, label: type, singleton: false }),
    patternToUrl: () => null,
  }
})

afterEach(() => resetTabStore())

describe("the view a turn is sent from", () => {
  it("a page with a record open in a pane names that record, not the page", () => {
    openTab({ type: "boxtal:shipments", entityId: "boxtal/shipments", label: "Shipments" })
    expect(currentViewForTurn()).toEqual({
      tabType: "boxtal:shipments",
      entityId: "boxtal/shipments",
    })
    const tabId = makeTabId("boxtal:shipments", "boxtal/shipments")
    setOpenRecord(tabId, { tabType: "boxtal:shipment", entityId: "ship-1" })
    expect(currentViewForTurn()).toEqual({ tabType: "boxtal:shipment", entityId: "ship-1" })
    setOpenRecord(tabId, null)
    expect(currentViewForTurn()?.tabType).toBe("boxtal:shipments")
  })

  it("the open record of a tab in the background does not speak for the active one", () => {
    openTab({ type: "boxtal:shipments", entityId: "boxtal/shipments", label: "Shipments" })
    setOpenRecord(makeTabId("boxtal:shipments", "boxtal/shipments"), {
      tabType: "boxtal:shipment",
      entityId: "ship-1",
    })
    openTab({ type: "invoicing:detail", entityId: "doc-1", label: "Invoice" })
    expect(currentViewForTurn()).toEqual({ tabType: "invoicing:detail", entityId: "doc-1" })
  })

  it("the generic detail tab names the record behind it, a Shopify id with slashes included", () => {
    openTab({ type: "detail", entityId: "shopify/order/gid://shopify/Order/12", label: "Order" })
    expect(currentViewForTurn()).toEqual({
      tabType: "shopify:order",
      entityId: "gid://shopify/Order/12",
    })
  })
})

describe("trackOpenRecord", () => {
  it("follows the page's signal, and stops with the page", () => {
    let dispose = () => {}
    createRoot((d) => {
      dispose = d
      const Page = () => {
        trackOpenRecord("boxtal", "shipment", () => "ship-9")
        return null
      }
      return (
        <TabVisibilityProvider value={() => true} tabId="tab-1">
          <Page />
        </TabVisibilityProvider>
      )
    })
    expect(openRecordOf("tab-1")).toEqual({ tabType: "boxtal:shipment", entityId: "ship-9" })
    dispose()
    expect(openRecordOf("tab-1")).toBeUndefined()
  })

  it("outside a tab it does nothing", () => {
    createRoot((dispose) => {
      trackOpenRecord("boxtal", "shipment", () => "ship-9")
      dispose()
    })
    expect(openRecordOf("tab-1")).toBeUndefined()
  })
})
