// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The browser sign-in (lib/surfaces/browser.ts) finds the login page's
// controls by test id, never by their words: on a French Chrome profile the
// "Sign in with a password" button reads "Se connecter avec un mot de passe",
// and a name match on /password/ never found it (demo run, 2026-10-07).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { LOGIN_SELECTORS, serverHoldsPush } from "./lib/surfaces/browser"

describe("browser sign-in selectors", () => {
  it("name the login page's own test ids", () => {
    const login = readFileSync(
      join(import.meta.dir, "..", "..", "apps", "web", "src", "modules", "auth", "Login.tsx"),
      "utf8",
    )
    for (const selector of [LOGIN_SELECTORS.passwordToggle, LOGIN_SELECTORS.passwordSubmit]) {
      const id = /\[data-testid="([^"]+)"\]/.exec(selector)?.[1]
      expect(id).toBeDefined()
      expect(login).toContain(`data-testid="${id}"`)
    }
  })

  it("leave a demo box's visitor front page for the account sign-in first", () => {
    const entry = readFileSync(
      join(import.meta.dir, "..", "..", "apps", "web", "src", "modules", "demo", "DemoEntry.tsx"),
      "utf8",
    )
    const id = /\[data-testid="([^"]+)"\]/.exec(LOGIN_SELECTORS.demoSignInInstead)?.[1]
    expect(id).toBeDefined()
    expect(entry).toContain(`data-testid="${id}"`)
  })
})

// After the "unregistered" state deleted the browser device server-side, Chrome
// still holds its local push subscription: the runner trusted that and judged
// later browser cells against a server that no longer had the device (demo
// smoke, 2026-10-07). Registration counts only when the SERVER lists it.
describe("serverHoldsPush", () => {
  const dev = (deviceId: string, surface: string, webPush: boolean) => ({
    deviceId,
    surface,
    detail: { webPush },
  })
  it("is true only for this browser device with Web Push on the server", () => {
    expect(serverHoldsPush([dev("b1", "browser", true)], "b1")).toBe(true)
    expect(serverHoldsPush([dev("b1", "browser", false)], "b1")).toBe(false)
    expect(serverHoldsPush([dev("b2", "browser", true)], "b1")).toBe(false)
    expect(serverHoldsPush([], "b1")).toBe(false)
    expect(serverHoldsPush([dev("b1", "browser", true)], null)).toBe(false)
  })
})
