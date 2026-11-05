// SPDX-License-Identifier: FSL-1.1-ALv2
// A production process refuses to boot with any debug, QA, load-test or
// insecure-fallback flag on. lib/env.ts enforces this with process.exit at
// module load, so each case loads it in a child process with a production
// environment that is otherwise valid, and reads the exit code. The control
// case (no flag) must boot, or every refusal below would be vacuous.
import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { join } from "node:path"

const API_DIR = join(import.meta.dir, "..", "..")

function productionEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "production",
    JWT_SECRET: randomBytes(32).toString("hex"),
    ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    BYOK_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    MONITOR_TOKEN: randomBytes(24).toString("hex"),
    BASE_URL: "https://liaison.example.com",
    DATABASE_URL: "postgres://u:p@127.0.0.1:1/none",
    REDIS_URL: "redis://127.0.0.1:1",
    MEILISEARCH_API_KEY: randomBytes(16).toString("hex"),
  }
  return { ...base, ...extra }
}

function bootEnvModule(extra: Record<string, string>): { code: number; stderr: string } {
  const res = Bun.spawnSync(["bun", "-e", "await import('./src/lib/env.ts'); process.exit(0)"], {
    cwd: API_DIR,
    env: productionEnv(extra),
    stderr: "pipe",
    stdout: "pipe",
  })
  return { code: res.exitCode ?? -1, stderr: res.stderr.toString() }
}

const REFUSED: Record<string, Record<string, string>> = {
  EXPOSE_REFRESH_TOKEN_IN_BODY: { EXPOSE_REFRESH_TOKEN_IN_BODY: "true" },
  EXPOSE_ERROR_DETAIL: { EXPOSE_ERROR_DETAIL: "true" },
  ENABLE_LOAD_TEST_ENDPOINT: { ENABLE_LOAD_TEST_ENDPOINT: "true" },
  ENABLE_QA_SEED_ROUTES: { ENABLE_QA_SEED_ROUTES: "true" },
  "LIAISON_QA_ROUTES without demo mode": { LIAISON_QA_ROUTES: "true" },
  "ALLOW_INSECURE_PUSH on a public BASE_URL": { ALLOW_INSECURE_PUSH: "true" },
  LIAISON_TEST_FANOUT_EVERY_MS: { LIAISON_TEST_FANOUT_EVERY_MS: "5000" },
  LIAISON_TEST_FANOUT_EXIT_AFTER_ADD: { LIAISON_TEST_FANOUT_EXIT_AFTER_ADD: "true" },
  LIAISON_TEST_FANOUT_ID_MODE: { LIAISON_TEST_FANOUT_ID_MODE: "deduplication" },
  "the shipped placeholder JWT_SECRET": { JWT_SECRET: "replace-with-at-least-32-char-secret" },
}

describe("production refuses to boot with a debug or QA flag", () => {
  it("boots with a valid production environment and no flag (control)", () => {
    const r = bootEnvModule({})
    expect(r.stderr).not.toContain("FATAL")
    expect(r.code).toBe(0)
  }, 30_000)

  for (const [name, extra] of Object.entries(REFUSED)) {
    it(`refuses ${name}`, () => {
      expect(bootEnvModule(extra).code).not.toBe(0)
    }, 30_000)
  }
})

// The load harness (lib/load-harness.ts) is the production-safe posture: its
// key boots a production demo box, and nothing else in production. It never shares a box with
// ENABLE_LOAD_TEST_ENDPOINT, in any environment.
describe("the load harness key", () => {
  const key = { LOAD_HARNESS_KEY: randomBytes(32).toString("hex") }

  it("boots in production on a demo box", () => {
    const r = bootEnvModule({ ...key, LIAISON_DEMO_MODE: "true" })
    expect(r.stderr).not.toContain("FATAL")
    expect(r.code).toBe(0)
  }, 30_000)

  // The demo egress lockdown is what keeps a load org's app traffic on the box.
  it("is refused in production without demo mode", () => {
    const r = bootEnvModule(key)
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain("LOAD_HARNESS_KEY is for a demo box only")
  }, 30_000)

  it("refuses a key shorter than 32 characters", () => {
    expect(bootEnvModule({ LOAD_HARNESS_KEY: "short" }).code).not.toBe(0)
  }, 30_000)

  it("is refused together with ENABLE_LOAD_TEST_ENDPOINT outside production too", () => {
    const testEnv = { NODE_ENV: "test", ENABLE_LOAD_TEST_ENDPOINT: "true" }
    const control = bootEnvModule(testEnv)
    expect(control.stderr).not.toContain("FATAL")
    expect(control.code).toBe(0)
    const both = bootEnvModule({ ...testEnv, ...key })
    expect(both.code).not.toBe(0)
    expect(both.stderr).toContain("mutually exclusive")
  }, 30_000)
})
