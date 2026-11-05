// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Anyone with write access to this repository can read every Actions secret,
// so no workflow that runs here may take one. The release workflows live under
// apps/*/ci/ as data for the tests and run from the operator's private
// repository instead.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { REPO_ROOT } from "./ci/workflow"

const WORKFLOWS = path.join(REPO_ROOT, ".github/workflows")

function workflowFiles(): string[] {
  return readdirSync(WORKFLOWS, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join(WORKFLOWS, f))
}

describe("workflows that run in this repository", () => {
  it("are found", () => {
    expect(workflowFiles().length).toBeGreaterThan(0)
  })

  it("reference no secret but GITHUB_TOKEN", () => {
    for (const file of workflowFiles()) {
      const names = [...readFileSync(file, "utf8").matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(
        (m) => m[1],
      )
      expect(
        `${path.relative(REPO_ROOT, file)}: ${names.filter((n) => n !== "GITHUB_TOKEN").join(",")}`,
      ).toBe(`${path.relative(REPO_ROOT, file)}: `)
    }
  })

  it("include neither release workflow", () => {
    const names = workflowFiles().map((f) => path.basename(f))
    expect(names).not.toContain("desktop-release.yml")
    expect(names).not.toContain("mobile-release.yml")
  })

  it("name no self-hosted runner variable", () => {
    for (const file of workflowFiles()) {
      expect(readFileSync(file, "utf8")).not.toMatch(/vars\.DESKTOP_RUNNER_/)
    }
  })
})
