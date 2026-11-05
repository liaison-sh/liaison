// SPDX-License-Identifier: FSL-1.1-ALv2

import { describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { HOME_CHUNK_BUDGET_BYTES, measureHomeChunk } from "./check-bundle-size"

const SCRIPT = path.join(import.meta.dir, "check-bundle-size.ts")

function fixture(bytes: Uint8Array): string {
  const root = mkdtempSync(path.join(tmpdir(), "mobile-bundle-"))
  mkdirSync(path.join(root, "assets"), { recursive: true })
  writeFileSync(path.join(root, "assets", "Home-abc12345.js"), bytes)
  return root
}

/** Incompressible: the gzipped size is about the raw size. */
function noise(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length))
}

describe("home chunk budget", () => {
  it("fails when the Home chunk exceeds the budget", () => {
    const root = fixture(noise(HOME_CHUNK_BUDGET_BYTES * 2))
    try {
      const measured = measureHomeChunk(root)
      expect(measured.gzipped).toBeGreaterThan(HOME_CHUNK_BUDGET_BYTES)
      const result = Bun.spawnSync(["bun", SCRIPT, "--dir", root], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(1)
      expect(result.stdout.toString()).toContain("over the budget")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("passes when the Home chunk is under the budget", () => {
    const root = fixture(new TextEncoder().encode("a".repeat(HOME_CHUNK_BUDGET_BYTES * 4)))
    try {
      expect(measureHomeChunk(root).gzipped).toBeLessThan(HOME_CHUNK_BUDGET_BYTES)
      const result = Bun.spawnSync(["bun", SCRIPT, "--dir", root], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toContain("gzipped")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails when there is no Home chunk to measure", () => {
    // The measured thing is a code-split boundary. If it moves or disappears,
    // a budget check that finds nothing must not report a pass.
    const root = mkdtempSync(path.join(tmpdir(), "mobile-bundle-"))
    mkdirSync(path.join(root, "assets"), { recursive: true })
    try {
      expect(() => measureHomeChunk(root)).toThrow()
      const result = Bun.spawnSync(["bun", SCRIPT, "--dir", root], {
        stdout: "pipe",
        stderr: "pipe",
      })
      expect(result.exitCode).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("measures the Home chunk inside the real Capacitor build when one is synced", () => {
    const synced = path.resolve(import.meta.dir, "..", "ios/App/App/public")
    const measured = measureHomeChunk(synced)
    console.log(`Home chunk in the synced iOS build: ${measured.gzipped} bytes gzipped`)
    expect(measured.gzipped).toBeLessThanOrEqual(HOME_CHUNK_BUDGET_BYTES)
  })
})
