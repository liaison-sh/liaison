// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { lintI18nStrings, scanSource } from "./lint-i18n-strings"

describe("lint-i18n-strings", () => {
  test("flags exactly one hardcoded JSX text node", () => {
    const src = `export function C() { return <div>Welcome aboard</div> }`
    const v = scanSource("c.tsx", src)
    expect(v).toHaveLength(1)
    expect(v[0]?.text).toBe("Welcome aboard")
  })

  test("flags a hardcoded user-facing attribute", () => {
    const src = `export function C() { return <input placeholder="Search people" /> }`
    const v = scanSource("c.tsx", src)
    expect(v).toHaveLength(1)
    expect(v[0]?.text).toBe("Search people")
  })

  test("string wrapped in t() yields zero violations", () => {
    const src = `export function C() { return <div>{t("kernel.common.save")}</div> }`
    expect(scanSource("c.tsx", src)).toHaveLength(0)
  })

  test("data-testid and class attributes are not flagged", () => {
    const src = `export function C() { return <div data-testid="save-btn" class="flex gap-2" /> }`
    expect(scanSource("c.tsx", src)).toHaveLength(0)
  })

  test("JSX expression comments are never text, on one line or many", () => {
    const src = [
      `export function C() {`,
      `  return (`,
      `    <div>`,
      "      {/* `<Index>`, not `<For>`: keyed by position, a row stays mounted */}",
      "      {/* `<Index>`, not `<For>`: the same note",
      `          spread over lines, with <b>markup</b> words in it. */}`,
      `      {`,
      `        // a line comment with <Tag> words in it`,
      `      }`,
      `      <span>{t("kernel.common.save")}</span>`,
      `    </div>`,
      `  )`,
      `}`,
    ].join("\n")
    expect(scanSource("c.tsx", src)).toHaveLength(0)
  })

  test("a hardcoded JSX text node next to a JSX comment still fails, on its own line", () => {
    const src = [
      `export function C() {`,
      `  return (`,
      `    <div>`,
      `      {/* a note that spans`,
      `          two lines */}`,
      `      <span>Welcome aboard</span>`,
      `      {/* first */} <b>{x}</b> {/* second */}`,
      `      <em>Still flagged</em>`,
      `    </div>`,
      `  )`,
      `}`,
    ].join("\n")
    const v = scanSource("c.tsx", src)
    expect(v.map((x) => [x.line, x.text])).toEqual([
      [6, "Welcome aboard"],
      [8, "Still flagged"],
    ])
  })

  test("import lines and comments are ignored", () => {
    const src = [
      `import { Foo } from "~/modules/foo"`,
      `// This is a descriptive comment with words`,
      `export const x = 1`,
    ].join("\n")
    expect(scanSource("c.tsx", src)).toHaveLength(0)
  })

  test("JS comparison/logical expressions are not flagged as JSX text", () => {
    // The `>…<` regex would capture `>= 400 && status <` here; these are
    // expression lines, never user copy. Regression for the codemod
    // corruption that rewrote `if (status >= 400 && status < 500)`.
    const src = [
      `function classify(status: number) {`,
      `  if (status >= 400 && status < 500) return "client"`,
      `  const within = a <= b && c > d`,
      `  return status >= 500 ? "server" : "ok"`,
      `}`,
    ].join("\n")
    expect(scanSource("c.tsx", src)).toHaveLength(0)
  })

  test("reports correct file and line", () => {
    const src = ["line one", "<span>Hello world</span>"].join("\n")
    const v = scanSource("path/to/c.tsx", src)
    expect(v).toHaveLength(1)
    expect(v[0]?.file).toBe("path/to/c.tsx")
    expect(v[0]?.line).toBe(2)
  })
  test("walks view code but skips test fixtures and test files", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lint-i18n-"))
    try {
      const view = `export function C() { return <div>Welcome aboard</div> }`
      for (const rel of [
        "src/views/c.tsx",
        "src/tests/e2e/fixture/ui.tsx",
        "src/views/c.test.tsx",
      ]) {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
        writeFileSync(path.join(root, rel), view)
      }
      const v = await lintI18nStrings(root)
      expect(v.map((x) => x.file)).toEqual(["src/views/c.tsx"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
