// SPDX-License-Identifier: FSL-1.1-ALv2
// Validation Gate 8 — production env-gate deployment-shape sanity check
// (plan: docs/sdk-gaps Validation Protocol, security-review 2026-05-23 Vuln 3).
//
// Two layers of defense are at play in production:
//   (A) app.ts:519 host guard — `CHAOS_DEBUG=1` + `NODE_ENV=production` →
//       API process refuses to start (`CHAOS_DEBUG requires explicit local
//       chaos mode`). This means in prod the chaos-injector route never
//       mounts AND the sandboxed chaos-debug app's loader can never even
//       see the per-app flag.
//   (B) discover-apps gate — `NODE_ENV ∉ {test, development}` → chaos-debug
//       is filtered out of `discoverInTreeApps()` regardless of the per-app
//       `CHAOS_DEBUG=1` flag.
//
// The unit-level `discover-apps.test.ts` "default-deny (security)" block is
// the daily guard for (B) using mocked fixture dirs (15 production-like
// NODE_ENV variants). This file is the deployment-shape complement: boot a
// real process under the production env and exercise *both* defenses.
//
// Why we boot strict NODE_ENV=production (rather than just any non-test
// NODE_ENV): the strict env zod schema only accepts
// {"development","production","test"}, so "staging" doesn't even parse. The
// production env-validators (lib/env.ts: EXPOSE_REFRESH_TOKEN_IN_BODY,
// EXPOSE_ERROR_DETAIL, BYOK_ENCRYPTION_KEY, BASE_URL≠localhost:3000,
// ALLOWED_ORIGINS≠*) are satisfied via explicit serverEnv overrides.
import { describe, expect, it } from "bun:test"

// Common production-env overrides — every production env-validator in
// lib/env.ts and app.ts must pass.
const PROD_ENV_BASE = {
  NODE_ENV: "production",
  // Boolean env keys parse strictly (lib/env-boolean.ts); empty string is false.
  EXPOSE_REFRESH_TOKEN_IN_BODY: "",
  EXPOSE_ERROR_DETAIL: "",
  // worker-env sets ALLOWED_ORIGINS=* for test ergonomics; app.ts's
  // production guard refuses to start with that. Pin to localhost.
  ALLOWED_ORIGINS: "http://localhost",
} as const

describe("Gate 8 — production env-gate (deployment shape)", () => {
  describe("Defense (B): discover-apps gate filters chaos-debug under NODE_ENV=production", () => {
    // A separate process with the deployment's NODE_ENV, walking the REAL app
    // roots of this checkout (not fixtures). The e2e server entrypoint refuses
    // NODE_ENV=production by design, so the gate is observed on the discovery
    // module itself, with CHAOS_DEBUG=1 set to show the per-app flag cannot
    // re-enable a test-only app outside a test environment.
    it("chaos-debug and the other test-only apps are NOT discovered under NODE_ENV=production", async () => {
      const script =
        'const { discoverInTreeApps } = await import("./src/modules/apps/discover-apps.ts");' +
        "console.log(JSON.stringify((await discoverInTreeApps()).map((a) => a.name)))"
      const proc = Bun.spawn(["bun", "-e", script], {
        cwd: process.cwd(),
        env: { ...process.env, ...PROD_ENV_BASE, CHAOS_DEBUG: "1", CHAOS_LOCAL_ONLY: "1" },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      expect(code, stderr).toBe(0)
      const names = JSON.parse(stdout.trim().split("\n").at(-1) ?? "[]") as string[]
      // Sanity: the production in-tree apps are still there, so an empty list
      // means the probe is broken, not that the gate works.
      expect(names).toContain("mail")
      for (const testOnly of ["chaos-debug", "test", "test-bridge-a", "test-bridge-b", "example"]) {
        expect(names).not.toContain(testOnly)
      }
    }, 30_000)
  })

  describe("Defense (A): app.ts host-mount guard refuses CHAOS_DEBUG=1 in production", () => {
    it("the API process exits at boot when CHAOS_DEBUG=1 + NODE_ENV=production", async () => {
      // Direct Bun.spawn (NOT setupScenario) — we want to observe the API
      // process FAILING to start, not have setupScenario throw at us.
      const env = {
        ...process.env,
        ...PROD_ENV_BASE,
        // Minimum env to even attempt boot; we fail before reaching DB/Redis.
        PORT: "0",
        DATABASE_URL: "postgres://postgres:postgres@localhost:5432/liaison_test",
        REDIS_URL: "redis://localhost:6379",
        // Real-looking key material: production refuses placeholder or repeating secrets.
        JWT_SECRET: "k3Jx9fQ2mZpL8vNcR5tYwB7hD1sGaE4uQ8rT2nV6",
        ENCRYPTION_KEY: "9f2c7a1be84d03659cfa12d7e6b0384a51c9d2e7f0a6b83c4d15e9f2a7c0b6d3",
        BYOK_ENCRYPTION_KEY: "4be1d07c93a6f2851e7d0c3b9a64f5e28d1c7b0a3f96e4d52c8b1a07e3d9f6c4",
        BASE_URL: "https://prod-gate-test.example.com",
        // The e2e harness enables the local Gmail push mock; with a public
        // BASE_URL its own boot guard would refuse first.
        ALLOW_INSECURE_PUSH: "false",
        // Production env validator requires MEILISEARCH_API_KEY when
        // MEILISEARCH_HOST is set (and it has a localhost default). Provide a
        // value so we get past env validation and reach the CHAOS_DEBUG host
        // guard — which is what this gate is actually testing.
        MEILISEARCH_API_KEY: "prod-gate-e2e-meili-key",
        CHAOS_DEBUG: "1",
        CHAOS_LOCAL_ONLY: "1",
        CHAOS_DEBUG_TOKEN: "prod-gate-e2e-token",
      } as Record<string, string>

      const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
        cwd: process.cwd(),
        env,
        stdout: "pipe",
        stderr: "pipe",
      })

      // Either the process exits (preferred) or it hangs (regression — guard
      // is broken). Race with a deadline to detect both.
      const exited = await Promise.race([
        proc.exited,
        new Promise<number>((resolve) => setTimeout(() => resolve(-1), 8000)),
      ])
      const stderr = await new Response(proc.stderr).text().catch(() => "")
      if (exited === -1) {
        proc.kill("SIGKILL")
        throw new Error(
          `regression: API process did NOT exit under NODE_ENV=production+CHAOS_DEBUG=1 within 8s.\n` +
            `stderr: ${stderr.slice(0, 800)}`,
        )
      }
      expect(exited).not.toBe(0)
      expect(stderr).toContain("CHAOS_DEBUG requires explicit local chaos mode")
    }, 30_000)
  })
})
