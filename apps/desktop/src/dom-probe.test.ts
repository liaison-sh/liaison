// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The probe exists because a walk reads a WINDOW, and a window that draws
// nothing says nothing about which layer is blank. What is asserted here is
// the line the operator reads: every layer named, with the numbers that tell
// an unmounted tree from an invisible one.
//
// Since A33 those layers are apps/web's own: `#app` is the root, and the
// login card is the screen. The probe names no element of the shell's,
// because the shell appends none.
import { beforeEach, describe, expect, it, vi } from "vitest"

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined as unknown),
}))
vi.mock("./tauri", () => ({ invoke, listen: vi.fn() }))

import { DIAGNOSTIC_COMMAND } from "./diagnostics"
import { DOM_PROBE_DELAYS_MS, describeDom, installDomProbe, resetDomProbeErrors } from "./dom-probe"

function lastReport(): { kind: string; message: string } | null {
  const call = invoke.mock.calls.findLast(([command]) => command === DIAGNOSTIC_COMMAND)
  return call ? (call[1] as { kind: string; message: string }) : null
}

describe("the desktop dom probe", () => {
  beforeEach(() => {
    invoke.mockClear()
    document.body.innerHTML = ""
  })

  it("names the host page's root, its child count and the head of its text", () => {
    const host = document.createElement("div")
    host.id = "app"
    host.append(document.createElement("p"), document.createElement("p"))
    host.textContent = "Sign in to Liaison"
    document.body.append(host)

    const line = describeDom(document)
    expect(line).toContain("host=#app")
    expect(line).toContain("host.text=18")
    expect(line).toContain("Sign in to Liaison")
  })

  it("reports the page's root as absent when nothing mounted it", () => {
    expect(describeDom(document)).toContain("root=absent")
  })

  it("reports the page root's child count, background and z-index", () => {
    const root = document.createElement("div")
    root.id = "app"
    root.style.setProperty("z-index", "2147483647")
    root.style.setProperty("background-color", "rgb(255, 255, 255)")
    root.append(document.createElement("span"))
    document.body.append(root)

    const line = describeDom(document)
    expect(line).toContain("root.children=1")
    expect(line).toContain("root.z=2147483647")
    expect(line).toContain("root.bg=rgb(255, 255, 255)")
  })

  it("measures the login card, so an invisible one is told from an absent one", () => {
    const root = document.createElement("div")
    root.id = "app"
    const panel = document.createElement("form")
    panel.dataset.testid = "auth-card"
    panel.style.setProperty("opacity", "0")
    panel.append(document.createElement("input"))
    root.append(panel)
    document.body.append(root)

    const line = describeDom(document)
    expect(line).toContain("panel=present")
    expect(line).toContain("panel.children=1")
    expect(line).toContain("panel.opacity=0")
    expect(line).toMatch(/panel\.rect=\d+x\d+/)
  })

  it("measures each control the login card draws, with its text", () => {
    const root = document.createElement("div")
    root.id = "app"
    const panel = document.createElement("form")
    panel.dataset.testid = "auth-card"
    const button = document.createElement("button")
    button.textContent = "Sign in"
    panel.append(button)
    root.append(panel)
    document.body.append(root)

    const line = describeDom(document)
    expect(line).toContain("panel.kids=[BUTTON|")
    expect(line).toContain("|Sign in]")
  })

  it("names no element of the shell's own, because the shell appends none", () => {
    const stale = document.createElement("div")
    stale.id = "liaison-desktop-root"
    const stalePanel = document.createElement("form")
    stalePanel.dataset.testid = "liaison-first-launch"
    stale.append(stalePanel)
    document.body.append(stale)

    const line = describeDom(document)
    expect(line).toContain("root=absent")
    expect(line).toContain("panel=absent")
  })

  it("carries the document's readiness and the body's child count", () => {
    document.body.append(document.createElement("div"))
    const line = describeDom(document)
    expect(line).toContain("readyState=")
    expect(line).toContain("body.children=1")
  })

  it("counts what the page threw since the overlay mounted", () => {
    resetDomProbeErrors()
    const uninstall = installDomProbe(document)
    try {
      window.dispatchEvent(Object.assign(new Event("error"), { message: "boom" }))
      expect(describeDom(document)).toContain("errors=1")
      expect(describeDom(document)).toContain('lastError="boom"')
    } finally {
      uninstall()
      resetDomProbeErrors()
    }
  })

  it("forwards one report per delay, and none before the first one", () => {
    vi.useFakeTimers()
    try {
      installDomProbe(document)
      expect(lastReport()).toBeNull()
      vi.advanceTimersByTime(DOM_PROBE_DELAYS_MS[0])
      expect(lastReport()?.kind).toBe("dom")
      const first = invoke.mock.calls.length
      vi.advanceTimersByTime(DOM_PROBE_DELAYS_MS[1] - DOM_PROBE_DELAYS_MS[0])
      expect(invoke.mock.calls.length).toBe(first + 1)
    } finally {
      vi.useRealTimers()
    }
  })
})
