// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The public pages a client opens (the token page, and the portal once it has a
// web module) are chunks of their own. Their import graph, followed through
// every relative and `~/` import, never reaches the member shell, the agent, the
// thread store or the tab system, and never ships a PDF library: a client's page
// carries no member code and parses no PDF in the browser.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = resolve(__dirname)
const PUBLIC_CHUNKS = ["modules/client-action", "modules/portal"]
const FORBIDDEN = [
  /^modules\/shell\//,
  /^modules\/agent\//,
  /^modules\/threads\//,
  /^modules\/assist\//,
  /^framework\//,
]
const FORBIDDEN_PACKAGES = [/^pdfjs-dist/, /^pdf-lib/, /^react-pdf/]

const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s[^"'`]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm

function resolveFile(base: string): string | null {
  for (const cand of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

function specifiersOf(file: string): string[] {
  const text = readFileSync(file, "utf8")
  const out: string[] = []
  for (const m of text.matchAll(IMPORT_RE)) {
    const s = m[1] ?? m[2] ?? m[3]
    if (s) out.push(s)
  }
  return out
}

/** Every source file a chunk's entry files reach, and every package they name. */
function graphOf(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.pop() as string
    if (files.has(file)) continue
    files.add(file)
    for (const spec of specifiersOf(file)) {
      let target: string | null = null
      if (spec.startsWith("~/")) target = resolveFile(join(SRC, spec.slice(2)))
      else if (spec.startsWith(".")) target = resolveFile(resolve(dirname(file), spec))
      else {
        packages.add(spec)
        continue
      }
      if (target && /\.(ts|tsx)$/.test(target)) queue.push(target)
    }
  }
  return { files, packages }
}

function chunkEntries(dir: string): string[] {
  const abs = join(SRC, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .map((f) => join(abs, f))
}

describe("the public chunks", () => {
  it("neither public chunk reaches the shell or the agent", () => {
    const entries = PUBLIC_CHUNKS.flatMap(chunkEntries)
    expect(entries.length).toBeGreaterThan(0)
    const { files, packages } = graphOf(entries)
    const reached = [...files].map((f) => f.slice(SRC.length + 1))
    expect(reached.filter((f) => FORBIDDEN.some((re) => re.test(f)))).toEqual([])
    expect([...packages].filter((p) => FORBIDDEN_PACKAGES.some((re) => re.test(p)))).toEqual([])
  })

  it("the walk follows imports far enough to see the shell when a file imports it", () => {
    const shellEntry = join(SRC, "modules/shell/Shell.tsx")
    const { files } = graphOf([shellEntry])
    expect(files.size).toBeGreaterThan(1)
    const app = join(SRC, "App.tsx")
    expect([...graphOf([app]).files].some((f) => f.includes("/modules/shell/"))).toBe(true)
  })
})
