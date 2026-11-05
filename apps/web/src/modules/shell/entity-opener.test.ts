// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  namespaceRegistryKey,
  registerEntityExternalLink,
  registerEntityOpener,
  registerPanel,
  registerTabType,
  resetRegistry,
} from "~/framework/app-registry"
import { openAttentionLink, openEntity } from "~/modules/shell/entity-opener"

const openTabMock = vi.fn()
vi.mock("~/modules/shell/tab-store", () => ({
  openTab: (opts: unknown) => openTabMock(opts),
}))

const markStaleAndReloadMock = vi.fn()
vi.mock("~/modules/shell/attention-store", () => ({
  attentionStore: {
    get markStaleAndReload() {
      return markStaleAndReloadMock
    },
  },
}))

const addToastMock = vi.fn()
vi.mock("~/modules/shell/toast-store", () => ({
  addToast: (input: unknown) => addToastMock(input),
}))

function makeApi(overrides: { post?: any } = {}) {
  return {
    post: overrides.post ?? vi.fn().mockResolvedValue({}),
    get: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getEnvelope: vi.fn(),
  } as any
}

const mockApi = {} as any

beforeEach(() => {
  resetRegistry()
  openTabMock.mockReset()
  markStaleAndReloadMock.mockReset()
  addToastMock.mockReset()
})

describe("entity opener registry", () => {
  it("registered opener takes precedence over default fallback", async () => {
    registerEntityOpener("kernel", "contact", (_api, id) => ({
      tabType: "contacts:contact-detail",
      entityId: id,
      label: "Contact",
    }))
    await openEntity(mockApi, "kernel", "contact", "c-1")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "contacts:contact-detail",
      entityId: "c-1",
      label: "Contact",
    })
  })

  it("default fallback opens app:entityType when no opener is registered", async () => {
    await openEntity(mockApi, "tickets", "ticket", "t-1")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "tickets:ticket",
      entityId: "t-1",
      label: "tickets:ticket",
    })
  })

  it("opens a first-class app tab type when one is registered", async () => {
    registerTabType("tickets:ticket", {
      component: (() => null) as never,
      sidebar: null,
      icon: (() => null) as never,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
      appId: "tickets",
      localType: "ticket",
    })
    await openEntity(mockApi, "tickets", "ticket", "t-1", "Ticket #1")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "tickets:ticket",
      entityId: "t-1",
      label: "Ticket #1",
    })
  })

  it("routes an app detail-panel entity through the generic detail tab", async () => {
    // The app declares an in-app detail panel (via views.detail.<entity>) but no
    // first-class tab type — e.g. a Shopify return/refund. Must open the kernel
    // `detail` tab with a "<app>/<entity>/<id>" entityId, not a bare
    // "shopify:return" tab (which has no registration → "unknown tab type").
    registerPanel(namespaceRegistryKey("shopify", "detail:return"), {
      component: (() => null) as never,
      icon: undefined,
      label: "Return",
      appId: "shopify",
      localType: "detail:return",
    })
    await openEntity(mockApi, "shopify", "return", "r-99", "Return #99")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "detail",
      entityId: "shopify/return/r-99",
      label: "Return #99",
    })
  })

  it("async openers resolve before openTab is called", async () => {
    let resolved = false
    registerEntityOpener("kernel", "approval_request", async (_api, id) => {
      await Promise.resolve()
      resolved = true
      return { tabType: "thread", entityId: `t-${id}`, label: "Approval discussion" }
    })
    await openEntity(mockApi, "kernel", "approval_request", "ar-1")
    expect(resolved).toBe(true)
    expect(openTabMock).toHaveBeenCalledWith({
      type: "thread",
      entityId: "t-ar-1",
      label: "Approval discussion",
    })
  })

  it("opener target without label falls back to tabType as label", async () => {
    registerEntityOpener("mail", "conversation", (_api, id) => ({
      tabType: "mail:conversation",
      entityId: id,
    }))
    await openEntity(mockApi, "mail", "conversation", "m-1")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "mail:conversation",
      entityId: "m-1",
      label: "mail:conversation",
    })
  })

  it("connected_account opens the qualified kernel settings tab with the item's route", async () => {
    // Regression: the opener used bare tabType "settings", an AMBIGUOUS alias
    // (invoicing also registers a local `settings`), which resolved to no
    // component ("Unknown tab type"). The opener must return the qualified
    // type, and an attention item's resolved settings sub-route
    // (metadata.settingsRoute, e.g. the tickets inboxes page) must win over
    // the opener's generic /settings/admin/apps default.
    registerTabType("kernel:settings", {
      component: (() => null) as never,
      sidebar: null,
      icon: (() => null) as never,
      urlPattern: "/settings",
      defaultLabel: "Settings",
      appId: "kernel",
      localType: "settings",
    })
    registerEntityOpener("kernel", "connected_account", (_api, id) => ({
      tabType: "kernel:settings",
      entityId: id,
      label: "Settings",
      routePath: "/settings/admin/apps",
    }))
    const api = makeApi()
    await openEntity(api, "kernel", "connected_account", "acc-1", "summary", {
      routePath: "/settings/tickets/inboxes",
    })
    expect(openTabMock).toHaveBeenCalledWith({
      type: "kernel:settings",
      entityId: "acc-1",
      label: "Settings",
      routePath: "/settings/tickets/inboxes",
    })
  })

  it("connected_account without a carried route falls back to the opener default", async () => {
    registerEntityOpener("kernel", "connected_account", (_api, id) => ({
      tabType: "kernel:settings",
      entityId: id,
      label: "Settings",
      routePath: "/settings/admin/apps",
    }))
    await openEntity(mockApi, "kernel", "connected_account", "acc-2")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "kernel:settings",
      entityId: "acc-2",
      label: "Settings",
      routePath: "/settings/admin/apps",
    })
  })

  it("openEntity opens tab and fires mark-read when requested by Home", async () => {
    const post = vi.fn().mockResolvedValue({})
    const api = makeApi({ post })
    await openEntity(api, "kernel", "thread", "t-1", "Sprint", { markAttentionRead: true })
    expect(openTabMock).toHaveBeenCalledWith({
      type: "kernel:thread",
      entityId: "t-1",
      label: "Sprint",
    })
    expect(post).toHaveBeenCalledWith("/attention-items/mark-read", {
      app: "kernel",
      entityType: "thread",
      entityId: "t-1",
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(markStaleAndReloadMock).toHaveBeenCalled()
  })

  it("openEntity does not mark attention read for generic entity opens", async () => {
    const post = vi.fn().mockResolvedValue({})
    const api = makeApi({ post })
    await openEntity(api, "kernel", "thread", "t-1", "Sprint")
    expect(post).not.toHaveBeenCalledWith("/attention-items/mark-read", expect.any(Object))
  })

  it("mark-read failure does not block tab activation", async () => {
    const post = vi.fn().mockRejectedValue(new Error("network"))
    const api = makeApi({ post })
    await openEntity(api, "kernel", "thread", "t-1", "Sprint", { markAttentionRead: true })
    expect(openTabMock).toHaveBeenCalled()
    await Promise.resolve()
    await Promise.resolve()
    expect(markStaleAndReloadMock).not.toHaveBeenCalled()
  })

  describe("external-only entities (e.g. Shopify order)", () => {
    it("opens the resolved external deep link in a new tab, not an in-app tab", async () => {
      registerEntityExternalLink("shopify", "order", { label: "Open in Shopify" })
      const fakeWindow = { location: { href: "" }, opener: {}, close: vi.fn() }
      const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeWindow as unknown as Window)
      const api = makeApi()
      api.getEnvelope.mockResolvedValue({
        data: { kind: "external", url: "https://acme.myshopify.com/admin/orders/1234" },
      })

      await openEntity(api, "shopify", "order", "1234")

      // Placeholder tab opened synchronously (popup-blocker safe), then navigated.
      expect(openSpy).toHaveBeenCalledWith("", "_blank")
      expect(api.getEnvelope).toHaveBeenCalledWith(
        "/references/open-target?app=shopify&entityType=order&entityId=1234",
      )
      expect(fakeWindow.location.href).toBe("https://acme.myshopify.com/admin/orders/1234")
      // Never falls back to a broken "shopify:order" in-app tab.
      expect(openTabMock).not.toHaveBeenCalled()
      openSpy.mockRestore()
    })

    it("closes the placeholder and toasts when no link resolves", async () => {
      registerEntityExternalLink("shopify", "order", { label: "Open in Shopify" })
      const fakeWindow = { location: { href: "" }, opener: {}, close: vi.fn() }
      const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeWindow as unknown as Window)
      const api = makeApi()
      api.getEnvelope.mockResolvedValue({ data: { kind: "internal" } })

      await openEntity(api, "shopify", "order", "1234")

      expect(fakeWindow.close).toHaveBeenCalled()
      expect(fakeWindow.location.href).toBe("")
      expect(addToastMock).toHaveBeenCalled()
      expect(openTabMock).not.toHaveBeenCalled()
      openSpy.mockRestore()
    })

    it("a detail-panel entity that also has an external link still opens in-app", async () => {
      // Shopify customer declares BOTH a component panel and an externalLink — the
      // in-app panel wins; the external branch is only for component-less entities.
      registerPanel(namespaceRegistryKey("shopify", "detail:customer"), {
        component: (() => null) as never,
        icon: undefined,
        label: "Customer",
        appId: "shopify",
        localType: "detail:customer",
      })
      registerEntityExternalLink("shopify", "customer", { label: "Open in Shopify" })
      const openSpy = vi.spyOn(window, "open")
      await openEntity(mockApi, "shopify", "customer", "c-1", "Acme")

      expect(openTabMock).toHaveBeenCalledWith({
        type: "detail",
        entityId: "shopify/customer/c-1",
        label: "Acme",
      })
      expect(openSpy).not.toHaveBeenCalled()
      openSpy.mockRestore()
    })
  })
})

describe("openAttentionLink (an attention item's metadata.link)", () => {
  function tabType(id: string, urlPattern: string, preserveSubRoutes = false) {
    registerTabType(id, {
      component: (() => null) as never,
      urlPattern,
      ...(preserveSubRoutes ? { preserveSubRoutes } : {}),
    } as never)
  }

  it("goes through the entity's opener when the link names app:entity", async () => {
    registerEntityOpener("mail", "conversation", (_api, id) => ({
      tabType: "mail:conversation",
      entityId: id,
    }))
    await openAttentionLink(mockApi, "mail:conversation", "conv-1", "Nouvel e-mail")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "mail:conversation",
      entityId: "conv-1",
      label: "Nouvel e-mail",
      routePath: undefined,
    })
  })

  it("opens a registered tab type directly (thread)", async () => {
    tabType("kernel:thread", "/thread/:id")
    await openAttentionLink(mockApi, "kernel:thread", "t-7", "Routine finished")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "kernel:thread",
      entityId: "t-7",
      label: "Routine finished",
    })
  })

  it("lands a settings link on its section", async () => {
    tabType("kernel:settings", "/settings", true)
    await openAttentionLink(mockApi, "kernel:settings", "notifications", "Settings changed")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "kernel:settings",
      entityId: "notifications",
      label: "Settings changed",
      routePath: "/settings/notifications",
    })
  })

  it("reads a bare settings link as the kernel's Settings, not an app's local settings tab", async () => {
    tabType("kernel:settings", "/settings", true)
    tabType("invoicing:settings", "/invoicing/settings")
    await openAttentionLink(mockApi, "settings", "security", "Finish mailbox setup")
    expect(openTabMock).toHaveBeenCalledWith({
      type: "kernel:settings",
      entityId: "security",
      label: "Finish mailbox setup",
      routePath: "/settings/security",
    })
  })
})
