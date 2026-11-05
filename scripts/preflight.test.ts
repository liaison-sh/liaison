// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { CACHE_FILE, PreflightError, runPreflight } from "./preflight"

// These cover the deterministic paths (escape hatch + env gate). The escape
// hatch and the env gate both short-circuit BEFORE any service I/O, so they run
// without depending on a live substrate. A future-dated `now` bypasses the
// success cache so the env gate is actually exercised.
const FAR_FUTURE = 10_000_000_000_000

describe("preflight", () => {
  const saved = { ...process.env }
  afterEach(() => {
    // Restore the full env after each case (we mutate process.env below).
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  it("SKIP_PREFLIGHT=1 short-circuits to a no-op", async () => {
    process.env.SKIP_PREFLIGHT = "1"
    await expect(runPreflight()).resolves.toBe("skipped")
  })

  it("throws PreflightError naming every missing required env var (before any I/O)", async () => {
    delete process.env.SKIP_PREFLIGHT
    delete process.env.JWT_SECRET
    delete process.env.ENCRYPTION_KEY
    // Future `now` guarantees a cache miss so the env gate runs.
    const err = await runPreflight({ now: FAR_FUTURE, quiet: true }).catch((e) => e)
    expect(err).toBeInstanceOf(PreflightError)
    expect((err as PreflightError).message).toContain("JWT_SECRET")
    expect((err as PreflightError).message).toContain("ENCRYPTION_KEY")
  })

  it("passes against the live substrate and returns a stable fingerprint", async () => {
    delete process.env.SKIP_PREFLIGHT
    // Requires the test substrate up (PG/Redis migrated) — same as every other
    // test in this suite. Returns a 64-hex fingerprint on success.
    const fp = await runPreflight({ now: FAR_FUTURE, quiet: true })
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
  })

  it("a cached success does not excuse a missing required env var", async () => {
    delete process.env.SKIP_PREFLIGHT
    // Live substrate, as above: a success at FAR_FUTURE is cached at FAR_FUTURE.
    await runPreflight({ now: FAR_FUTURE, quiet: true })
    delete process.env.JWT_SECRET
    const err = await runPreflight({ now: FAR_FUTURE, quiet: true }).catch((e) => e)
    expect(err).toBeInstanceOf(PreflightError)
    expect((err as PreflightError).message).toContain("JWT_SECRET")
  })

  it("a future-dated cache entry is not fresh: a run at the real time probes again", async () => {
    delete process.env.SKIP_PREFLIGHT
    await runPreflight({ now: FAR_FUTURE, quiet: true })
    const before = Date.now()
    await runPreflight({ quiet: true })
    const cached = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as { ts: number }
    expect(cached.ts).toBeGreaterThanOrEqual(before)
    expect(cached.ts).toBeLessThan(FAR_FUTURE)
  })
})
