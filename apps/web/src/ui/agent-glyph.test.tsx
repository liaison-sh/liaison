// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An avatar is an identity. When its glyph is missing from the platform's
// fonts the user sees a dotted box with a question mark, which reads as a
// broken account rather than as a missing character, and nothing in any test
// or log says so. The walk found exactly that on iOS for the agent avatar.
//
// So two things are pinned: the mark is drawn, and no source file reintroduces
// one of the rare symbols that started this. The blocklist is built from code
// points rather than written out, so this file never trips its own sweep.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { render } from "@solidjs/testing-library"
import { describe, expect, it } from "vitest"
import { AGENT_BOLT_PATH, AgentGlyph } from "~/ui/AgentGlyph"

/** Dingbats and symbols outside the set iOS ships a glyph for. */
const RARE_SYMBOLS = [0x2726, 0x2727, 0x2736, 0x2739, 0x2756, 0x27e1, 0x2b51, 0x2b52].map((cp) =>
  String.fromCodePoint(cp),
)

/** The repo root: apps/web/src/ui -> apps/web/src -> apps/web -> apps -> . */
const ROOT = resolve(__dirname, "..", "..", "..", "..")

/**
 * EVERY ROOT THAT SHIPS A STRING TO A USER, not just this app's source.
 *
 * The glyph that started this was in shared UI copy, and the most plausible
 * place for one to come back is the i18n locale JSON, which no `.ts` sweep
 * sees. The shells render the same copy in their own boot overlays, so they
 * are swept too.
 */
const SWEPT: Array<{ dir: string; matches: RegExp }> = [
  { dir: "apps/web/src", matches: /\.(ts|tsx|css)$/ },
  { dir: "apps/mobile/src", matches: /\.(ts|tsx|css)$/ },
  { dir: "apps/desktop/src", matches: /\.(ts|tsx|css)$/ },
  { dir: "packages/shared/src/i18n/locales", matches: /\.(ts|json)$/ },
]

/** Single files outside those trees that still reach the page. */
const SWEPT_FILES = ["apps/web/index.html"]

function sourceFiles(dir: string, matches: RegExp, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, matches, found)
    } else if (matches.test(entry)) {
      found.push(full)
    }
  }
  return found
}

function sweptFiles(): string[] {
  const files: string[] = []
  for (const root of SWEPT) {
    const dir = resolve(ROOT, root.dir)
    // A root that moved is a sweep that silently covers nothing.
    expect(statSync(dir).isDirectory()).toBe(true)
    files.push(...sourceFiles(dir, root.matches))
  }
  for (const file of SWEPT_FILES) files.push(resolve(ROOT, file))
  return files
}

describe("the agent mark", () => {
  it("renders as a drawing that takes the colour and size around it", () => {
    const { container } = render(() => <AgentGlyph />)
    const svg = container.querySelector("svg[data-agent-glyph]")
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute("fill")).toBe("currentColor")
    expect(svg?.getAttribute("width")).toBe("1em")
    expect(svg?.querySelector("path")).not.toBeNull()
  })

  it("is the lightning bolt, not a star or a diamond", () => {
    const { container } = render(() => <AgentGlyph />)
    const d = container.querySelector("svg[data-agent-glyph] path")?.getAttribute("d") ?? ""
    expect(d).toBe(AGENT_BOLT_PATH)
    // A bolt zigzags: its outline crosses the vertical middle line twice going
    // opposite ways, so its path carries both an upward and a downward diagonal.
    // The star it replaces had only symmetric arcs, and a diamond has none.
    expect(d).toMatch(/l9\.9-10\.2/)
    expect(d).toMatch(/l-9\.9 10\.2/)
  })

  it("is hidden from assistive technology, which reads the name beside it", () => {
    const { container } = render(() => <AgentGlyph />)
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
  })

  it("leaves no rare symbol anywhere the frontends ship copy from", () => {
    const files = sweptFiles()
    // The sweep reaching nothing would pass just as quietly as a clean one.
    expect(files.length).toBeGreaterThan(100)
    const offenders: string[] = []
    for (const file of files) {
      if (file.endsWith("agent-glyph.test.tsx")) continue
      const text = readFileSync(file, "utf-8")
      for (const symbol of RARE_SYMBOLS) {
        if (text.includes(symbol)) offenders.push(`${file.slice(ROOT.length + 1)}: ${symbol}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
