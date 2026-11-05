#!/usr/bin/env bun
// SPDX-License-Identifier: FSL-1.1-ALv2
//
// No Node anywhere in a shipped app shell: the desktop shell is Rust, its
// sidecar is a Bun compiled binary, the mobile shell is native code around a
// webview, and nothing shipped inside either may need a Node runtime to start.
// Both trees are scanned (SCAN_ROOTS below); an absent one is simply skipped,
// so the gate is honest on a checkout that has only one of them.
//
// This is a HEURISTIC, not a proof, but it is a heuristic with four arms. For
// every package.json under each scanned root it flags:
//   - the scanned package's own `engines.node` with no `engines.bun`,
//   - a script in it that shells out to `node`,
//   - a declared dependency whose own package.json says the same,
//   - a declared dependency whose `bin` entry is a script with a Node shebang.
// Declared means all four fields: dependencies, devDependencies,
// optionalDependencies and peerDependencies. The platform packages that carry
// the shipped Claude Code CLI are optionalDependencies, so a gate that reads
// only the first two never looks at the binary the app actually ships.
//
// A declared dependency that cannot be resolved is itself a failure, allowlist
// entries included: an uninstalled tree must look broken, not clean, and an
// allowlist is evidence about a package that is there. The one exception is an
// optionalDependency, which a platform is free not to install (the three
// non-host target triples are exactly that); an
// absent one is reported as not installed here and nothing is claimed about it.
//
// Every dependency it looks at is printed with its verdict, so the pass is
// auditable rather than a bare exit code. A package that needs Node without
// saying so still slips through, which is why this is one guard among several
// rather than the whole argument.
//
// Usage: bun scripts/check-desktop-no-node.ts [--root <repo root>]

import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * Build-time tools that never enter the shipped app: they run on a developer
 * or CI machine to produce the bundle and are not loaded by the sidecar or the
 * shell at runtime. Each entry needs a reason, and the list may only shrink.
 */
const BUILD_ONLY_TOOLS: Record<string, string> = {
  "@tauri-apps/cli": "packaging CLI, runs on the build machine only",
  typescript: "typecheck only, never loaded at runtime",
  // The overlay's build and test tooling. It produces apps/desktop/dist/overlay.js
  // on a developer or CI machine; the shell compiles that ONE file in with
  // include_str! and none of these packages is reachable from the running app.
  vite: "builds the overlay bundle on the build machine; nothing of it is shipped",
  "vite-plugin-solid": "Vite plugin, compiles Solid JSX at build time only",
  vitest: "component test runner, never loaded by the shell or the sidecar",
  jsdom: "the vitest test environment, a test-time DOM and nothing the app loads",
  "@solidjs/testing-library": "render helpers for the component tests only",
  "@testing-library/jest-dom": "test matchers, imported only from src/test-setup.ts",
  // The Capacitor tooling. `cap sync` copies the apps/web build into the two
  // native projects on the build machine; the shipped app is Swift and Kotlin
  // around a webview and never loads the CLI.
  "@capacitor/cli": "Capacitor CLI, generates and syncs the native projects on the build machine",
  "@happy-dom/global-registrator":
    "the DOM the mobile bun tests render into, never loaded by the app",
}

/**
 * Packages that DO ship inside the app and DO declare `engines.node`, but were
 * measured running without Node: on Bun inside the compiled sidecar, or (for a
 * mobile Capacitor plugin) in the webview, with its module also loaded by the
 * Bun test runner. `engines.node` is a publisher's floor for the Node runtime,
 * not a statement that Bun is refused, so the only thing that settles it is a
 * run. Each entry names the evidence, and the list may only shrink.
 */
const BUN_VERIFIED: Record<string, string> = {
  "@anthropic-ai/claude-agent-sdk":
    "hosted in the Bun compiled sidecar: a full turn streamed against the Liaison " +
    "MCP gateway (the day one desktop spike, criteria 1 to 5)",
  // Added with d118fbbf7 (the mobile app lock). Its engines.node >=20 is the
  // floor of the publisher's own pnpm/rollup toolchain; the published dist/
  // imports only @capacitor/core and @capacitor/app, no Node builtin.
  "@aparajita/capacitor-biometric-auth":
    "a Capacitor plugin: Swift/Kotlin plus a dist/ shim that runs in the webview; " +
    "the shim is loaded on Bun by apps/mobile/src/native/shelf-authenticate.test.ts " +
    "(through shelf.ts), and its dist/ imports only @capacitor/core and @capacitor/app",
  // Added with the mobile secret store (the refresh token in the keychain /
  // Android Keystore). Same publisher and toolchain floor as the plugin above;
  // the published dist/ imports only @capacitor/core and its own files.
  "@aparajita/capacitor-secure-storage":
    "a Capacitor plugin: Swift/Kotlin plus a dist/ shim that runs in the webview; " +
    "the shim is loaded on Bun by apps/mobile/src/push-deps.test.ts (through main.ts, " +
    "unmocked), and its dist/ imports only @capacitor/core",
}

interface Offender {
  packageJson: string
  /** The dependency at fault, or the scanned package itself. */
  subject: string
  reason: string
}

/** One dependency the gate looked at, and what it concluded about it. */
interface Inspection {
  packageJson: string
  subject: string
  verdict: string
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const

/** A bare `node` invocation, not `nodemon` and not a path ending in node. */
const SHELLS_TO_NODE = /(^|\s|&&|\|\||;|\()node(\s|$)/

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function findPackageJsonFiles(dir: string): string[] {
  const found: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "target" || entry.name === "dist") {
        continue
      }
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === "package.json") found.push(full)
    }
  }
  return found
}

function resolveDependency(fromDir: string, name: string, repoRoot: string): string | null {
  let dir = fromDir
  while (true) {
    const candidate = path.join(dir, "node_modules", name, "package.json")
    if (existsSync(candidate)) return candidate
    if (dir === repoRoot || dir === path.dirname(dir)) return null
    dir = path.dirname(dir)
  }
}

/** The first bin entry of a package whose script carries a Node shebang. */
function nodeShebangBin(packageDir: string, bin: unknown): string | null {
  const entries: string[] =
    typeof bin === "string" ? [bin] : bin ? Object.values(bin as Record<string, string>) : []
  for (const entry of entries) {
    const file = path.join(packageDir, entry)
    if (!existsSync(file)) continue
    let head: string
    try {
      head = readFileSync(file, "utf8").slice(0, 120)
    } catch {
      continue
    }
    if (/^#!.*\bnode\b/.test(head.split("\n")[0] ?? "")) return entry
  }
  return null
}

/** The shipped app shells this gate covers. An absent one is skipped. */
export const SCAN_ROOTS = ["apps/desktop", "apps/mobile"] as const

/**
 * Generated native projects. `cap add ios` and `cap add android` write their
 * own package.json files (CocoaPods and Gradle metadata), none of which is a
 * Node dependency declaration this gate can say anything about.
 */
const GENERATED_NATIVE_DIRS = new Set(["ios", "android"])

export function scan(repoRoot: string): {
  scanned: string[]
  inspections: Inspection[]
  offenders: Offender[]
} {
  const offenders: Offender[] = []
  const inspections: Inspection[] = []
  const scanned: string[] = []
  for (const root of SCAN_ROOTS) {
    const absolute = path.join(repoRoot, ...root.split("/"))
    if (!existsSync(absolute)) continue
    for (const file of findPackageJsonFiles(absolute)) {
      const relative = path.relative(absolute, path.dirname(file)).split(path.sep)[0]
      if (GENERATED_NATIVE_DIRS.has(relative)) continue
      scanned.push(file)
    }
  }
  for (const file of scanned) {
    const manifest = readJson(file)
    if (!manifest) continue
    const declared = new Map<string, boolean>()
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys((manifest[field] ?? {}) as Record<string, string>)) {
        const optional = field === "optionalDependencies"
        declared.set(name, (declared.get(name) ?? optional) && optional)
      }
    }
    for (const [name, optional] of declared) {
      const record = (verdict: string) =>
        inspections.push({ packageJson: file, subject: name, verdict })
      const flag = (reason: string) => {
        offenders.push({ packageJson: file, subject: name, reason })
        record(`offender, ${reason}`)
      }
      const resolved = resolveDependency(path.dirname(file), name, repoRoot)
      if (!resolved) {
        // Optional by declaration: a platform that does not install it has not
        // broken anything, and there is nothing on disk to claim otherwise.
        if (optional) record("optional, not installed on this platform")
        else flag("declared but not installed, so nothing about it could be checked")
        continue
      }
      if (name in BUILD_ONLY_TOOLS) {
        record(`allowlisted build-only, ${BUILD_ONLY_TOOLS[name]}`)
        continue
      }
      if (name in BUN_VERIFIED) {
        record(`allowlisted bun-verified, ${BUN_VERIFIED[name]}`)
        continue
      }
      const dependencyManifest = readJson(resolved)
      const engines = dependencyManifest?.engines as Record<string, string> | undefined
      const nodeBin = nodeShebangBin(path.dirname(resolved), dependencyManifest?.bin)
      if (engines?.node && !engines.bun) {
        flag(`declares engines.node ${engines.node} with no engines.bun`)
      }
      if (nodeBin) flag(`its bin script ${nodeBin} starts with a Node shebang`)
      if (!(engines?.node && !engines.bun) && !nodeBin) record("inspected")
    }

    const ownEngines = manifest.engines as Record<string, string> | undefined
    if (ownEngines?.node && !ownEngines.bun) {
      offenders.push({
        packageJson: file,
        subject: (manifest.name as string) ?? path.basename(path.dirname(file)),
        reason: `declares engines.node ${ownEngines.node} with no engines.bun`,
      })
    }
    for (const [script, body] of Object.entries(
      (manifest.scripts ?? {}) as Record<string, string>,
    )) {
      if (SHELLS_TO_NODE.test(body)) {
        offenders.push({
          packageJson: file,
          subject: `script ${script}`,
          reason: `runs the node binary: ${body}`,
        })
      }
    }
  }
  return { scanned, inspections, offenders }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const index = argv.indexOf("--root")
  const repoRoot =
    index === -1 ? path.resolve(import.meta.dir, "..") : path.resolve(argv[index + 1])
  const { scanned, inspections, offenders } = scan(repoRoot)
  console.log(`${SCAN_ROOTS.join(", ")}: scanned ${scanned.length} package.json files`)
  for (const inspection of inspections) {
    console.log(
      `  ${inspection.subject}: ${inspection.verdict} ` +
        `(in ${path.relative(repoRoot, inspection.packageJson)})`,
    )
  }
  for (const offender of offenders) {
    console.log(
      `  ${offender.subject}: ${offender.reason} ` +
        `(in ${path.relative(repoRoot, offender.packageJson)})`,
    )
  }
  if (offenders.length > 0) {
    console.log(
      "Every shipped shell dependency must run on Bun. Replace the package, record it in " +
        "BUILD_ONLY_TOOLS if it never ships inside the app, or record it in BUN_VERIFIED " +
        "with the evidence of it actually running on Bun.",
    )
    process.exit(1)
  }
}
