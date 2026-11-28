// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { createServedShell, reselectThenReload, type ServedShellPlugin } from "./served-shell"

function plugin(overrides: Partial<ServedShellPlugin> = {}) {
  const calls: Array<{ buildId: string | null }> = []
  const p: ServedShellPlugin = {
    shellInfo: async () => ({
      bridgeVersion: 1,
      shell: "served:0123456789abcdef",
      served: true,
      buildId: "0123456789abcdef",
    }),
    shellReady: async (o) => {
      calls.push(o)
    },
    shellReselect: async () => ({ changed: true }),
    ...overrides,
  }
  return { p, calls }
}

describe("served shell bridge", () => {
  it("reports the host's bridge version and shell", async () => {
    const { p } = plugin()
    const shell = createServedShell({ available: () => true, plugin: p })
    expect(await shell.info()).toEqual({
      bridgeVersion: 1,
      shell: "served:0123456789abcdef",
      served: true,
      buildId: "0123456789abcdef",
    })
  })

  it("answers null without the plugin or on a malformed answer", async () => {
    const { p } = plugin({ shellInfo: async () => ({ nope: 1 }) as never })
    expect(await createServedShell({ available: () => false, plugin: p }).info()).toBeNull()
    expect(await createServedShell({ available: () => true, plugin: p }).info()).toBeNull()
    const failing = plugin({ shellInfo: async () => Promise.reject(new Error("x")) })
    expect(await createServedShell({ available: () => true, plugin: failing.p }).info()).toBeNull()
  })

  it("signals ready once per page", () => {
    const { p, calls } = plugin()
    const shell = createServedShell({ available: () => true, plugin: p })
    shell.ready("0123456789abcdef")
    shell.ready("0123456789abcdef")
    expect(calls).toEqual([{ buildId: "0123456789abcdef" }])
  })

  it("reselects before a server switch reloads, and reloads anyway when the host is slow", async () => {
    const order: string[] = []
    const { p } = plugin({
      shellReselect: async () => {
        order.push("reselect")
        return { changed: true }
      },
    })
    const shell = createServedShell({ available: () => true, plugin: p })
    await new Promise<void>((done) => {
      reselectThenReload(shell, (path) => {
        order.push(`reload:${path}`)
        done()
      })("/login")
    })
    expect(order).toEqual(["reselect", "reload:/login"])

    const hung = plugin({ shellReselect: () => new Promise(() => undefined) })
    const slow = createServedShell({ available: () => true, plugin: hung.p, timeoutMs: 10 })
    expect(await slow.reselect()).toBe(false)
  })
})
