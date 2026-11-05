// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The post-install smoke check, pinned as text. What it exists to catch is a
// build that INSTALLS perfectly and registers nothing: the app launches, so a
// CI job that only starts the binary is green, and the deep links, the
// uninstall entry and the command line are all missing. Those three are
// exactly what an update silently drops when the installer hooks stop being
// included (a renamed hook file, a config key lost in a merge).
//
// The script itself runs on Windows only. There is no Windows machine here, so
// the assertion is over the text and over its wiring into the job that does
// have one.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { mainBinaryName, PRODUCT } from "./ci/artifact-names"
import { loadDesktopReleaseWorkflow, secretRef, step, stepIndex } from "./ci/workflow"

const SCRIPT = path.join(import.meta.dir, "ci", "verify-windows-registration.ps1")
const script = readFileSync(SCRIPT, "utf8")

describe("the Windows registration check", () => {
  it("reads the url scheme key the deep link plugin needs", () => {
    expect(script).toContain("HKCU:\\Software\\Classes\\liaison")
    expect(script).toContain("shell\\open\\command")
  })

  it("checks the scheme points at an executable that exists", () => {
    // A key holding the previous version's path is present and useless, which
    // is the update failure this whole guard is about.
    expect(script).toContain("Test-Path")
    expect(script).toContain(".exe")
  })

  it("asks whether the install directory is a PATH ELEMENT, normalising both sides", () => {
    // The installer adds it as one element (EnVar), so that is the question to
    // ask. A substring test says yes to a directory that merely shares a
    // prefix, and a raw element comparison says no to the same directory
    // written with a trailing separator, which Windows itself treats as equal.
    expect(script).toContain("ConvertTo-PathEntry")
    expect(script).not.toMatch(/\$UserPath\s*-(like|match)/)
    expect(script).not.toContain("$UserPath.Contains(")
  })

  it("checks the uninstall key and the user PATH entry as separate failures", () => {
    expect(script).toContain("Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall")
    expect(script).toContain('[Environment]::GetEnvironmentVariable("Path", "User")')
  })

  it("looks the uninstall key up under the PRODUCT name, which is what NSIS writes", () => {
    // tauri's template defines UNINSTKEY as Uninstall\${PRODUCTNAME}. This
    // script asked for the bundle identifier, so it would have reported "no
    // uninstall entry" on a perfectly registered install and taken the PATH
    // and signature checks down with it (both key off InstallLocation).
    expect(script).toContain("Uninstall\\$ProductName")
    expect(script).not.toMatch(/liaison\.desktop/)
    expect(script).toMatch(/\[string\]\$ProductName = "Liaison"/)
    expect(PRODUCT).toBe("Liaison")
  })

  it("strips the quotes NSIS writes around InstallLocation before joining paths onto it", () => {
    // The template writes "$\"$INSTDIR$\"", so the registry value carries its
    // own quotes. Joining a file name onto that reads every installed binary
    // as absent.
    expect(script).toMatch(/InstallLocation\.Trim\(\)\.Trim\('"'\)/)
  })

  it("reports every missing registration, then exits 1", () => {
    // Stopping at the first failure means three runs to learn three things,
    // and this runs on a machine nobody can log into.
    expect(script).toContain("$failures")
    expect(script).toContain("exit 1")
    expect(script).toContain("exit 0")
  })

  it("fails when the scheme is absent rather than treating absence as fine", () => {
    // -ErrorAction SilentlyContinue with no null check is how a check like
    // this passes on a machine where nothing is registered at all.
    expect(script).toMatch(/if \(-not \$(Scheme|Command)/)
  })
})

describe("the Windows registration smoke step", () => {
  const steps = loadDesktopReleaseWorkflow().jobs["build-windows"].steps

  it("installs the signed installer silently, then checks it", () => {
    const install = stepIndex(steps, "Install the app silently")
    const verify = stepIndex(steps, "Verify the Windows registration")
    expect(install).toBeGreaterThan(stepIndex(steps, "Sign the Windows installer"))
    expect(verify).toBeGreaterThan(install)
    expect(verify).toBeLessThan(stepIndex(steps, "Upload the Windows artifact"))
    expect(step(steps, "Install the app silently").run).toContain("/S")
  })

  it("runs the checked-in script, not an inline copy of it", () => {
    expect(step(steps, "Verify the Windows registration").run).toContain(
      "apps/desktop/ci/verify-windows-registration.ps1",
    )
  })
})

describe("the installed binaries' signatures", () => {
  // The installer is signed, and that says nothing about what it INSTALLED.
  // A relink between the two signing stages, or a bundler that staged a stale
  // copy, both end with an unsigned Liaison.exe on the machine and every check
  // in the pipeline green. So the check runs against the installed files,
  // after the install, which is the only place the question can be answered.
  it("reads the authenticode status of the installed app and sidecar", () => {
    // By the name the installer actually writes. NSIS installs
    // $INSTDIR\${MAINBINARYNAME}.exe, and MAINBINARYNAME is the cargo
    // binary's name: `Liaison.exe` is produced by nothing, anywhere.
    expect(script).toContain("$MainBinaryName.exe")
    expect(script).toContain("liaison-sidecar.exe")
    expect(script).toContain("Get-LiaisonSignatureFailures")
    expect(script).not.toContain('@("Liaison.exe"')
    expect(mainBinaryName()).toBe("liaison-desktop")
  })

  it("refuses to run without being told that name, rather than guessing it", () => {
    expect(script).toMatch(/\[string\]\$MainBinaryName = \$env:LIAISON_MAIN_BINARY/)
    expect(script).toContain("no main binary name")
  })

  it("takes the expected publisher as a parameter rather than assuming one", () => {
    expect(script).toMatch(/\[string\]\$Publisher/)
  })

  it("asserts the unsigned state when no signature was asked for", () => {
    // AZURE_CLIENT_ID unset is the pre-provisioning build: unsigned on
    // purpose. Demanding a signature there is a red pipeline nobody can fix,
    // and skipping the check entirely is how the check stops existing.
    expect(script).toContain("AZURE_CLIENT_ID")
  })

  it("is given the publisher by the workflow step that runs it", () => {
    const steps = loadDesktopReleaseWorkflow().jobs["build-windows"].steps
    const entry = step(steps, "Verify the Windows registration")
    expect(entry.run).toContain("-Publisher")
    expect(entry.env?.AZURE_CLIENT_ID).toBe(secretRef("AZURE_CLIENT_ID"))
  })

  it("is given the main binary name by a step that derives it, before it runs", () => {
    const steps = loadDesktopReleaseWorkflow().jobs["build-windows"].steps
    const derive = step(steps, "Name the binary the bundler installs")
    expect(derive.run).toContain("artifact-names.ts main-binary")
    expect(derive.run).toContain("LIAISON_MAIN_BINARY")
    expect(stepIndex(steps, "Name the binary the bundler installs")).toBeLessThan(
      stepIndex(steps, "Verify the Windows registration"),
    )
  })
})
