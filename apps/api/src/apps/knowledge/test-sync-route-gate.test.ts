// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `POST /api/knowledge/synced-sources/:id/_test_sync_now` runs a synced-source
// reconcile inline and exists for e2e tests only. It must follow the same gate
// as every other test-only route (`qaSeedRoutesEnabled`: NODE_ENV=test, or
// ENABLE_QA_SEED_ROUTES, which env.ts refuses in production). The route file
// decides at import time, so each case imports it in a fresh process with a
// controlled environment and lists the registered paths.
import { describe, expect, it } from "bun:test"

const API_DIR = new URL("../../..", import.meta.url).pathname

// Production refuses placeholder and repeated-pattern secrets, so the probe
// carries random ones.
const randomHex = () => crypto.getRandomValues(new Uint8Array(32)).toHex()

const BASE_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  JWT_SECRET: randomHex(),
  ENCRYPTION_KEY: randomHex(),
  BYOK_ENCRYPTION_KEY: randomHex(),
  MONITOR_TOKEN: "gate-test-monitor-token",
  MEILISEARCH_API_KEY: "gate-test-meili-key",
  BASE_URL: "https://liaison.example",
  ALLOWED_ORIGINS: "https://liaison.example",
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://localhost:5432/liaison",
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
}

const PROBE = `
const { knowledgeRoutes } = await import("~/apps/knowledge/routes")
const paths = knowledgeRoutes.routes.map((r) => r.path)
console.log("ROUTES=" + JSON.stringify(paths.filter((p) => p.includes("_test_sync_now"))))
process.exit(0)
`

async function exposesTestSyncRoute(extra: Record<string, string>): Promise<boolean> {
  const proc = Bun.spawn(["bun", "--eval", PROBE], {
    cwd: API_DIR,
    env: { ...BASE_ENV, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const line = stdout.split("\n").find((l) => l.startsWith("ROUTES="))
  if (code !== 0 || !line) throw new Error(`probe failed (exit ${code}):\n${stdout}\n${stderr}`)
  return (JSON.parse(line.slice("ROUTES=".length)) as string[]).length > 0
}

describe("knowledge _test_sync_now route gate", () => {
  it("a production-mode app does not expose it", async () => {
    expect(await exposesTestSyncRoute({ NODE_ENV: "production" })).toBe(false)
  }, 60_000)

  it("a development-mode app without ENABLE_QA_SEED_ROUTES does not expose it", async () => {
    expect(await exposesTestSyncRoute({ NODE_ENV: "development" })).toBe(false)
  }, 60_000)

  it("NODE_ENV=test exposes it (the e2e harness)", async () => {
    expect(await exposesTestSyncRoute({ NODE_ENV: "test" })).toBe(true)
  }, 60_000)

  it("ENABLE_QA_SEED_ROUTES exposes it outside test (bun run dev and the qa harness)", async () => {
    expect(
      await exposesTestSyncRoute({ NODE_ENV: "development", ENABLE_QA_SEED_ROUTES: "true" }),
    ).toBe(true)
  }, 60_000)
})
