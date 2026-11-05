#!/usr/bin/env bun

// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `tauri build`, with the build machine's own directories rewritten out of the
// binary. Without this the shipped shell carried 480 references to the path of
// whoever built it (`/Users/<name>/.cargo/registry/...`): rustc keeps those
// for panic messages and `strip` does not remove them. They resolve to nothing
// on a customer's machine and they publish a username nobody meant to publish.
//
// Cargo's own `trim-paths` profile option would be the tidy way to say this,
// and it is not stable in the cargo this repo builds with (checked: "feature
// `trim-paths` is required ... not stabilized"). `--remap-path-prefix` is
// stable and does the same job, but it needs the prefixes computed at build
// time, which is why this is a script and not a line in Cargo.toml.
//
// WINDOWS. A remap fires only on the exact spelling rustc recorded, while the
// checker matches a prefix anywhere in the bytes, either slash kind, case
// folded. The first Windows run named `C:\Users\runneradmin\.cargo` in the
// remap and its binary still carried 97 references to that directory: one
// directory has several spellings there (backslash, forward slash, and the
// `\\?\` verbatim form a canonicalized path takes), and a remap that names one
// of them silently rewrites nothing. So every spelling of every root is named,
// and the roots are the ones a Windows runner actually has (USERPROFILE,
// RUNNER_TEMP) rather than the POSIX ones it does not.
//
// THE C HALF. rustc's remap reaches what rustc records, and this shell links
// C: aws-lc-sys compiles the crypto with cc and cmake, and every `__FILE__` in
// that C is the absolute registry path it was compiled from. Those are handed
// the same rewrite through CFLAGS/CXXFLAGS, which is the half a rustc only fix
// leaves behind on a toolchain that compiles with absolute source paths.
//
// apps/desktop/ci/check-bundle-no-absolute-paths.ts is the gate that fails the
// build when one of these paths survives anyway.
//
// Usage: bun apps/desktop/ci/tauri-build.ts [tauri build args...]

import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { channelBuild, tauriConfigArgs } from "./channel"

const DESKTOP = path.resolve(import.meta.dir, "..")

/** The repository root, resolved from this file rather than from a literal. */
export function repoRoot(): string {
  return path.resolve(DESKTOP, "..", "..")
}

/** `C:\`, `c:/` or `\\server\share`: an absolute path that is not POSIX. */
function isWindowsPath(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/])/.test(value)
}

/** One spelling per prefix, for dedupe, matching the checker's own folding. */
function canonical(value: string): string {
  const slashed = value.replace(/\\/g, "/").replace(/\/+$/, "")
  return isWindowsPath(value) ? slashed.toLowerCase() : slashed
}

/** Every spelling of one directory that rustc may have recorded. On POSIX
 *  there is one. On Windows there are three: the shell writes `D:\a\liaison`,
 *  rustc and cargo write `D:/a/liaison` for paths that went through a manifest
 *  or a build script, and a canonicalized path reads `\\?\D:\a\liaison`. */
export function prefixSpellings(value: string): string[] {
  const trimmed = value.replace(/[\\/]+$/, "")
  if (!isWindowsPath(trimmed)) return [trimmed]
  const backslash = trimmed.replace(/\//g, "\\")
  const forward = trimmed.replace(/\\/g, "/")
  const spellings = [backslash, forward, `\\\\?\\${backslash}`]
  return [...new Set(spellings)]
}

/** `--remap-path-prefix` for every directory that identifies this machine.
 *  The replacement is a virtual path, and it is stable across machines, which
 *  is also what makes two builds of the same commit comparable.
 *
 *  Order matters: rustc takes the first prefix that matches, so a nested
 *  directory (the cargo home inside the home directory) is named before the
 *  one it sits in, or it is never rewritten as itself. */
export function buildRoots(env: Record<string, string | undefined>, root = ""): [string, string][] {
  const home = env.HOME || env.USERPROFILE || ""
  const cargoHome = env.CARGO_HOME || (home ? path.join(home, ".cargo") : "")
  const candidates: [string, string][] = [
    [cargoHome, "/cargo"],
    [env.GITHUB_WORKSPACE ?? "", "/liaison"],
    [root, "/liaison"],
    [env.RUNNER_TEMP ?? "", "/temp"],
    [env.HOME ?? "", "/rust"],
    [env.USERPROFILE ?? "", "/rust"],
  ]
  const seen = new Set<string>()
  const roots: [string, string][] = []
  for (const [from, to] of candidates) {
    if (from.length < 2) continue
    const key = canonical(from)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push([from, to])
  }
  return roots
}

export function remapFlags(env: Record<string, string | undefined>, root = ""): string[] {
  const flags: string[] = []
  for (const [from, to] of buildRoots(env, root)) {
    for (const spelling of prefixSpellings(from))
      flags.push(`--remap-path-prefix=${spelling}=${to}`)
  }
  return flags
}

/** The same rewrite for the C compiler. rustc's remap reaches what rustc
 *  records and nothing else, and this shell links C: aws-lc-sys builds its
 *  crypto with cc and cmake, and every `__FILE__` in that C is the absolute
 *  path of the source it was compiled from, in the cargo registry. On Unix
 *  clang and gcc take `-ffile-prefix-map`; MSVC has no equivalent it will
 *  admit to, so the prefix is trimmed off instead (`/d1trimfile:`, which is
 *  how a Windows build stops shipping the builder's directory). */
export function cCompilerFlags(env: Record<string, string | undefined>, root = ""): string[] {
  const flags: string[] = []
  for (const [from, to] of buildRoots(env, root)) {
    if (isWindowsPath(from)) {
      const trimmed = from.replace(/[\\/]+$/, "")
      // A verbatim `\\?\` prefix is not a spelling any compiler is handed a
      // source file under, so the two ordinary ones are all that is trimmed.
      flags.push(`/d1trimfile:${trimmed.replace(/\//g, "\\")}\\`)
      flags.push(`/d1trimfile:${trimmed.replace(/\\/g, "/")}/`)
    } else {
      flags.push(`-ffile-prefix-map=${from}=${to}`)
    }
  }
  return flags
}

/** Cargo splits `RUSTFLAGS` on whitespace and has no quoting, so a build root
 *  with a space in it (a developer's machine, never a runner) would become two
 *  broken flags. `CARGO_ENCODED_RUSTFLAGS` is the unambiguous form and cargo
 *  prefers it when both are set, which is also why the caller's encoded flags
 *  win over its unencoded ones here. */
export function buildRustflagsEnv(
  env: Record<string, string | undefined>,
  root = "",
): Record<string, string> {
  const inherited = env.CARGO_ENCODED_RUSTFLAGS
    ? env.CARGO_ENCODED_RUSTFLAGS.split("\u001f").filter(Boolean)
    : (env.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean)
  const flags = [...inherited, ...remapFlags(env, root)]
  const cFlags = cCompilerFlags(env, root)
  return {
    RUSTFLAGS: flags.join(" "),
    CARGO_ENCODED_RUSTFLAGS: flags.join("\u001f"),
    // The remaining Windows references were debug info strings, which a
    // release build has no use for: no debug info, nothing to hide a path in.
    // Cargo.toml says the same for this profile; an env override says it again
    // for anyone who builds with a different one, and an env setting wins over
    // the manifest, so this is the spelling that actually decides.
    //
    // "debuginfo" and not "symbols": the symbol table is not where the paths
    // were, and tauri patches a __TAURI_BUNDLE_TYPE symbol into the binary at
    // bundling time for the updater to read back. Strip the symbols and the
    // bundler has nothing to patch, which it says as a warning and the shipped
    // app discovers as an update that does not apply.
    CARGO_PROFILE_RELEASE_DEBUG: env.CARGO_PROFILE_RELEASE_DEBUG ?? "0",
    CARGO_PROFILE_RELEASE_STRIP: env.CARGO_PROFILE_RELEASE_STRIP ?? "debuginfo",
    // PINNED, not defaulted (P6d-FX7, SK-9). `Cargo.toml` does not say it for
    // this profile and cargo's own default for `release` is the only thing
    // that kept every `cfg(debug_assertions)` block out of a shipped binary.
    // The refusal above stops a build that asked for the opposite; this is
    // what the build actually runs with.
    CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS: "false",
    // cc and cmake read these, which is how the C half of the crypto stack
    // gets the same treatment as the Rust half.
    CFLAGS: [env.CFLAGS, ...cFlags].filter(Boolean).join(" "),
    CXXFLAGS: [env.CXXFLAGS, ...cFlags].filter(Boolean).join(" "),
  }
}

/**
 * A RELEASE BUILD REFUSES TO BE A DEBUG BUILD (P6d-FX7, SK-9).
 *
 * This script forwards its argv to `tauri build` verbatim, and nothing rejected
 * `--debug`. The four release jobs never pass it, so the shipped bundles are
 * release builds today: that is a convention held by four lines of YAML, not a
 * gate. A debug build compiles in the DOM driver, the background window and the
 * seeded recent folder, and it would be signed, notarized and published like
 * any other.
 *
 * `CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS` is the same door with no flag in
 * sight: one environment variable flips every `cfg(debug_assertions)` in a
 * release profile build, and an env setting wins over the manifest. It is
 * refused rather than overwritten, because a build asked for something it must
 * not have and the answer to that is to stop, not to quietly do something else.
 *
 * Answers the sentence to print, or null when the build may proceed.
 */
export const DEBUG_BUILD_FLAGS = ["--debug", "-d"]

export const DEBUG_ASSERTIONS_ENV = "CARGO_PROFILE_RELEASE_DEBUG_ASSERTIONS"

export function releaseBuildRefusal(
  argv: string[],
  env: Record<string, string | undefined>,
): string | null {
  const flag = argv.find((argument) => DEBUG_BUILD_FLAGS.includes(argument))
  if (flag) {
    return (
      `refusing to build: ${flag} produces a debug build, and a debug build carries ` +
      "the DOM driver, the background window and the seeded recent folder."
    )
  }
  if (env[DEBUG_ASSERTIONS_ENV] !== undefined) {
    return (
      `refusing to build: ${DEBUG_ASSERTIONS_ENV} is set in the environment ` +
      `(${env[DEBUG_ASSERTIONS_ENV]}), and it turns every debug only block back on ` +
      "in a release profile build."
    )
  }
  return null
}

/** The bundler's own words when it cannot find the bundle type placeholder in
 *  the compiled shell. It is a `log::warn!`, so the build stays green and the
 *  line scrolls past inside several thousand others. */
export const BUNDLE_TYPE_WARNING_MARKER = "__TAURI_BUNDLE_TYPE variable not found in binary"

/**
 * What that warning means for THIS distribution, spelled out where the log
 * puts it next to the warning instead of leaving a reader to guess.
 *
 * The warning is real and it is expected. tauri-utils declares the placeholder
 * as `#[used] static mut __TAURI_BUNDLE_TYPE: &str = "__TAURI_BUNDLE_TYPE_VAR_UNK"`
 * (platform.rs) and tauri-bundler patches that literal in the binary by a raw
 * byte search (bundle.rs, `patch_binary`). `#[used]` is llvm.used, which stops
 * the compiler removing the static and does not stop the LINKER: on Mach O it
 * becomes .no_dead_strip and survives, on ELF and PE it does not. Measured on
 * this profile (lto = true, codegen-units = 1, strip = debuginfo): the macOS
 * shell carries the literal, the Windows and Linux shells do not. macOS never
 * shows the warning for a second reason, which is that tauri-bundler SKIPS
 * patching for its own bundle types (`MacOsBundle | Dmg => return Ok(())`).
 *
 * It costs this distribution nothing, and that is a property of what we
 * publish rather than a general truth:
 *
 *   - the manifest keys are the generic `windows-x86_64` and `linux-x86_64`.
 *     `bundle_type()` is read by the updater in `get_urls` only to try a MORE
 *     specific key first (`{os}-{arch}-{installer}`) before the generic one,
 *     so with no bundle type the generic key is simply the only candidate, and
 *     it is the one we publish;
 *   - on Windows the installer kind is decided from the downloaded BYTES, not
 *     from the bundle type (`extract_exe`: `infer::app::is_exe` gives Nsis),
 *     and we ship NSIS only;
 *   - on Linux `install_inner` falls through to `install_appimage` when there
 *     is no bundle type, and the AppImage is our updater payload. The .deb is
 *     installed by a package manager and never auto updates.
 *
 * The day a manifest gains an installer suffixed key, that reasoning is gone.
 * apps/desktop/windows-installer-decision.test.ts pins the generic keys so the
 * change fails there rather than in a customer's update.
 */
export function bundleTypeWarningNote(line: string): string | null {
  if (!line.includes(BUNDLE_TYPE_WARNING_MARKER)) return null
  return [
    "note: the bundle type placeholder is absent from this binary, and that is expected here.",
    "  The linker drops the #[used] static on ELF and PE; macOS keeps it and is never patched anyway.",
    "  It changes nothing for this distribution: the updater manifest publishes the generic",
    "  windows-x86_64 and linux-x86_64 keys, the Windows installer kind is read from the downloaded",
    "  bytes, and a Linux update with no bundle type installs the AppImage, which is our payload.",
    "  See apps/desktop/ci/windows-installer.md for the source citations.",
  ].join("\n")
}

/** Copies a stream to a sink line by line, and answers whether the bundle type
 *  warning went past. Piped rather than inherited for exactly that reason: an
 *  inherited stream cannot be read. */
export async function relay(
  stream: ReadableStream<Uint8Array>,
  sink: (text: string) => void,
): Promise<string[]> {
  const decoder = new TextDecoder()
  const notes: string[] = []
  let pending = ""
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split("\n")
    pending = lines.pop() ?? ""
    for (const line of lines) {
      sink(`${line}\n`)
      const note = bundleTypeWarningNote(line)
      if (note) notes.push(note)
    }
  }
  if (pending) {
    sink(pending)
    const note = bundleTypeWarningNote(pending)
    if (note) notes.push(note)
  }
  return notes
}

/**
 * WINDOWS: the bundler signs what it builds, through the same script as the
 * signing steps (2026-09-28). `tauri build --bundles nsis` recompiled the app
 * after the signing step on the first signed test build (runs 36410435681 and
 * 36411933927) and on the unsigned 0.1.9 release alike, and a recompile
 * discards the signature: "Verify the Windows binaries are still signed" read
 * NotSigned. Why cargo relinks there is not ours to pin, so the signature is
 * made where it survives it: tauri-bundler 2.7 runs signCommand on the main
 * binary after its (re)build and after it patches it, on every externalBin not
 * already signed, on the uninstaller (!uninstfinalize) and on the installer.
 *
 * The config goes in a FILE, passed by path: its command names a Windows path,
 * and a JSON string with backslashes and quotes is exactly what the command
 * line quoting between bunx and the tauri CLI mangles. The AZURE_CLIENT_ID
 * skip holds: the script exits 0 without signing, as every other stage does.
 */
export function windowsSignConfigArgs(
  platform: string,
  desktopRoot: string,
  configPath: string,
): string[] {
  if (platform !== "win32") return []
  const config = {
    bundle: {
      windows: {
        signCommand: {
          cmd: "pwsh",
          args: [
            "-NoProfile",
            "-NonInteractive",
            "-File",
            path.join(desktopRoot, "ci", "sign-windows.ps1"),
            "-Stage",
            "file",
            "-Path",
            "%1",
          ],
        },
      },
    },
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return ["--config", configPath]
}

/** The command this script runs: `tauri build` with the caller's arguments,
 *  plus, on the test channel, the config merge that stamps its version and
 *  points its updater at the test manifest (channel.ts), plus, on Windows,
 *  the signCommand above. A production build elsewhere adds nothing. */
export function tauriBuildCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  platform: string = process.platform,
  signConfigPath: string = path.join(env.RUNNER_TEMP ?? tmpdir(), "liaison-tauri-sign.json"),
): string[] {
  return [
    "bunx",
    "tauri",
    "build",
    ...argv,
    ...tauriConfigArgs(channelBuild(env)),
    ...windowsSignConfigArgs(platform, DESKTOP, signConfigPath),
  ]
}

if (import.meta.main) {
  const refusal = releaseBuildRefusal(process.argv.slice(2), process.env)
  if (refusal) {
    process.stderr.write(`${refusal}\n`)
    process.exit(1)
  }
  const added = buildRustflagsEnv(process.env, repoRoot())
  console.log(`RUSTFLAGS: ${added.RUSTFLAGS}`)
  console.log(`CFLAGS: ${added.CFLAGS}`)
  const command = tauriBuildCommand(process.argv.slice(2), process.env)
  console.log(`running: ${command.join(" ")}`)
  const child = Bun.spawn(command, {
    cwd: DESKTOP,
    env: { ...process.env, ...added },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err] = await Promise.all([
    relay(child.stdout, (text) => process.stdout.write(text)),
    relay(child.stderr, (text) => process.stderr.write(text)),
  ])
  const code = await child.exited
  for (const note of new Set([...out, ...err])) process.stderr.write(`${note}\n`)
  process.exit(code)
}
