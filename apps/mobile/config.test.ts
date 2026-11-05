// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Capacitor project's identity, pinned. Two things about it are load
// bearing and neither is visible from the native projects once they are
// generated: the bundle id (a store listing is bound to it forever) and the
// `webDir` (the ONE apps/web build the desktop shell also wraps: a second
// frontend built for mobile is the failure this pins shut).
//
// The third assertion is the no-Node rule applied to this package's own
// manifest: nothing shipped inside the app may need a Node runtime, so every
// dependency here is either Capacitor's own runtime (native, no Node) or
// build-time tooling named in the allowlist below.

import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

const ROOT = import.meta.dir

/** Build-time only: runs on a developer or CI machine, never inside the app. */
const BUILD_TIME_TOOLING = new Set([
  "@capacitor/cli",
  "@happy-dom/global-registrator",
  "typescript",
  "@types/bun",
])

/**
 * Runtime (shipped-in-app) dependencies that are not `@capacitor/*` but are
 * still no-Node: native Capacitor plugins, or workspace source bundled into
 * the boot code. Each entry names the reason
 * so this allowlist cannot grow by accident.
 */
const RUNTIME_ALLOWLIST: Record<string, string> = {
  "@aparajita/capacitor-biometric-auth":
    "Capacitor 8 biometric plugin, maintained; the capacitor-native-biometric alternative is Capacitor 5 era.",
  "@aparajita/capacitor-secure-storage":
    "Capacitor 8 Keychain / Keystore storage for the refresh token, same maintainer as the biometric plugin; Preferences is plain storage.",
  "@liaison/shared":
    "Workspace source, not a plugin: the boot bundle imports its import-free server-address rule so first launch and the settings form agree.",
}

describe("capacitor config", () => {
  it("declares the appId and a webDir that resolves to the apps/web build", async () => {
    const config = (await import("./capacitor.config")).default
    expect(config.appId).toBe("sh.liaison.mobile")
    expect(config.appName).toBe("Liaison")
    // Relative to apps/mobile, and it must be apps/web's own Vite output: the
    // mobile app wraps that build, in the native mode that leaves out the
    // legacy Argon2id KDF. Never `dist`, which is the desktop shell's build and
    // keeps it.
    expect(config.webDir).toBe("../web/dist-native")
    expect(path.resolve(ROOT, config.webDir as string)).toBe(
      path.resolve(ROOT, "..", "web", "dist-native"),
    )
    // A `server.url` would make the shipped app load a remote origin instead
    // of the bundled assets.
    expect(config.server?.url).toBeUndefined()
  })

  it("prints no plugin traffic to the device console, in any build", async () => {
    // The Preferences plugin answers with the values it stores, and the
    // bridge's default logging prints every answer: the refresh token in
    // clear text in the device log.
    const config = (await import("./capacitor.config")).default
    expect(config.loggingBehavior).toBe("none")
  })

  it("declares no Node runtime dependency beyond build-time tooling", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      expect(name.startsWith("@capacitor/") || name in RUNTIME_ALLOWLIST).toBe(true)
      expect(BUILD_TIME_TOOLING.has(name)).toBe(false)
    }
    for (const name of Object.keys(manifest.devDependencies ?? {})) {
      expect(BUILD_TIME_TOOLING.has(name)).toBe(true)
    }
  })

  it("keeps the web build as the only frontend", () => {
    // No index.html of its own anywhere in apps/mobile/src: the webview loads
    // apps/web's build, and a second entry page here would be a second app.
    expect(existsSync(path.join(ROOT, "index.html"))).toBe(false)
    expect(existsSync(path.join(ROOT, "src", "index.html"))).toBe(false)
  })
})
