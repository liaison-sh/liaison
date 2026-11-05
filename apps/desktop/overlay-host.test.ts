// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The overlay only reaches the user if three things line up: it is built to
// the exact path the shell includes, the shell attaches it while the webview
// is created (an initialization script cannot be added afterwards), and the
// window is therefore NOT auto-created from the config. Each of the three is
// silent when it breaks: the app simply runs with no overlay.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const HERE = import.meta.dir
const mainRs = readFileSync(path.join(HERE, "src-tauri/src/main.rs"), "utf8")
const buildRs = readFileSync(path.join(HERE, "src-tauri/build.rs"), "utf8")
const config = JSON.parse(readFileSync(path.join(HERE, "src-tauri/tauri.conf.json"), "utf8"))
const manifest = JSON.parse(readFileSync(path.join(HERE, "package.json"), "utf8"))
const viteConfig = readFileSync(path.join(HERE, "vite.config.ts"), "utf8")

describe("the overlay host", () => {
  it("compiles the built bundle into the shell from the path vite writes", () => {
    expect(mainRs).toContain('include_str!("../../dist/overlay.js")')
    expect(viteConfig).toContain('fileName: () => "overlay.js"')
    expect(viteConfig).toContain('formats: ["iife"]')
  })

  it("injects it as an initialization script rather than evaluating it later", () => {
    expect(mainRs).toContain("initialization_script(OVERLAY_BUNDLE)")
  })

  it("builds the window itself, because the config one would be created first", () => {
    expect(config.app.windows[0].create).toBe(false)
    expect(mainRs).toContain("WebviewWindowBuilder::from_config")
  })

  it("tells the developer which build step was skipped rather than failing on include_str", () => {
    expect(buildRs).toContain("bun run build:overlay")
    expect(buildRs).toContain("cargo:rerun-if-changed")
  })

  it("names the overlay build and the component suite as scripts", () => {
    expect(manifest.scripts["build:overlay"]).toBe("vite build")
    // Under Bun, not Node: Node's own experimental web storage shadows jsdom's
    // localStorage and leaves it method-less, so every component that
    // remembers something fails on the node runner alone. The suite runner
    // (scripts/test-run.ts, "desktop-ui") invokes it the same way.
    expect(manifest.scripts["test:ui"]).toBe("bunx --bun vitest run")
  })

  it("starts no session from the environment any more", () => {
    expect(mainRs).not.toContain("from_env")
  })
})
