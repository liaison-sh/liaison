// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { bundledApps, classify, docsRelevant, projects } from "./ci-scope"

const m = (path: string) => ({ status: "M", path })

describe("ci-scope classify", () => {
  it("runs everything outside a pull request", () => {
    const s = classify([], undefined)
    expect(s.full).toBe(true)
    expect(s.docs).toBe(true)
  })

  it.each([
    "package.json",
    "apps/web/package.json",
    "bun.lock",
    "tsconfig.json",
    "packages/shared/tsconfig.json",
    "biome.json",
    ".github/workflows/ci.yml",
    "scripts/ci-scope.ts",
  ])("falls back to a full run when %s changes", (path) => {
    const s = classify([m("apps/web/src/App.tsx"), m(path)], "origin/main")
    expect(s.full).toBe(true)
    expect(s.reason).toContain(path)
  })

  it("scopes a pull request to its changed files", () => {
    const s = classify(
      [
        m("apps/web/src/lib/x.ts"),
        { status: "A", path: "docs/a.md" },
        { status: "D", path: "notes.txt" },
      ],
      "origin/main",
    )
    expect(s.full).toBe(false)
    expect(s.biomeFiles).toEqual(["apps/web/src/lib/x.ts", "docs/a.md"])
    expect(s.typescript).toBe(true)
    expect(s.typescriptAll).toBe(false)
  })

  it("type checks everything when a TypeScript file is deleted", () => {
    const s = classify([{ status: "D", path: "packages/shared/src/csv.ts" }], "origin/main")
    expect(s.typescriptAll).toBe(true)
  })

  it("needs no type check for a docs-only change", () => {
    const s = classify([m("docs/agents/models.md"), m("README.md")], "origin/main")
    expect(s.typescript).toBe(false)
    expect(s.docs).toBe(true)
  })
})

describe("ci-scope docsRelevant", () => {
  it.each([
    ["docs/agents/models.md", true],
    ["scripts/docs/gen-reference.ts", true],
    [".claude/docs-map.ts", true],
    // Generated reference pages read api sources, exempt modules included.
    ["apps/api/src/modules/admin/routes.ts", true],
    ["bundled-apps/shopify/app.manifest.json", true],
    ["apps/web/src/modules/agent/AgentPanel.tsx", true],
    // Exempt, or outside every docs input.
    ["apps/api/src/modules/admin/routes.test.ts", false],
    ["apps/web/src/ui/Button.tsx", false],
    ["packages/test-helpers/src/x.ts", false],
    ["scripts/lib/deploy-counters.ts", false],
    ["qa/notifications/run.ts", false],
  ])("%s → %p", (file, expected) => {
    expect(docsRelevant(file)).toBe(expected)
  })
})

describe("ci-scope projects", () => {
  it("lists every typechecked workspace package and scripts/", () => {
    const dirs = projects().map((p) => p.dir)
    expect(dirs).toContain("apps/api")
    expect(dirs).toContain("apps/web")
    expect(dirs).toContain("apps/desktop/sidecar")
    expect(dirs).toContain("packages/shared")
    expect(dirs.at(-1)).toBe("scripts")
  })

  it("lists the bundled apps apart: the workspace projects never reach them", () => {
    const apps = bundledApps().map((p) => p.dir)
    expect(apps).toContain("bundled-apps/invoicing")
    expect(apps).toContain("bundled-apps/shopify")
    const workspace = new Set(projects().map((p) => p.dir))
    expect(apps.filter((dir) => workspace.has(dir))).toEqual([])
  })
})
