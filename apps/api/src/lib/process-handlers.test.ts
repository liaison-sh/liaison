// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"

describe("registerProcessHandlers", () => {
  test("an uncaughtException logs a level-60 Pino line and exits non-zero", async () => {
    const snippet = `
      import { registerProcessHandlers } from "${import.meta.dir}/process-handlers"
      import { rootLogger } from "${import.meta.dir}/logger"
      registerProcessHandlers(rootLogger)
      setTimeout(() => { throw new Error("boom from uncaughtException test") }, 10)
    `
    const proc = Bun.spawn(["bun", "--env-file=../../.env.test", "-e", snippet], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test" },
    })
    const exitCode = await proc.exited
    // Liaison's logger writes to fd 2 (stderr) -- see src/lib/logger.ts's header comment --
    // unlike tessera-platform's default-stdout Pino destination.
    const stderr = await new Response(proc.stderr).text()
    expect(exitCode).not.toBe(0)
    const lines = stderr.split("\n").filter((l) => l.trim().startsWith("{"))
    const fatalLine = lines.find((l) => {
      try {
        const parsed = JSON.parse(l)
        return parsed.level === 60
      } catch {
        return false
      }
    })
    expect(fatalLine).toBeDefined()
    expect(fatalLine).toContain("boom from uncaughtException test")
  })

  test("an unhandledRejection with a non-Error reason still logs and exits non-zero", async () => {
    const snippet = `
      import { registerProcessHandlers } from "${import.meta.dir}/process-handlers"
      import { rootLogger } from "${import.meta.dir}/logger"
      registerProcessHandlers(rootLogger)
      Promise.reject("plain string rejection reason")
    `
    const proc = Bun.spawn(["bun", "--env-file=../../.env.test", "-e", snippet], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test" },
    })
    const exitCode = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("plain string rejection reason")
  })

  test("does not double-register when called twice", async () => {
    const snippet = `
      import { registerProcessHandlers } from "${import.meta.dir}/process-handlers"
      import { rootLogger } from "${import.meta.dir}/logger"
      registerProcessHandlers(rootLogger)
      registerProcessHandlers(rootLogger)
      console.error("listener count: " + process.listenerCount("uncaughtException"))
      process.exit(0)
    `
    const proc = Bun.spawn(["bun", "--env-file=../../.env.test", "-e", snippet], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test" },
    })
    await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain("listener count: 1")
  })

  test("installs no SIGTERM/SIGINT handler (lib/shutdown.ts is the one entry)", async () => {
    const snippet = `
      import { registerProcessHandlers } from "${import.meta.dir}/process-handlers"
      import { rootLogger } from "${import.meta.dir}/logger"
      registerProcessHandlers(rootLogger)
      console.error("signal listeners: " + (process.listenerCount("SIGTERM") + process.listenerCount("SIGINT")))
      process.exit(0)
    `
    const proc = Bun.spawn(["bun", "--env-file=../../.env.test", "-e", snippet], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, NODE_ENV: "test" },
    })
    await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(stderr).toContain("signal listeners: 0")
  })
})
