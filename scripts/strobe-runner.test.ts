// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { parseArgs, resolveCommand } from "./strobe-runner"

describe("strobe-runner", () => {
  it("--suite security resolves to test-run.ts security", () => {
    const cmd = resolveCommand("security")
    expect(cmd).toEqual(["bun", "run", "scripts/test-run.ts", "security"])
  })

  it("--suite all maps to scripts/test-run.ts full", () => {
    expect(resolveCommand("all")).toEqual(["bun", "run", "scripts/test-run.ts", "full"])
  })

  it("parseArgs returns suite + dryRun", () => {
    expect(parseArgs(["--suite", "unit", "--dry-run"])).toEqual({ suite: "unit", dryRun: true })
  })
})

describe("strobe-runner CLI", () => {
  it("unknown suite exits 2", () => {
    const proc = Bun.spawnSync(
      ["bun", "run", `${import.meta.dir}/strobe-runner.ts`, "--suite", "nonsense"],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(proc.exitCode).toBe(2)
    expect(proc.stderr.toString()).toContain("unknown suite")
  })

  it("missing --suite exits 2", () => {
    const proc = Bun.spawnSync(["bun", "run", `${import.meta.dir}/strobe-runner.ts`], {
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(proc.exitCode).toBe(2)
    expect(proc.stderr.toString()).toContain("missing --suite")
  })

  it("--dry-run prints the resolved command for a known suite without running", () => {
    const proc = Bun.spawnSync(
      ["bun", "run", `${import.meta.dir}/strobe-runner.ts`, "--suite", "security", "--dry-run"],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(proc.exitCode).toBe(0)
    expect(proc.stdout.toString()).toContain("scripts/test-run.ts")
    expect(proc.stdout.toString()).toContain("security")
  })
})
