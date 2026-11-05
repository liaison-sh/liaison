// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Windows signing, pinned as text. Three ways this goes wrong quietly:
//   - the installer is signed and the app .exe inside it is not, which is the
//     SmartScreen warning a customer sees on first launch and no CI run ever
//     reproduces;
//   - the sidecar .exe ships unsigned inside a signed installer, which is what
//     an antivirus quarantines a week after release;
//   - a missing Azure variable makes the step sign NOTHING and stay green,
//     because the skip path that exists for the pre-provisioning weeks never
//     learned to tell the two cases apart.
// There is no Windows machine in this pipeline's reach, so the script's shape
// is the assertion.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mainBinaryName } from "./ci/artifact-names"
import { WINDOWS_SIGNING_MARKER } from "./ci/build-publish-request"
import { tauriBuildCommand, windowsSignConfigArgs } from "./ci/tauri-build"
import { loadDesktopReleaseWorkflow, secretRef, step, stepIndex } from "./ci/workflow"

const SCRIPT = path.join(import.meta.dir, "ci", "sign-windows.ps1")
const script = readFileSync(SCRIPT, "utf8")

/** The six variables the monorepo's own Windows signing script reads. The
 *  names are shared on purpose: an operator provisions one set of secrets. */
const AZURE_VARS = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CODESIGN_ACCOUNT",
  "AZURE_CODESIGN_PROFILE",
  "AZURE_CODESIGN_ENDPOINT",
]

function at(marker: string): number {
  const index = script.indexOf(marker)
  expect(index, `marker not in sign-windows.ps1: ${marker}`).toBeGreaterThanOrEqual(0)
  return index
}

describe("the Windows signing script", () => {
  it("reads the same six Azure variables as the monorepo script", () => {
    for (const name of AZURE_VARS) expect(script).toContain(`env:${name}`)
  })

  it("stops on the first error", () => {
    expect(script).toContain('$ErrorActionPreference = "Stop"')
  })

  it("signs the sidecar exe, then the app exe, then the installer", () => {
    expect(at("liaison-sidecar-*.exe")).toBeLessThan(at("$AppExe"))
    expect(at("$AppExe")).toBeLessThan(at("bundle\\nsis"))
  })

  it("skips signing and LEAVES the artifacts untouched when AZURE_CLIENT_ID is unset", () => {
    // The pre-provisioning path: green, unsigned, and LOUD about it. A silent
    // skip is how an unsigned installer reaches a release page. Nothing is
    // copied anywhere: the files stay exactly where the bundler wrote them,
    // which is what the steps after this one go on to package and upload.
    const guard = at("if (-not $env:AZURE_CLIENT_ID)")
    expect(guard).toBeLessThan(at("& $SignTool sign"))
    const skipBlock = script.slice(guard, at("# --- Validate"))
    expect(skipBlock).toContain("UNSIGNED")
    expect(skipBlock).toContain("exit 0")
    expect(skipBlock).not.toContain("signtool")
  })

  it("fails loud when AZURE_CLIENT_ID is set and another variable is missing", () => {
    const validation = script.slice(at("# --- Validate"))
    for (const name of AZURE_VARS.filter((name) => name !== "AZURE_CLIENT_ID")) {
      expect(validation).toContain(name)
    }
    expect(validation).toContain("Write-Error")
    expect(validation).toContain("exit 1")
  })

  it("timestamps every signature", () => {
    // Artifact Signing certificates live about three days. Without an RFC3161
    // timestamp every signed build expires on its own that week.
    expect(script).toContain("/tr ")
    expect(script).toContain("/td SHA256")
  })

  it("writes its metadata file outside the checkout, and removes it", () => {
    // The file names the signing account, the certificate profile and the
    // endpoint. Written into the working directory it is a file the next step
    // can upload, glob into an artifact, or commit, and on a self hosted
    // runner it simply stays there between jobs.
    expect(script).not.toContain("Join-Path (Get-Location)")
    expect(script).toMatch(/RUNNER_TEMP|\$env:TEMP/)
    expect(script).toContain("Remove-Item")
    expect(at("& $SignTool sign")).toBeLessThan(at("Remove-Item"))
  })

  it("records what it did in a marker file, on both paths", () => {
    // The publish job holds no Azure secret. Whatever it reads out of its own
    // environment says "unsigned" on every release, signed ones included, so
    // the only place the answer can come from is the job that signed: it
    // writes it down, beside the artifacts, on the signing path AND on the
    // skip path.
    expect(script).toContain(WINDOWS_SIGNING_MARKER)
    const skipBlock = script.slice(at("if (-not $env:AZURE_CLIENT_ID)"), at("# --- Validate"))
    expect(skipBlock).toContain("Write-SigningMarker")
    const installerStage = script.slice(at('if ($Stage -eq "installer"'))
    expect(installerStage).toContain("Write-SigningMarker")
  })

  it("writes the marker beside the installer, where the upload picks it up", () => {
    // Anywhere else and the file is not in the artifact the publish job
    // downloads, which is the same as never writing it.
    const marker = script.slice(at("function Write-SigningMarker"))
    expect(marker).toContain("$Installers")
    expect(marker).toContain("signed")
    expect(marker).toContain("reason")
    expect(marker).toContain("publisher")
  })

  it("never echoes a credential", () => {
    for (const name of AZURE_VARS) {
      expect(script).not.toContain(`Write-Host $env:${name}`)
      expect(script).not.toContain(`Write-Host "$env:${name}"`)
    }
  })
})

describe("the Windows signing steps", () => {
  const steps = loadDesktopReleaseWorkflow().jobs["build-windows"].steps
  const binaries = step(steps, "Sign the Windows binaries")
  const installer = step(steps, "Sign the Windows installer")

  it("signs the binaries BEFORE the bundler wraps them in the installer", () => {
    // Signing target/release after the installer was written leaves the copy
    // inside the installer unsigned, and the installer's own signature makes
    // that look fine.
    const signBinaries = stepIndex(steps, "Sign the Windows binaries")
    const bundle = stepIndex(steps, "Build the app bundle")
    const signInstaller = stepIndex(steps, "Sign the Windows installer")
    expect(signBinaries).toBeGreaterThan(stepIndex(steps, "Compile the app binary"))
    expect(signBinaries).toBeLessThan(bundle)
    expect(bundle).toBeLessThan(signInstaller)
    expect(signInstaller).toBeLessThan(stepIndex(steps, "Upload the Windows artifact"))
  })

  it("runs the two stages of one script, not two scripts", () => {
    expect(binaries.run).toContain("apps/desktop/ci/sign-windows.ps1")
    expect(binaries.run).toContain("-Stage binaries")
    expect(installer.run).toContain("apps/desktop/ci/sign-windows.ps1")
    expect(installer.run).toContain("-Stage installer")
  })

  it("takes every Azure variable from a named secret, in both steps", () => {
    const expected = Object.fromEntries(AZURE_VARS.map((name) => [name, secretRef(name)]))
    expect(binaries.env).toEqual(expected)
    expect(installer.env).toEqual(expected)
  })

  it("uploads the signing marker with the artifacts", () => {
    // The marker is what the publish gate reads to decide whether the
    // Authenticode half runs at all. Left out of the upload it is a marker
    // nobody sees, and the gate refuses every release.
    const upload = step(steps, "Upload the Windows artifact")
    const paths = String((upload.with as { path?: string })?.path ?? "")
    expect(paths).toContain(WINDOWS_SIGNING_MARKER)
    expect(stepIndex(steps, "Sign the Windows installer")).toBeLessThan(
      stepIndex(steps, "Upload the Windows artifact"),
    )
  })

  it("checks the bundle for absolute paths before the installer is signed", () => {
    expect(stepIndex(steps, "Verify no absolute paths in the bundle")).toBeLessThan(
      stepIndex(steps, "Sign the Windows installer"),
    )
  })
})

describe("the check that the bundler did not drop the signatures", () => {
  // `tauri build --bundles nsis` runs cargo again. Cargo decides for itself
  // whether to relink, and a relink rewrites target/release/Liaison.exe, which
  // DISCARDS the Authenticode signature the step before put on it. Nothing in
  // the build says so: the installer is signed, the pipeline is green, and the
  // executable a customer runs is unsigned. So the signatures are re-read from
  // the files the bundler actually packaged, after the bundler ran.
  const steps = loadDesktopReleaseWorkflow().jobs["build-windows"].steps
  const SCRIPT = path.join(import.meta.dir, "ci", "verify-windows-signatures.ps1")
  const LIBRARY = path.join(import.meta.dir, "ci", "windows-signature.ps1")

  it("runs after the bundler and before the installer is signed", () => {
    const verify = stepIndex(steps, "Verify the Windows binaries are still signed")
    expect(verify).toBeGreaterThan(stepIndex(steps, "Build the app bundle"))
    expect(verify).toBeLessThan(stepIndex(steps, "Sign the Windows installer"))
    expect(step(steps, "Verify the Windows binaries are still signed").run).toContain(
      "apps/desktop/ci/verify-windows-signatures.ps1",
    )
  })

  it("reads the sidecar the bundler packaged, and names the publisher to expect", () => {
    const run = step(steps, "Verify the Windows binaries are still signed").run ?? ""
    expect(run).toContain("liaison-sidecar")
    expect(run).toContain("-Publisher")
  })

  it("leaves the app exe to the installed copy: the bundler restores it unsigned", () => {
    // tauri-bundler 2.12 signs the patched main binary per package type, packs
    // it, then restores the unsigned original in target/release (bundle.rs,
    // "Restore unsigned and unpatched binary"). Reading it here failed 0.1.14
    // on a binary nobody ships. The installed copy is what a customer runs,
    // and the registration check reads its signature after the install.
    const run = step(steps, "Verify the Windows binaries are still signed").run ?? ""
    expect(run).not.toContain("LIAISON_MAIN_BINARY")
    expect(run).not.toContain("target/release")
    expect(stepIndex(steps, "Verify the Windows registration")).toBeGreaterThan(
      stepIndex(steps, "Install the app silently"),
    )
    const registration = step(steps, "Verify the Windows registration").run ?? ""
    expect(registration).toContain("apps/desktop/ci/verify-windows-registration.ps1")
    expect(registration).toContain("-Publisher")
    const script = readFileSync(
      path.join(import.meta.dir, "ci", "verify-windows-registration.ps1"),
      "utf8",
    )
    expect(script).toContain("$env:LIAISON_MAIN_BINARY")
    expect(script).toContain("The signatures of the binaries that were actually installed")
  })

  it("names files the build actually produces, and none it does not", () => {
    // This assertion used to pin `Liaison.exe`, which nothing produces, and
    // the step it pinned died on the runner reporting exactly that: "BAD:
    // matched no file: apps/desktop/src-tauri/target/release/Liaison.exe"
    // (dry run 34777230634). A pattern that matches no file is a failure by
    // design here, so a guessed name is a red job rather than a soft warning.
    // The name is derived from the config and the cargo manifest instead.
    const run = step(steps, "Verify the Windows binaries are still signed").run ?? ""
    expect(run).not.toContain("/Liaison.exe")
    expect(mainBinaryName()).toBe("liaison-desktop")
    // Derived before the registration check reads it from the environment.
    expect(stepIndex(steps, "Name the binary the bundler installs")).toBeLessThan(
      stepIndex(steps, "Verify the Windows registration"),
    )
  })

  it("keeps the refusal fail closed for a file that should exist and does not", () => {
    const script = readFileSync(SCRIPT, "utf8")
    expect(script).toContain("matched no file")
    expect(script).toContain("exit 1")
  })

  it("throws away the bundler's own updater signature before the installer is re-signed", () => {
    // `tauri build` signs the installer, then the Authenticode step rewrites
    // it. The bundler's .sig covers the earlier bytes and its name matches the
    // upload glob, so it would ship beside the real one.
    const discard = stepIndex(steps, "Discard the bundler's own updater signature")
    expect(discard).toBeGreaterThan(stepIndex(steps, "Build the app bundle"))
    expect(discard).toBeLessThan(stepIndex(steps, "Sign the Windows installer"))
    expect(step(steps, "Discard the bundler's own updater signature").run).toContain("*.exe.sig")
  })

  it("knows whether a signature was even asked for", () => {
    // Before the service principal exists nothing is signed, and a check that
    // demands a signature then is a red pipeline nobody can fix. It asserts
    // the UNSIGNED state instead, so the two cases stay told apart.
    const run = step(steps, "Verify the Windows binaries are still signed").env ?? {}
    expect(run.AZURE_CLIENT_ID).toBe(secretRef("AZURE_CLIENT_ID"))
  })

  it("fails loud on anything but a Valid signature from the expected publisher", () => {
    const library = readFileSync(LIBRARY, "utf8")
    expect(library).toContain("Get-AuthenticodeSignature")
    expect(library).toContain("Valid")
    expect(library).toContain("SignerCertificate.Subject")
    expect(library).toContain("$Publisher")
    // Unsigned is a state it can assert, not a state it ignores.
    expect(library).toContain("NotSigned")
  })

  it("refuses a pattern that matches no file", () => {
    // The failure this whole step guards is a MISSING signature, so a step
    // that finds no file to look at and exits 0 is the same defect wearing a
    // check's clothes.
    const script = readFileSync(SCRIPT, "utf8")
    expect(script).toContain("matched no file")
    expect(script).toContain("exit 1")
  })
})

describe("the bundler signs through the same script, whatever it recompiles", () => {
  // Found on the first signed test build (runs 36410435681, 36411933927):
  // `tauri build --bundles nsis` recompiled liaison-desktop AFTER the signing
  // step, and "Verify the Windows binaries are still signed" read NotSigned.
  // The unsigned 0.1.9 run recompiled there too, so it is not the signing that
  // causes it, and why cargo relinks is not ours to pin. What is ours: the
  // bundler signs the main binary itself, AFTER any recompile and after it
  // patches the binary, through bundle.windows.signCommand (tauri-bundler
  // 2.7: bundle.rs signs the main binary per package type and every
  // externalBin not already signed; nsis/mod.rs signs the uninstaller through
  // !uninstfinalize and the installer). That command is this same script.
  const DESKTOP = import.meta.dir

  it("hands tauri build a signCommand on Windows, and nothing elsewhere", () => {
    const configPath = path.join(mkdtempSync(path.join(tmpdir(), "liaison-sign-")), "sign.json")
    const args = windowsSignConfigArgs("win32", DESKTOP, configPath)
    expect(args).toEqual(["--config", configPath])
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    expect(config).toEqual({
      bundle: {
        windows: {
          signCommand: {
            cmd: "pwsh",
            args: [
              "-NoProfile",
              "-NonInteractive",
              "-File",
              path.join(DESKTOP, "ci", "sign-windows.ps1"),
              "-Stage",
              "file",
              "-Path",
              "%1",
            ],
          },
        },
      },
    })
    expect(windowsSignConfigArgs("darwin", DESKTOP, configPath)).toEqual([])
    expect(windowsSignConfigArgs("linux", DESKTOP, configPath)).toEqual([])
  })

  it("is part of the command tauri-build.ts spawns, on Windows only", () => {
    const configPath = path.join(mkdtempSync(path.join(tmpdir(), "liaison-sign-")), "sign.json")
    const windows = tauriBuildCommand(["--bundles", "nsis"], {}, "win32", configPath)
    expect(windows).toEqual(["bunx", "tauri", "build", "--bundles", "nsis", "--config", configPath])
    expect(tauriBuildCommand(["--bundles", "nsis"], {}, "linux", configPath)).toEqual([
      "bunx",
      "tauri",
      "build",
      "--bundles",
      "nsis",
    ])
  })

  it("gives the bundle step the Azure variables the signCommand reads", () => {
    const steps = loadDesktopReleaseWorkflow().jobs["build-windows"].steps
    const bundle = step(steps, "Build the app bundle")
    const expected = Object.fromEntries(AZURE_VARS.map((name) => [name, secretRef(name)]))
    expect(bundle.env).toEqual(expected)
    // The compile before it gets them too: it runs the same command, so the
    // two cargo builds see the same configuration.
    expect(step(steps, "Compile the app binary").env).toEqual(expected)
  })

  it("signs exactly the file it is given, and takes the unsigned skip for it too", () => {
    const pwsh = Bun.which("pwsh")
    expect(pwsh, "pwsh is required").toBeTruthy()
    const file = path.join(mkdtempSync(path.join(tmpdir(), "liaison-sign-")), "a b.exe")
    writeFileSync(file, "MZ unsigned")
    const env = { ...process.env }
    for (const name of AZURE_VARS) delete env[name]
    const run = Bun.spawnSync(
      [pwsh as string, "-NoProfile", "-File", SCRIPT, "-Stage", "file", "-Path", file],
      { env },
    )
    const out = `${run.stdout.toString()}${run.stderr.toString()}`
    expect(run.exitCode, out).toBe(0)
    expect(out).toContain(`UNSIGNED: ${file}`)
    expect(out).not.toContain("liaison-sidecar")
    expect(readFileSync(file, "utf8")).toBe("MZ unsigned")
    // No marker from a per file call: only the installer stage writes it.
    const fileStage = script.slice(at('if ($Stage -eq "file") {\n'))
    expect(fileStage.slice(0, fileStage.indexOf("\n}"))).toContain("Sign-Binary $Path")
  })
})
