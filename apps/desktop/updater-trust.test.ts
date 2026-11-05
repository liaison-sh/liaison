// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What an installed app trusts when it updates itself: the one endpoint and
// the one public key in tauri.conf.json, over TLS, and only a NEWER version.
// The plugin enforces all three by default (it verifies the minisign
// signature before it installs, refuses a non https endpoint and offers a
// release only when its version is greater than the running one). These
// assertions pin that nothing in the shell turns a default off.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const SRC_TAURI = path.join(import.meta.dir, "src-tauri")
const config = JSON.parse(readFileSync(path.join(SRC_TAURI, "tauri.conf.json"), "utf8"))
const updaterRs = readFileSync(path.join(SRC_TAURI, "src", "updater.rs"), "utf8")
const production = updaterRs.split("#[cfg(test)]")[0] ?? ""
const shellSources = ["main.rs", "updater.rs"].map(
  (file) => readFileSync(path.join(SRC_TAURI, "src", file), "utf8").split("#[cfg(test)]")[0] ?? "",
)

describe("the desktop updater's trust", () => {
  it("turns off none of the plugin's transport checks", () => {
    const updater = config.plugins.updater as Record<string, unknown>
    for (const key of [
      "dangerousInsecureTransportProtocol",
      "dangerousAcceptInvalidCerts",
      "dangerousAcceptInvalidHostnames",
    ]) {
      expect(updater[key]).toBeUndefined()
    }
    expect(JSON.stringify(config)).not.toMatch(/dangerous/i)
  })

  it("keeps the plugin's own newer-only comparison (no downgrade)", () => {
    for (const source of shellSources) {
      expect(source).not.toContain("version_comparator")
      expect(source).not.toContain("default_version_comparator")
    }
  })

  it("never replaces the configured endpoint or public key at runtime", () => {
    for (const source of shellSources) {
      expect(source).not.toMatch(/\.endpoints\(/)
      expect(source).not.toMatch(/\.pubkey\(/)
      expect(source).not.toMatch(/\.header\(/)
    }
    expect(production).toContain("tauri_plugin_updater::Builder::new().build()")
  })

  it("installs only bytes the plugin downloaded and verified", () => {
    // `install(bytes)` skips verification by itself; every call must take the
    // bytes `download` returned (which verified the signature).
    const installs = [...production.matchAll(/update\s*\.install\(([^)]*)\)/g)].map((m) => m[1])
    expect(installs.length).toBeGreaterThan(0)
    for (const argument of installs) expect(argument?.trim()).toBe("bytes")
    expect(production).toMatch(/let bytes = update\s*\.download\(/)
  })
})
