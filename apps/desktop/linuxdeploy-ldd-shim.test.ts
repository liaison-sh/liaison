// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The AppImage half of the Linux job died on a question nobody needed
// answered. linuxdeploy runs `ldd` over every ELF file in the AppDir; on the
// runner it reached the Bun compiled sidecar, ldd exited 1, and linuxdeploy
// threw `Failed to run ldd: exited with code 1` from inside the gtk plugin
// (SIGABRT, plugin exit 134, no AppImage). The sidecar needs no library
// deployment at all: every library it names is on linuxdeploy's own blacklist,
// and the pass that did complete deployed nothing for it.
//
// So the shim answers for that one file with the sentence linuxdeploy already
// handles, and passes everything else to the real ldd. These tests run the
// shim as a program, because a shell script asserted by reading it is a shell
// script nobody ran.
import { describe, expect, it } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadDesktopReleaseWorkflow, step, stepIndex } from "./ci/workflow"

const SHIM = path.join(import.meta.dir, "ci", "linuxdeploy-ldd-shim.sh")
const steps = loadDesktopReleaseWorkflow().jobs["build-linux"].steps
const SHIM_STEP = "Put the ldd shim in front of the AppImage bundler"
const VERIFY_STEP = "Verify the sidecar inside the AppImage still runs"

/** A stand in for the real ldd, so the delegating half can be observed on a
 *  machine that has no ldd at all. It records its arguments and answers the
 *  way ldd answers for a binary with one dependency. */
function fakeLdd(): { path: string; calls: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "ldd-shim-"))
  const calls = path.join(dir, "calls.txt")
  const script = path.join(dir, "real-ldd")
  writeFileSync(
    script,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(calls)}\n` +
      `printf '\\tlibc.so.6 => /lib/libc.so.6\\n'\nexit 0\n`,
  )
  chmodSync(script, 0o755)
  writeFileSync(calls, "")
  return { path: script, calls }
}

function runShim(args: string[], real: { path: string }) {
  return Bun.spawnSync(["bash", SHIM, ...args], {
    env: { ...process.env, LIAISON_LDD_SHIM_REAL: real.path },
  })
}

describe("the ldd shim linuxdeploy runs over the AppDir", () => {
  it("answers for the sidecar with the sentence linuxdeploy handles", () => {
    // Exit 1 with those words is linuxdeploy's "not linked dynamically"
    // branch: it warns and returns an empty dependency list. Exit 1 with
    // anything else is the std::runtime_error that killed the runner.
    const real = fakeLdd()
    const result = runShim(["/w/Liaison.AppDir/usr/bin/liaison-sidecar"], real)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("not a dynamic executable")
    expect(readFileSync(real.calls, "utf8")).toBe("")
  })

  it("never reads the file, so a sidecar that is not there answers the same", () => {
    // linuxdeploy canonicalizes the path before it calls ldd, and the point of
    // the shim is that the sidecar is never inspected at all.
    const real = fakeLdd()
    const result = runShim(["/no/such/place/liaison-sidecar"], real)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("not a dynamic executable")
  })

  it("hands every other file to the real ldd, unchanged", () => {
    const real = fakeLdd()
    const result = runShim(["/usr/lib/libgtk-3.so.0"], real)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain("libc.so.6")
    expect(readFileSync(real.calls, "utf8").trim()).toBe("/usr/lib/libgtk-3.so.0")
  })

  it("does not exempt a library that merely sits beside the sidecar", () => {
    // A shim that lied about a library would ship an AppImage missing a
    // dependency, which fails on a user's machine and nowhere else.
    const real = fakeLdd()
    const result = runShim(["/w/Liaison.AppDir/usr/lib/liaison-sidecar.so"], real)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(real.calls, "utf8").trim()).toBe(
      "/w/Liaison.AppDir/usr/lib/liaison-sidecar.so",
    )
  })

  it("never calls ldd by name, which would find itself and recurse", () => {
    const source = readFileSync(SHIM, "utf8")
    expect(source).toContain("REAL_LDD")
    expect(source).not.toMatch(/^\s*exec\s+ldd\b/m)
  })
})

describe("the Linux job's AppImage steps", () => {
  it("installs the shim on PATH before the bundler runs", () => {
    const install = step(steps, SHIM_STEP)
    const script = install.run ?? ""
    expect(script).toContain("linuxdeploy-ldd-shim.sh")
    // Copied to the exact name linuxdeploy looks up, and put where a PATH
    // lookup finds it first.
    expect(script).toContain("/ldd")
    expect(script).toContain("GITHUB_PATH")
    expect(stepIndex(steps, SHIM_STEP)).toBeLessThan(stepIndex(steps, "Build the app bundle"))
  })

  it("extracts the built AppImage and runs the sidecar out of it", () => {
    // linuxdeploy rewrites the rpath of every binary in the AppDir with
    // patchelf, the sidecar included, and a rewrite that corrupted a 325 MB
    // self extracting runtime would produce an AppImage that launches and dies
    // on the first agent turn. So the check runs the real binary out of the
    // real artifact and reads its real output.
    const verify = step(steps, VERIFY_STEP)
    const script = verify.run ?? ""
    expect(script).toContain("--appimage-extract")
    expect(script).toContain("squashfs-root/usr/bin/liaison-sidecar")
    expect(script).toContain("usage: liaison-sidecar")
    expect(script).toContain("exit 1")
    expect(stepIndex(steps, VERIFY_STEP)).toBeGreaterThan(stepIndex(steps, "Build the app bundle"))
    expect(stepIndex(steps, VERIFY_STEP)).toBeLessThan(
      stepIndex(steps, "Upload the Linux artifact"),
    )
  })

  it("runs the check on a dry run too, which is the only run that has ever reached it", () => {
    expect(step(steps, VERIFY_STEP).if).toBeUndefined()
    expect(step(steps, SHIM_STEP).if).toBeUndefined()
  })
})
