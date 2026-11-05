// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell reads the turn line by line, so a sidecar that buffered its whole
// answer and flushed at the end would look identical in a captured transcript
// and completely broken in the product. These assertions are about the framing
// AND about when each line leaves the process.
import { describe, expect, it } from "bun:test"
import { parseArgs, runMain } from "./index"

function gate() {
  let release!: () => void
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { opened, release }
}

describe("stdout streaming", () => {
  it("emits one JSON line per message before the final done line", async () => {
    const written: string[] = []
    await runMain({
      config: parseArgs(["--mcp-config", "c.json", "--model", "haiku"]),
      write: (line) => written.push(line),
      runner: () =>
        (async function* () {
          yield { type: "system", subtype: "init" }
          yield { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }
          yield { type: "result", subtype: "success" }
        })(),
    })

    const lines = written.join("").split("\n").filter(Boolean)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    const events = lines.map((line) => JSON.parse(line) as { type: string })
    expect(events.filter((event) => event.type === "message")).toHaveLength(3)
    expect(events.at(-1)).toEqual({ type: "done" })
  })

  it("writes each line before the next message is produced", async () => {
    const written: string[] = []
    const first = gate()
    const second = gate()
    const runnerDone = runMain({
      config: parseArgs(["--mcp-config", "c.json", "--model", "haiku"]),
      write: (line) => written.push(line),
      runner: () =>
        (async function* () {
          yield { type: "one" }
          await first.opened
          yield { type: "two" }
          await second.opened
        })(),
    })

    // The first message has been yielded; its line must already be out before
    // the runner is allowed to produce the second one.
    await Bun.sleep(5)
    expect(written.filter((line) => line.includes('"message"'))).toHaveLength(1)
    first.release()
    await Bun.sleep(5)
    expect(written.filter((line) => line.includes('"message"'))).toHaveLength(2)
    second.release()
    await runnerDone
  })

  it("reports a turn that throws as an error line and exits non zero", async () => {
    const written: string[] = []
    const code = await runMain({
      config: parseArgs(["--mcp-config", "c.json", "--model", "haiku"]),
      write: (line) => written.push(line),
      runner: () =>
        (async function* () {
          yield { type: "system" }
          throw new Error("upstream refused the turn")
        })(),
    })

    const events = written
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    const error = events.find((event) => event.type === "error")
    expect(error.message).toContain("upstream refused the turn")
    expect(events.at(-1)).toEqual({ type: "done" })
    expect(code).toBe(1)
  })
})
