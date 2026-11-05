// SPDX-License-Identifier: FSL-1.1-ALv2
// [Task 13] scripts/spec-coverage.ts — extract criteria + scan markers.
import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("scripts.spec-coverage", () => {
  it("reports covered when every numbered criterion has a marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-cov-"))
    const spec = `
# Sample
## 1. Purpose and Success Criteria
1. First criterion
2. Second criterion
3. Third criterion
`
    const src = `import { test } from "bun:test"\ntest("[SC1] thing", () => {})\ntest("[SC2] other", () => {})\ntest("[SC3] last", () => {})\n`
    await writeFile(join(dir, "spec.md"), spec)
    await writeFile(join(dir, "src.test.ts"), src)
    const out = join(dir, "report.md")
    const result = spawnSync(
      "bun",
      [
        "scripts/spec-coverage.ts",
        "--phase-spec",
        join(dir, "spec.md"),
        "--search-roots",
        dir,
        "--output",
        out,
      ],
      {
        cwd: process.cwd().replace(/apps\/api$/, "") || process.cwd(),
      },
    )
    expect(result.status).toBe(0)
    const report = await readFile(out, "utf8")
    expect(report).toContain("Total criteria: 3")
    expect(report).toContain("Missing: 0")
    expect(report).toContain("spec:SC1 | covered")
    expect(report).toContain("[SC1] thing")
  })

  it("exits non-zero and lists missing criteria", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-cov-miss-"))
    const spec = `
# Sample
## 1. Purpose and Success Criteria
1. First criterion
2. Second criterion
`
    const src = `import { it } from "bun:test"\nit("[SC1] only the first one", () => {})\n`
    await writeFile(join(dir, "spec.md"), spec)
    await writeFile(join(dir, "src.test.ts"), src)
    const out = join(dir, "report.md")
    const result = spawnSync(
      "bun",
      [
        "scripts/spec-coverage.ts",
        "--spec",
        join(dir, "spec.md"),
        "--search-roots",
        dir,
        "--output",
        out,
      ],
      {
        cwd: process.cwd().replace(/apps\/api$/, "") || process.cwd(),
      },
    )
    expect(result.status).toBe(1)
    const report = await readFile(out, "utf8")
    expect(report).toContain("Missing: 1")
    expect(report).toContain("spec:SC2 | MISSING")
  })

  it("namespaces same-number criteria from different specs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-cov-ns-"))
    const phase7 = `
# Phase 7
## 1. Purpose and Success Criteria
1. Main first criterion
2. Main second criterion
`
    const phase74 = `
# Phase 7.4
## 1. Purpose and Success Criteria
1. Add-on first criterion
`
    await writeFile(join(dir, "03-phase-7-spec.md"), phase7)
    await writeFile(join(dir, "03-phase-7-4-spec.md"), phase74)
    await writeFile(
      join(dir, "src.test.ts"),
      `import { it } from "bun:test"\nit("[phase7:SC1] main only", () => {})\nit("[phase7.4:SC1] add-on", () => {})\n`,
    )
    const out = join(dir, "report.md")
    const result = spawnSync(
      "bun",
      [
        "scripts/spec-coverage.ts",
        "--main-spec",
        join(dir, "03-phase-7-spec.md"),
        "--phase-spec",
        join(dir, "03-phase-7-4-spec.md"),
        "--search-roots",
        dir,
        "--output",
        out,
      ],
      {
        cwd: process.cwd().replace(/apps\/api$/, "") || process.cwd(),
      },
    )
    expect(result.status).toBe(1)
    const report = await readFile(out, "utf8")
    expect(report).toContain("phase7:SC1 | covered")
    expect(report).toContain("phase7.4:SC1 | covered")
    expect(report).toContain("phase7:SC2 | MISSING")
  })

  it("[SC17] rejects SC markers in production files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "spec-cov-prod-"))
    const spec = `
# Sample
## 1. Purpose and Success Criteria
1. First criterion
`
    await writeFile(join(dir, "spec.md"), spec)
    await writeFile(join(dir, "src.ts"), `// [SC1] production marker\n`)
    await writeFile(
      join(dir, "src.test.ts"),
      `import { it } from "bun:test"\nit("[SC1] real test", () => {})\n`,
    )
    const out = join(dir, "report.md")
    const result = spawnSync(
      "bun",
      [
        "scripts/spec-coverage.ts",
        "--main-spec",
        join(dir, "spec.md"),
        "--search-roots",
        dir,
        "--output",
        out,
      ],
      {
        cwd: process.cwd().replace(/apps\/api$/, "") || process.cwd(),
      },
    )
    expect(result.status).toBe(1)
    const report = await readFile(out, "utf8")
    expect(report).toContain("Production marker violations: 1")
  })
})
