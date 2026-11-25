// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Knowledge tree inside the phone navigator sheet: opening a folder or a
// row's menu is not a navigation, so the sheet stays (B8).
import { Route, Router } from "@solidjs/router"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { closePhoneNavigator, phoneNavigatorOpen } from "~/modules/shell/phone-navigator-store"
import { Sidebar } from "~/modules/shell/Sidebar"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"
import KnowledgeCollectionTree from "./KnowledgeCollectionTree"
import { resetKnowledgeStore } from "./knowledge-store"

vi.stubGlobal("fetch", vi.fn())

const tree = [
  {
    id: "c1",
    name: "Policies",
    parentId: null,
    children: [{ id: "c2", name: "Returns", parentId: "c1", children: [], documents: [] }],
    documents: [{ id: "d1", title: "Warranty" }],
  },
]

function renderPhoneShell() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <PanelProvider>
            <MainPanel tier="phone" />
            <Sidebar tier="phone" />
          </PanelProvider>
        )}
      />
    </Router>
  ))
}

describe("Knowledge tree in the phone navigator", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    closePhoneNavigator()
    resetKnowledgeStore()
    registerTabType("kn-probe", {
      component: () => <div>probe body</div>,
      sidebar: () => <KnowledgeCollectionTree tree={tree as never} onOpenDoc={() => {}} />,
      icon: () => null,
      urlPattern: "/kn-probe",
      defaultLabel: "Probe",
      singleton: true,
    })
  })

  afterEach(() => {
    closePhoneNavigator()
    cleanup()
  })

  it("B8: chevron keeps the sheet open", () => {
    openTab({ type: "kn-probe", entityId: "probe", label: "Probe" })
    renderPhoneShell()
    fireEvent.click(screen.getByTestId("phone-navigator-opener"))
    expect(phoneNavigatorOpen()).toBe(true)

    fireEvent.click(screen.getByTestId("knowledge-tree-toggle-c1"))
    expect(phoneNavigatorOpen()).toBe(true)
    expect(screen.getByTestId("knowledge-tree-folder-c2")).toBeInTheDocument()
    // The folder's name opens it too, and the row's menu button keeps the sheet.
    fireEvent.click(screen.getByTestId("knowledge-tree-folder-c2"))
    fireEvent.click(screen.getByTestId("knowledge-tree-menu-c1"))
    expect(phoneNavigatorOpen()).toBe(true)
  })
})
