// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest"
import {
  closeTabletSidebar,
  tabletSidebarOpen,
  toggleTabletSidebar,
} from "~/modules/shell/tablet-sidebar-store"

describe("tablet sidebar store", () => {
  beforeEach(() => closeTabletSidebar())

  it("tabletSidebarOpen defaults to false", () => {
    expect(tabletSidebarOpen()).toBe(false)
  })

  it("toggleTabletSidebar flips the signal from false to true and back", () => {
    toggleTabletSidebar()
    expect(tabletSidebarOpen()).toBe(true)
    toggleTabletSidebar()
    expect(tabletSidebarOpen()).toBe(false)
  })

  it("closeTabletSidebar sets the signal to false even when already open", () => {
    toggleTabletSidebar()
    expect(tabletSidebarOpen()).toBe(true)
    closeTabletSidebar()
    expect(tabletSidebarOpen()).toBe(false)
  })
})
