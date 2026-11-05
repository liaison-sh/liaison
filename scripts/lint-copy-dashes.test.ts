// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  APP_MANIFEST_ROOTS,
  COPY_ROOTS,
  exemptLines,
  LOCALE_ROOTS,
  MARKDOWN_COPY_FILES,
  SCOPE_CATALOG_FILES,
  scanAppManifest,
  scanLocaleJson,
  scanMarkdown,
  scanSource,
} from "./lint-copy-dashes"

const EM = "—"
const EN = "–"

describe("scanSource", () => {
  it("flags an em dash in JSX text", () => {
    const hits = scanSource(
      "apps/web/src/x.tsx",
      `export const A = () => <div>Saved${EM}for now</div>`,
    )
    expect(hits.length).toBe(1)
    expect(hits[0].text).toContain(EM)
  })

  it("flags an en dash in a JSX attribute", () => {
    const hits = scanSource(
      "apps/web/src/x.tsx",
      `export const A = () => <button aria-label="Open${EN}close">x</button>`,
    )
    expect(hits.length).toBe(1)
  })

  it("flags a literal double hyphen", () => {
    const hits = scanSource("apps/web/src/x.ts", `export const m = "1-8 items -- confirm"`)
    expect(hits.length).toBe(1)
    expect(hits[0].text).toContain("--")
  })

  it("flags a double hyphen between word characters", () => {
    const hits = scanSource("apps/web/src/x.ts", `export const m = "confirm--then ship"`)
    expect(hits.length).toBe(1)
  })

  it("does not flag a plain hyphen compound or numeric range", () => {
    expect(scanSource("apps/web/src/x.ts", `export const m = "1-8 items, well-formed"`)).toEqual([])
  })

  it("does not flag a dash inside a code comment", () => {
    expect(
      scanSource("apps/web/src/x.ts", `// note ${EM} this is for developers\nexport const n = 1`),
    ).toEqual([])
  })

  it("does not flag an import specifier line", () => {
    expect(
      scanSource("apps/web/src/x.ts", `import { a } from "./a${EN}b"\nexport const n = a`),
    ).toEqual([])
  })

  it("does not flag a logger reached through a receiver", () => {
    expect(
      scanSource("bundled-apps/x/src/a.ts", `ctx.logger.warn("shop mismatch${EM}rejecting")`),
    ).toEqual([])
  })

  it("does not flag an optional-chained logger call", () => {
    expect(
      scanSource(
        "bundled-apps/x/src/a.ts",
        `ctx.logger?.warn?.("no topics${EM}nothing will arrive")`,
      ),
    ).toEqual([])
  })

  it("still flags a non-logger method that merely ends in a log-like word", () => {
    expect(scanSource("bundled-apps/x/src/a.ts", `banner.warn("Saved${EM}for now")`).length).toBe(1)
  })

  it("does not flag a log call", () => {
    expect(
      scanSource(
        "apps/web/src/x.ts",
        `export const f = () => console.warn("sync failed ${EM} retrying")`,
      ),
    ).toEqual([])
  })

  it("does not flag an Error message built in the framework layer", () => {
    expect(
      scanSource(
        "apps/web/src/framework/x.ts",
        `export const f = () => { throw new Error("boot ${EM} failed") }`,
      ),
    ).toEqual([])
  })

  it("flags a template literal chunk", () => {
    const placeholder = ["$", "{n}"].join("")
    const src = ["export const m = (n: number) => ", "`", EM, " ", placeholder, " items", "`"].join(
      "",
    )
    expect(scanSource("apps/web/src/x.ts", src).length).toBe(1)
  })

  it("reports the file and line of each violation", () => {
    const hits = scanSource("apps/web/src/x.ts", `export const a = 1\nexport const m = "a ${EM} b"`)
    expect(hits[0].file).toBe("apps/web/src/x.ts")
    expect(hits[0].line).toBe(2)
  })
})

describe("scanLocaleJson", () => {
  it("flags an em dash in a locale string VALUE", () => {
    const hits = scanLocaleJson(
      "packages/shared/src/i18n/locales/en/kernel.json",
      `{\n  "close": "Close",\n  "hint": "Saved${EM}for now"\n}\n`,
    )
    expect(hits.length).toBe(1)
    expect(hits[0].text).toContain(EM)
    expect(hits[0].line).toBe(3)
  })

  it("flags a dash in a nested value", () => {
    const hits = scanLocaleJson(
      "packages/shared/src/i18n/locales/fr/kernel.json",
      `{\n  "errors": {\n    "busy": "Reessayez${EN}plus tard"\n  }\n}\n`,
    )
    expect(hits.length).toBe(1)
  })

  it("never flags a KEY, only a value", () => {
    const hits = scanLocaleJson(
      "packages/shared/src/i18n/locales/en/kernel.json",
      `{\n  "in${EM}progress": "In progress"\n}\n`,
    )
    expect(hits).toEqual([])
  })

  it("does not flag plain hyphens in a value", () => {
    expect(
      scanLocaleJson(
        "packages/shared/src/i18n/locales/en/kernel.json",
        `{\n  "range": "1-8 items, well-formed"\n}\n`,
      ),
    ).toEqual([])
  })

  it("declares the locale json roots alongside the source roots", () => {
    expect(LOCALE_ROOTS).toContain("packages/shared/src/i18n/locales")
    expect(COPY_ROOTS).toContain("apps/web/src")
  })
})

// A string that is not copy at all (a transliteration table keyed by the dash
// character, a regex, a machine identifier) is exempted at its own line with a
// documented reason rather than by editing the string or by widening the rule.
describe("copy-lint exemption marker", () => {
  it("suppresses a violation on the marker's own line", () => {
    const src = `const MAP = { "${EM}": "-" } // copy-lint: exempt transliteration table key\n`
    expect(scanSource("bundled-apps/x/src/a.ts", src)).toEqual([])
  })

  it("suppresses a violation on the line directly below the marker", () => {
    const src = `const MAP = {\n  // copy-lint: exempt transliteration table key\n  "${EM}": "-",\n}\n`
    expect(scanSource("bundled-apps/x/src/a.ts", src)).toEqual([])
  })

  it("does not suppress a line two below the marker", () => {
    const src = `// copy-lint: exempt something\nconst a = "ok"\nconst b = "Saved${EM}for now"\n`
    expect(scanSource("bundled-apps/x/src/a.ts", src).map((v) => v.line)).toEqual([3])
  })

  it("requires a reason: a bare marker exempts nothing", () => {
    const src = `const a = "Saved${EM}for now" // copy-lint: exempt\n`
    expect(scanSource("bundled-apps/x/src/a.ts", src).length).toBe(1)
  })

  it("reports the marker lines it found", () => {
    expect([...exemptLines(`a\n// copy-lint: exempt why\nb\n`)].sort()).toEqual([2, 3])
  })
})

// The release notes and the migration runbook are read by a customer and by an
// operator, and both landed outside every root this gate walked: the rule was
// stated in the slice's own note and enforced nowhere.
describe("scanMarkdown", () => {
  it("flags an em dash in a document a customer reads", () => {
    const hits = scanMarkdown("docs/release-notes.md", `There is a desktop app${EM}for now\n`)
    expect(hits.map((h) => h.line)).toEqual([1])
  })

  it("flags an en dash and a spaced double hyphen", () => {
    expect(scanMarkdown("docs/x.md", `a ${EN} b\n`).length).toBe(1)
    expect(scanMarkdown("docs/x.md", `a -- b\n`).length).toBe(1)
  })

  it("leaves a plain hyphen and a range alone", () => {
    expect(scanMarkdown("docs/x.md", "one time step, 640 to 1023 pixels, opt-in\n")).toEqual([])
  })

  it("does not read a fenced block as prose", () => {
    const doc = ["```sql", "-- the ledger, one row per applied migration", "select 1;", "```", ""]
    expect(scanMarkdown("docs/release-notes.md", doc.join("\n"))).toEqual([])
  })

  it("does not read an inline code span or an html comment as prose", () => {
    expect(scanMarkdown("docs/x.md", "run `liaison migrate -- --apply` first\n")).toEqual([])
    expect(scanMarkdown("docs/x.md", `<!-- a ${EM} b -->\n`)).toEqual([])
  })

  it("keeps scanning after a fenced block closes", () => {
    const doc = ["```", "-- code", "```", `prose${EM}here`, ""]
    expect(scanMarkdown("docs/x.md", doc.join("\n")).map((h) => h.line)).toEqual([4])
  })

  it("names the customer facing documents the gate walks", () => {
    expect(MARKDOWN_COPY_FILES).toContain("docs/release-notes.md")
  })

  it("finds no dash punctuation in those documents as they stand", async () => {
    for (const file of MARKDOWN_COPY_FILES) {
      const text = await Bun.file(new URL(`../${file}`, import.meta.url).pathname).text()
      expect(scanMarkdown(file, text)).toEqual([])
    }
  })
})

// The capability picker prints one `description` per scope, so the scope
// catalog is interface copy that happens to live in a TypeScript file on the
// api side, and an app manifest mixes that copy with model-facing tool schema
// prose in the same document.
describe("scope catalog and app manifest copy", () => {
  it("names the scope catalogue as a copy file the sweep walks", () => {
    expect(SCOPE_CATALOG_FILES).toContain("apps/api/src/modules/permissions/scope-catalog.ts")
  })

  it("names both manifest roots", () => {
    expect(APP_MANIFEST_ROOTS).toContain("bundled-apps")
    expect(APP_MANIFEST_ROOTS).toContain("apps/api/src/apps")
  })

  it("flags an em dash in a scope description and leaves the file comments alone", () => {
    const src = [
      `// A dash ${EM} in a comment is not copy.`,
      "export const KERNEL_SCOPES = [",
      `  { scope: "policies:admin", app: "kernel", description: "Tighten policies ${EM} admin only" },`,
      "]",
      "",
    ].join("\n")
    const hits = scanSource("apps/api/src/modules/permissions/scope-catalog.ts", src)
    expect(hits.length).toBe(1)
    expect(hits[0].line).toBe(3)
  })

  it("flags an em dash in a manifest's own description and in a label at any depth", () => {
    const manifest = JSON.stringify(
      {
        name: "metrics",
        description: `KPI surface ${EM} versioned formulas`,
        connections: {
          "kpi-service": { credentialFields: [{ label: `Admin token ${EN} optional` }] },
        },
      },
      null,
      2,
    )
    const hits = scanAppManifest("bundled-apps/metrics/app.manifest.json", manifest)
    expect(hits.length).toBe(2)
  })

  it("leaves model-facing manifest prose alone", () => {
    const manifest = JSON.stringify(
      {
        name: "metrics",
        description: "KPI surface: versioned formulas",
        agentInstructions: `Call kpi_run first ${EM} then read lineage`,
        tools: {
          kpi_run: {
            description: `Run one KPI ${EM} hub scoped`,
            params: { properties: { hubId: { description: `The hub ${EM} required` } } },
          },
        },
      },
      null,
      2,
    )
    expect(scanAppManifest("bundled-apps/metrics/app.manifest.json", manifest)).toEqual([])
  })

  it("leaves a plain hyphen in a manifest label alone", () => {
    const manifest = JSON.stringify({ name: "x", description: "A read-only connector" }, null, 2)
    expect(scanAppManifest("bundled-apps/x/app.manifest.json", manifest)).toEqual([])
  })
})
