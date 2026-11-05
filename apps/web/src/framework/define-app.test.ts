// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock localStorage before importing stores
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

describe("defineApp — frontend contract", () => {
  beforeEach(async () => {
    vi.resetModules()
    for (const key of Object.keys(storage)) delete storage[key]
    const { resetRegistry } = await import("~/framework/app-registry")
    const { resetAppIndex } = await import("~/framework/define-app")
    resetRegistry()
    resetAppIndex()
  })

  it("registerApp registers all primitives from an AppDefinition", async () => {
    const { registerApp } = await import("~/framework/define-app")
    const {
      getTabType,
      getActivityBarEntries,
      getCommands,
      getWsEntityHandlers,
      getWsMessageHandlers,
      getKeybindings,
    } = await import("~/framework/app-registry")

    registerApp({
      name: "test-app",
      tabTypes: {
        "test-item": {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/test-items/:entityId",
          defaultLabel: "Test Item",
        },
      },
      activityBar: { icon: () => null, label: "Test", order: 20 },
      commands: [{ id: "test:create", label: "Create test item", execute: () => {} }],
      wsHandlers: {
        "test-item": [
          { owner: "projection", handler: () => {} },
          { owner: "analytics", handler: () => {} },
        ],
      },
      wsMessages: { presence_sync: () => {} },
      keybindings: [
        { id: "test:new", key: "mod+shift+n", label: "New test item", handler: () => {} },
      ],
    })

    expect(getTabType("test-item")).toBeDefined()
    expect(getActivityBarEntries().find((e) => e.appId === "test-app")).toBeDefined()
    expect(getCommands().find((c) => c.localId === "test:create")).toBeDefined()
    expect(getWsEntityHandlers("test-app:test-item")).toHaveLength(2)
    expect(getWsMessageHandlers("presence_sync")).toHaveLength(1)
    expect(getKeybindings().find((k) => k.localId === "test:new")).toBeDefined()
  })

  it("registerApp without optional fields does not throw", async () => {
    const { registerApp } = await import("~/framework/define-app")
    expect(() => registerApp({ name: "minimal-app" })).not.toThrow()
  })

  it("unregisterApp cleans up all registrations", async () => {
    const { registerApp, unregisterApp } = await import("~/framework/define-app")
    const {
      getTabType,
      getActivityBarEntries,
      getWsEntityHandlers,
      getWsMessageHandlers,
      getCommands,
      getKeybindings,
    } = await import("~/framework/app-registry")

    registerApp({
      name: "removable",
      tabTypes: {
        "removable-item": {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/removable/:entityId",
          defaultLabel: "Item",
        },
      },
      activityBar: { icon: () => null, label: "Removable", order: 50 },
      commands: [{ id: "removable:create", label: "Create item", execute: () => {} }],
      wsHandlers: { "removable-item": () => {} },
      wsMessages: { presence_sync: () => {} },
      keybindings: [
        { id: "removable:new", key: "mod+shift+r", label: "New item", handler: () => {} },
      ],
    })
    expect(getTabType("removable-item")).toBeDefined()
    expect(getCommands().find((c) => c.localId === "removable:create")).toBeDefined()
    expect(getKeybindings().find((k) => k.localId === "removable:new")).toBeDefined()

    unregisterApp("removable")
    expect(getTabType("removable-item")).toBeUndefined()
    expect(getActivityBarEntries().find((e) => e.appId === "removable")).toBeUndefined()
    expect(getWsEntityHandlers("removable:removable-item")).toHaveLength(0)
    expect(getWsMessageHandlers("presence_sync")).toHaveLength(0)
    expect(getCommands().find((c) => c.localId === "removable:create")).toBeUndefined()
    expect(getKeybindings().find((k) => k.localId === "removable:new")).toBeUndefined()
  })

  // G1 — a manifest app (tickets) attaches a phone header / hidden-bar marker
  // to one of its OWN tab types at runtime, after `registerApp()` has already
  // registered it (mirrors `registerAppHooks()`, called right after a
  // manifest's `registerAppFromManifest()`).
  it("registerAppPhoneHeader attaches a header to the app's qualified tab type", async () => {
    const { registerApp, registerAppPhoneHeader } = await import("~/framework/define-app")
    const { getPhoneHeader } = await import("~/framework/app-registry")

    registerApp({
      name: "tickets",
      tabTypes: {
        ticket: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/tickets/:entityId",
          defaultLabel: "Ticket",
        },
      },
    })
    const Header = () => null
    registerAppPhoneHeader("tickets", "ticket", Header)
    expect(getPhoneHeader("tickets:ticket")).toBe(Header)
  })

  it("registerAppPhoneTopBarHidden marks the app's qualified tab type", async () => {
    const { registerApp, registerAppPhoneTopBarHidden } = await import("~/framework/define-app")
    const { getPhoneTopBarHidden } = await import("~/framework/app-registry")

    registerApp({
      name: "tickets",
      tabTypes: {
        inbox: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/tickets",
          defaultLabel: "Tickets",
        },
      },
    })
    registerAppPhoneTopBarHidden("tickets", "inbox")
    expect(getPhoneTopBarHidden("tickets:inbox")).toBe(true)
  })

  it("unregisterApp tears down phone headers registered via registerAppPhoneHeader", async () => {
    const { registerApp, registerAppPhoneHeader, unregisterApp } = await import(
      "~/framework/define-app"
    )
    const { getPhoneHeader } = await import("~/framework/app-registry")

    registerApp({
      name: "tickets",
      tabTypes: {
        ticket: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/tickets/:entityId",
          defaultLabel: "Ticket",
        },
      },
    })
    registerAppPhoneHeader("tickets", "ticket", () => null)
    expect(getPhoneHeader("tickets:ticket")).toBeDefined()

    unregisterApp("tickets")
    expect(getPhoneHeader("tickets:ticket")).toBeUndefined()
  })

  it("records a tab type once however many times a phone header is attached to it", async () => {
    const {
      registerApp,
      registerAppPhoneHeader,
      registerAppPhoneTopBarHidden,
      DefineAppTestAccess,
    } = await import("~/framework/define-app")

    registerApp({
      name: "tickets",
      tabTypes: {
        ticket: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/tickets/:entityId",
          defaultLabel: "Ticket",
        },
      },
    })
    // A header and a hidden-bar marker on the same tab type, and a re-sync
    // that attaches the header again: the teardown index kept one entry per
    // CALL, so it grew without bound and unregisterApp swept the same type
    // several times over.
    registerAppPhoneHeader("tickets", "ticket", () => null)
    registerAppPhoneHeader("tickets", "ticket", () => null)
    registerAppPhoneTopBarHidden("tickets", "ticket")

    expect(DefineAppTestAccess.phoneHeaderTypes("tickets")).toEqual(["tickets:ticket"])
  })

  it("an idempotent registerApp refresh carries the phone header forward", async () => {
    const { registerApp, registerAppPhoneHeader } = await import("~/framework/define-app")
    const { getPhoneHeader } = await import("~/framework/app-registry")

    const def = {
      name: "tickets",
      tabTypes: {
        ticket: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/tickets/:entityId",
          defaultLabel: "Ticket",
        },
      },
    }
    registerApp(def)
    const Header = () => null
    registerAppPhoneHeader("tickets", "ticket", Header)
    // A second registerApp() call for the SAME app (a manifest re-sync) never
    // re-runs registerAppHooks() for an already-registered app, so the header
    // must survive without a second registerAppPhoneHeader call.
    registerApp(def)
    expect(getPhoneHeader("tickets:ticket")).toBe(Header)
  })

  it("activity bar defaults tabAction to first registered tab type", async () => {
    const { registerApp } = await import("~/framework/define-app")
    const { getActivityBarEntries } = await import("~/framework/app-registry")

    registerApp({
      name: "tickets",
      tabTypes: {
        ticket: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/tickets/:entityId",
          defaultLabel: "Ticket",
        },
      },
      activityBar: { icon: () => null, label: "Tickets", order: 20 },
    })

    const entry = getActivityBarEntries().find((e) => e.appId === "tickets")
    expect(entry?.tabAction.type).toBe("tickets:ticket")
  })

  it("unregisterApp closes tabs of that app's tab types", async () => {
    const { registerApp, unregisterApp } = await import("~/framework/define-app")
    const { tabStore, openTab } = await import("~/modules/shell/tab-store")

    registerApp({
      name: "tickets",
      tabTypes: {
        ticket: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/tickets/:entityId",
          defaultLabel: "Ticket",
        },
      },
    })

    // Open a tab of the app's type (namespaced as "tickets:ticket")
    openTab({ type: "ticket", entityId: "k1", label: "Ticket 1" })
    expect(tabStore.tabs.find((t) => t.entityId === "k1")).toBeTruthy()

    // Also open a thread tab (unrelated) to verify it survives
    openTab({ type: "thread", entityId: "t1", label: "Thread 1" })

    unregisterApp("tickets")

    // Ticket tab should be gone
    expect(tabStore.tabs.find((t) => t.entityId === "k1")).toBeUndefined()
    // Thread tab should survive
    expect(tabStore.tabs.find((t) => t.entityId === "t1")).toBeTruthy()
    // Home should still be present
    expect(tabStore.tabs.find((t) => t.id === "kernel:home:home")).toBeTruthy()
  })

  it("unregisterApp activates Home when the active tab belonged to the removed app", async () => {
    const { registerApp, unregisterApp } = await import("~/framework/define-app")
    const { tabStore, openTab } = await import("~/modules/shell/tab-store")

    registerApp({
      name: "tickets",
      tabTypes: {
        ticket: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/tickets/:entityId",
          defaultLabel: "Ticket",
        },
      },
    })

    openTab({ type: "ticket", entityId: "k1", label: "Ticket 1" })
    // Active tab is the ticket
    expect(tabStore.activeTabId).toBe("tickets:ticket:k1")

    unregisterApp("tickets")

    // Active should fall back (not point to a removed tab)
    expect(tabStore.tabs.find((t) => t.id === tabStore.activeTabId)).toBeTruthy()
  })

  it("re-registering an app preserves tabs for unchanged tab types", async () => {
    const { registerApp } = await import("~/framework/define-app")
    const { tabStore, openTab, tabToUrl } = await import("~/modules/shell/tab-store")

    const definition = {
      name: "mail",
      tabTypes: {
        conversation: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/mail/:entityId",
          defaultLabel: "Conversation",
        },
      },
    }

    registerApp(definition)
    openTab({ type: "mail:conversation", entityId: "conv-1", label: "Conversation" })
    expect(tabStore.activeTabId).toBe("mail:conversation:conv-1")

    registerApp(definition)

    expect(tabStore.activeTabId).toBe("mail:conversation:conv-1")
    expect(tabStore.tabs.find((t) => t.id === "mail:conversation:conv-1")).toBeTruthy()
    expect(tabToUrl(tabStore.tabs.find((t) => t.id === "mail:conversation:conv-1")!)).toBe(
      "/mail/conv-1",
    )
  })

  it("re-registering an app closes tabs only for removed tab types", async () => {
    const { registerApp } = await import("~/framework/define-app")
    const { tabStore, openTab } = await import("~/modules/shell/tab-store")

    registerApp({
      name: "tickets",
      tabTypes: {
        detail: {
          component: () => null,
          sidebar: null,
          icon: () => null,
          urlPattern: "/tickets/:entityId",
          defaultLabel: "Ticket",
        },
      },
    })
    openTab({ type: "detail", entityId: "t1", label: "Ticket" })

    registerApp({ name: "tickets", tabTypes: {} })

    expect(tabStore.tabs.find((t) => t.id === "tickets:detail:t1")).toBeUndefined()
  })
})

describe("WS handler namespacing", () => {
  it("namespaces wsHandler keys with app name", async () => {
    const { registerApp } = await import("~/framework/define-app")
    const { getWsEntityHandlers } = await import("~/framework/app-registry")

    const handler = () => {}
    registerApp({
      name: "mail",
      wsHandlers: { conversation: handler },
    })

    // Handler registered under "mail:conversation", not bare "conversation"
    expect(getWsEntityHandlers("mail:conversation")).toHaveLength(1)
    expect(getWsEntityHandlers("conversation")).toHaveLength(0)
  })

  it("registerAppFromManifest uses explicit websocket handler keys", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { dispatchWsEntityEvent } = await import("~/framework/app-registry")
    let received: unknown = null

    registerAppFromManifest(
      {
        name: "contacts",
        views: {
          wsHandlers: { contact: { key: "kernel:contact", handler: "handleContactEvent" } as any },
        },
      },
      {
        handleContactEvent: (action: string, data: unknown) => {
          received = { action, data }
        },
      },
    )

    dispatchWsEntityEvent(
      "kernel:contact",
      "create",
      { id: "c1" },
      {
        currentUserId: "u1",
        activeTabId: null,
        isDocumentVisible: true,
        isOwnAction: false,
      },
    )
    expect(received).toEqual({ action: "create", data: { id: "c1" } })

    received = null
    dispatchWsEntityEvent(
      "contacts:contact",
      "create",
      { id: "c2" },
      {
        currentUserId: "u1",
        activeTabId: null,
        isDocumentVisible: true,
        isOwnAction: false,
      },
    )
    expect(received).toBeNull()
  })
})

describe("registerAppFromManifest label resolvers", () => {
  it("resolves dynamic tab labels from trusted app exports", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { getTabType } = await import("~/framework/app-registry")
    const resolveContactTabLabel = vi.fn(() => "Hans Weber")

    registerAppFromManifest(
      {
        name: "contacts",
        views: {
          tabTypes: {
            "contact-detail": {
              component: "ContactDetail",
              resolveLabel: "resolveContactTabLabel",
            } as any,
          },
        },
      },
      { ContactDetail: () => null, resolveContactTabLabel },
    )

    expect(getTabType("contacts:contact-detail")?.resolveLabel?.("c1")).toBe("Hans Weber")
    expect(resolveContactTabLabel).toHaveBeenCalledWith("c1")
  })

  it("uses the manifest label as defaultLabel (regression: URL-opened tabs were named after the raw type)", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { getTabType } = await import("~/framework/app-registry")

    registerAppFromManifest(
      {
        name: "invoicing",
        views: {
          tabTypes: {
            documents: {
              component: "DocumentsList",
              label: "Documents",
              urlPattern: "/invoicing/documents/:typeFilter",
            } as any,
            editor: {
              component: "DocumentsList",
              urlPattern: "/invoicing/editor/:documentId",
            } as any,
          },
        },
      },
      { DocumentsList: () => null },
    )

    expect(getTabType("invoicing:documents")?.defaultLabel).toBe("Documents")
    // No manifest label → type name fallback (previous behavior).
    expect(getTabType("invoicing:editor")?.defaultLabel).toBe("editor")
  })
})

describe("manifest.referenceable", () => {
  it("manifest.referenceable-hydration", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { getTabType } = await import("~/framework/app-registry")

    registerAppFromManifest(
      {
        name: "x",
        views: {
          tabTypes: {
            foo: {
              component: "Cmp",
              icon: "Icon",
              urlPattern: "/x",
              referenceable: true,
            } as any,
          },
        },
      },
      { Cmp: () => null, Icon: () => null },
    )
    expect(getTabType("x:foo")?.referenceable).toBe(true)
  })

  it("tab-store.referenceable-default-and-explicit", async () => {
    const { registerTabType, getTabType } = await import("~/framework/app-registry")
    const component = () => null
    const icon = () => null

    registerTabType("a:b", {
      component,
      sidebar: null,
      icon,
      urlPattern: "/",
      defaultLabel: "x",
    })
    expect(getTabType("a:b")?.referenceable).toBeFalsy()

    registerTabType("a:c", {
      component,
      sidebar: null,
      icon,
      urlPattern: "/",
      defaultLabel: "x",
      referenceable: true,
    })
    expect(getTabType("a:c")?.referenceable).toBe(true)
  })
})

// An app whose manifest declares its icon as data shows that icon in the page too, so it looks
// the same in a browser (in-page) and in a shell that frames it.
describe("registerAppFromManifest declared icon", () => {
  it("draws the manifest's iconName in the page, not the app's own icon export", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { getActivityBarEntries, getTabType } = await import("~/framework/app-registry")
    const { render } = await import("@solidjs/testing-library")
    const OwnIcon = vi.fn(() => null)
    registerAppFromManifest(
      {
        name: "kpi-icon",
        iconName: "bar-chart",
        views: {
          activityBar: { icon: "OwnIcon", label: "KPI", order: 70 },
          tabTypes: {
            definitions: { component: "Main", icon: "OwnIcon", urlPattern: "/kpi-icon-x" },
          },
        },
      } as any,
      { OwnIcon, Main: () => null },
    )
    const Rail = getActivityBarEntries().find((e) => e.appId === "kpi-icon")?.icon
    const Tab = getTabType("kpi-icon:definitions")?.icon
    for (const Icon of [Rail, Tab]) {
      expect(Icon).toBeDefined()
      const { container, unmount } = render(() => (Icon as any)({ size: 16 }))
      expect(container.querySelector('[data-icon-name="bar-chart"]')).not.toBeNull()
      unmount()
    }
    expect(OwnIcon).not.toHaveBeenCalled()
  })
})

// An installed app's tab pattern decides which page URL opens its tab (and so what its frame
// may navigate to and receives): one that is not its own is skipped, whatever the server let in.
describe("registerAppFromManifest tab patterns of an installed app", () => {
  it("skips a pattern under another app, a Liaison page or a leading parameter, and keeps its own", async () => {
    vi.resetModules()
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { getTabType, urlToTabInfo } = await import("~/framework/app-registry")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    registerAppFromManifest(
      {
        name: "mail",
        views: {
          tabTypes: {
            inbox: { component: "C", urlPattern: "/mail" },
            conversation: { component: "C", urlPattern: "/mail/:entityId" },
          },
        },
      },
      { C: () => null },
    )
    registerAppFromManifest(
      {
        name: "evil",
        views: {
          tabTypes: {
            steal: { component: "C", urlPattern: "/mail/:entityIdXXXXXXXX" },
            page: { component: "C", urlPattern: "/settings/:x" },
            any: { component: "C", urlPattern: "/:a/:b" },
            own: { component: "C", urlPattern: "/evil/:entityId" },
          },
        },
      },
      { C: () => null },
      { external: true },
    )
    registerAppFromManifest(
      {
        name: "kpi",
        views: {
          tabTypes: { definitions: { component: "C", urlPattern: "/kpi-catalogue/:entityId+" } },
        },
      },
      { C: () => null },
      { external: true },
    )
    expect(getTabType("evil:steal")).toBeUndefined()
    expect(getTabType("evil:page")).toBeUndefined()
    expect(getTabType("evil:any")).toBeUndefined()
    expect(getTabType("evil:own")?.urlPattern).toBe("/evil/:entityId")
    expect(getTabType("kpi:definitions")?.urlPattern).toBe("/kpi-catalogue/:entityId+")
    expect(urlToTabInfo("/mail/abc")?.type).toBe("mail:conversation")
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "tab urlPattern '/mail/:entityIdXXXXXXXX' is under '/mail', which belongs to the app 'mail'",
      ),
    )
    warn.mockRestore()
  })

  it("skips a pattern another installed app's manifest owns, whichever registers first", async () => {
    vi.resetModules()
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { getTabType } = await import("~/framework/app-registry")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const kpi = {
      name: "kpi",
      views: {
        tabTypes: { definitions: { component: "C", urlPattern: "/kpi-catalogue/:entityId+" } },
      },
    }
    registerAppFromManifest(
      {
        name: "evil",
        views: { tabTypes: { steal: { component: "C", urlPattern: "/kpi-catalogue/:x" } } },
      },
      { C: () => null },
      { external: true, routeOwners: [{ name: "kpi", manifest: kpi }] },
    )
    expect(getTabType("evil:steal")).toBeUndefined()
  })
})
