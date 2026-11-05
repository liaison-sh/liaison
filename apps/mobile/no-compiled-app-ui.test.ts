// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE PHONE FRAMES EVERY APP UI THE SERVER DELIVERS (D7, S14).
//
// On iOS and Android the page holds the Capacitor bridge (push, the stored
// refresh token), and Apple 4.7.2 forbids exposing native APIs to downloaded
// code. So the phone carries no app UI of its own and runs none in its page:
//
// - no first-party app's UI is compiled into the web build it wraps (the
//   `native` mode of apps/web's Vite build): no web source reaches into
//   `bundled-apps/`, and no build plugin compiles them in;
// - there is no in-page path for a server bundle: the phone's policy runs only
//   its own scripts (`script-src 'self'`, no `liaison-app:` scheme, no blob:,
//   no remote host), and the phone's shell publishes no verifier, so the page's
//   verified path (desktop only, apps/web framework/verified-app.ts) never
//   applies. Every app, first-party included, renders in the sandboxed frame.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { MOBILE_CSP } from "./scripts/boot-injection"

const WEB = path.resolve(import.meta.dir, "../web")

function sources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === "tests" || name === "node_modules") continue
      out.push(...sources(full))
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

describe("the phone carries and runs no app UI of its own", () => {
  it("no web source the phone wraps compiles a bundled app's UI in", () => {
    const offenders = sources(path.join(WEB, "src")).filter((file) =>
      /bundled-apps\//.test(readFileSync(file, "utf8")),
    )
    expect(offenders.map((f) => path.relative(WEB, f))).toEqual([])
  })

  it("the web build has no plugin that compiles bundled apps", () => {
    for (const config of ["vite.config.ts", "vitest.config.ts"]) {
      const text = readFileSync(path.join(WEB, config), "utf8")
      expect(text).not.toMatch(/bundled-app|bundledAppHost/)
    }
  })

  it("the phone's policy runs only its own scripts: no verified-app scheme, no remote code", () => {
    const script = MOBILE_CSP.split(";")
      .map((d) => d.trim())
      .find((d) => d.startsWith("script-src "))
    expect(script).toBe("script-src 'self'")
  })

  it("the phone's shell publishes no app verifier", () => {
    const offenders = sources(path.join(import.meta.dir, "src")).filter((file) =>
      /verifyFirstPartyApp|verify_first_party_app/.test(readFileSync(file, "utf8")),
    )
    expect(offenders).toEqual([])
  })
})
