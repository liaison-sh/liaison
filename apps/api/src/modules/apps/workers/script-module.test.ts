// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Worker module of a plain script (an import transform, a PDF template) is
// made without handing the script to Bun: Bun runs a macro import while it
// parses, in the API process. Every variant below must be refused before any
// build, and no marker file may appear.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadBundle } from "~/modules/apps/sandbox/bundle-loader"
import { plainScriptIssue } from "~/modules/apps/sandbox/import-attributes"
import { validateTransformSource } from "~/modules/imports/transforms/source"
import {
  AdhocModuleError,
  AdhocModuleTestAccess,
  runtimeHandlersSource,
  scriptModuleText,
} from "./adhoc-module"

describe("plain script modules are never parsed by Bun", () => {
  let dir = ""
  let marker = ""
  let macro = ""
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "liaison-script-module-"))
    marker = join(dir, "pwned.txt")
    macro = join(dir, "macro.ts")
    writeFileSync(
      macro,
      `import { writeFileSync } from "node:fs"\nexport function mark() { writeFileSync(${JSON.stringify(marker)}, "ran"); return 1 }\n`,
    )
  })
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const fn = "\nfunction transform(batch, ctx) { return batch }\n"
  const variants = (): Record<string, string> => {
    const fs = JSON.stringify("node:fs")
    const m = JSON.stringify(macro)
    const write = `writeFileSync(${JSON.stringify(marker)}, "x");`
    return {
      "a carriage return before import": `var a = 1\rimport { writeFileSync } from ${fs} with { type: "macro" };\n${write}${fn}`,
      "a line separator before import": `var a = 1\u2028import { writeFileSync } from ${fs} with { type: "macro" };\n${write}${fn}`,
      "a paragraph separator before import": `var a = 1\u2029import { writeFileSync } from ${fs} with { type: "macro" };\n${write}${fn}`,
      "a comment before import": `/* x */import { writeFileSync } from ${fs} with { type: "macro" };\n${write}${fn}`,
      "a plain macro import": `import { mark } from ${m} with { type: "macro" };\nvar seen = mark();${fn}`,
      "an assert attribute": `import { mark } from ${m} assert { type: "macro" };\nvar seen = mark();${fn}`,
      "an escaped with keyword": `import { mark } from ${m} \\u0077ith { type: "macro" };\nvar seen = mark();${fn}`,
      "an import without attribute": `import { mark } from ${m};\nvar seen = mark();${fn}`,
      "an export from": `export { mark } from ${m} with { type: "macro" };${fn}`,
      "an export": `export const x = 1;${fn}`,
      "a dynamic import": `var p = import(${m});${fn}`,
      "a dynamic import with options": `var p = import(${m}, { with: { type: "macro" } });${fn}`,
      "import.meta": `var u = import.meta.url;${fn}`,
      "an import in a template literal hole": `var t = \`\${(() => { return 1 })()}\`\nimport { mark } from ${m} with { type: "macro" };${fn}`,
      "text that closes the wrapper": `})(); import { mark } from ${m} with { type: "macro" }; (function () {${fn}`,
      "a return outside a function": `return 1;${fn}`,
      "a script that does not parse": "function transform(batch, ctx) { return {",
    }
  }

  it("refuses every variant at the parse, without running anything", async () => {
    for (const [what, script] of Object.entries(variants())) {
      expect({ what, issue: await plainScriptIssue(script) }).toMatchObject({
        what,
        issue: expect.any(String),
      })
      const err = await scriptModuleText(script, ["transform"]).catch((e: unknown) => e)
      expect({ what, err }).toMatchObject({ what, err: expect.any(AdhocModuleError) })
    }
    expect(existsSync(marker)).toBe(false)
  })

  it("the transform source check refuses the line-terminator variants too", () => {
    for (const sep of ["\r", "\u2028", "\u2029"]) {
      const source = `var a = 1${sep}import { writeFileSync } from "node:fs" with { type: "macro" };${fn}`
      expect(() => validateTransformSource(source, "transform")).toThrow(/import is not available/)
    }
  })

  it("passes code that only mentions import or export in text, comments and regexes", async () => {
    for (const script of [
      `var a = "import x from 'y' with { type: \\"macro\\" }";${fn}`,
      `// import { x } from "y"\n/* export default 1 */${fn}`,
      `var r = /import\\s*\\(/;\nvar t = \`export \${1} import\`;${fn}`,
      `var o = { import: 1, export: 2 }; o.import; o.export;${fn}`,
    ]) {
      expect(await plainScriptIssue(script)).toBeNull()
    }
  })

  it("builds Bun only from platform code: the script is joined as text", async () => {
    const before = AdhocModuleTestAccess.builds()
    const script =
      "var n = 0\nfunction transform(b) { n++; return { state: b.records.length + n } }"
    const text = await scriptModuleText(script, ["transform"])
    expect(text.startsWith("const __liaison_adhoc_script = (function () {\n")).toBe(true)
    expect(text).toContain(script)
    // The runtime is built once per export list and process, from the wrappers only.
    await scriptModuleText(`${script}\n// another`, ["transform"])
    expect(AdhocModuleTestAccess.builds() - before).toBeLessThanOrEqual(1)
    expect(runtimeHandlersSource(["transform"])).not.toContain(script)
    expect(() => runtimeHandlersSource(["__liaison_adhoc_script"])).toThrow(AdhocModuleError)
  })

  it("the module runs the script's function, or a globalThis property it set", async () => {
    // The module's slot, evaluated alone (the runtime needs workerd): the
    // lookup finds a top-level function first, then a globalThis property.
    const text = await scriptModuleText(
      "function transform(b) { return b * 2 }\nglobalThis.renderTemplate = (d) => [d]",
      ["renderTemplate", "transform"],
    )
    const slot = text.slice(0, text.indexOf("})();") + "})();".length)
    const lookup = new Function(`${slot}\nreturn __liaison_adhoc_script`)() as (
      n: string,
    ) => ((x: unknown) => unknown) | undefined
    expect(lookup("transform")?.(21)).toBe(42)
    expect(lookup("renderTemplate")?.("x")).toEqual(["x"])
    expect(lookup("missing")).toBeUndefined()
    delete (globalThis as Record<string, unknown>).renderTemplate
  })

  it("a TypeScript handler bundle from outside the repo is never transpiled", async () => {
    const bundle = join(dir, "handlers.ts")
    writeFileSync(
      bundle,
      `import { mark } from ${JSON.stringify(macro)} with { type: "macro" };\nexport const seen = mark();\n`,
    )
    await expect(loadBundle(bundle)).rejects.toThrow(/only a \.js handler bundle/)
    expect(existsSync(marker)).toBe(false)
  })
})
