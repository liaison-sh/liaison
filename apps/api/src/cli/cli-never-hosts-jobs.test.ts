// SPDX-License-Identifier: FSL-1.1-ALv2
// Design audit 2026-09-30, finding 14: the `liaison` CLI's import graph
// reaches spawn-agent, whose module-scope registration created an autorun
// `app-kernel` Worker in the CLI process: a CLI run inside the production
// container could take the server's kernel jobs and fail them "No handler
// registered", burning their retries (34 such `attention-*` failures sat in
// the failed set). Job hosting is now opt-in, and a CLI process can never opt
// in. Both halves are pinned: the real CLI prelude plus that module owns no
// worker, and only the server and harness entrypoints ever declare a host.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

const API = path.resolve(import.meta.dir, "../..")

describe("the liaison CLI is never a job host", () => {
  it("importing the CLI prelude and spawn-agent creates no BullMQ worker, and hosting refuses", async () => {
    const script = `
      import "~/cli/cli-env"
      import "~/modules/agent/subruns/spawn-agent"
      const jobs = await import("~/infra/jobs/jobs")
      let refused = false
      try { jobs.hostJobWorkers() } catch { refused = true }
      console.log(JSON.stringify({
        registered: jobs.isJobWorkerRegistered("kernel", "agent-subrun"),
        workers: jobs.jobWorkerCount(),
        refused,
      }))
      await jobs.closeAllQueues()
      process.exit(0)
    `
    const proc = Bun.spawn(["bun", "-e", script], {
      cwd: API,
      // The test runner's own env says "host jobs" (LIAISON_TEST_JOB_HOST):
      // the CLI marker must win over it.
      env: { ...process.env, LOG_LEVEL: "fatal" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    const line = out.trim().split("\n").at(-1) ?? "{}"
    expect(JSON.parse(line)).toEqual({ registered: true, workers: 0, refused: true })
  }, 60_000)

  it("only the server and the test harness entrypoints declare a job host", () => {
    const callers: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name)
        if (name === "node_modules") continue
        if (statSync(full).isDirectory()) walk(full)
        else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
          if (/\bhostJobWorkers\(\)/.test(readFileSync(full, "utf8"))) {
            callers.push(path.relative(API, full))
          }
        }
      }
    }
    walk(path.join(API, "src"))
    walk(path.join(API, "test-support"))
    expect(callers.sort()).toEqual(
      ["src/index.ts", "src/infra/jobs/jobs.ts", "test-support/index.e2e.ts"].sort(),
    )
  })
})
