// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The install and launch check, and its place in each platform job.
//
// The check exists because every earlier step in this pipeline asks a tool
// whether a file is well formed, and none of them asks the operating system
// whether the thing runs. A bundle can be signed, notarized, stapled, checked
// for absolute paths and correctly named while its window never builds, and
// every one of those checks stays green.
//
// So it runs on the runner that built the package, after packaging (there is
// nothing to install before that) and before the upload (an artifact that does
// not launch must not become a release asset).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { mainBinaryName } from "./ci/artifact-names"
import { type Job, loadDesktopReleaseWorkflow, step, stepIndex } from "./ci/workflow"

const workflow = loadDesktopReleaseWorkflow()
const shell = readFileSync(path.join(import.meta.dir, "ci/install-launch-check.sh"), "utf8")
const powershell = readFileSync(path.join(import.meta.dir, "ci/install-launch-check.ps1"), "utf8")

const CHECK = "Scripted install and launch check"

function job(name: string): Job {
  const found = workflow.jobs[name]
  if (!found) throw new Error(`no job named ${name}`)
  return found
}

describe("the install and launch step", () => {
  it.each(["build-macos", "build-windows", "build-linux"])(
    "runs in %s after packaging and before the upload",
    (name) => {
      const steps = job(name).steps
      const check = stepIndex(steps, CHECK)
      expect(check).toBeGreaterThanOrEqual(0)
      const upload = steps.findIndex((step) =>
        (step.uses ?? "").startsWith("actions/upload-artifact"),
      )
      expect(upload).toBeGreaterThan(check)
      const packaged = Math.max(
        stepIndex(steps, "Build the app bundle"),
        stepIndex(steps, "Package DMG"),
      )
      expect(check).toBeGreaterThan(packaged)
    },
  )
})

describe("the check itself", () => {
  it("asks the window server, not only the process table", () => {
    // A process that is alive proves the binary started. The window is built
    // in the shell's setup callback, after the webview is created, and that is
    // where a bad bundle actually dies.
    expect(shell).toContain("CGWindowListCopyWindowInfo")
    expect(powershell).toContain("MainWindowHandle")
  })

  it("on a desktop-less Windows service runner, still asks for more than a live process", () => {
    // Session 0 has no desktop, so no window can come up. The fallback must
    // need the webview engine started under the app, never alive alone.
    expect(powershell).toContain("SessionId -eq 0")
    expect(powershell).toContain("msedgewebview2.exe")
    expect(powershell).toMatch(/if \(-not \$webview\) \{ Write-Error/)
    expect(powershell).toMatch(/if \(-not \$alive\) \{ Write-Error/)
  })

  it("requires the installed copy to carry a usable sidecar", () => {
    // The sidecar is spawned when a session starts, not at launch, so its
    // absence is invisible until the first agent turn. Both halves check the
    // installed copy carries one.
    expect(shell).toContain("codesign --verify --strict")
    expect(powershell).toContain("liaison-sidecar")
  })

  it("installs the way a customer does, rather than running from the image", () => {
    expect(shell).toContain("hdiutil attach")
    expect(shell).toContain("cp -R")
  })

  it("launches the executable the installer actually writes", () => {
    // NSIS installs $INSTDIR\${MAINBINARYNAME}.exe, and MAINBINARYNAME is the
    // CARGO binary's name, not the product name. This script looked for
    // `Liaison.exe`, which nothing in the pipeline produces, so it would have
    // thrown on a correct install: the same guessed name that killed dry run
    // 34777230634 one step earlier.
    expect(powershell).toContain("$MainBinaryExe")
    expect(powershell).not.toContain('Filter "Liaison.exe"')
    expect(mainBinaryName()).toBe("liaison-desktop")
  })

  it("refuses to run without being told that name, rather than guessing it", () => {
    expect(powershell).toMatch(/\[string\]\$MainBinaryName = \$env:LIAISON_MAIN_BINARY/)
    expect(powershell).toContain("no main binary name")
  })

  it("is given the name by a Windows job step that derives it, before it runs", () => {
    const steps = job("build-windows").steps
    expect(step(steps, "Name the binary the bundler installs").run).toContain(
      "artifact-names.ts main-binary",
    )
    expect(stepIndex(steps, "Name the binary the bundler installs")).toBeLessThan(
      stepIndex(steps, CHECK),
    )
  })

  it("never needs the owner's open Liaison closed: the launch is skipped, the install still checked", () => {
    // The single instance plugin makes a second copy quit silently, and this
    // Mac is also the owner's computer, whose Liaison stays open. An open one
    // used to fail a good build (0.1.12, 0.1.24); a second copy beside it would
    // read the same sign-in. So the launch is skipped and the rest is checked.
    const guard = shell.indexOf('pgrep -f "/Contents/MacOS/liaison-desktop"')
    expect(guard).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(shell.indexOf('"$BINARY" > "$LOG" 2>&1 &'))
    const skip = shell.slice(guard, shell.indexOf('"$BINARY" > "$LOG" 2>&1 &'))
    expect(skip).toContain('codesign --verify --deep --strict "$APP"')
    expect(skip).toContain("sidecar_is_ready")
    expect(skip).toContain("launch skipped")
    expect(skip).toContain("exit 0")
    expect(shell).not.toContain("quit it and run the check again")
  })

  it("cleans up after itself even when it fails", () => {
    // It runs on this Mac, which is also the macOS CI runner. A left behind
    // app process or a mounted image is somebody else's failing build.
    expect(shell).toContain("trap cleanup EXIT")
    expect(shell).toContain("hdiutil detach")
  })
})
