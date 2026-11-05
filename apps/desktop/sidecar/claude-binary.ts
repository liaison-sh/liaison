// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Which Claude Code a session runs (D22, D30, D44, S13 header).
//
// The process the node starts is the one that applies the guard, so the copy
// it runs must be one no session can have written. The node looks only at the
// known install launchers (never PATH), resolves each to its real path and to
// its install root, and trusts a copy only when:
// - its real path lies under a known install root (native installer, local
//   install, the npm package, a Homebrew cask or formula);
// - neither the real path nor the install root overlaps a path a Strict or
//   Standard session of this node can write (an allow entry could win over
//   the install root's deny there);
// - `<real path> --version` answers within 5 s with a version newer than the
//   bundled copy's.
// Otherwise the bundled copy runs. The binary run is always the real path.
// Every launcher and every resolved install root is write-denied at Strict and
// Standard by the guard and the sandbox (T29, T30), whether chosen or not.

import { spawn } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"

export const CLAUDE_CODE_PACKAGE = "@anthropic-ai/claude-code"
export const DEFAULT_BREW_PREFIXES = ["/opt/homebrew", "/usr/local"]
export const PROBE_TIMEOUT_MS = 5_000

export type ClaudeRejection =
  | "missing"
  | "outside_install_roots"
  | "writable_location"
  | "probe_failed"
  | "not_newer"

export type ClaudeCandidate =
  | { launcher: string; realPath: string; installRoot: string }
  | { launcher: string; realPath?: string; rejected: ClaudeRejection }

export interface ClaudeInstallPaths {
  /** Every launcher looked at, in order (all write-denied at Strict and Standard). */
  launchers: string[]
  candidates: ClaudeCandidate[]
}

export interface ClaudeInstallPathsArgs {
  home: string
  npmPrefix?: string | null
  brewPrefixes?: string[]
}

function real(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/** `child` is `parent` or lies inside it. */
function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))
}

function npmPackageRoot(realPath: string): string | null {
  let dir = path.dirname(realPath)
  for (;;) {
    const manifest = path.join(dir, "package.json")
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown }).name
        if (name === CLAUDE_CODE_PACKAGE) return dir
      } catch {
        // An unreadable manifest names nothing.
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function claudeInstallPaths(args: ClaudeInstallPathsArgs): ClaudeInstallPaths {
  const brewPrefixes = args.brewPrefixes ?? DEFAULT_BREW_PREFIXES
  const launchers = [
    path.join(args.home, ".local", "bin", "claude"),
    path.join(args.home, ".claude", "local", "claude"),
    ...(args.npmPrefix ? [path.join(args.npmPrefix, "bin", "claude")] : []),
    ...brewPrefixes.map((prefix) => path.join(prefix, "bin", "claude")),
  ].filter((p, i, all) => all.indexOf(p) === i)

  const fixedRoots = [
    path.join(args.home, ".local", "share", "claude"),
    path.join(args.home, ".claude", "local"),
    ...brewPrefixes.flatMap((prefix) => [
      path.join(prefix, "Caskroom", "claude-code"),
      path.join(prefix, "Cellar", "claude-code"),
    ]),
  ]

  const candidates = launchers.map((launcher): ClaudeCandidate => {
    let realPath: string
    try {
      realPath = realpathSync(launcher)
    } catch {
      return { launcher, rejected: "missing" }
    }
    const fixed = fixedRoots.find((root) => within(realPath, real(root)))
    const installRoot = fixed ? real(fixed) : npmPackageRoot(realPath)
    if (!installRoot) return { launcher, realPath, rejected: "outside_install_roots" }
    return { launcher, realPath, installRoot }
  })
  return { launchers, candidates }
}

/** Runs `file --version`; its stdout, or null on any failure or timeout. */
export type VersionProbe = (file: string, timeoutMs: number) => Promise<string | null>

// Settles on the timer too: a probe whose children keep stdout open must not
// hold the start past its timeout.
const probeVersion: VersionProbe = (file, timeoutMs) =>
  new Promise((resolve) => {
    let out = ""
    let settled = false
    const settle = (value: string | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(file, ["--version"], { stdio: ["ignore", "pipe", "ignore"] })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      settle(null)
    }, timeoutMs)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      if (out.length < 64 * 1024) out += chunk
    })
    child.on("error", () => settle(null))
    child.on("close", (code) => settle(code === 0 ? out : null))
  })

function parseVersion(text: string | null): [number, number, number] | null {
  const m = text?.match(/(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number)
  return 0
}

/** The bundled Claude Code version, from the SDK's own package.json; null if unreadable. */
export function bundledClaudeCodeVersion(): string | null {
  try {
    const entry = new URL(import.meta.resolve("@anthropic-ai/claude-agent-sdk")).pathname
    const manifest = JSON.parse(
      readFileSync(path.join(path.dirname(entry), "package.json"), "utf8"),
    ) as {
      claudeCodeVersion?: unknown
    }
    return typeof manifest.claudeCodeVersion === "string" ? manifest.claudeCodeVersion : null
  } catch {
    return null
  }
}

export interface ChooseClaudeBinaryArgs extends ClaudeInstallPathsArgs {
  bundledPath: string
  /** Defaults to the SDK's `claudeCodeVersion`. Unknown: the bundled copy runs. */
  bundledVersion?: string | null
  /**
   * Every path a Strict or Standard session of this node can write: the node
   * root, every advertised folder, `os.tmpdir()`, `$TMPDIR`, `/tmp`,
   * `/private/tmp`, `/private/var/folders`.
   */
  writable: string[]
  run?: VersionProbe
  probeTimeoutMs?: number
}

export type ChosenClaudeBinary =
  | { path: string; version: string; source: "installed"; installRoot: string }
  | {
      path: string
      version: string | null
      source: "bundled"
      rejected: Array<{ launcher: string; reason: ClaudeRejection }>
    }

export async function chooseClaudeBinary(
  args: ChooseClaudeBinaryArgs,
): Promise<ChosenClaudeBinary> {
  const run = args.run ?? probeVersion
  const timeoutMs = args.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  let bundledVersion =
    args.bundledVersion === undefined ? bundledClaudeCodeVersion() : args.bundledVersion
  // P1-walk D3: the compiled sidecar cannot resolve the SDK's package.json;
  // the bundled binary itself says its version.
  if (!parseVersion(bundledVersion) && args.bundledPath) {
    const probed = parseVersion(await run(args.bundledPath, timeoutMs))
    if (probed) bundledVersion = probed.join(".")
  }
  const bundled = parseVersion(bundledVersion)
  const writable = args.writable.map(real)
  const overlaps = (p: string) => writable.some((w) => within(p, w) || within(w, p))

  const rejected: Array<{ launcher: string; reason: ClaudeRejection }> = []
  let best: {
    path: string
    version: [number, number, number]
    text: string
    installRoot: string
  } | null = null
  for (const candidate of claudeInstallPaths(args).candidates) {
    if ("rejected" in candidate) {
      if (candidate.rejected === "missing") continue
      const reason =
        candidate.realPath && overlaps(candidate.realPath)
          ? "writable_location"
          : candidate.rejected
      rejected.push({ launcher: candidate.launcher, reason })
      continue
    }
    if (overlaps(candidate.realPath) || overlaps(candidate.installRoot)) {
      rejected.push({ launcher: candidate.launcher, reason: "writable_location" })
      continue
    }
    const version = parseVersion(await run(candidate.realPath, timeoutMs))
    if (!version) {
      rejected.push({ launcher: candidate.launcher, reason: "probe_failed" })
      continue
    }
    if (
      !bundled ||
      compare(version, bundled) <= 0 ||
      (best && compare(version, best.version) <= 0)
    ) {
      rejected.push({ launcher: candidate.launcher, reason: "not_newer" })
      continue
    }
    best = {
      path: candidate.realPath,
      version,
      text: version.join("."),
      installRoot: candidate.installRoot,
    }
  }
  if (best) {
    return {
      path: best.path,
      version: best.text,
      source: "installed",
      installRoot: best.installRoot,
    }
  }
  return { path: args.bundledPath, version: bundledVersion, source: "bundled", rejected }
}
