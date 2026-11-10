// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { esmExportsToGlobalThis } from "~/modules/apps/sandbox/bundle-loader"
import { importAttributeIssue } from "~/modules/apps/sandbox/import-attributes"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..", "..")

describe("import attributes in a handler bundle", () => {
  let dir = ""
  let marker = ""
  let macro = ""
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "liaison-import-attributes-"))
    marker = join(dir, "ran")
    macro = join(dir, "macro.ts")
    writeFileSync(
      macro,
      `import { writeFileSync } from "node:fs"\nexport function mark() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1 }\n`,
    )
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const refused = (m: string): Record<string, string> => ({
    "a static import with `with`": `import { mark } from ${m} with { type: "macro" };\nvar seen = mark();\nexport { seen };`,
    "a static import with `assert`": `import { mark } from ${m} assert { type: "macro" };\nvar seen = mark();\nexport { seen };`,
    "comments before the object": `import { mark } from ${m} with /* a */ // b\n { type: "macro" };\nexport { mark };`,
    "a bare import": `import ${m} with { type: "text" };\nexport {};`,
    "an export from": `export { mark } from ${m} with { type: "macro" };`,
    "a dynamic import with options": `var p = import(${m}, { with: { type: "macro" } });\nexport { p };`,
    "a dynamic import with `assert` options": `var p = import(${m}, { assert: { type: "macro" } });\nexport { p };`,
    "an escaped keyword": `import { mark } from ${m} \\u0077ith { type: "macro" };\nexport { mark };`,
  })

  it("refuses every way of writing one, without running the macro", async () => {
    for (const [what, source] of Object.entries(refused(JSON.stringify(macro)))) {
      expect({ what, issue: await importAttributeIssue(source) }).toMatchObject({
        what,
        issue: expect.any(String),
      })
    }
    // The check is the TypeScript parser's: nothing Bun reads, so nothing Bun runs.
    expect(existsSync(marker)).toBe(false)
  })

  it("refuses a bundle the parser cannot read", async () => {
    expect(await importAttributeIssue("function list_items( {")).toContain("does not parse")
  })

  it("passes code whose text only mentions `with {` or `assert {`", async () => {
    for (const source of [
      `var a = "reply with { name }";\nvar b = 'assert { ok }';\nexport { a, b };`,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the text under test
      "var x = 1;\nvar t = `start with {${x}} and assert {x}`;\nexport { t };",
      "var r = /with \\{/;\nvar s = /assert\\s*\\{/g;\nexport { r, s };",
      "// formats it with { YYYY }\n/* assert { x } */\nvar x = 1;\nexport { x };",
      "var o = { with: 1, assert: 2 };\nvar w = o.with + o.assert;\nexport { w };",
      `var s = "from" + " with { type: 'macro' }";\nexport { s };`,
      `function f() { with (Math) { return max(1, 2) } }\nvar g = f;`,
      `var spec = import.meta;\nvar lazy = () => import("./x.js");\nexport { lazy };`,
    ]) {
      expect({ source, issue: await importAttributeIssue(source) }).toEqual({
        source,
        issue: null,
      })
    }
  })

  it("passes real first-party bundles (handlers and UI), minified or not", async () => {
    const entries: Array<[string, "bun" | "browser"]> = [
      [join(REPO_ROOT, "apps", "api", "src", "apps", "example", "handlers.ts"), "bun"],
      [join(REPO_ROOT, "bundled-apps", "social", "handlers.ts"), "bun"],
      [join(REPO_ROOT, "bundled-apps", "social", "ui.tsx"), "browser"],
    ]
    for (const [entry, target] of entries) {
      for (const minify of [false, true]) {
        const built = await Bun.build({
          entrypoints: [entry],
          target,
          external: ["node:*", "solid-js", "solid-js/*", "@liaison/*"],
          minify,
        })
        expect(built.success).toBe(true)
        const source = esmExportsToGlobalThis(await (built.outputs[0] as Bun.BuildArtifact).text())
        expect({ entry, minify, issue: await importAttributeIssue(source) }).toEqual({
          entry,
          minify,
          issue: null,
        })
      }
    }
  }, 60_000)
})
