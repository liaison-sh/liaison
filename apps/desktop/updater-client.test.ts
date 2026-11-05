// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client half of the updater: what the shell does with a check result.
//
// The decision itself is Rust, and its unit tests live beside it in
// src-tauri/src/updater.rs. What is pinned here is the WIRING, because the
// wiring is what a refactor drops silently: a shell that never calls check
// looks exactly like a shell with no update available, and a shell that
// installs without asking looks exactly like a shell that asked and got a yes.
//
// Three rules:
//   1. the check runs at startup, from Rust, through the plugin,
//   2. nothing installs without the user saying yes to a native dialog,
//   3. a development build checks for nothing at all: an agent session running
//      against a local server must never have its binary replaced underneath
//      it by a release the developer did not build.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const SRC = path.join(import.meta.dir, "src-tauri/src")
const updater = readFileSync(path.join(SRC, "updater.rs"), "utf8")
const main = readFileSync(path.join(SRC, "main.rs"), "utf8")

describe("the updater client", () => {
  it("is attached to the shell and checked at startup", () => {
    expect(main).toContain("mod updater;")
    expect(main).toContain("updater::attach(builder)")
    expect(main).toContain("updater::check_on_start(")
  })

  it("asks the plugin, rather than fetching the manifest by hand", () => {
    // Fetching and parsing it here would be a second implementation of the
    // signature check, and the second one is always the weaker one.
    expect(updater).toContain("UpdaterExt")
    expect(updater).toContain(".check()")
  })

  it("never installs without a native confirmation", () => {
    // The install call is reachable from exactly one place, and that place is
    // behind the dialog's answer.
    // Assembled from pieces, so neither this file nor the Rust test module at
    // the bottom of updater.rs counts as one of the occurrences.
    const needle = ["download", "and", "install"].join("_")
    const production = updater.split("#[cfg(test)]")[0] ?? ""
    expect(production.split(needle).length - 1).toBe(1)
    expect(updater).toContain("MessageDialogButtons::OkCancel")
    expect(updater).toContain("blocking_show")
  })

  it("does nothing at all on a development build", () => {
    expect(updater).toContain("#[cfg(debug_assertions)]")
    expect(updater).toContain("BuildKind::Dev")
  })

  it("on Windows starts the installer itself, after the local work stopped, then quits normally", () => {
    // 2026-09-28: the plugin's install hid the window, ShellExecuted the
    // installer and called std::process::exit, which skips RunEvent::Exit.
    // Nothing stopped the sidecar, nothing released the single instance
    // mutex, and nothing could tell a blocked installer from a started one.
    const production = updater.split("#[cfg(test)]")[0] ?? ""
    const windows = production.slice(
      production.indexOf("AfterInstall::InstallerRelaunches =>"),
      production.indexOf("AfterInstall::RestartHere =>"),
    )
    const order = ["crate::stop_local_work(", "launch_installer(", "app.exit(0)"]
    const at = order.map((step) => windows.indexOf(step))
    for (const [index, value] of at.entries()) {
      expect(value, `${order[index]} is missing`).toBeGreaterThanOrEqual(0)
    }
    expect(at).toEqual([...at].sort((a, b) => a - b))
    expect(production).toContain('NSIS_UPDATE_ARGS: [&str; 3] = ["/P", "/UPDATE", "/R"]')
  })

  it("restarts on macOS and Linux once the plugin has installed", () => {
    const production = updater.split("#[cfg(test)]")[0] ?? ""
    const other = production.slice(production.indexOf("AfterInstall::RestartHere =>"))
    expect(other.indexOf("request_restart()")).toBeGreaterThan(
      other.indexOf(["download", "and", "install"].join("_")),
    )
  })

  it("registers no updater command for the webview to call", () => {
    // The plugin's own commands would be reachable from the page if the
    // capability granted them; apps/desktop/capabilities.test.ts pins that it
    // grants none. What is pinned here is that the shell adds no command of
    // its own that would route around that.
    expect(main).not.toContain("updater::install")
    expect(main).not.toContain("check_for_update,")
  })
})
