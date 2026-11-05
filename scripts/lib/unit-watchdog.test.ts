// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  QUIET_BUN_VARS,
  silenceLimitMs,
  tailLines,
  watchSilence,
  withoutQuietBunVars,
} from "./unit-watchdog"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("silenceLimitMs", () => {
  it("is five per-test timeouts", () => {
    expect(silenceLimitMs(60_000)).toBe(300_000)
  })

  it("takes an override, and ignores one that is not a positive number", () => {
    expect(silenceLimitMs(60_000, "90000")).toBe(90_000)
    expect(silenceLimitMs(60_000, "soon")).toBe(300_000)
    expect(silenceLimitMs(60_000, "0")).toBe(300_000)
  })
})

describe("watchSilence", () => {
  it("fires once, after the limit, when nothing arrives", async () => {
    const fired: number[] = []
    const watch = watchSilence(40, (ms) => fired.push(ms), 10)
    await wait(120)
    watch.stop()
    expect(fired).toHaveLength(1)
    expect(fired[0]).toBeGreaterThanOrEqual(40)
  })

  it("stays quiet while output keeps arriving", async () => {
    const fired: number[] = []
    const watch = watchSilence(60, (ms) => fired.push(ms), 10)
    for (let i = 0; i < 6; i++) {
      await wait(20)
      watch.touch()
    }
    watch.stop()
    expect(fired).toEqual([])
  })

  it("never fires after stop", async () => {
    const fired: number[] = []
    const watch = watchSilence(20, (ms) => fired.push(ms), 5)
    watch.stop()
    await wait(60)
    expect(fired).toEqual([])
  })
})

describe("tailLines", () => {
  it("keeps the last non-empty lines", () => {
    expect(tailLines("a\n\nb\nc\n", 2)).toBe("b\nc")
  })
})

describe("a watched bun process", () => {
  const agentEnv = (): Record<string, string> => ({
    ...(process.env as Record<string, string>),
    ...Object.fromEntries(QUIET_BUN_VARS.map((name) => [name, "1"])),
  })

  it("drops the variables that quiet bun, and only those", () => {
    const env = withoutQuietBunVars({ CLAUDECODE: "1", AGENT: "1", REPL_ID: "x", KEEP: "yes" })
    expect(env).toEqual({ KEEP: "yes" })
  })

  it("shows progress while it runs, started from an agent's environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "unit-watchdog-"))
    try {
      writeFileSync(
        join(dir, "fast.test.ts"),
        'import { it } from "bun:test"\nit("fast", () => {})\n',
      )
      // The second file is still running when the first file's result is due.
      writeFileSync(
        join(dir, "slow.test.ts"),
        'import { it } from "bun:test"\nit("slow", async () => { await Bun.sleep(3000) })\n',
      )
      const err = join(dir, "err")
      const proc = Bun.spawn({
        cmd: ["bun", "test", "./fast.test.ts", "./slow.test.ts"],
        cwd: dir,
        env: withoutQuietBunVars(agentEnv()),
        stdin: "ignore",
        stdout: "ignore",
        stderr: Bun.file(err),
      })
      let bytesWhileRunning = 0
      const until = Date.now() + 2500
      while (Date.now() < until && bytesWhileRunning === 0) {
        await wait(50)
        bytesWhileRunning = statSync(err, { throwIfNoEntry: false })?.size ?? 0
      }
      expect(proc.exitCode).toBeNull()
      proc.kill("SIGKILL")
      await proc.exited
      expect(bytesWhileRunning).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it("is still killed when it truly wedges", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", "-e", "while (true) {}"],
      env: withoutQuietBunVars(agentEnv()),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    let silentFor = 0
    const watch = watchSilence(
      200,
      (ms) => {
        silentFor = ms
        proc.kill("SIGKILL")
      },
      20,
    )
    const exitCode = await proc.exited
    watch.stop()
    expect(silentFor).toBeGreaterThanOrEqual(200)
    expect(exitCode).not.toBe(0)
  }, 15_000)
})
