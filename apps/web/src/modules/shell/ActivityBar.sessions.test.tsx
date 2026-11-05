// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T16 (S10, charter): the rail's Sessions entry shows the count of sessions
// waiting on you, in the warning colour, never the danger red; an entry with no
// tone (Messages) keeps the danger red.
import { Route, Router } from "@solidjs/router"
import { render, screen, waitFor } from "@solidjs/testing-library"
import { MessageSquare } from "lucide-solid"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerActivityBarEntry, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { applyRow, resetSessionStore } from "~/modules/sessions/session-store"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import { WsProvider } from "~/modules/shell/WsContext"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const [wsStatus] = createSignal<"connected" | "disconnected">("connected")

function renderRail() {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <WsProvider send={() => {}} status={wsStatus}>
            <ActivityBar />
          </WsProvider>
        )}
      />
    </Router>
  ))
}

afterEach(() => {
  resetSessionStore()
  resetRegistry()
  resetBootstrap()
})

describe("ActivityBar Sessions badge", () => {
  it("shows the waiting count in the warning tone; an untoned badge stays danger", async () => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    registerActivityBarEntry({
      id: "probe",
      icon: MessageSquare,
      label: "Probe",
      order: 0.6,
      appId: "kernel",
      position: "top",
      badge: () => 2,
      tabAction: { type: "kernel:chats", entityId: "chats", label: "Probe" },
    })
    renderRail()
    expect(screen.queryByTestId("activity-bar-badge-sessions")).toBeNull()
    applyRow({ id: "w1", status: "waiting", lastSeq: 0, title: "a" } as never)
    const badge = await waitFor(() => screen.getByTestId("activity-bar-badge-sessions"))
    expect(badge.textContent).toBe("1")
    expect(badge.dataset.tone).toBe("warning")
    expect(badge.className).toContain("bg-warning")
    expect(badge.className).not.toContain("bg-danger")
    const probe = screen.getByTestId("activity-bar-badge-probe")
    expect(probe.dataset.tone).toBe("danger")
    expect(probe.className).toContain("bg-danger")
  })
})
