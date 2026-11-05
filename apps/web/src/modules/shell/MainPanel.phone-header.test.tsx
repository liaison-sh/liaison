// SPDX-License-Identifier: FSL-1.1-ALv2
//
// F4. The phone thread screen had no header at all: the top bar carried the
// tab's label and nothing else, and ThreadView's own header is a desktop
// component. The bar now renders whatever header the ACTIVE TAB TYPE registers
// (resolved through the registry, never from route params), so a thread gets a
// nav bar and every other tab type keeps the plain label.
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: () => true,
    userFromToken: () => ({ userId: "me", name: "Tester" }),
  }
})

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
    }),
  ),
)

import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppPhoneHeader, registerAppPhoneTopBarHidden } from "~/framework/define-app"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"
import { addThread, handleTypingEvent, resetThreadStore } from "~/modules/threads/thread-store"

function renderPanel() {
  return render(() => (
    <Router>
      <Route
        path="/*"
        component={() => (
          <ApiProvider>
            <PanelProvider>
              <MainPanel tier="phone" />
            </PanelProvider>
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("the phone top bar", () => {
  beforeEach(() => {
    resetRegistry()
    resetTabStore()
    resetThreadStore()
    resetBootstrap()
    bootstrapKernelApps()
  })
  afterEach(() => cleanup())

  it("renders the thread's own nav bar: title, agent state and actions", async () => {
    addThread({
      id: "t-dm",
      handle: "@dm",
      title: null,
      participants: [
        { id: "me", name: "Tester", avatarUrl: null },
        { id: "u-2", name: "Alice Chen", avatarUrl: null },
      ],
      lastMessage: null,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
    })
    // A turn announced over the typing channel reads as Queued.
    handleTypingEvent({
      type: "typing:start",
      threadId: "t-dm",
      userId: "a-1",
      authorType: "agent",
      agentId: "a-1",
    })
    openTab({ type: "thread", entityId: "t-dm", label: "Alice Chen", preview: false })
    renderPanel()

    await waitFor(() => expect(screen.getByTestId("phone-thread-header")).toBeTruthy(), {
      timeout: 15000,
    })
    expect(screen.getByTestId("phone-thread-title").textContent).toContain("Alice")
    expect(screen.getByTestId("phone-thread-state").textContent).toBe("Queued")
    expect(screen.getByTestId("phone-thread-actions")).toBeTruthy()
    // The plain label bar is replaced, not stacked on top of.
    expect(screen.queryByTestId("phone-top-bar-title")).toBeNull()
  })

  it("keeps the plain label bar for a tab type that registers no header", async () => {
    registerTabType("tickets:inbox", {
      component: () => <div data-testid="tickets-body" />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets",
      defaultLabel: "Tickets",
    })
    openTab({ type: "tickets:inbox", entityId: "inbox", label: "Tickets", preview: false })
    renderPanel()

    await waitFor(() =>
      expect(screen.getByTestId("phone-top-bar-title").textContent).toBe("Tickets"),
    )
    expect(screen.queryByTestId("phone-thread-header")).toBeNull()
  })

  // G1 — a MANIFEST tab type (tickets:ticket, tickets:inbox) has no way to
  // carry a `phoneHeader` / `hidePhoneTopBar` component reference on its own
  // registration (it is built from JSON), so it attaches one at runtime via
  // `registerAppPhoneHeader` / `registerAppPhoneTopBarHidden` instead —
  // resolved here through the SAME fallback path as the literal field.
  it("G1: renders a runtime-registered header for a manifest tab type", async () => {
    registerTabType("tickets:ticket", {
      component: () => <div data-testid="tickets-detail-body" />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
      appId: "tickets",
      localType: "ticket",
    })
    registerAppPhoneHeader("tickets", "ticket", () => (
      <div data-testid="ticket-phone-header-probe" />
    ))
    openTab({ type: "tickets:ticket", entityId: "t1", label: "Ticket", preview: false })
    renderPanel()

    await waitFor(() => expect(screen.getByTestId("ticket-phone-header-probe")).toBeTruthy())
    // The plain label bar is replaced, not stacked on top of.
    expect(screen.queryByTestId("phone-top-bar-title")).toBeNull()
  })

  it("G1: hides the bar entirely for a manifest tab type registered as hidden", async () => {
    registerTabType("tickets:inbox", {
      component: () => <div data-testid="tickets-inbox-body" />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets",
      defaultLabel: "Tickets",
      appId: "tickets",
      localType: "inbox",
    })
    registerAppPhoneTopBarHidden("tickets", "inbox")
    openTab({ type: "tickets:inbox", entityId: "inbox", label: "Tickets", preview: false })
    renderPanel()

    await waitFor(() => expect(screen.getByTestId("tickets-inbox-body")).toBeTruthy())
    expect(screen.queryByTestId("phone-top-bar-title")).toBeNull()
  })

  // K1: the shell's own back control used to render BESIDE a registered
  // header's own back control ("< Tickets" next to the ticket header's own
  // back), showing two back affordances stacked on the ticket detail. A
  // registered header owns the ENTIRE bar, so the shell must render nothing
  // else — not even its generic back button — once one is active.
  it("K1: renders no shell back control when a header is registered on a detail route", async () => {
    registerTabType("tickets:ticket", {
      component: () => <div data-testid="tickets-detail-body" />,
      sidebar: null,
      icon: () => null,
      urlPattern: "/tickets/:entityId",
      defaultLabel: "Ticket",
      appId: "tickets",
      localType: "ticket",
    })
    registerAppPhoneHeader("tickets", "ticket", () => (
      <div data-testid="ticket-phone-header-probe" />
    ))
    window.history.pushState({}, "", "/tickets/t1")
    openTab({ type: "tickets:ticket", entityId: "t1", label: "Ticket", preview: false })
    renderPanel()

    await waitFor(() => expect(screen.getByTestId("ticket-phone-header-probe")).toBeTruthy())
    expect(screen.queryByTestId("main-panel-back")).toBeNull()
    window.history.pushState({}, "", "/")
  })

  it("F3: hides the bar entirely for a root screen that hides it (hidePhoneTopBar)", async () => {
    registerTabType("root-screen:probe", {
      component: () => <div data-testid="root-screen-body" />,
      hidePhoneTopBar: true,
      sidebar: null,
      icon: () => null,
      urlPattern: "/root-screen",
      defaultLabel: "Root Screen",
    })
    openTab({ type: "root-screen:probe", entityId: "probe", label: "Root Screen", preview: false })
    renderPanel()

    await waitFor(() => expect(screen.getByTestId("root-screen-body")).toBeTruthy())
    // Neither the plain label bar nor a registered header slot renders: no bar
    // at all, not even an empty one (no back control, no navigator opener).
    expect(screen.queryByTestId("phone-top-bar-title")).toBeNull()
    expect(screen.queryByTestId("phone-top-bar-org")).toBeNull()
    expect(screen.queryByTestId("main-panel-back")).toBeNull()
  })

  it("hides the bar for the settings tab, whose phone root owns the You title", async () => {
    // The You screen prints its own large "You" title, so the shell's generic
    // bar above it was a second header saying the same thing. A section pushed
    // on top of You carries its own back control, so nothing is lost with the
    // bar gone.
    openTab({ type: "settings", entityId: "settings", label: "Settings", preview: false })
    renderPanel()

    await waitFor(() =>
      expect(
        screen.queryByTestId("you-title") ?? screen.queryByTestId("settings-content"),
      ).not.toBeNull(),
    )
    expect(screen.queryByTestId("phone-top-bar-title")).toBeNull()
    expect(screen.queryByTestId("phone-top-bar-org")).toBeNull()
  })
})
