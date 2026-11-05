// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 1 Task 1.5. Three standing properties of this package:
//   1. It is isomorphic. No source file reaches a Node or Bun builtin, and no
//      file imports a dependency the package does not declare, so the browser
//      bundle of `apps/web` can load it unchanged.
//   2. The seal-safe entrypoint stays seal-safe. Nothing reachable from
//      `src/index.ts` can open ciphertext.
//   3. The client-only manifest is honest. Every name in it exists on disk, so
//      a rename cannot silently empty the list that T-SEC-1 walks.

import { describe, expect, it } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { CLIENT_ONLY_MODULES } from "./client-only-manifest"

const SRC = import.meta.dir
const pkg = JSON.parse(readFileSync(path.join(SRC, "..", "package.json"), "utf8")) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const DECLARED = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith(".ts")) out.push(full)
  }
  return out
}

// Static and dynamic import specifiers, both forms. The dynamic form
// matters: `legacy-passphrase-kdf.ts` pulls Argon2id through `await import("hash-wasm")`, and a
// regex that only saw static imports would let an undeclared dependency in.
const IMPORT_RE = /(?:from|import)\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g

function importsOf(file: string): string[] {
  const contents = readFileSync(file, "utf8")
  const specs: string[] = []
  for (const match of contents.matchAll(IMPORT_RE)) specs.push(match[1] ?? match[2])
  return specs
}

function resolveRelative(file: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null
  const base = path.resolve(path.dirname(file), spec)
  for (const candidate of [`${base}.ts`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const ALL_FILES = walk(SRC)

describe("mailbox-crypto package shape", () => {
  it("walks a non empty source tree", () => {
    expect(ALL_FILES.length).toBeGreaterThan(0)
  })

  it("imports no node or bun builtin outside test files", () => {
    const offenders: string[] = []
    for (const file of ALL_FILES) {
      if (file.endsWith(".test.ts")) continue
      for (const spec of importsOf(file)) {
        if (spec.startsWith("node:") || spec.startsWith("bun:")) {
          offenders.push(`${path.relative(SRC, file)} imports ${spec}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("imports no package that is not declared in its own package.json", () => {
    const offenders: string[] = []
    for (const file of ALL_FILES) {
      for (const spec of importsOf(file)) {
        if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("bun:")) continue
        const name = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0]
        if (!DECLARED.has(name)) offenders.push(`${path.relative(SRC, file)} imports ${spec}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("seal safe entrypoint", () => {
  const clientOnlyPaths = new Set(CLIENT_ONLY_MODULES.map((m) => path.join(SRC, m)))

  function reachableFrom(entry: string): Set<string> {
    const seen = new Set<string>()
    const queue = [entry]
    while (queue.length > 0) {
      const file = queue.pop() as string
      if (seen.has(file)) continue
      seen.add(file)
      for (const spec of importsOf(file)) {
        const resolved = resolveRelative(file, spec)
        if (resolved) queue.push(resolved)
      }
    }
    return seen
  }

  it("reaches at least three modules from src/index.ts", () => {
    expect(reachableFrom(path.join(SRC, "index.ts")).size).toBeGreaterThanOrEqual(3)
  })

  it("reaches no client only module from src/index.ts, directly or transitively", () => {
    const reached = reachableFrom(path.join(SRC, "index.ts"))
    const leaked = Array.from(reached).filter((f) => clientOnlyPaths.has(f))
    expect(leaked).toEqual([])
  })

  it("names only modules that exist on disk in CLIENT_ONLY_MODULES", () => {
    expect(CLIENT_ONLY_MODULES.length).toBeGreaterThan(0)
    for (const name of CLIENT_ONLY_MODULES) {
      expect(existsSync(path.join(SRC, name)), `missing client only module ${name}`).toBe(true)
    }
  })
})
