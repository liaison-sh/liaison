// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Any script that runs in the desktop window reaches the shell's commands
// (`generate_handler!` commands are not permission gated), which reach local
// sessions on this computer. So the window must not run more script than the
// browser build does: an injected inline handler, or a script from any https
// host, is code on the staff machine here and is refused by the web client's
// own policy (apps/api middleware/security-headers.ts: script-src 'self').
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const config = JSON.parse(
  readFileSync(path.join(import.meta.dir, "src-tauri", "tauri.conf.json"), "utf8"),
)
const csp: string = config.app?.security?.csp ?? ""
const scriptSources = (/script-src ([^;]+)/.exec(csp)?.[1] ?? "").split(/\s+/).filter(Boolean)

describe("the desktop window runs no script the browser build would refuse", () => {
  it("positive control: script-src is set and starts with 'self'", () => {
    expect(scriptSources[0]).toBe("'self'")
    expect(scriptSources).not.toContain("'unsafe-eval'")
  })

  it("runs no inline script", () => {
    expect(scriptSources).not.toContain("'unsafe-inline'")
  })

  it("runs no script from an arbitrary https host", () => {
    expect(scriptSources).not.toContain("https:")
  })
})
