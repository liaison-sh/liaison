// SPDX-License-Identifier: FSL-1.1-ALv2
//
// worker-core's console capture: the run marker on the real console first,
// console lines and uncaught errors in the answer, the per-run caps, shared
// lines when runs overlap, and the console put back afterwards.

import { afterEach, describe, expect, it } from "bun:test"
import {
  RUN_CONSOLE_LINE_MAX_BYTES,
  RUN_CONSOLE_MAX_BYTES,
  RUN_CONSOLE_MAX_LINES,
  runHandler,
  type WorkerRunRequest,
} from "./worker-core"

const req = (exportName: string, runId = "inst-1:run-1"): WorkerRunRequest => ({
  exportName,
  params: {},
  bridgeMethods: [],
  approval: null,
  runId,
})
const noBridge = async () => null

const original = {
  debug: console.debug,
  log: console.log,
  warn: console.warn,
}
afterEach(() => {
  console.debug = original.debug
  console.log = original.log
  console.warn = original.warn
})

describe("worker-core console capture", () => {
  it("logs the run marker first on the real console, never in the answer", async () => {
    const real: unknown[][] = []
    console.debug = (...a: unknown[]) => {
      real.push(a)
    }
    const out = await runHandler(
      {
        h: async () => {
          console.log("hello", { n: 1 }, 2)
          console.warn("careful")
          console.error(new Error("bad thing"))
          console.debug("dbg")
          return 1
        },
      },
      req("h"),
      noBridge,
    )
    expect(real).toEqual([["__liaison_run inst-1:run-1"]])
    expect(out.ok).toBe(true)
    const logs = out.logs ?? []
    expect(logs.map((l) => [l.level, l.msg.split("\n")[0]])).toEqual([
      ["info", 'hello {"n":1} 2'],
      ["warn", "careful"],
      ["error", "Error: bad thing"],
      ["debug", "dbg"],
    ])
    expect(logs.every((l) => typeof l.at === "number" && !l.shared)).toBe(true)
    expect(out.logsDropped).toBeUndefined()
    // Put back once the run ended.
    console.log("after")
    expect(console.debug).not.toBe(original.debug)
  })

  it("a failing run keeps its lines too", async () => {
    const out = await runHandler(
      {
        h: async () => {
          console.log("before the throw")
          throw new Error("nope")
        },
      },
      req("h"),
      noBridge,
    )
    expect(out.ok).toBe(false)
    expect(out.logs?.map((l) => l.msg)).toEqual(["before the throw"])
  })

  it("caps a run at 200 lines and counts the rest", async () => {
    const out = await runHandler(
      {
        h: async () => {
          for (let i = 0; i < RUN_CONSOLE_MAX_LINES + 25; i++) console.log(`line ${i}`)
        },
      },
      req("h"),
      noBridge,
    )
    expect(out.logs).toHaveLength(RUN_CONSOLE_MAX_LINES)
    expect(out.logsDropped).toBe(25)
  })

  it("caps a run at 64 KiB and cuts a line at 4 KiB", async () => {
    const out = await runHandler(
      {
        h: async () => {
          for (let i = 0; i < 40; i++) console.log("x".repeat(10_000))
        },
      },
      req("h"),
      noBridge,
    )
    const logs = out.logs ?? []
    expect(logs[0]?.msg.length).toBe(RUN_CONSOLE_LINE_MAX_BYTES)
    expect(logs.length).toBe(Math.floor(RUN_CONSOLE_MAX_BYTES / RUN_CONSOLE_LINE_MAX_BYTES))
    expect(out.logsDropped).toBe(40 - logs.length)
  })

  it("lines logged while runs overlap go to each, marked shared", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const mod = {
      first: async () => {
        console.log("alone")
        await gate
        console.log("together")
      },
      second: async () => {
        console.log("from second")
        release()
      },
    }
    const a = runHandler(mod, req("first", "i:a"), noBridge)
    await Bun.sleep(5)
    const b = runHandler(mod, req("second", "i:b"), noBridge)
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.logs?.map((l) => [l.msg, l.shared === true])).toEqual([
      ["alone", false],
      ["from second", true],
      ["together", true],
    ])
    // Every line of the second run was logged while the first was in flight.
    expect(rb.logs?.[0]).toMatchObject({ msg: "from second", shared: true })
    expect(rb.logs?.every((l) => l.shared === true)).toBe(true)
  })

  it("no console call, no logs field", async () => {
    const out = await runHandler({ h: async () => 1 }, req("h"), noBridge)
    expect(Object.hasOwn(out, "logs")).toBe(false)
  })
})
