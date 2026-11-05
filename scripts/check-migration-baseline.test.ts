// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// We invoke the script as a subprocess so we can test the file-system contract
// (absent .baseline → exit 0, mismatch → exit 1) without monkey-patching the
// resolved REPO_ROOT inside the module.

interface RunOutcome {
  code: number
  stdout: string
  stderr: string
}

function runScript(root: string, env: Record<string, string> = {}): RunOutcome {
  const script = join(import.meta.dir, "check-migration-baseline.ts")
  const proc = Bun.spawnSync(["bun", "run", script], {
    cwd: root,
    env: { ...process.env, LIAISON_ROOT: root, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    code: proc.exitCode ?? -1,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

describe("check-migration-baseline", () => {
  let root: string
  let migrationsDir: string
  let baselinePath: string
  let protectedSql: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "baseline-"))
    migrationsDir = join(root, "apps/api/src/db/migrations")
    mkdirSync(migrationsDir, { recursive: true })
    protectedSql = join(migrationsDir, "0000_initial.sql")
    writeFileSync(protectedSql, "-- initial migration\nCREATE TABLE foo (id int);\n")
    baselinePath = join(migrationsDir, ".baseline")
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("no-op when .baseline absent", () => {
    const r = runScript(root)
    expect(r.code).toBe(0)
  })

  it("passes when protected file unchanged", () => {
    const hash = sha256(readFileSync(protectedSql))
    writeFileSync(
      baselinePath,
      JSON.stringify({
        tag: "v0.1.0",
        protected: [{ path: "apps/api/src/db/migrations/0000_initial.sql", sha256: hash }],
      }),
    )
    const r = runScript(root)
    expect(r.code).toBe(0)
  })

  it("fails when protected file mutated", () => {
    writeFileSync(
      baselinePath,
      JSON.stringify({
        tag: "v0.1.0",
        protected: [
          {
            path: "apps/api/src/db/migrations/0000_initial.sql",
            sha256: "wronghash".padEnd(64, "0"),
          },
        ],
      }),
    )
    const r = runScript(root)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("hash mismatch")
  })

  it("allows adding a NEW migration file not in baseline", () => {
    const hash = sha256(readFileSync(protectedSql))
    writeFileSync(
      baselinePath,
      JSON.stringify({
        tag: "v0.1.0",
        protected: [{ path: "apps/api/src/db/migrations/0000_initial.sql", sha256: hash }],
      }),
    )
    // Add a forward migration that is NOT in the baseline — should still pass.
    writeFileSync(join(migrationsDir, "0001_new.sql"), "ALTER TABLE foo ADD COLUMN new_col TEXT;\n")
    const r = runScript(root)
    expect(r.code).toBe(0)
  })

  it("fails when .baseline JSON cannot be parsed", () => {
    writeFileSync(baselinePath, "not-json")
    const r = runScript(root)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("failed to parse")
  })

  // I-OPS-1 — pre-launch mode (living baseline). A deliberately MISMATCHED hash
  // is used so a pass can only come from the short-circuit, not from the file
  // coincidentally matching.
  it("pre-launch via .baseline prelaunch:true skips the lock even on hash mismatch", () => {
    writeFileSync(
      baselinePath,
      JSON.stringify({
        tag: "v0.1.0",
        prelaunch: true,
        protected: [
          {
            path: "apps/api/src/db/migrations/0000_initial.sql",
            sha256: "wronghash".padEnd(64, "0"),
          },
        ],
      }),
    )
    const r = runScript(root)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("pre-launch mode active")
    expect(r.stderr).not.toContain("hash mismatch")
  })

  it("pre-launch via LIAISON_PRELAUNCH=1 env skips the lock even on hash mismatch", () => {
    writeFileSync(
      baselinePath,
      JSON.stringify({
        tag: "v0.1.0",
        protected: [
          {
            path: "apps/api/src/db/migrations/0000_initial.sql",
            sha256: "wronghash".padEnd(64, "0"),
          },
        ],
      }),
    )
    const r = runScript(root, { LIAISON_PRELAUNCH: "1" })
    expect(r.code).toBe(0)
    expect(r.stdout).toContain("pre-launch mode active")
  })

  it("re-arms post-launch: prelaunch:false enforces the hash lock again", () => {
    writeFileSync(
      baselinePath,
      JSON.stringify({
        tag: "v0.1.0",
        prelaunch: false,
        protected: [
          {
            path: "apps/api/src/db/migrations/0000_initial.sql",
            sha256: "wronghash".padEnd(64, "0"),
          },
        ],
      }),
    )
    const r = runScript(root)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("hash mismatch")
  })
})
