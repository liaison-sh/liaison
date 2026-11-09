// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"

describe("app-registry", () => {
  beforeEach(async () => {
    const { resetRegistry } = await import("~/framework/app-registry")
    resetRegistry()
  })

  describe("tab type registry", () => {
    it("registers and retrieves a tab type", async () => {
      const { registerTabType, getTabType } = await import("~/framework/app-registry")
      registerTabType("thread", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/threads/:entityId",
        defaultLabel: "Thread",
      })
      expect(getTabType("thread")).toBeDefined()
      expect(getTabType("thread")?.defaultLabel).toBe("Thread")
    })

    it("returns undefined for unregistered type", async () => {
      const { getTabType } = await import("~/framework/app-registry")
      expect(getTabType("nonexistent")).toBeUndefined()
    })

    it("reset clears all registrations", async () => {
      const { registerTabType, getTabType, resetRegistry } = await import(
        "~/framework/app-registry"
      )
      registerTabType("thread", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/threads/:entityId",
        defaultLabel: "Thread",
      })
      resetRegistry()
      expect(getTabType("thread")).toBeUndefined()
    })

    it("does not let one app alias overwrite another app's local tab type", async () => {
      const { registerTabType, getTabType } = await import("~/framework/app-registry")
      registerTabType("sales:detail", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/sales/:entityId",
        defaultLabel: "Sales Detail",
        appId: "sales",
        localType: "detail",
      })
      registerTabType("support:detail", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/support/:entityId",
        defaultLabel: "Support Detail",
        appId: "support",
        localType: "detail",
      })

      expect(getTabType("detail")).toBeUndefined()
      expect(getTabType("sales:detail")?.defaultLabel).toBe("Sales Detail")
      expect(getTabType("support:detail")?.defaultLabel).toBe("Support Detail")
    })
  })

  // G1 — a manifest tab type has no way to declare `phoneHeader` /
  // `hidePhoneTopBar` on its own registration (a component reference cannot
  // travel through the manifest's JSON), so this side registry lets a module
  // attach one at runtime after the tab type is registered.
  describe("phone header registry", () => {
    it("has no header or hidden bar for an unregistered tab type", async () => {
      const { getPhoneHeader, getPhoneTopBarHidden } = await import("~/framework/app-registry")
      expect(getPhoneHeader("tickets:ticket")).toBeUndefined()
      expect(getPhoneTopBarHidden("tickets:ticket")).toBe(false)
    })

    it("registers and retrieves a phone header for a tab type", async () => {
      const { registerPhoneHeader, getPhoneHeader } = await import("~/framework/app-registry")
      const Header = () => null
      registerPhoneHeader("tickets:ticket", Header)
      expect(getPhoneHeader("tickets:ticket")).toBe(Header)
    })

    it("registers a tab type as hiding the phone top bar", async () => {
      const { registerPhoneTopBarHidden, getPhoneTopBarHidden } = await import(
        "~/framework/app-registry"
      )
      registerPhoneTopBarHidden("tickets:inbox")
      expect(getPhoneTopBarHidden("tickets:inbox")).toBe(true)
    })

    it("unregister removes a registered header", async () => {
      const { registerPhoneHeader, unregisterPhoneHeader, getPhoneHeader } = await import(
        "~/framework/app-registry"
      )
      registerPhoneHeader("tickets:ticket", () => null)
      unregisterPhoneHeader("tickets:ticket")
      expect(getPhoneHeader("tickets:ticket")).toBeUndefined()
    })

    it("reset clears all phone header registrations", async () => {
      const { registerPhoneHeader, getPhoneHeader, resetRegistry } = await import(
        "~/framework/app-registry"
      )
      registerPhoneHeader("tickets:ticket", () => null)
      resetRegistry()
      expect(getPhoneHeader("tickets:ticket")).toBeUndefined()
    })
  })

  describe("matchUrlPattern", () => {
    it("matches dynamic pattern /threads/:entityId", async () => {
      const { matchUrlPattern } = await import("~/framework/app-registry")
      expect(matchUrlPattern("/threads/:entityId", "/threads/abc")).toEqual({ entityId: "abc" })
    })

    it("rejects non-matching dynamic pattern", async () => {
      const { matchUrlPattern } = await import("~/framework/app-registry")
      expect(matchUrlPattern("/threads/:entityId", "/settings")).toBeNull()
    })

    it("matches static pattern with sub-routes", async () => {
      const { matchUrlPattern } = await import("~/framework/app-registry")
      expect(matchUrlPattern("/settings", "/settings/security")).toEqual({ entityId: "settings" })
    })

    it("matches exact static pattern", async () => {
      const { matchUrlPattern } = await import("~/framework/app-registry")
      expect(matchUrlPattern("/settings", "/settings")).toEqual({ entityId: "settings" })
    })

    it("matches root / only for exact path", async () => {
      const { matchUrlPattern } = await import("~/framework/app-registry")
      expect(matchUrlPattern("/", "/")).toEqual({ entityId: "home" })
      expect(matchUrlPattern("/", "/threads/abc")).toBeNull()
    })
  })

  describe("urlToTabInfo — specificity sort", () => {
    it("matches dynamic patterns before static prefix patterns", async () => {
      const { registerTabType, urlToTabInfo } = await import("~/framework/app-registry")
      registerTabType("home", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/",
        defaultLabel: "Home",
        singleton: true,
      })
      registerTabType("thread", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/threads/:entityId",
        defaultLabel: "Thread",
      })
      registerTabType("settings", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/settings",
        defaultLabel: "Settings",
        singleton: true,
      })
      expect(urlToTabInfo("/threads/abc")).toEqual({
        type: "thread",
        entityId: "abc",
        label: "Thread",
      })
      expect(urlToTabInfo("/settings/security")).toEqual({
        type: "settings",
        entityId: "settings",
        label: "Settings",
      })
      expect(urlToTabInfo("/")).toEqual({ type: "home", entityId: "home", label: "Home" })
    })

    // T1: dynamic pattern wins over static prefix when both could match
    it("prefers dynamic pattern over static prefix for same base path", async () => {
      const { registerTabType, urlToTabInfo } = await import("~/framework/app-registry")
      registerTabType("things-list", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/things",
        defaultLabel: "Things",
      })
      registerTabType("thing-detail", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/things/:entityId",
        defaultLabel: "Thing",
      })
      expect(urlToTabInfo("/things/abc")).toEqual({
        type: "thing-detail",
        entityId: "abc",
        label: "Thing",
      })
    })

    // A `preserveSubRoutes` owner answers its own sub routes, but a deeper
    // pattern that matches the WHOLE path still wins: `/projects/tasks/<id>`
    // is the task tab, not `/projects/:entityId` with entityId "tasks".
    it("prefers a deeper full-path pattern over a preserveSubRoutes owner", async () => {
      const { registerTabType, urlToTabInfo } = await import("~/framework/app-registry")
      registerTabType("projects:project", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/projects/:entityId",
        defaultLabel: "Project",
        preserveSubRoutes: true,
      })
      registerTabType("projects:task", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/projects/tasks/:entityId",
        defaultLabel: "Task",
      })
      registerTabType("agent-page", {
        component: () => null,
        sidebar: null,
        icon: () => null,
        urlPattern: "/agents/:entityId",
        defaultLabel: "Agent",
        preserveSubRoutes: true,
      })

      expect(urlToTabInfo("/projects/tasks/11111111-2222-3333-4444-555555555555")).toEqual({
        type: "projects:task",
        entityId: "11111111-2222-3333-4444-555555555555",
        label: "Task",
      })
      expect(urlToTabInfo("/projects/abc")).toEqual({
        type: "projects:project",
        entityId: "abc",
        label: "Project",
      })
      // The agent page's sub routes have no competing full-path pattern, so
      // the cut-back fallback still owns them.
      expect(urlToTabInfo("/agents/@x/skills")).toEqual({
        type: "agent-page",
        entityId: "@x",
        label: "Agent",
      })
    })
  })

  describe("matchesKey — cross-platform", () => {
    it("mod+ matches metaKey on Mac", async () => {
      const { matchesKey } = await import("~/framework/app-registry")
      const e = new KeyboardEvent("keydown", { key: "k", metaKey: true })
      expect(matchesKey(e, "mod+k")).toBe(true)
    })

    it("mod+ matches ctrlKey on non-Mac", async () => {
      const { matchesKey } = await import("~/framework/app-registry")
      const e = new KeyboardEvent("keydown", { key: "k", ctrlKey: true })
      // In jsdom, navigator.platform is empty (non-Mac)
      expect(matchesKey(e, "mod+k")).toBe(true)
    })

    it("plain key matches without modifiers", async () => {
      const { matchesKey } = await import("~/framework/app-registry")
      const e = new KeyboardEvent("keydown", { key: "n" })
      expect(matchesKey(e, "n")).toBe(true)
    })

    it("rejects when modifier is missing", async () => {
      const { matchesKey } = await import("~/framework/app-registry")
      const e = new KeyboardEvent("keydown", { key: "k" })
      expect(matchesKey(e, "mod+k")).toBe(false)
    })

    it("plain key spec rejects when modifier is present", async () => {
      const { matchesKey } = await import("~/framework/app-registry")
      expect(matchesKey(new KeyboardEvent("keydown", { key: "n", metaKey: true }), "n")).toBe(false)
      expect(matchesKey(new KeyboardEvent("keydown", { key: "n", ctrlKey: true }), "n")).toBe(false)
    })
  })

  describe("keybinding registry — unregister", () => {
    it("unregisterKeybinding removes by id", async () => {
      const { registerKeybinding, unregisterKeybinding, getKeybindings } = await import(
        "~/framework/app-registry"
      )
      registerKeybinding({ id: "test", key: "n", label: "Test", handler: () => {} })
      expect(getKeybindings()).toHaveLength(1)
      unregisterKeybinding("test")
      expect(getKeybindings()).toHaveLength(0)
    })

    it("keeps colliding app keybindings distinct by namespaced id", async () => {
      const { registerKeybinding, getKeybindings } = await import("~/framework/app-registry")
      registerKeybinding({
        id: "sales:open",
        localId: "open",
        key: "o",
        label: "Open",
        handler: () => {},
      })
      registerKeybinding({
        id: "support:open",
        localId: "open",
        key: "shift+o",
        label: "Open",
        handler: () => {},
      })
      expect(getKeybindings().map((binding) => binding.id)).toEqual(["sales:open", "support:open"])
    })
  })

  describe("activity bar — position and appId", () => {
    it("entries preserve position field", async () => {
      const { registerActivityBarEntry, getActivityBarEntries } = await import(
        "~/framework/app-registry"
      )
      registerActivityBarEntry({
        id: "home",
        icon: () => null,
        label: "Home",
        order: 0,
        appId: "kernel",
        position: "top",
        tabAction: { type: "home", entityId: "home", label: "Home" },
      })
      registerActivityBarEntry({
        id: "settings",
        icon: () => null,
        label: "Settings",
        order: 1000,
        appId: "kernel",
        position: "bottom",
        tabAction: { type: "settings", entityId: "settings", label: "Settings" },
      })
      const entries = getActivityBarEntries()
      expect(entries).toHaveLength(2)
      expect(entries[0].position).toBe("top")
      expect(entries[1].position).toBe("bottom")
    })
  })

  describe("ws handler registry — unregister by app", () => {
    it("unregisterWsEntityHandlers removes all handlers for an app", async () => {
      const { registerWsEntityHandler, unregisterWsEntityHandlers, getWsEntityHandlers } =
        await import("~/framework/app-registry")
      registerWsEntityHandler("thread", "kernel", () => {})
      registerWsEntityHandler("thread", "tickets", () => {})
      expect(getWsEntityHandlers("thread")).toHaveLength(2)
      unregisterWsEntityHandlers("tickets")
      expect(getWsEntityHandlers("thread")).toHaveLength(1)
    })

    it("dispatches entity handlers in explicit priority order", async () => {
      const { dispatchWsEntityEvent, registerWsEntityHandler } = await import(
        "~/framework/app-registry"
      )
      const calls: string[] = []

      registerWsEntityHandler(
        "thread",
        "projection",
        () => {
          calls.push("projection")
        },
        { priority: 20 },
      )
      registerWsEntityHandler(
        "thread",
        "kernel",
        () => {
          calls.push("kernel")
        },
        { priority: 10 },
      )

      dispatchWsEntityEvent(
        "thread",
        "update",
        {},
        {
          currentUserId: "u1",
          activeTabId: null,
          isDocumentVisible: true,
          isOwnAction: false,
        },
      )
      expect(calls).toEqual(["kernel", "projection"])
    })

    it("replaces an app handler instead of stacking duplicates", async () => {
      const { dispatchWsEntityEvent, registerWsEntityHandler } = await import(
        "~/framework/app-registry"
      )
      const calls: string[] = []

      registerWsEntityHandler("thread", "kernel", () => {
        calls.push("old")
      })
      registerWsEntityHandler("thread", "kernel", () => {
        calls.push("new")
      })

      dispatchWsEntityEvent(
        "thread",
        "update",
        {},
        {
          currentUserId: "u1",
          activeTabId: null,
          isDocumentVisible: true,
          isOwnAction: false,
        },
      )
      expect(calls).toEqual(["new"])
    })

    it("allows one app to register multiple owned handlers for the same entity", async () => {
      const { dispatchWsEntityEvent, registerWsEntityHandler } = await import(
        "~/framework/app-registry"
      )
      const calls: string[] = []

      registerWsEntityHandler(
        "thread",
        "kernel",
        () => {
          calls.push("thread-projection")
        },
        { owner: "thread-projection", priority: 10 },
      )
      registerWsEntityHandler(
        "thread",
        "kernel",
        () => {
          calls.push("analytics")
        },
        { owner: "analytics", priority: 20 },
      )

      dispatchWsEntityEvent(
        "thread",
        "update",
        {},
        {
          currentUserId: "u1",
          activeTabId: null,
          isDocumentVisible: true,
          isOwnAction: false,
        },
      )
      expect(calls).toEqual(["thread-projection", "analytics"])
    })
  })

  describe("dispatchWsEventMessage — isOwnAction enrichment (A2)", () => {
    it("sets isOwnAction=true when payload.actorId matches currentUserId", async () => {
      const { dispatchWsEventMessage, registerWsEntityHandler } = await import(
        "~/framework/app-registry"
      )
      let receivedCtx: any = null

      registerWsEntityHandler("kernel:thread", "kernel", (_action, _data, ctx) => {
        receivedCtx = ctx
      })

      dispatchWsEventMessage(
        {
          type: "event",
          payload: { entity: "thread", action: "update", actorId: "u1" },
        },
        { currentUserId: "u1", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
      )

      expect(receivedCtx).toBeDefined()
      expect(receivedCtx.isOwnAction).toBe(true)
    })

    it("sets isOwnAction=false when payload.actorId differs from currentUserId", async () => {
      const { dispatchWsEventMessage, registerWsEntityHandler } = await import(
        "~/framework/app-registry"
      )
      let receivedCtx: any = null

      registerWsEntityHandler("kernel:thread", "kernel", (_action, _data, ctx) => {
        receivedCtx = ctx
      })

      dispatchWsEventMessage(
        {
          type: "event",
          payload: { entity: "thread", action: "update", actorId: "u2" },
        },
        { currentUserId: "u1", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
      )

      expect(receivedCtx.isOwnAction).toBe(false)
    })

    it("sets isOwnAction=false when no actorId in payload", async () => {
      const { dispatchWsEventMessage, registerWsEntityHandler } = await import(
        "~/framework/app-registry"
      )
      let receivedCtx: any = null

      registerWsEntityHandler("kernel:thread", "kernel", (_action, _data, ctx) => {
        receivedCtx = ctx
      })

      dispatchWsEventMessage(
        {
          type: "event",
          payload: { entity: "thread", action: "update" },
        },
        { currentUserId: "u1", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
      )

      expect(receivedCtx.isOwnAction).toBe(false)
    })
  })

  describe("ws message registry", () => {
    it("dispatches raw websocket messages via the message registry", async () => {
      const { dispatchWsMessage, registerWsMessageHandler } = await import(
        "~/framework/app-registry"
      )
      const calls: string[] = []

      registerWsMessageHandler(
        "presence_sync",
        "kernel",
        () => {
          calls.push("presence")
        },
        { owner: "presence-snapshot" },
      )

      dispatchWsMessage(
        "presence_sync",
        { type: "presence_sync", users: { u1: "online" } },
        { currentUserId: "u1", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
      )

      expect(calls).toEqual(["presence"])
    })
  })

  describe("slot registry", () => {
    it("registers a slot and contribution", async () => {
      const { registerSlot, registerContribution, getContributions } = await import(
        "~/framework/app-registry"
      )
      registerSlot("ticket:detail:tabs", { position: "tabs" })
      registerContribution("ticket:detail:tabs", {
        appId: "invoicing",
        component: () => null,
        label: "Invoices",
      })
      expect(getContributions("ticket:detail:tabs")).toHaveLength(1)
      expect(getContributions("ticket:detail:tabs")[0].label).toBe("Invoices")
    })
  })

  describe("entity opener registry", () => {
    it("registers and retrieves entity openers per (app, entityType)", async () => {
      const { registerEntityOpener, getEntityOpener } = await import("~/framework/app-registry")
      const opener = (_api: any, id: string) => ({ tabType: "thread", entityId: id })
      registerEntityOpener("kernel", "approval_request", opener)
      expect(getEntityOpener("kernel", "approval_request")).toBe(opener)
      expect(getEntityOpener("kernel", "missing")).toBeUndefined()
    })

    it("last register wins for the same key", async () => {
      const { registerEntityOpener, getEntityOpener } = await import("~/framework/app-registry")
      const a = (_api: any, id: string) => ({ tabType: "x", entityId: id })
      const b = (_api: any, id: string) => ({ tabType: "y", entityId: id })
      registerEntityOpener("kernel", "contact", a)
      registerEntityOpener("kernel", "contact", b)
      expect(getEntityOpener("kernel", "contact")).toBe(b)
    })

    it("resetRegistry clears entity openers", async () => {
      const { registerEntityOpener, getEntityOpener, resetRegistry } = await import(
        "~/framework/app-registry"
      )
      registerEntityOpener("kernel", "contact", (_api, id) => ({ tabType: "x", entityId: id }))
      resetRegistry()
      expect(getEntityOpener("kernel", "contact")).toBeUndefined()
    })
  })

  describe("executeCommand", () => {
    it("executes a registered command by id", async () => {
      const { registerCommand, executeCommand } = await import("~/framework/app-registry")
      let called = false
      registerCommand({
        id: "test-cmd",
        label: "Test",
        execute: () => {
          called = true
        },
      })
      executeCommand("test-cmd")
      expect(called).toBe(true)
    })

    it("does nothing for unknown command id", async () => {
      const { executeCommand } = await import("~/framework/app-registry")
      expect(() => executeCommand("nonexistent")).not.toThrow()
    })

    it("does not execute an ambiguous local command alias", async () => {
      const { registerCommand, executeCommand } = await import("~/framework/app-registry")
      let called = 0
      registerCommand({
        id: "sales:open",
        localId: "open",
        label: "Open sales",
        execute: () => {
          called++
        },
      })
      registerCommand({
        id: "support:open",
        localId: "open",
        label: "Open support",
        execute: () => {
          called++
        },
      })
      executeCommand("open")
      expect(called).toBe(0)
    })
  })
})

describe("WS dispatch widening — app:entity compound keys", () => {
  it("dispatches to app:entity compound key", async () => {
    const { registerWsEntityHandler, dispatchWsEventMessage } = await import(
      "~/framework/app-registry"
    )
    const calls: string[] = []
    registerWsEntityHandler("mail:conversation", "mail", (action) => {
      calls.push(`mail:conversation:${action}`)
    })

    dispatchWsEventMessage(
      {
        type: "event",
        payload: {
          app: "mail",
          entity: "conversation",
          action: "create",
          data: {},
          actorId: "other",
        },
      },
      { currentUserId: "me", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )

    expect(calls).toEqual(["mail:conversation:create"])
  })

  it("defaults to kernel: prefix when app field is missing", async () => {
    const { registerWsEntityHandler, dispatchWsEventMessage } = await import(
      "~/framework/app-registry"
    )
    const calls: string[] = []
    registerWsEntityHandler("kernel:thread", "kernel", (action) => {
      calls.push(`kernel:thread:${action}`)
    })

    dispatchWsEventMessage(
      {
        type: "event",
        payload: { entity: "thread", action: "update", data: {}, actorId: "other" },
      },
      { currentUserId: "me", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )

    expect(calls).toEqual(["kernel:thread:update"])
  })

  it("does not cross-dispatch between apps", async () => {
    const { registerWsEntityHandler, dispatchWsEventMessage } = await import(
      "~/framework/app-registry"
    )
    const kernelCalls: string[] = []
    const mailCalls: string[] = []

    registerWsEntityHandler("kernel:conversation", "kernel", (action) => {
      kernelCalls.push(action)
    })
    registerWsEntityHandler("mail:conversation", "mail", (action) => {
      mailCalls.push(action)
    })

    dispatchWsEventMessage(
      {
        type: "event",
        payload: { app: "mail", entity: "conversation", action: "create", data: {} },
      },
      { currentUserId: "me", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )

    expect(kernelCalls).toEqual([])
    expect(mailCalls).toEqual(["create"])
  })

  describe("savedViews + bulkUi", () => {
    it("registers savedViews handler per (app, viewId) and exposes capture/apply", async () => {
      const { registerApp } = await import("~/framework/define-app")
      const { getSavedViewsHandler } = await import("~/framework/app-registry")
      let captured: unknown = null
      registerApp({
        name: "demo",
        savedViews: {
          inbox: {
            capture: () => ({ q: 1 }),
            apply: (p) => {
              captured = p
            },
          },
        },
      })
      const h = getSavedViewsHandler("demo", "inbox")
      expect(h?.capture()).toEqual({ q: 1 })
      h?.apply({ x: 2 })
      expect(captured).toEqual({ x: 2 })
    })

    it("registers bulkUi.selection accessor + clear + optional all", async () => {
      const { registerApp } = await import("~/framework/define-app")
      const { getBulkUiSelection } = await import("~/framework/app-registry")
      registerApp({
        name: "demo2",
        bulkUi: {
          selection: {
            inbox: { accessor: () => ["a", "b"], clear: () => {} },
          },
        },
      })
      const sel = getBulkUiSelection("demo2", "inbox")
      expect(sel?.accessor()).toEqual(["a", "b"])
    })

    it("registers bulkUi.customForms keyed by action", async () => {
      const { registerApp } = await import("~/framework/define-app")
      const { getBulkUiCustomForm } = await import("~/framework/app-registry")
      const Form = () => null
      registerApp({
        name: "demo3",
        bulkUi: {
          selection: {},
          customForms: { merge: Form },
        },
      })
      expect(getBulkUiCustomForm("demo3", "merge")).toBe(Form)
      expect(getBulkUiCustomForm("demo3", "missing")).toBeUndefined()
    })

    it("unregisterApp removes savedViews + bulkUi entries for that app", async () => {
      const { registerApp, unregisterApp } = await import("~/framework/define-app")
      const { getSavedViewsHandler, getBulkUiSelection, getBulkUiCustomForm } = await import(
        "~/framework/app-registry"
      )
      registerApp({
        name: "demo4",
        savedViews: { inbox: { capture: () => ({}), apply: () => {} } },
        bulkUi: {
          selection: { inbox: { accessor: () => [], clear: () => {} } },
          customForms: { merge: () => null },
        },
      })
      unregisterApp("demo4")
      expect(getSavedViewsHandler("demo4", "inbox")).toBeUndefined()
      expect(getBulkUiSelection("demo4", "inbox")).toBeUndefined()
      expect(getBulkUiCustomForm("demo4", "merge")).toBeUndefined()
    })
  })
})

// ─── An app's bare route ─────────────────────────────────────────────
//
// `/monitoring` resolved only because that app happens to give its default tab
// the bare `/monitoring` urlPattern. Every other app names its default page in
// the pattern (`/boxtal/queue/worklist`, `/ads/dashboard`), so the bare route and
// any alias the app declares matched nothing and the shell kept Home. The bare
// route names the APP, not one of its pages, so it resolves through the
// manifest's `routes` next to the activity-bar entry that already carries the
// app's default tab action.

import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"

const BUNDLED = resolvePath(__dirname, "../../../../bundled-apps")

function bundledManifest(app: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolvePath(BUNDLED, app, "app.manifest.json"), "utf8"))
}

/** Every component a manifest names resolves to an inert stub. */
const stubExports = new Proxy({} as Record<string, unknown>, {
  get: () => () => null,
  has: () => true,
})

describe("urlToTabInfo - an app's bare route resolves to its default page", () => {
  beforeEach(async () => {
    const { resetRegistry } = await import("~/framework/app-registry")
    const { resetAppIndex } = await import("~/framework/define-app")
    resetRegistry()
    resetAppIndex()
  })

  async function coldLoad(app: string) {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    registerAppFromManifest(bundledManifest(app) as never, stubExports as never)
    const { urlToTabInfo } = await import("~/framework/app-registry")
    return urlToTabInfo
  }

  it("resolves /boxtal, the app's name and rail label, to the shipping worklist", async () => {
    const urlToTabInfo = await coldLoad("boxtal")
    const canonical = urlToTabInfo("/boxtal/queue/worklist")
    expect(canonical?.type).toBe("boxtal:queue")
    expect(urlToTabInfo("/boxtal")).toEqual(canonical)
  })

  it("resolves /ads to the dashboard page", async () => {
    const urlToTabInfo = await coldLoad("ads")
    const canonical = urlToTabInfo("/ads/dashboard")
    expect(canonical?.type).toBe("ads:dashboard")
    expect(urlToTabInfo("/ads")).toEqual(canonical)
  })

  it("keeps resolving /monitoring, whose default page owns the bare pattern", async () => {
    const urlToTabInfo = await coldLoad("monitoring")
    expect(urlToTabInfo("/monitoring")?.type).toBe("monitoring:home")
  })

  it("answers an alias the manifest declares in routes", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const manifest = bundledManifest("ads")
    ;(manifest as { routes?: string[] }).routes = ["/campaign-manager"]
    registerAppFromManifest(manifest as never, stubExports as never)
    const { urlToTabInfo } = await import("~/framework/app-registry")
    expect(urlToTabInfo("/campaign-manager")).toEqual(urlToTabInfo("/ads/dashboard"))
  })

  it("never lets a bare route shadow a page pattern", async () => {
    const urlToTabInfo = await coldLoad("monitoring")
    // /monitoring/incident/:id is a PAGE; the bare route must not swallow it.
    expect(urlToTabInfo("/monitoring/incident/abc")?.type).toBe("monitoring:incident")
  })

  it("does not answer a path that belongs to no app", async () => {
    const urlToTabInfo = await coldLoad("boxtal")
    expect(urlToTabInfo("/nothing-here")).toBeNull()
  })
})

// ─── A bundled app's name follows the reader's language ─────────────
//
// Invoicing and Monitoring ship an English label and no catalog key, so the tab
// strip, the activity bar and the phone header said "Invoicing" and
// "Monitoring" to a French reader (second French walk, 2026-09-23).
describe("a bundled app's shell name is named from the catalog", () => {
  beforeEach(async () => {
    const { resetRegistry } = await import("~/framework/app-registry")
    const { resetAppIndex } = await import("~/framework/define-app")
    resetRegistry()
    resetAppIndex()
  })

  it("the home tab and the activity bar read in French; a page tab keeps its label", async () => {
    const { registerAppFromManifest } = await import("~/framework/define-app")
    const { tabDisplayLabel, registryLabel, getActivityBarEntries } = await import(
      "~/framework/app-registry"
    )
    const { translatorFor } = await import("~/modules/i18n/i18n-context")
    const fr = translatorFor("fr")
    for (const [app, type, name] of [
      ["invoicing", "invoicing:home", "Facturation"],
      ["monitoring", "monitoring:home", "Supervision"],
    ] as const) {
      registerAppFromManifest(bundledManifest(app) as never, stubExports as never)
      const english = app === "invoicing" ? "Invoicing" : "Monitoring"
      expect(tabDisplayLabel(fr, { type, entityId: "home", label: english })).toBe(name)
      const entry = getActivityBarEntries().find((e) => e.label === english)
      expect(entry && registryLabel(fr, entry)).toBe(name)
    }
    // A page of the app is not the app: its own label stays.
    expect(
      tabDisplayLabel(fr, { type: "monitoring:incident", entityId: "x", label: "Incident" }),
    ).toBe("Incident")
  })
})
