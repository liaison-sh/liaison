// SPDX-License-Identifier: FSL-1.1-ALv2
// The sandbox worker attaches its own RSS to every result so the pool can
// recycle it. That read is a report: when it fails, the handler's outcome must
// still reach the pool unchanged. Spawns the real worker script with a preload
// that makes the RSS read throw.
import { describe, expect, it } from "bun:test"
import { join } from "node:path"

const WORKER = join(import.meta.dir, "sandbox-worker.ts")
const PRELOAD = join(import.meta.dir, "__fixtures__", "rss-read-throws.ts")

async function waitFor<T>(find: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = find()
    if (hit !== undefined) return hit
    await Bun.sleep(10)
  }
  throw new Error(`timed out after ${timeoutMs} ms`)
}

describe("sandbox worker: own RSS report", () => {
  it("the preload really makes the RSS read throw", async () => {
    const probe = Bun.spawn(
      [
        "bun",
        "--preload",
        PRELOAD,
        "-e",
        "try { process.memoryUsage.rss(); console.log('READ') } catch (e) { console.log('THREW ' + e.message) }",
      ],
      { stdout: "pipe" },
    )
    expect((await new Response(probe.stdout).text()).trim()).toBe(
      "THREW Failed to get memory usage",
    )
  })

  it("a successful execution still delivers its result when the worker cannot read its own RSS", async () => {
    const messages: any[] = []
    const proc = Bun.spawn(["bun", `--preload=${PRELOAD}`, WORKER], {
      ipc(message) {
        messages.push(message)
      },
      // The worker exits on EOF of its stdin (the pool's death pipe): keep it open.
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    })
    try {
      await waitFor(() => messages.find((m) => m.type === "ready"), 15_000)
      proc.send({
        type: "execute",
        id: "1",
        bundleSource: "function ok(p) { return { v: p.v + 1 } }",
        exportName: "ok",
        params: { v: 41 },
        bridgeMethods: [],
        timeoutMs: 10_000,
        memoryLimitBytes: 32 * 1024 * 1024,
      })
      const reply = await waitFor(
        () => messages.find((m) => m.id === "1" && (m.type === "result" || m.type === "error")),
        15_000,
      )
      expect({ type: reply.type, data: reply.data, error: reply.error }).toEqual({
        type: "result",
        data: { v: 42 },
        error: undefined,
      })
      expect(reply.rssBytes).toBeUndefined()
    } finally {
      proc.kill()
      await proc.exited
    }
  }, 40_000)
})
