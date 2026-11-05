// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

describe("developer docs", () => {
  it("docs/app-development.md exists and references the scaffold/freeze/install flow", () => {
    const path = join(REPO_ROOT, "docs/app-development.md")
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, "utf8")
    expect(text).toMatch(/bun run app:create/)
    expect(text).toMatch(/bun run app:freeze/)
    expect(text).toMatch(/POST \/api\/apps\/install/)
    expect(text).toMatch(/apps\/api\/src\/apps/)
    expect(text).toMatch(/docs\/sdk-gaps\.md/)
  })

  it("docs/sdk-gaps.md exists with a structural table (column names may evolve)", () => {
    const path = join(REPO_ROOT, "docs/sdk-gaps.md")
    expect(existsSync(path)).toBe(true)
    const text = readFileSync(path, "utf8")
    const tableRows = text.split("\n").filter((l) => l.trim().startsWith("|"))
    expect(tableRows.length).toBeGreaterThan(0)
    const cells = tableRows[0].split("|").filter((c) => c.trim().length > 0)
    expect(cells.length).toBeGreaterThanOrEqual(4)
    expect(text).toMatch(/gap/i)
  })

  it("README.md links to docs/app-development.md", () => {
    const text = readFileSync(join(REPO_ROOT, "README.md"), "utf8")
    expect(text).toMatch(/docs\/app-development\.md/)
  })

  it("CONTRIBUTING.md points plugin authors at the developer guide", () => {
    const path = join(REPO_ROOT, "CONTRIBUTING.md")
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, "utf8")).toMatch(/docs\/app-development\.md/)
  })
})
