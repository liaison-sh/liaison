// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell has no frontend of its own: it loads the same Vite bundle the web
// app ships. An absolute path here is the packaging failure this whole slice
// is guarding against, so the config is pinned relative and the target is
// checked to be apps/web's real build output.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const SRC_TAURI = path.join(import.meta.dir, "src-tauri")
const CONFIG_PATH = path.join(SRC_TAURI, "tauri.conf.json")
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"))

describe("frontend dist config", () => {
  it("frontendDist is a relative path with no leading slash or drive letter", () => {
    expect(typeof config.build.frontendDist).toBe("string")
    expect(/^(\/|[A-Za-z]:)/.test(config.build.frontendDist)).toBe(false)
  })

  it("devUrl points at the existing web dev server port", () => {
    expect(config.build.devUrl).toBe("http://localhost:5173")
  })

  it("frontendDist resolves to the web app's own Vite output, not a second frontend", () => {
    const resolved = path.resolve(SRC_TAURI, config.build.frontendDist)
    expect(resolved).toBe(path.resolve(import.meta.dir, "../web/dist"))
  })

  it("the config file bakes in no absolute host path", () => {
    const source = readFileSync(CONFIG_PATH, "utf8")
    expect(source).not.toContain("/Volumes/")
    expect(source).not.toContain("/Users/")
  })
})
