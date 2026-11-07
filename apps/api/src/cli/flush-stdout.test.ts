// SPDX-License-Identifier: FSL-1.1-ALv2
// The CLI's exit must not drop buffered stdout: an org transfer bundle piped to a slower consumer
// arrived cut short (at 64 KiB in a reduced repro) when the process exited right after writing.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const INDEX = join(import.meta.dir, "index.ts")

async function bytesReadSlowly(script: string): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "flush-stdout-"))
  try {
    const file = join(dir, "w.ts")
    writeFileSync(file, script)
    const child = Bun.spawn(["bun", file], { stdout: "pipe", stderr: "ignore" })
    await Bun.sleep(1500) // the consumer is late: the writer has long called exit
    const n = (await new Response(child.stdout).arrayBuffer()).byteLength
    await child.exited
    return n
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("flushStdout", () => {
  it("keeps every byte written before exit through a slow pipe", async () => {
    const n = await bytesReadSlowly(
      `import { flushStdout } from ${JSON.stringify(INDEX)}
const line = "x".repeat(999) + "\\n"
for (let i = 0; i < 5000; i++) process.stdout.write(line)
await flushStdout()
process.exit(0)
`,
    )
    expect(n).toBe(5_000_000)
  }, 30_000)

  it("gives up past its timeout when the reader stops reading", async () => {
    const { flushStdout } = await import("./index")
    const stalled = { end: (_cb: () => void) => {}, once: () => {} }
    const t0 = Date.now()
    expect(await flushStdout(stalled as never, 50)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it("resolves true once the stream drained", async () => {
    const { flushStdout } = await import("./index")
    const drained = { end: (cb: () => void) => setTimeout(cb, 5), once: () => {} }
    expect(await flushStdout(drained as never, 1_000)).toBe(true)
  })
})
