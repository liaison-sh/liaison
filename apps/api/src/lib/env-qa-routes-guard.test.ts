// SPDX-License-Identifier: FSL-1.1-ALv2
//
// LIAISON_QA_ROUTES mounts /api/qa/notifications, which raises notifications
// for any member of the caller's org. env.ts refuses to boot a production
// server that has it on unless it is the demo instance (LIAISON_DEMO_MODE).
// The guard is a module-level process.exit, so each case loads env.ts in a
// fresh `bun` process with a clean, production-shaped environment and reads
// the exit code. Route presence once booted is covered by test-send.test.ts.
import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"

const API_DIR = resolve(import.meta.dir, "../..")

const PRODUCTION_BASE: Record<string, string> = {
  NODE_ENV: "production",
  // Real-looking key material: production refuses placeholder or repeating secrets.
  JWT_SECRET: "k3Jx9fQ2mZpL8vNcR5tYwB7hD1sGaE4uQ8rT2nV6",
  ENCRYPTION_KEY: "9f2c7a1be84d03659cfa12d7e6b0384a51c9d2e7f0a6b83c4d15e9f2a7c0b6d3",
  BYOK_ENCRYPTION_KEY: "4be1d07c93a6f2851e7d0c3b9a64f5e28d1c7b0a3f96e4d52c8b1a07e3d9f6c4",
  MONITOR_TOKEN: "monitor-token",
  BASE_URL: "https://liaison.example.com",
  MEILISEARCH_API_KEY: "meili-key",
}

function bootEnv(extra: Record<string, string>): { code: number; stderr: string } {
  const proc = Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", "-e", 'await import("~/lib/env")'],
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      ...PRODUCTION_BASE,
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode ?? -1, stderr: proc.stderr.toString() }
}

describe("LIAISON_QA_ROUTES production guard", () => {
  it("boots a plain production server (the baseline the other cases vary)", () => {
    const r = bootEnv({})
    expect(r.stderr).toBe("")
    expect(r.code).toBe(0)
  })

  it("refuses to boot production with the QA routes on and demo mode off", () => {
    const r = bootEnv({ LIAISON_QA_ROUTES: "true" })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("FATAL: LIAISON_QA_ROUTES is for the demo instance only")
  })

  it("boots the demo instance with the QA routes on", () => {
    const r = bootEnv({ LIAISON_QA_ROUTES: "true", LIAISON_DEMO_MODE: "true" })
    expect(r.stderr).not.toContain("LIAISON_QA_ROUTES")
    expect(r.code).toBe(0)
  })
})
