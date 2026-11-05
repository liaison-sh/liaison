// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sidecar is a SESSION, not a turn: one SDK query fed by a streaming
// prompt, driven by control lines for the life of the process. These drive
// runMain with an injected runner and an injected control iterable, so the
// protocol is pinned without a model, a network or a compiled binary.
import { describe, expect, it } from "bun:test"
import {
  AsyncQueue,
  PERMISSION_MODE_REFUSED,
  PROTOCOL_VERSION,
  parseArgs,
  runMain,
  SESSION_CANNOT_CHANGE_MODE,
  type SessionRunner,
  type SidecarConfig,
  type SidecarUserMessage,
} from "./index"

function config(overrides: Partial<SidecarConfig> = {}): SidecarConfig {
  return {
    mcpConfigPath: "/tmp/mcp.json",
    cwd: "/tmp/work",
    permissionMode: "manual",
    model: "claude-haiku-4-5",
    isolateConfig: false,
    ...overrides,
  }
}

/** A runner that answers every streamed prompt with init, text and a result. */
function echoRunner(seen: SidecarUserMessage[] = [], interrupts: number[] = []): SessionRunner {
  return ({ prompts }) => {
    async function* run() {
      for await (const prompt of prompts) {
        seen.push(prompt)
        yield { type: "system", subtype: "init", session_id: "session-abc" }
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: String(prompt.message.content) }] },
        }
        yield { type: "result", subtype: "success" }
      }
    }
    const iterator = run()
    return {
      [Symbol.asyncIterator]: () => iterator,
      interrupt: async () => {
        interrupts.push(1)
      },
    }
  }
}

/**
 * A runner whose handle records every mid session mode change, so P6d-FX1's
 * `set_permission_mode` line can be pinned against the SDK call it makes.
 */
function modeRunner(modes: string[]): SessionRunner {
  return ({ prompts }) => {
    async function* run() {
      for await (const prompt of prompts) {
        void prompt
        yield { type: "result", subtype: "success" }
      }
    }
    const iterator = run()
    return {
      [Symbol.asyncIterator]: () => iterator,
      setPermissionMode: async (mode: string) => {
        modes.push(mode)
      },
    }
  }
}

function collect(lines: string[]): Array<Record<string, any>> {
  return lines.filter((line) => line.trim()).map((line) => JSON.parse(line))
}

async function* controlLines(lines: string[]): AsyncGenerator<string> {
  for (const line of lines) yield line
}

describe("the sidecar session", () => {
  it("announces protocol version 2 on boot", async () => {
    const written: string[] = []
    await runMain({
      config: config(),
      runner: echoRunner(),
      write: (line) => written.push(line),
      control: controlLines([JSON.stringify({ type: "shutdown" })]),
    })
    expect(PROTOCOL_VERSION).toBe(2)
    expect(collect(written)[0]).toMatchObject({ type: "boot", protocolVersion: 2 })
  })

  it("runs two turns in one process and emits one turn_done per turn", async () => {
    const written: string[] = []
    const seen: SidecarUserMessage[] = []
    await runMain({
      config: config(),
      runner: echoRunner(seen),
      write: (line) => written.push(line),
      control: controlLines([
        JSON.stringify({ type: "turn", prompt: "first" }),
        JSON.stringify({ type: "turn", prompt: "second" }),
        JSON.stringify({ type: "shutdown" }),
      ]),
    })
    const events = collect(written)
    expect(events.filter((event) => event.type === "turn_done")).toHaveLength(2)
    expect(seen.map((message) => message.message.content)).toEqual(["first", "second"])
    // `done` marks the process, not the turn: exactly one, at the very end.
    expect(events.filter((event) => event.type === "done")).toHaveLength(1)
    expect(events[events.length - 1].type).toBe("done")
  })

  // P6d-FX1 (SK-6): the mode was consumed once, at start, so a change made
  // mid session never reached the running query at all.
  it("a set_permission_mode line changes the RUNNING session's mode", async () => {
    const written: string[] = []
    const modes: string[] = []
    await runMain({
      config: config(),
      runner: modeRunner(modes),
      write: (line) => written.push(line),
      control: controlLines([
        JSON.stringify({ type: "set_permission_mode", mode: "bypass" }),
        JSON.stringify({ type: "shutdown" }),
      ]),
    })
    // The SDK's own name for it, never Liaison's.
    expect(modes).toEqual(["bypassPermissions"])
    expect(collect(written)).toContainEqual({ type: "permission_mode", mode: "bypass" })
  })

  // P6d-FX2 (SK-3): a refused mode change is NOT an `error` line. Every reader
  // of this stream takes `error` for the end of the turn, so an `error` here
  // retired the permission cards the SDK was still parked on and posted the
  // partial reply as the agent's finished answer.
  it("a mode the SDK has no name for is a refusal line, never an error or a dead session", async () => {
    const written: string[] = []
    const modes: string[] = []
    await runMain({
      config: config(),
      runner: modeRunner(modes),
      write: (line) => written.push(line),
      control: controlLines([
        JSON.stringify({ type: "set_permission_mode", mode: "yolo" }),
        JSON.stringify({ type: "turn", prompt: "still alive" }),
        JSON.stringify({ type: "shutdown" }),
      ]),
    })
    expect(modes).toEqual([])
    const events = collect(written)
    expect(events.some((event) => event.type === "error")).toBe(false)
    const refused = events.filter((event) => event.type === PERMISSION_MODE_REFUSED)
    expect(refused).toHaveLength(1)
    expect(refused[0].mode).toBe("yolo")
    expect(events.filter((event) => event.type === "turn_done")).toHaveLength(1)
  })

  // P6d-FX2 (SK-4): `SessionHandle.setPermissionMode` is optional on purpose,
  // and the other half of that sentence was never written: nothing said the
  // mode had not applied. The window wrote the preference and read the new
  // mode off a session still running the old one.
  it("a session whose query cannot change mode says so instead of reporting success", async () => {
    const written: string[] = []
    await runMain({
      config: config(),
      // echoRunner's handle carries no setPermissionMode at all.
      runner: echoRunner(),
      write: (line) => written.push(line),
      control: controlLines([
        JSON.stringify({ type: "set_permission_mode", mode: "bypass" }),
        JSON.stringify({ type: "turn", prompt: "still alive" }),
        JSON.stringify({ type: "shutdown" }),
      ]),
    })
    const events = collect(written)
    expect(events.some((event) => event.type === "permission_mode")).toBe(false)
    expect(events).toContainEqual({
      type: PERMISSION_MODE_REFUSED,
      mode: "bypass",
      reason: SESSION_CANNOT_CHANGE_MODE,
    })
    // And the session is still a session: the refusal ends nothing.
    expect(events.filter((event) => event.type === "turn_done")).toHaveLength(1)
  })

  it("emits ready once and the session id as soon as the SDK init reveals it", async () => {
    const written: string[] = []
    await runMain({
      config: config(),
      runner: echoRunner(),
      write: (line) => written.push(line),
      control: controlLines([
        JSON.stringify({ type: "turn", prompt: "a" }),
        JSON.stringify({ type: "turn", prompt: "b" }),
        JSON.stringify({ type: "shutdown" }),
      ]),
      systemPromptChecksum: "f".repeat(64),
    })
    const events = collect(written)
    expect(events.filter((event) => event.type === "ready")).toHaveLength(1)
    const session = events.filter((event) => event.type === "session")
    expect(session).toHaveLength(1)
    expect(session[0].sessionId).toBe("session-abc")
  })

  it("interrupts the running session on an interrupt control line", async () => {
    const written: string[] = []
    const interrupts: number[] = []
    await runMain({
      config: config(),
      runner: echoRunner([], interrupts),
      write: (line) => written.push(line),
      control: controlLines([
        JSON.stringify({ type: "turn", prompt: "a" }),
        JSON.stringify({ type: "interrupt" }),
        JSON.stringify({ type: "shutdown" }),
      ]),
    })
    expect(interrupts).toHaveLength(1)
    expect(collect(written).some((event) => event.type === "interrupted")).toBe(true)
  })

  it("ends the loop on shutdown even with no turn at all", async () => {
    const written: string[] = []
    const exit = await runMain({
      config: config(),
      runner: echoRunner(),
      write: (line) => written.push(line),
      control: controlLines([JSON.stringify({ type: "shutdown" })]),
    })
    expect(exit).toBe(0)
    expect(collect(written).some((event) => event.type === "done")).toBe(true)
  })

  it("reports an unreadable control line without ending the session", async () => {
    const written: string[] = []
    await runMain({
      config: config(),
      runner: echoRunner(),
      write: (line) => written.push(line),
      control: controlLines([
        "{not json",
        JSON.stringify({ type: "turn", prompt: "a" }),
        JSON.stringify({ type: "shutdown" }),
      ]),
    })
    const events = collect(written)
    expect(events.some((event) => event.type === "error")).toBe(true)
    expect(events.filter((event) => event.type === "turn_done")).toHaveLength(1)
  })
})

describe("parseArgs --resume", () => {
  it("threads a resumed session id into the config", () => {
    const parsed = parseArgs([
      "--mcp-config",
      "c.json",
      "--model",
      "haiku",
      "--resume",
      "session-abc",
    ])
    expect(parsed.resumeSessionId).toBe("session-abc")
  })

  it("leaves the resumed session id undefined when the flag is absent", () => {
    expect(
      parseArgs(["--mcp-config", "c.json", "--model", "haiku"]).resumeSessionId,
    ).toBeUndefined()
  })
})

describe("AsyncQueue", () => {
  it("delivers pushed items and ends when closed", async () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.close()
    const seen: number[] = []
    for await (const item of queue) seen.push(item)
    expect(seen).toEqual([1, 2])
  })
})
