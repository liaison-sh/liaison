// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock localStorage before importing store
const storage: Record<string, string> = {}
vi.stubGlobal("localStorage", {
  getItem: vi.fn((key: string) => storage[key] ?? null),
  setItem: vi.fn((key: string, val: string) => {
    storage[key] = val
  }),
  removeItem: vi.fn((key: string) => {
    delete storage[key]
  }),
})

describe("tab-store", () => {
  beforeEach(async () => {
    // Reset module state between tests
    vi.resetModules()
    for (const key of Object.keys(storage)) delete storage[key]
  })

  it("initializes with a Home tab when localStorage is empty", async () => {
    const { tabStore } = await import("~/modules/shell/tab-store")
    expect(tabStore.tabs).toHaveLength(1)
    expect(tabStore.tabs[0].id).toBe("kernel:home:home")
    expect(tabStore.tabs[0].type).toBe("kernel:home")
    expect(tabStore.tabs[0].label).toBe("Home")
    expect(tabStore.tabs[0].isPreview).toBe(false)
    expect(tabStore.activeTabId).toBe("kernel:home:home")
  })

  it("opens a new tab and activates it", async () => {
    const { tabStore, openTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Bug Report" })
    expect(tabStore.tabs).toHaveLength(2) // Home + thread
    expect(tabStore.activeTabId).toBe("thread:t1")
    expect(tabStore.tabs[1].label).toBe("Bug Report")
  })

  it("focuses existing tab instead of creating duplicate", async () => {
    const { tabStore, openTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Bug Report" })
    openTab({ type: "thread", entityId: "t1", label: "Bug Report Updated" })
    expect(tabStore.tabs).toHaveLength(2) // Still Home + 1 thread
    expect(tabStore.activeTabId).toBe("thread:t1")
    // Label updates when re-focused
    expect(tabStore.tabs[1].label).toBe("Bug Report Updated")
  })

  it("closes a tab and activates adjacent", async () => {
    const { tabStore, openTab, closeTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    openTab({ type: "thread", entityId: "t2", label: "Thread 2", preview: false })
    // Active is t2, close it -> should activate t1 (previous)
    closeTab("thread:t2")
    expect(tabStore.tabs).toHaveLength(2) // Home + t1
    expect(tabStore.activeTabId).toBe("thread:t1")
  })

  it("auto-reopens Home tab when last tab is closed", async () => {
    const { tabStore, openTab, closeTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    closeTab("kernel:home:home") // Close Home
    expect(tabStore.tabs).toHaveLength(1) // Just t1
    closeTab("thread:t1") // Close last
    expect(tabStore.tabs).toHaveLength(1)
    expect(tabStore.tabs[0].id).toBe("kernel:home:home")
    expect(tabStore.activeTabId).toBe("kernel:home:home")
  })

  it("pushes closed tab to recentlyClosed stack", async () => {
    const { tabStore, openTab, closeTab, reopenLastClosed } = await import(
      "~/modules/shell/tab-store"
    )
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    closeTab("thread:t1")
    expect(tabStore.recentlyClosed).toHaveLength(1)
    expect(tabStore.recentlyClosed[0].id).toBe("thread:t1")
    reopenLastClosed()
    expect(tabStore.tabs.find((t) => t.id === "thread:t1")).toBeTruthy()
    expect(tabStore.activeTabId).toBe("thread:t1")
    expect(tabStore.recentlyClosed).toHaveLength(0)
  })

  it("Reopen restores single-instance app tabs, and focuses one already open", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("settings", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/settings",
      defaultLabel: "Settings",
      singleton: true,
    })
    const { tabStore, openTab, closeTab, closeOtherTabs, reopenLastClosed } = await import(
      "~/modules/shell/tab-store"
    )
    openTab({ type: "settings", entityId: "settings", label: "Settings", preview: false })
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    closeOtherTabs("thread:t1")
    expect(tabStore.tabs.some((t) => t.type === "settings")).toBe(false)
    reopenLastClosed()
    expect(tabStore.tabs.filter((t) => t.type === "settings")).toHaveLength(1)
    expect(tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.type).toBe("settings")
    // Plain close, then open again by hand: Reopen focuses it, no duplicate.
    closeTab(tabStore.activeTabId as string)
    openTab({ type: "settings", entityId: "settings", label: "Settings", preview: false })
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    reopenLastClosed()
    expect(tabStore.tabs.filter((t) => t.type === "settings")).toHaveLength(1)
    expect(tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.type).toBe("settings")
  })

  it("caps recentlyClosed at 10 and keeps most recently closed first", async () => {
    const { tabStore, openTab, closeTab } = await import("~/modules/shell/tab-store")
    for (let i = 0; i < 12; i++) {
      openTab({ type: "thread", entityId: `t${i}`, label: `Thread ${i}`, preview: false })
    }
    for (let i = 11; i >= 0; i--) {
      closeTab(`thread:t${i}`)
    }
    expect(tabStore.recentlyClosed.length).toBe(10)
    // Most recently closed (t0, closed last) should be first in the stack
    expect(tabStore.recentlyClosed[0].id).toBe("thread:t0")
  })

  it("preview tab is replaced by next preview open", async () => {
    const { tabStore, openTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: true })
    expect(tabStore.tabs[1].isPreview).toBe(true)
    openTab({ type: "thread", entityId: "t2", label: "Thread 2", preview: true })
    // t1 should be gone, replaced by t2
    expect(tabStore.tabs.find((t) => t.id === "thread:t1")).toBeUndefined()
    expect(tabStore.tabs[1].id).toBe("thread:t2")
    expect(tabStore.tabs[1].isPreview).toBe(true)
  })

  it("only one preview tab exists app-wide — a new preview of any type evicts the current one", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("ticket", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
    })

    const { tabStore, openTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: true })
    // Opening a preview of a DIFFERENT type replaces the existing preview — the
    // ephemeral slot is global, so "opening another screen auto-closes" the last one.
    openTab({ type: "ticket", entityId: "k1", label: "Ticket 1", preview: true })

    expect(tabStore.tabs.find((t) => t.id === "thread:t1")).toBeUndefined()
    expect(tabStore.tabs.find((t) => t.id === "ticket:k1")?.isPreview).toBe(true)
  })

  it("opens tabs as ephemeral previews by default; Home stays permanent", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("kernel:home", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })

    const { tabStore, openTab } = await import("~/modules/shell/tab-store")
    // No explicit preview flag → ephemeral by default.
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    expect(tabStore.tabs.find((t) => t.id === "thread:t1")?.isPreview).toBe(true)
    // The kernel Home fallback is exempt and always permanent.
    expect(tabStore.tabs.find((t) => t.type === "kernel:home")?.isPreview).toBe(false)
  })

  it("evictTabByEntity removes the matching tab silently (dangling 404 tabs)", async () => {
    const { tabStore, openTab, evictTabByEntity } = await import("~/modules/shell/tab-store")
    openTab({ type: "knowledge:document", entityId: "doc-x", label: "Doc X" })
    expect(tabStore.tabs.find((t) => t.entityId === "doc-x")).toBeTruthy()

    evictTabByEntity("knowledge:document", "doc-x")
    expect(tabStore.tabs.find((t) => t.entityId === "doc-x")).toBeUndefined()
    // Silent eviction — not offered in recently-closed.
    expect(tabStore.recentlyClosed.some((t) => t.entityId === "doc-x")).toBe(false)

    // Unknown (type, entityId) is a no-op.
    const count = tabStore.tabs.length
    evictTabByEntity("knowledge:document", "nope")
    expect(tabStore.tabs.length).toBe(count)
  })

  it("promoteActiveTab promotes the active preview to permanent", async () => {
    const { tabStore, openTab, promoteActiveTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    expect(tabStore.tabs.find((t) => t.id === "thread:t1")?.isPreview).toBe(true)
    promoteActiveTab()
    expect(tabStore.tabs.find((t) => t.id === "thread:t1")?.isPreview).toBe(false)
    // A later preview open no longer evicts it.
    openTab({ type: "thread", entityId: "t2", label: "Thread 2", preview: true })
    expect(tabStore.tabs.find((t) => t.id === "thread:t1")).toBeTruthy()
  })

  it("in-tab navigation (updateTabRoutePath) promotes a preview to permanent", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("settings", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/settings",
      defaultLabel: "Settings",
      singleton: true,
      preserveSubRoutes: true,
    })
    const { tabStore, openTab, updateTabRoutePath } = await import("~/modules/shell/tab-store")
    openTab({ type: "settings", entityId: "settings", label: "Settings" })
    expect(tabStore.tabs.find((t) => t.id === "settings:settings")?.isPreview).toBe(true)
    updateTabRoutePath("settings:settings", "/settings/security")
    expect(tabStore.tabs.find((t) => t.id === "settings:settings")?.isPreview).toBe(false)
  })

  it("promoteTab converts preview to permanent", async () => {
    const { tabStore, openTab, promoteTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: true })
    expect(tabStore.tabs[1].isPreview).toBe(true)
    promoteTab("thread:t1")
    expect(tabStore.tabs[1].isPreview).toBe(false)
    // Now opening another preview should NOT replace t1
    openTab({ type: "thread", entityId: "t2", label: "Thread 2", preview: true })
    expect(tabStore.tabs.find((t) => t.id === "thread:t1")).toBeTruthy()
  })

  it("reorders tabs", async () => {
    const { tabStore, openTab, reorderTabs } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    openTab({ type: "thread", entityId: "t2", label: "Thread 2", preview: false })
    // Move t2 (index 2) to index 1 (before t1)
    reorderTabs(2, 1)
    expect(tabStore.tabs[1].id).toBe("thread:t2")
    expect(tabStore.tabs[2].id).toBe("thread:t1")
  })

  it("persists to localStorage on mutation", async () => {
    const { openTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    const stored = JSON.parse(storage["liaison:tabs"])
    expect(stored.tabs).toHaveLength(2)
    expect(stored.activeTabId).toBe("thread:t1")
  })

  it("restores from localStorage on init", async () => {
    storage["liaison:tabs"] = JSON.stringify({
      tabs: [
        { type: "home", entityId: "home", label: "Home", isPreview: false },
        { type: "thread", entityId: "t1", label: "Restored Thread", isPreview: false },
      ],
      activeTabId: "thread:t1",
    })
    const { tabStore } = await import("~/modules/shell/tab-store")
    expect(tabStore.tabs).toHaveLength(2)
    expect(tabStore.tabs[1].label).toBe("Restored Thread")
    expect(tabStore.activeTabId).toBe("thread:t1")
  })

  it("preserves sub-routes for registered singleton tabs", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("settings", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/settings",
      defaultLabel: "Settings",
      singleton: true,
      preserveSubRoutes: true,
    })
    const { openTab, tabStore, tabToUrl } = await import("~/modules/shell/tab-store")

    openTab({
      type: "settings",
      entityId: "settings",
      label: "Settings",
      routePath: "/settings/security",
    })

    expect(tabStore.tabs.find((t) => t.id === "settings:settings")?.routePath).toBe(
      "/settings/security",
    )
    expect(tabToUrl(tabStore.tabs[1])).toBe("/settings/security")
  })

  it("rehydrates preserved sub-routes from storage", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("settings", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/settings",
      defaultLabel: "Settings",
      singleton: true,
      preserveSubRoutes: true,
    })
    storage["liaison:tabs"] = JSON.stringify({
      tabs: [
        { type: "home", entityId: "home", label: "Home", isPreview: false, routePath: "/" },
        {
          type: "settings",
          entityId: "settings",
          label: "Settings",
          isPreview: false,
          routePath: "/settings/security",
        },
      ],
      activeTabId: "settings:settings",
    })

    const { tabStore, tabToUrl } = await import("~/modules/shell/tab-store")

    expect(tabStore.activeTabId).toBe("settings:settings")
    expect(tabStore.tabs[1].routePath).toBe("/settings/security")
    expect(tabToUrl(tabStore.tabs[1])).toBe("/settings/security")
  })

  it("falls back to first tab when activeTabId is dangling", async () => {
    storage["liaison:tabs"] = JSON.stringify({
      tabs: [
        { type: "home", entityId: "home", label: "Home", isPreview: false },
        { type: "thread", entityId: "t1", label: "Thread 1", isPreview: false },
      ],
      activeTabId: "thread:deleted-thread", // Points to a tab that no longer exists
    })
    const { tabStore } = await import("~/modules/shell/tab-store")
    expect(tabStore.activeTabId).toBe("home:home") // Falls back to first tab
  })

  it("updateTabLabel updates the label of a specific tab", async () => {
    const { tabStore, openTab, updateTabLabel } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Old Name" })
    updateTabLabel("thread:t1", "New Name")
    expect(tabStore.tabs[1].label).toBe("New Name")
  })

  it("activateTab activates without creating", async () => {
    const { tabStore, openTab, activateTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    openTab({ type: "thread", entityId: "t2", label: "Thread 2", preview: false })
    activateTab("thread:t1")
    expect(tabStore.activeTabId).toBe("thread:t1")
  })

  it("enforces singleton — second open with different entityId activates existing", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("settings", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/settings",
      defaultLabel: "Settings",
      singleton: true,
    })
    const { tabStore, openTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "settings", entityId: "settings", label: "Settings" })
    openTab({ type: "settings", entityId: "other", label: "Other Settings" })
    const settingsTabs = tabStore.tabs.filter((t) => t.type === "settings")
    expect(settingsTabs).toHaveLength(1)
  })

  it("single-instance app tabs go on recentlyClosed", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("settings", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/settings",
      defaultLabel: "Settings",
      singleton: true,
    })
    const { tabStore, openTab, closeTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "settings", entityId: "settings", label: "Settings" })
    closeTab("settings:settings")
    expect(tabStore.recentlyClosed.find((t) => t.type === "settings")).toBeDefined()
  })

  it("home singleton excluded from recentlyClosed when registry is populated", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("home", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })
    const { tabStore, openTab, closeTab } = await import("~/modules/shell/tab-store")
    // Open a second tab so closing home doesn't trigger auto-reopen
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    closeTab("home:home")
    expect(tabStore.recentlyClosed.find((t) => t.type === "home")).toBeUndefined()
  })

  // ─── Tab Lifecycle: Rehydration, Validation, Persistence ───────────

  it("rehydrateTabs preserves unknown types for manifest apps that register later", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
    })
    registerTabType("home", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })

    // Seed localStorage with a mix of valid and unknown tab types
    storage["liaison:tabs"] = JSON.stringify({
      tabs: [
        { type: "home", entityId: "home", label: "Home", isPreview: false, routePath: "/" },
        {
          type: "thread",
          entityId: "t1",
          label: "Thread 1",
          isPreview: false,
          routePath: "/threads/t1",
        },
        {
          type: "unknown-app-type",
          entityId: "x1",
          label: "Unknown",
          isPreview: false,
          routePath: "/unknown/x1",
        },
      ],
      activeTabId: "thread:t1",
    })

    const { tabStore, rehydrateTabs } = await import("~/modules/shell/tab-store")
    rehydrateTabs()

    expect(tabStore.tabs).toHaveLength(3)
    // The legacy bare-"home" kernel tab is migrated to its canonical qualified id;
    // genuinely unknown manifest types are preserved untouched until they register.
    expect(tabStore.tabs.map((t) => t.type)).toEqual(["kernel:home", "thread", "unknown-app-type"])
    expect(tabStore.activeTabId).toBe("thread:t1")
  })

  it("rehydrateTabs leaves an already canonical tab as the SAME object, so its body is not remounted", async () => {
    // MainPanel renders `<For each={tabStore.tabs}>` and `For` keys on item
    // identity: hand it a new object for a tab nothing changed about and it
    // disposes that tab's body and mounts a fresh one. This pass runs a beat
    // after boot (once the manifests resolve), so the remount landed on top of
    // whatever the user was already doing in the tab: an open header menu, a
    // dialog, a scroll position, a half typed draft. Identity is the assertion
    // because identity is what `For` reads.
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
    })
    registerTabType("kernel:home", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })

    storage["liaison:tabs"] = JSON.stringify({
      tabs: [
        {
          type: "kernel:home",
          entityId: "home",
          label: "Home",
          isPreview: false,
          routePath: "/",
        },
        {
          type: "thread",
          entityId: "t1",
          label: "Thread 1",
          isPreview: false,
          routePath: "/threads/t1",
        },
      ],
      activeTabId: "thread:t1",
    })

    const { tabStore, rehydrateTabs } = await import("~/modules/shell/tab-store")
    const before = tabStore.tabs.map((t) => t)

    rehydrateTabs()

    expect(tabStore.tabs).toHaveLength(2)
    expect(tabStore.tabs[0]).toBe(before[0])
    expect(tabStore.tabs[1]).toBe(before[1])
    // The normalization itself still stands: same ids, same route paths.
    expect(tabStore.tabs.map((t) => t.id)).toEqual(["kernel:home:home", "thread:t1"])
    expect(tabStore.tabs[1].routePath).toBe("/threads/t1")
    expect(tabStore.activeTabId).toBe("thread:t1")
  })

  it("rehydrateTabs heals a legacy blank Home tab (bare 'home' + qualified duplicate)", async () => {
    // Regression: older builds persisted the kernel Home tab under the bare,
    // ambiguous type "home" (the alias collides with knowledge's local "home",
    // so it resolves to no component and renders BLANK). A session could end up
    // with both the blank "home:home" tab AND the real "kernel:home:home" tab,
    // with the blank one persisted as active — so after login the user landed on
    // an empty placeholder while the sidebar Home worked. rehydrate must migrate
    // the bare tab, dedupe to a single Home, and repoint the active tab.
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("kernel:home", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })

    storage["liaison:tabs"] = JSON.stringify({
      tabs: [
        { type: "home", entityId: "home", label: "Home", isPreview: false, routePath: "/" },
        { type: "kernel:home", entityId: "home", label: "Home", isPreview: false, routePath: "/" },
      ],
      activeTabId: "home:home", // the blank tab is the one the user would see
    })

    const { tabStore, rehydrateTabs } = await import("~/modules/shell/tab-store")
    rehydrateTabs()

    // Collapsed to a single, resolvable Home tab...
    expect(tabStore.tabs).toHaveLength(1)
    expect(tabStore.tabs[0].id).toBe("kernel:home:home")
    expect(tabStore.tabs[0].type).toBe("kernel:home")
    // ...and the active tab points at it (not the evicted blank "home:home").
    expect(tabStore.activeTabId).toBe("kernel:home:home")
  })

  it("rehydrateTabs keeps persisted tabs when their types are not registered yet", async () => {
    storage["liaison:tabs"] = JSON.stringify({
      tabs: [
        {
          type: "thread",
          entityId: "t1",
          label: "Thread 1",
          isPreview: false,
          routePath: "/threads/t1",
        },
      ],
      activeTabId: "thread:t1",
    })

    const { tabStore, rehydrateTabs } = await import("~/modules/shell/tab-store")
    rehydrateTabs()

    expect(tabStore.tabs).toHaveLength(1)
    expect(tabStore.tabs[0].id).toBe("thread:t1")
    expect(tabStore.activeTabId).toBe("thread:t1")
  })

  it("rehydrateTabs preserves active unknown tabs for manifest apps that register later", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
    })

    // Active tab points to a type that may register after authenticated manifest loading.
    storage["liaison:tabs"] = JSON.stringify({
      tabs: [
        {
          type: "thread",
          entityId: "t1",
          label: "Thread 1",
          isPreview: false,
          routePath: "/threads/t1",
        },
        {
          type: "unknown-type",
          entityId: "x1",
          label: "Unknown",
          isPreview: false,
          routePath: "/unknown/x1",
        },
      ],
      activeTabId: "unknown-type:x1",
    })

    const { tabStore, rehydrateTabs } = await import("~/modules/shell/tab-store")
    rehydrateTabs()

    expect(tabStore.tabs).toHaveLength(2)
    expect(tabStore.tabs[1].id).toBe("unknown-type:x1")
    expect(tabStore.activeTabId).toBe("unknown-type:x1")
  })

  it("a tab re-keyed by a late alias keeps its first-activation latch", async () => {
    // P4c FX-F4. An entity-id alias can only answer once its source has loaded
    // (the agent directory names `self`'s handle after a roundtrip), so a tab
    // opened before that is stored under one id and re-keyed onto the canonical
    // one by `rehydrateTabs`. The first-activation latch is keyed by tab id:
    // orphan it and MainPanel's lazy first-mount gate never opens, which is a
    // tab that is active, correctly labelled, and blank for ever.
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("agents:agent", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/agents/:entityId",
      defaultLabel: "Agent",
    })
    const { hasTabBeenActive, openTab, rehydrateTabs, registerTabEntityAlias, tabStore } =
      await import("~/modules/shell/tab-store")

    // The directory has not loaded: the alias passes `self` through.
    let handle: string | null = null
    registerTabEntityAlias("agents:agent", (entityId) =>
      entityId === "self" ? (handle ?? "self") : entityId,
    )
    openTab({ type: "agents:agent", entityId: "self", label: "Agent" })
    expect(tabStore.activeTabId).toBe("agents:agent:self")
    expect(hasTabBeenActive("agents:agent:self")).toBe(true)

    // The directory lands, and rehydration re-keys the open tab onto the handle.
    handle = "@taylor"
    rehydrateTabs()

    const tab = tabStore.tabs.find((t) => t.type === "agents:agent")!
    expect(tab.id).toBe("agents:agent:@taylor")
    expect(tabStore.activeTabId).toBe("agents:agent:@taylor")
    expect(hasTabBeenActive(tab.id)).toBe(true)
  })

  it("a sub route written under an alias keeps its sub route on the canonical tab", async () => {
    // `/agents/self/routines` (a tour, the Home sidebar) names the personal
    // agent's Routines tab; the tab lives under the handle, and the sub route
    // used to be dropped for the bare page.
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("agents:agent", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/agents/:entityId",
      defaultLabel: "Agent",
      preserveSubRoutes: true,
    })
    const { openTab, registerTabEntityAlias, tabStore } = await import("~/modules/shell/tab-store")
    registerTabEntityAlias("agents:agent", (entityId) =>
      entityId === "self" ? "@taylor" : entityId,
    )

    openTab({ type: "agents:agent", entityId: "@taylor", label: "Agent" })
    openTab({
      type: "agents:agent",
      entityId: "self",
      label: "Agent",
      routePath: "/agents/self/routines?selected=rt-1",
    })
    const tab = tabStore.tabs.find((t) => t.type === "agents:agent")!
    expect(tabStore.tabs.filter((t) => t.type === "agents:agent")).toHaveLength(1)
    expect(tab.routePath).toBe("/agents/@taylor/routines?selected=rt-1")

    // The shell's URL sync rebases the address bar's alias route the same way.
    const { canonicalTabRoute } = await import("~/modules/shell/tab-store")
    expect(canonicalTabRoute("agents:agent", "self", "/agents/self/routines")).toBe(
      "/agents/@taylor/routines",
    )
    expect(canonicalTabRoute("agents:agent", "@taylor", "/agents/@taylor/skills")).toBe(
      "/agents/@taylor/skills",
    )

    // A route of another agent is not rebased onto this one.
    openTab({
      type: "agents:agent",
      entityId: "self",
      label: "Agent",
      routePath: "/agents/selfish",
    })
    expect(tabStore.tabs.find((t) => t.type === "agents:agent")!.routePath).toBe("/agents/@taylor")
  })

  it("a deep link opened under an alias before it resolved lands on its own sub route once merged", async () => {
    // A gestalt walk: with the personal agent's tab restored on Routines,
    // `/agents/self/memory` opened before the directory named the handle made a
    // second `self` tab; the merge kept the restored tab and its Routines route,
    // so the link landed on Routines and the URL was rewritten to it.
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("agents:agent", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/agents/:entityId",
      defaultLabel: "Agent",
      preserveSubRoutes: true,
    })
    const { openTab, registerTabEntityAlias, recanonicalizeTabEntities, tabStore } = await import(
      "~/modules/shell/tab-store"
    )
    let directoryLoaded = false
    registerTabEntityAlias("agents:agent", (entityId) =>
      entityId === "self" && directoryLoaded ? "@taylor" : entityId,
    )

    openTab({
      type: "agents:agent",
      entityId: "@taylor",
      label: "Agent",
      routePath: "/agents/@taylor/routines",
      preview: false,
    })
    openTab({
      type: "agents:agent",
      entityId: "self",
      label: "Agent",
      routePath: "/agents/self/memory",
    })
    expect(tabStore.tabs.filter((t) => t.type === "agents:agent")).toHaveLength(2)

    directoryLoaded = true
    recanonicalizeTabEntities("agents:agent")

    const agentTabs = tabStore.tabs.filter((t) => t.type === "agents:agent")
    expect(agentTabs).toHaveLength(1)
    expect(tabStore.activeTabId).toBe(agentTabs[0]!.id)
    expect(agentTabs[0]!.routePath).toBe("/agents/@taylor/memory")
  })

  it("validateTabs evicts tabs whose validateEntity returns false", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
      validateEntity: async (entityId: string) => entityId !== "deleted-thread",
    })

    const { tabStore, openTab, validateTabs } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Valid Thread", preview: false })
    openTab({ type: "thread", entityId: "deleted-thread", label: "Deleted Thread", preview: false })
    expect(tabStore.tabs).toHaveLength(3) // Home + 2 threads

    await validateTabs()

    expect(tabStore.tabs).toHaveLength(2) // Home + valid thread
    expect(tabStore.tabs.find((t) => t.entityId === "deleted-thread")).toBeUndefined()
    expect(tabStore.tabs.find((t) => t.entityId === "t1")).toBeTruthy()
  })

  it("validateTabs does not evict tabs when validateEntity throws", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
      validateEntity: async () => {
        throw new Error("network error")
      },
    })

    const { tabStore, openTab, validateTabs } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    expect(tabStore.tabs).toHaveLength(2)

    await validateTabs()

    // Tab should survive — errors don't evict
    expect(tabStore.tabs).toHaveLength(2)
    expect(tabStore.tabs.find((t) => t.entityId === "t1")).toBeTruthy()
  })

  it("validateTabs skips singleton tabs", async () => {
    const validateFn = vi.fn(async () => false)
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("kernel:home", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
      validateEntity: validateFn,
    })

    const { tabStore, validateTabs } = await import("~/modules/shell/tab-store")
    await validateTabs()

    expect(validateFn).not.toHaveBeenCalled()
    expect(tabStore.tabs.find((t) => t.type === "kernel:home")).toBeTruthy()
  })

  it("validateTabs activates adjacent tab when active tab is evicted", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
      validateEntity: async (entityId: string) => entityId !== "stale",
    })

    const { tabStore, openTab, validateTabs } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "good", label: "Good", preview: false })
    openTab({ type: "thread", entityId: "stale", label: "Stale", preview: false })
    // Active is now "stale"
    expect(tabStore.activeTabId).toBe("thread:stale")

    await validateTabs()

    expect(tabStore.tabs.find((t) => t.entityId === "stale")).toBeUndefined()
    // Active should have moved to another tab
    expect(tabStore.activeTabId).not.toBe("thread:stale")
    expect(tabStore.tabs.find((t) => t.id === tabStore.activeTabId)).toBeTruthy()
  })

  it("validateTabs skips never-activated tabs; first activation triggers lazy validation (B2.1/L8)", async () => {
    const validateFn = vi.fn(async (entityId: string) => entityId !== "stale-bg")
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
      validateEntity: validateFn,
    })

    // Simulate a rehydrated session: 3 thread tabs restored from storage, only
    // one (the persisted activeTabId) has ever been activated in this runtime.
    // Seed the SHARED top-level `storage` stub (cleared by beforeEach) rather
    // than installing a fresh vi.stubGlobal — a per-test stub would leak into
    // every subsequent test because beforeEach only clears `storage`, it does
    // not re-install the original localStorage stub.
    storage["liaison:tabs"] = JSON.stringify({
      tabs: [
        { type: "kernel:home", entityId: "home", label: "Home", isPreview: false, routePath: "/" },
        { type: "thread", entityId: "active-one", label: "Active", isPreview: false },
        { type: "thread", entityId: "bg-one", label: "BG One", isPreview: false },
        { type: "thread", entityId: "stale-bg", label: "BG Stale", isPreview: false },
      ],
      activeTabId: "thread:active-one",
    })
    const { tabStore, validateTabs, activateTab } = await import("~/modules/shell/tab-store")

    await validateTabs()

    // Only the already-active tab was validated — the two background tabs
    // never mounted, so validating them now would be wasted reconnect-burst
    // work (finding L8).
    expect(validateFn).toHaveBeenCalledExactlyOnceWith("active-one")
    expect(tabStore.tabs.find((t) => t.entityId === "stale-bg")).toBeTruthy()

    // First activation of the stale background tab triggers its own lazy
    // validation exactly once, evicting it.
    activateTab("thread:stale-bg")
    await Promise.resolve() // flush the fire-and-forget validateEntity().then()
    await Promise.resolve()

    expect(validateFn).toHaveBeenCalledWith("stale-bg")
    expect(tabStore.tabs.find((t) => t.entityId === "stale-bg")).toBeUndefined()
  })

  it("persistence roundtrip: open tabs → persist → rehydrate", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
    })
    registerTabType("home", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })

    const { openTab, tabStore } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    openTab({ type: "thread", entityId: "t2", label: "Thread 2", preview: false })

    // Verify persist was called — data should be in storage
    expect(storage["liaison:tabs"]).toBeDefined()
    const persisted = JSON.parse(storage["liaison:tabs"])
    expect(persisted.tabs).toHaveLength(3) // Home + 2 threads
    expect(persisted.activeTabId).toBe("thread:t2")

    // Now reset modules to simulate a fresh page load, keeping storage intact
    vi.resetModules()

    // Re-register tab types (module state was cleared)
    const registry2 = await import("~/framework/app-registry")
    registry2.registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
    })
    registry2.registerTabType("kernel:home", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/",
      defaultLabel: "Home",
      singleton: true,
    })

    // Import tab-store fresh — it calls loadFromStorage() on init
    const { tabStore: restored } = await import("~/modules/shell/tab-store")

    expect(restored.tabs).toHaveLength(3)
    expect(restored.tabs.map((t) => t.id)).toEqual(["kernel:home:home", "thread:t1", "thread:t2"])
    expect(restored.activeTabId).toBe("thread:t2")
    expect(restored.tabs[1].label).toBe("Thread 1")
    expect(restored.tabs[2].label).toBe("Thread 2")
    // Restored tabs should never be previews
    expect(restored.tabs.every((t) => t.isPreview === false)).toBe(true)
  })

  it("evicted tabs are not added to recentlyClosed", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
      validateEntity: async (entityId: string) => entityId !== "gone",
    })

    const { tabStore, openTab, validateTabs } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "gone", label: "Gone Thread" })
    expect(tabStore.tabs).toHaveLength(2)

    await validateTabs()

    expect(tabStore.tabs.find((t) => t.entityId === "gone")).toBeUndefined()
    // evictTab does not track recently closed
    expect(tabStore.recentlyClosed.find((t) => t.entityId === "gone")).toBeUndefined()
  })

  it("closeTabsByTypes removes all tabs of given types", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("thread", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/threads/:entityId",
      defaultLabel: "Thread",
    })
    registerTabType("ticket", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
    })

    const { tabStore, openTab, closeTabsByTypes } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    openTab({ type: "ticket", entityId: "k1", label: "Ticket 1", preview: false })
    expect(tabStore.tabs).toHaveLength(3)

    closeTabsByTypes(["thread"])

    expect(tabStore.tabs).toHaveLength(2) // Home + ticket
    expect(tabStore.tabs.find((t) => t.type === "thread")).toBeUndefined()
    expect(tabStore.tabs.find((t) => t.type === "ticket")).toBeTruthy()
  })

  it("closing active tab activates left neighbor", async () => {
    const { tabStore, openTab, closeTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "T1", preview: false })
    openTab({ type: "thread", entityId: "t2", label: "T2", preview: false })
    openTab({ type: "thread", entityId: "t3", label: "T3", preview: false })
    // Active is t3 (last opened). Close it.
    const t3Id = tabStore.tabs.find((t) => t.entityId === "t3")!.id
    closeTab(t3Id)
    // Should activate t2 (left neighbor), not home
    expect(tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.entityId).toBe("t2")
  })

  it("closing the only tab falls back to home", async () => {
    const { tabStore, openTab, closeTab } = await import("~/modules/shell/tab-store")
    openTab({ type: "thread", entityId: "t1", label: "T1" })
    const t1Id = tabStore.tabs.find((t) => t.entityId === "t1")!.id
    // Remove the default home tab if present, leaving only t1
    const homeTabs = tabStore.tabs.filter((t) => t.type === "kernel:home")
    for (const h of homeTabs) closeTab(h.id)
    // Now close the only remaining tab
    closeTab(t1Id)
    // Should have created a new home tab as fallback
    expect(tabStore.tabs.length).toBe(1)
    expect(tabStore.tabs[0].type).toBe("kernel:home")
    expect(tabStore.activeTabId).toBe(tabStore.tabs[0].id)
  })

  // ─── Tab-Close Eviction (C1) ────────────────────────────────────────

  it("closeTab evicts entity data when the last tab for that entity closes", async () => {
    const { tabStore, openTab, closeTab, registerTabEvictor } = await import(
      "~/modules/shell/tab-store"
    )
    const evictor = vi.fn()
    registerTabEvictor("thread", evictor)

    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    closeTab("thread:t1")

    expect(evictor).toHaveBeenCalledExactlyOnceWith("t1")
    expect(tabStore.tabs.find((t) => t.entityId === "t1")).toBeUndefined()
  })

  it("closeTab does NOT evict entity data for a DIFFERENT entity that's still open", async () => {
    const { tabStore, openTab, closeTab, registerTabEvictor } = await import(
      "~/modules/shell/tab-store"
    )
    const evictor = vi.fn()
    registerTabEvictor("thread", evictor)

    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    openTab({ type: "thread", entityId: "t2", label: "Thread 2", preview: false })
    // Close t2 — its own entity data must evict, but t1 (still open) must not.
    closeTab("thread:t2")

    expect(evictor).toHaveBeenCalledExactlyOnceWith("t2")
    expect(evictor).not.toHaveBeenCalledWith("t1")
    expect(tabStore.tabs.find((t) => t.entityId === "t1")).toBeTruthy()
  })

  it("evictTabByEntity's silent removal also respects the shared-entity guard", async () => {
    // openTab dedupes by (type, entityId), so a genuine "two open tabs, same
    // entity" state can't arise through the public API — the guard's only
    // observable behavior is therefore "does the evictor fire once the
    // specific (type, entityId) has zero open tabs left", covered by the two
    // tests above. This test pins evictTabByEntity to the same contract.
    const { tabStore, openTab, evictTabByEntity, registerTabEvictor } = await import(
      "~/modules/shell/tab-store"
    )
    const evictor = vi.fn()
    registerTabEvictor("thread", evictor)

    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    openTab({ type: "thread", entityId: "t2", label: "Thread 2", preview: false })
    evictTabByEntity("thread", "t1")

    expect(evictor).toHaveBeenCalledExactlyOnceWith("t1")
    expect(tabStore.tabs.find((t) => t.entityId === "t2")).toBeTruthy()
  })

  it("evictTabByEntity evicts entity data via the same last-tab-closes guard", async () => {
    const { tabStore, openTab, evictTabByEntity, registerTabEvictor } = await import(
      "~/modules/shell/tab-store"
    )
    const evictor = vi.fn()
    registerTabEvictor("knowledge:document", evictor)

    openTab({ type: "knowledge:document", entityId: "doc-x", label: "Doc X" })
    evictTabByEntity("knowledge:document", "doc-x")

    expect(evictor).toHaveBeenCalledExactlyOnceWith("doc-x")
    expect(tabStore.tabs.find((t) => t.entityId === "doc-x")).toBeUndefined()
  })

  it("closeTabsByTypes evicts every matching entity (app uninstall)", async () => {
    const { registerTabType } = await import("~/framework/app-registry")
    registerTabType("ticket", {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
    })
    const { tabStore, openTab, closeTabsByTypes, registerTabEvictor } = await import(
      "~/modules/shell/tab-store"
    )
    const evictor = vi.fn()
    registerTabEvictor("ticket", evictor)

    openTab({ type: "ticket", entityId: "k1", label: "Ticket 1", preview: false })
    openTab({ type: "ticket", entityId: "k2", label: "Ticket 2", preview: false })
    closeTabsByTypes(["ticket"])

    expect(evictor).toHaveBeenCalledTimes(2)
    expect(evictor).toHaveBeenCalledWith("k1")
    expect(evictor).toHaveBeenCalledWith("k2")
    expect(tabStore.tabs.find((t) => t.type === "ticket")).toBeUndefined()
  })

  it("singleton tabs (home) have no evictor registered — closing is a no-op", async () => {
    const { tabStore, openTab, closeTab } = await import("~/modules/shell/tab-store")
    // Open a second tab so closing home doesn't trigger the auto-reopen fallback.
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })
    // No evictor registered for "kernel:home" — closeTab must not throw.
    expect(() => closeTab("kernel:home:home")).not.toThrow()
    expect(tabStore.tabs.find((t) => t.type === "kernel:home")).toBeUndefined()
  })

  it("reopening after eviction refetches cleanly (no dangling loaded-flag)", async () => {
    const { tabStore, openTab, closeTab, registerTabEvictor } = await import(
      "~/modules/shell/tab-store"
    )
    // Model a store's own loaded-flag map the evictor is responsible for clearing.
    const loaded = new Set<string>(["t1"])
    registerTabEvictor("thread", (entityId) => loaded.delete(entityId))

    openTab({ type: "thread", entityId: "t1", label: "Thread 1", preview: false })
    closeTab("thread:t1")
    expect(loaded.has("t1")).toBe(false)

    // Reopening creates a fresh tab — nothing dangling from the evicted state.
    openTab({ type: "thread", entityId: "t1", label: "Thread 1 Reopened", preview: false })
    expect(tabStore.tabs.find((t) => t.entityId === "t1")?.label).toBe("Thread 1 Reopened")
  })

  it("reopenLastClosed skips if tab already open", async () => {
    const { tabStore, openTab, closeTab, reopenLastClosed } = await import(
      "~/modules/shell/tab-store"
    )
    openTab({ type: "thread", entityId: "t1", label: "T1" })
    const t1Id = tabStore.tabs.find((t) => t.entityId === "t1")!.id
    closeTab(t1Id)
    // Re-open via URL navigation (simulated by openTab)
    openTab({ type: "thread", entityId: "t1", label: "T1" })
    const countBefore = tabStore.tabs.length
    reopenLastClosed()
    // Should NOT create a duplicate
    expect(tabStore.tabs.length).toBe(countBefore)
  })

  it("closing other tabs or tabs to the right asks first when one of them holds unsaved work", async () => {
    const { tabStore, openTab, closeOtherTabs, closeTabsToRight } = await import(
      "~/modules/shell/tab-store"
    )
    const work = await import("~/lib/unsaved-work")
    openTab({ type: "thread", entityId: "t1", label: "One", preview: false })
    openTab({ type: "thread", entityId: "t2", label: "Two", preview: false })
    openTab({ type: "thread", entityId: "t3", label: "Three", preview: false })
    work.registerUnsavedWork("draft", { tabId: "thread:t3", describe: () => "A draft" })

    closeOtherTabs("thread:t1")
    expect(work.pendingDiscard()?.items).toEqual(["A draft"])
    expect(tabStore.tabs).toHaveLength(4)
    work.resolveDiscard(false)
    expect(tabStore.tabs).toHaveLength(4)

    // Only the tabs that would close count: t3's draft is not to the right of t3.
    closeTabsToRight("thread:t2")
    expect(work.pendingDiscard()?.items).toEqual(["A draft"])
    work.resolveDiscard(true)
    expect(tabStore.tabs.map((t) => t.id)).toEqual(["kernel:home:home", "thread:t1", "thread:t2"])

    work.registerUnsavedWork("draft", { tabId: "thread:t1", describe: () => "A draft" })
    closeTabsToRight("thread:t1")
    expect(work.pendingDiscard()).toBeNull()
    expect(tabStore.tabs.map((t) => t.id)).toEqual(["kernel:home:home", "thread:t1"])
    work.resetUnsavedWork()
  })
})
