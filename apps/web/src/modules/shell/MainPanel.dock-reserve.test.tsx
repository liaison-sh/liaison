// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The band under the floating chat dock is reserved ONCE. The main panel's tab
// wrapper keeps it clear below every page; a composer that pads itself by the
// same clearance (a session's, the chat's) stacked a second band, and the
// session composer sat ~100px above the panel's bottom with nothing under it.

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import type { ApiClient } from "~/lib/api-client"

// The composer's writing helpers read the API from context, as under the
// shell's ApiProvider; this runtime cannot record, so dictation stays hidden
// and the client is never called.
vi.mock("~/modules/shell/ApiContext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/shell/ApiContext")>()
  const client: Partial<ApiClient> = {}
  return { ...actual, useApi: () => client as ApiClient }
})

import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { loadNodes, resetNodesStore, setNodesStoreApi } from "~/modules/nodes/nodes-store"
import SessionComposer from "~/modules/sessions/SessionComposer"
import type { NodeSessionRow } from "~/modules/sessions/session-api"
import { resetSessionCommands, setSessionCommandsApi } from "~/modules/sessions/session-commands"
import { resetSessionStore } from "~/modules/sessions/session-store"
import { MainPanel } from "~/modules/shell/MainPanel"
import { PanelProvider } from "~/modules/shell/PanelContext"
import { openTab, resetTabStore } from "~/modules/shell/tab-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

const ID = "11111111-2222-4333-8444-555555555555"
const STRIP_CLEARANCE = "48px"

function session(): NodeSessionRow {
  return {
    id: ID,
    ownerUserId: "u1",
    nodeId: "n1",
    jobId: "j1",
    agentId: "a1",
    source: "app",
    configKind: "owner",
    sourceThreadId: null,
    sourceMessageId: null,
    title: "Fix the flaky test",
    folderName: "code",
    repo: null,
    branch: null,
    pushed: false,
    prUrl: null,
    model: "claude-haiku-4-5",
    level: "standard",
    status: "running",
    pendingCount: 0,
    waitingReason: null,
    claudeCode: null,
    lastSeq: 0,
    latestActivity: null,
    tokensIn: 0,
    tokensOut: 0,
    resultSummary: null,
    error: null,
    createdAt: "2026-10-13T10:00:00.000Z",
    startedAt: null,
    endedAt: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
  }
}

function fakeApi() {
  const post = vi.fn(async () => ({ commandId: "00000000-0000-4000-8000-000000000001", seq: 1 }))
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/commands?open=1")) return { commands: [] }
    if (path.includes("/nodes/me")) {
      return {
        nodes: [
          {
            id: "n1",
            name: "Mac mini",
            enabled: true,
            online: true,
            lastSeenAt: null,
            os: "darwin",
            appVersion: null,
            deviceId: "d1",
            queue: { queued: 0, running: 1 },
            models: [{ id: "claude-haiku-4-5", label: "Haiku 4.5" }],
          },
        ],
      }
    }
    return {}
  })
  return { post, get }
}

/** The dock rules of the real stylesheet (jsdom cannot load Tailwind's file whole). */
function injectDockRules(): HTMLStyleElement {
  const css = readFileSync(resolve(import.meta.dirname, "../../index.css"), "utf8")
  const rules = css.match(/\[data-dock-(?:reserved|window)\][^{]*\{[^}]*\}/g) ?? []
  const style = document.createElement("style")
  style.textContent = rules.join("\n")
  document.head.appendChild(style)
  return style
}

function renderPanel() {
  render(() => (
    // What Shell.tsx publishes at desktop with the dock strip showing.
    <div style={{ "--shell-dock-clearance": STRIP_CLEARANCE }}>
      <Router>
        <Route
          path="/*"
          component={() => (
            <PanelProvider>
              <MainPanel />
            </PanelProvider>
          )}
        />
      </Router>
    </div>
  ))
}

describe("MainPanel: the dock's band is reserved once", () => {
  let style: HTMLStyleElement
  beforeEach(async () => {
    resetRegistry()
    resetTabStore()
    resetBootstrap()
    bootstrapKernelApps()
    resetSessionStore()
    resetSessionCommands()
    resetNodesStore()
    const api = fakeApi()
    setSessionCommandsApi(() => api as never)
    setNodesStoreApi(() => api as never)
    await loadNodes()
    registerTabType("kernel:session-under-test", {
      component: () => (
        <div class="flex h-full flex-col" data-testid="session-page">
          <div class="flex-1" />
          <SessionComposer
            session={session()}
            pendingRequests={[]}
            nodeOnline
            confirmLevel={async () => null}
          />
        </div>
      ),
      sidebar: null,
      icon: () => null,
      urlPattern: "/session-under-test",
      defaultLabel: "Session",
      appId: "kernel",
    })
    style = injectDockRules()
  })
  afterEach(() => {
    style.remove()
    cleanup()
    resetSessionCommands()
    resetNodesStore()
  })

  it("the tab wrapper reserves the strip's band below the page", async () => {
    openTab({ type: "kernel:session-under-test", entityId: ID, label: "Session", preview: false })
    renderPanel()
    const wrapper = await screen.findByTestId("app-tab-scroll")
    expect(wrapper.style.paddingBottom).toBe("var(--shell-dock-clearance, 0px)")
    expect(getComputedStyle(wrapper).getPropertyValue("--shell-dock-clearance")).toBe(
      STRIP_CLEARANCE,
    )
  })

  it("the session composer inside it adds no second band", async () => {
    openTab({ type: "kernel:session-under-test", entityId: ID, label: "Session", preview: false })
    renderPanel()
    const composer = await screen.findByTestId("session-composer")
    // The composer pads by the clearance it sees (its own 0.875rem otherwise)...
    expect(composer.className).toContain("var(--shell-dock-clearance")
    // ...and inside the wrapper that clearance is spent already.
    expect(getComputedStyle(composer).getPropertyValue("--shell-dock-clearance")).toBe("0px")
    expect(
      getComputedStyle(screen.getByTestId("session-page")).getPropertyValue(
        "--shell-dock-clearance",
      ),
    ).toBe("0px")
  })
})
