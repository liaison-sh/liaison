// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The load-test runner's scenario enumeration is the only place a k6 script
// becomes runnable and reportable; a scenario file that is never listed there
// silently never runs. This pins the channel agent fan-out scenario into it.
import { describe, expect, it } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadSeedCommand, parseLoadSeedResult } from "./lib/load-seed"

const ROOT = join(import.meta.dir, "..")
const RUNNER = readFileSync(join(ROOT, "scripts/load-test.ts"), "utf8")

describe("load-test runner enumeration", () => {
  it("includes the channel agent fan-out scenario", () => {
    expect(RUNNER).toContain("a8-channel-agent-fanout")
    expect(existsSync(join(ROOT, "qa/load/a8-channel-agent-fanout.js"))).toBe(true)
  })

  it("keeps the existing scenarios in order ahead of it", () => {
    const ids = Array.from(RUNNER.matchAll(/\{ id: "(a\d)", file: "([\w-]+\.js)" \}/g)).map(
      (m) => m[1],
    )
    expect(ids).toEqual(["a2", "a3", "a4", "a5", "a6", "a7", "a8"])
  })
})

describe("the release load-test overlay boots", () => {
  // apps/api/src/lib/env.ts refuses to start a NODE_ENV=production process with
  // ENABLE_LOAD_TEST_ENDPOINT on, and the release image runs production: the
  // overlay must not set it, or the measured stack never comes up.
  it("does not set ENABLE_LOAD_TEST_ENDPOINT on a production app", () => {
    type Svc = { environment?: Record<string, unknown> }
    const read = (f: string) =>
      Bun.YAML.parse(readFileSync(join(ROOT, f), "utf8")) as { services: Record<string, Svc> }
    const base = read("deploy/docker-compose.yml").services
    const overlay = read("deploy/docker-compose.loadtest.yml").services
    for (const [name, svc] of Object.entries(overlay)) {
      const env = { ...(base[name]?.environment ?? {}), ...(svc.environment ?? {}) }
      if (env.NODE_ENV === "production") {
        expect(env.ENABLE_LOAD_TEST_ENDPOINT, name).toBeUndefined()
      }
    }
  })

  it("skips the scenario that needs the load-test route on the release target", () => {
    expect(RUNNER).toMatch(/LOCAL_ONLY[^=]*=\s*\{\s*a2:/)
  })
})

describe("the load-test workload seed", () => {
  // scripts/seed-load.ts is gone: the workload is the seed CLI's load tier.
  it("runs `liaison seed --tier load --volume` in the release stack's app container", () => {
    const cmd = loadSeedCommand("release", "deploy/.env")
    expect(cmd.slice(0, 3)).toEqual(["docker", "compose", "--env-file"])
    const app = cmd.indexOf("app")
    expect(cmd.slice(cmd.indexOf("exec"), app)).toEqual([
      "exec",
      "-T",
      "-e",
      "LOAD_PASSWORD",
      "-w",
      "/app/apps/api",
    ])
    expect(cmd.slice(app + 1, app + 8)).toEqual([
      "bun",
      "run",
      "src/cli/index.ts",
      "seed",
      "--tier",
      "load",
      "--orgs",
    ])
    expect(cmd).toContain("--volume")
    expect(cmd[cmd.indexOf("--passwords-env") + 1]).toBe("LOAD_PASSWORD")
  })

  it("runs the same CLI directly for the local target", () => {
    expect(loadSeedCommand("local", "x").slice(0, 4)).toEqual([
      "bun",
      "run",
      "src/cli/index.ts",
      "seed",
    ])
  })

  it("reads the org the seed reports, and refuses output without a result line", () => {
    const out = [
      "[load-seed] loadtest-0: world: org ready",
      '[load-seed] result {"orgs":[{"slug":"loadtest-0","adminEmail":"elodie@x.example","orgId":"o"}],"failures":[],"seconds":3}',
    ].join("\n")
    expect(parseLoadSeedResult(out)).toEqual([
      { slug: "loadtest-0", adminEmail: "elodie@x.example", orgId: "o" } as never,
    ])
    expect(() => parseLoadSeedResult("[load-seed] FAILED")).toThrow()
  })

  it("no longer references the deleted seed-load script", () => {
    expect(RUNNER).not.toContain("seed-load.ts")
    expect(existsSync(join(ROOT, "scripts/seed-load.ts"))).toBe(false)
  })
})
