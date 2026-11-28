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
//
// THE MAIN PAGE ITSELF (S7) runs one of two builds of apps/web, both under
// `capacitor://localhost` and the same policy: the one compiled into the app,
// or the connected server's own build of the same web app once the native host
// has verified it against Liaison's signing key (apps/mobile/ios/LiaisonShell:
// a signed statement, pinned keys, every file's sha256, the bridge range, the
// revocation floor, the kill switches). Either way the page's JavaScript that
// reaches the native plugins (the boot bundle) is the binary's own, the policy
// is the phone's, and the sandboxed frames still get no bridge. Native code
// never changes without an App Store update.

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

const IOS = path.join(import.meta.dir, "ios")
const read = (rel: string) => readFileSync(path.join(IOS, rel), "utf8")

describe("the main page runs only the bundled or a Liaison-signed shell", () => {
  it("stays on the app's own origin: no server URL in the Capacitor config", () => {
    const config = readFileSync(path.join(import.meta.dir, "capacitor.config.ts"), "utf8")
    expect(config).not.toMatch(/\burl\s*:/)
  })

  it("chooses its folder only from the verified store or the bundled public folder", () => {
    const controller = read("App/App/MainViewController.swift")
    expect(controller).toContain("override func instanceDescriptor()")
    expect(controller).toContain("ServedShellHost.shared.launch()")
    expect(controller).toContain("descriptor.appLocation = bundledRoot")
    // Capacitor's own persisted path (no verification, no fallback) is never used.
    expect(controller).not.toMatch(/persistServerBasePath|KeyValueStore/)
  })

  it("verifies with the pinned app-signing keys, native mode only, the bridge range included", () => {
    const store = read("LiaisonShell/Sources/LiaisonShell/ShellStore.swift")
    expect(store).toContain('public static let mode = "native"')
    expect(store).toContain("BridgeRange.allows(statement.bridgeIos, version: trust.bridgeVersion)")
    const host = read("LiaisonShell/Sources/LiaisonShell/ServedShellHost.swift")
    expect(host).toContain("keys: [PinnedKey] = PinnedKeys.keys")
  })

  it("a served page gets the binary's boot bundle and the phone's policy", () => {
    const page = read("LiaisonShell/Sources/LiaisonShell/MobilePage.swift")
    expect(page).toContain('public static let bootScriptName = "liaison-mobile-boot.js"')
    const parts = [...page.matchAll(/^ {8}"([^"]+)",$/gm)].map((m) => m[1])
    expect(parts.join("; ")).toBe(MOBILE_CSP)
  })

  it("only the host moves the page's folder, and only on a main-frame document load or a security leave", () => {
    const controller = read("App/App/MainViewController.swift")
    // Capacitor's WebView.setServerBasePath sets the router's base path: ignored.
    expect(controller).toContain("if !base.offer(newValue)")
    expect(controller).toContain("action.targetFrame?.isMainFrame == true")
    expect(controller).toContain("ServedShellHost.shared.promote()")
    const plugin = read("App/App/LiaisonNativePlugin.swift")
    expect(plugin).toContain('call.resolve(["changed": ServedShellHost.shared.reselect()])')
  })

  it("installed apps' frames still never reach the bridge", () => {
    const controller = read("App/App/MainViewController.swift")
    expect(controller).toContain("answerTheMainFrameOnly()")
    expect(controller).toContain("guard message.frameInfo.isMainFrame else { return }")
  })
})
