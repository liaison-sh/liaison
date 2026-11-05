// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The build wrapper's path remapping, read from a Windows shaped environment.
// The first GitHub hosted Windows run compiled fine and then refused its own
// binary: 97 references to the runner's cargo home survived a remap that named
// exactly that directory. A remap only fires on the spelling rustc recorded,
// and on Windows one directory has several (backslash, forward slash, the
// `\\?\` verbatim form), while the checker that fails the build matches all of
// them. So the wrapper has to name every spelling, and it has to cover the
// roots a Windows runner actually has (USERPROFILE, RUNNER_TEMP), not the
// POSIX ones it does not.

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildRustflagsEnv, cCompilerFlags, remapFlags } from "./ci/tauri-build"

const WINDOWS_RUNNER = {
  CARGO_HOME: "C:\\Users\\runneradmin\\.cargo",
  USERPROFILE: "C:\\Users\\runneradmin",
  GITHUB_WORKSPACE: "D:\\a\\liaison\\liaison",
  RUNNER_TEMP: "D:\\a\\_temp",
}

describe("the remap flags on a Windows runner", () => {
  const flags = remapFlags(WINDOWS_RUNNER)

  it("names every build root the checker refuses, in both slash spellings", () => {
    for (const root of Object.values(WINDOWS_RUNNER)) {
      const forward = root.replace(/\\/g, "/")
      const backslash = flags.filter((flag) => flag.startsWith(`--remap-path-prefix=${root}=`))
      const slashed = flags.filter((flag) => flag.startsWith(`--remap-path-prefix=${forward}=`))
      expect(backslash.length).toBe(1)
      expect(slashed.length).toBe(1)
    }
  })

  it("names the verbatim spelling too, which is how a canonicalized path reads", () => {
    expect(flags).toContain("--remap-path-prefix=\\\\?\\C:\\Users\\runneradmin\\.cargo=/cargo")
  })

  it("maps each root to a stable placeholder", () => {
    expect(flags).toContain("--remap-path-prefix=C:\\Users\\runneradmin\\.cargo=/cargo")
    expect(flags).toContain("--remap-path-prefix=D:\\a\\liaison\\liaison=/liaison")
    expect(flags).toContain("--remap-path-prefix=C:\\Users\\runneradmin=/rust")
    expect(flags).toContain("--remap-path-prefix=D:\\a\\_temp=/temp")
  })

  it("remaps the cargo home before the user profile it lives under", () => {
    // rustc takes the first prefix that matches, so the nested one has to come
    // first or every registry path becomes /rust/.cargo/... and the cargo home
    // is never rewritten.
    const cargo = flags.indexOf("--remap-path-prefix=C:\\Users\\runneradmin\\.cargo=/cargo")
    const profile = flags.indexOf("--remap-path-prefix=C:\\Users\\runneradmin=/rust")
    expect(cargo).toBeGreaterThanOrEqual(0)
    expect(profile).toBeGreaterThan(cargo)
  })

  it("says nothing twice", () => {
    expect(new Set(flags).size).toBe(flags.length)
  })
})

describe("the remap flags on a POSIX machine", () => {
  it("are what they were, one spelling and nothing invented", () => {
    expect(
      remapFlags({ HOME: "/Users/builder", GITHUB_WORKSPACE: "/home/runner/work/liaison" }),
    ).toEqual([
      "--remap-path-prefix=/Users/builder/.cargo=/cargo",
      "--remap-path-prefix=/home/runner/work/liaison=/liaison",
      "--remap-path-prefix=/Users/builder=/rust",
    ])
  })

  it("adds the checkout root, and only when it is not the workspace already", () => {
    expect(
      remapFlags({ GITHUB_WORKSPACE: "/home/runner/work/liaison" }, "/home/runner/work/liaison"),
    ).toEqual(["--remap-path-prefix=/home/runner/work/liaison=/liaison"])
    expect(remapFlags({}, "/Volumes/dev/liaison")).toEqual([
      "--remap-path-prefix=/Volumes/dev/liaison=/liaison",
    ])
  })

  it("asks for nothing when the environment names nothing", () => {
    expect(remapFlags({})).toEqual([])
  })
})

describe("the environment the build runs with", () => {
  const env = buildRustflagsEnv({ ...WINDOWS_RUNNER, RUSTFLAGS: "-C target-cpu=x86-64-v2" })

  it("keeps the caller's own flags and appends ours", () => {
    expect(env.RUSTFLAGS.startsWith("-C target-cpu=x86-64-v2 ")).toBe(true)
    expect(env.RUSTFLAGS).toContain("--remap-path-prefix=C:\\Users\\runneradmin\\.cargo=/cargo")
  })

  it("passes the flags encoded, so a path with a space is still one flag", () => {
    const encoded = buildRustflagsEnv({
      CARGO_HOME: "C:\\Users\\run ner\\.cargo",
      RUSTFLAGS: "-C target-cpu=x86-64-v2",
    }).CARGO_ENCODED_RUSTFLAGS.split("\u001f")
    expect(encoded).toContain("--remap-path-prefix=C:\\Users\\run ner\\.cargo=/cargo")
    expect(encoded[0]).toBe("-C")
    expect(encoded[1]).toBe("target-cpu=x86-64-v2")
  })

  it("takes the caller's encoded flags over the unencoded ones, as cargo does", () => {
    const encoded = buildRustflagsEnv({
      CARGO_HOME: "/opt/cargo",
      RUSTFLAGS: "-C ignored",
      CARGO_ENCODED_RUSTFLAGS: "-C\u001ftarget-cpu=native",
    }).CARGO_ENCODED_RUSTFLAGS.split("\u001f")
    expect(encoded).toEqual(["-C", "target-cpu=native", "--remap-path-prefix=/opt/cargo=/cargo"])
  })

  it("rewrites the C compiler's paths too, where the crypto stack is built", () => {
    // rustc's remap reaches what rustc records. aws-lc-sys compiles C, and
    // every __FILE__ in it is an absolute registry path rustc never sees.
    expect(env.CFLAGS).toContain("/d1trimfile:C:\\Users\\runneradmin\\.cargo\\")
    expect(env.CFLAGS).toContain("/d1trimfile:C:/Users/runneradmin/.cargo/")
    expect(env.CXXFLAGS).toBe(env.CFLAGS)
    expect(cCompilerFlags({ HOME: "/Users/builder" })).toEqual([
      "-ffile-prefix-map=/Users/builder/.cargo=/cargo",
      "-ffile-prefix-map=/Users/builder=/rust",
    ])
    expect(
      buildRustflagsEnv({ HOME: "/Users/builder", CFLAGS: "-O2" }).CFLAGS.startsWith("-O2 "),
    ).toBe(true)
  })

  it("leaves no debug info for a path to hide in, and keeps the symbols", () => {
    // The debug info is what carried the builder's directories, so it goes.
    // The SYMBOLS stay: tauri patches a __TAURI_BUNDLE_TYPE symbol into the
    // binary at bundling time and reads it back at runtime for the updater,
    // and a symbol table stripped by cargo leaves it nothing to patch
    // ("Failed to add bundler type to the binary"). Both spellings say the
    // same thing, the env one wins over the manifest, so they must agree.
    expect(env.CARGO_PROFILE_RELEASE_DEBUG).toBe("0")
    expect(env.CARGO_PROFILE_RELEASE_STRIP).toBe("debuginfo")
  })

  it("says the same strip setting in the manifest as in the environment", () => {
    const manifest = readFileSync(path.join(import.meta.dir, "src-tauri", "Cargo.toml"), "utf8")
    expect(manifest).toContain('strip = "debuginfo"')
    expect(manifest).not.toContain('strip = "symbols"')
  })
})
