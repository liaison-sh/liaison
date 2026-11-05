// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  importRequestPath,
  isFollowHostCall,
  parseArgs,
  runMain,
  type SessionRunner,
  type SidecarConfig,
  serializeEvent,
} from "./index"

describe("--import (S40, A42)", () => {
  it("S40: --import <request file> is a one-shot import call; anything else is not", () => {
    expect(importRequestPath(["--import", "/cfg/req.json"])).toBe("/cfg/req.json")
    expect(importRequestPath(["--import"])).toBeNull()
    expect(importRequestPath(["--import", "a", "--model", "x"])).toBeNull()
    expect(importRequestPath(["--mcp-config", "c.json", "--model", "haiku"])).toBeNull()
  })
})

describe("--follow (A45, D28 b)", () => {
  it("A45: --follow alone starts the follow host; with anything else it does not", () => {
    expect(isFollowHostCall(["--follow"])).toBe(true)
    expect(isFollowHostCall(["--follow", "x"])).toBe(false)
    expect(isFollowHostCall(["--import", "/cfg/req.json"])).toBe(false)
    expect(isFollowHostCall([])).toBe(false)
  })
})

describe("parseArgs", () => {
  it("throws when mcp-config flag is missing", () => {
    expect(() => parseArgs([])).toThrow()
  })

  it("parses the model flag", () => {
    expect(parseArgs(["--mcp-config", "c.json", "--model", "haiku"]).model).toBe("haiku")
  })

  it("throws when the model flag is missing", () => {
    expect(() => parseArgs(["--mcp-config", "c.json"])).toThrow()
  })

  it("parses cwd and permission mode", () => {
    const config = parseArgs([
      "--mcp-config",
      "c.json",
      "--model",
      "haiku",
      "--cwd",
      "/tmp/x",
      "--permission-mode",
      "plan",
    ])
    expect(config.mcpConfigPath).toBe("c.json")
    expect(config.cwd).toBe("/tmp/x")
    expect(config.permissionMode).toBe("plan")
  })

  it("defaults permission mode to auto", () => {
    expect(parseArgs(["--mcp-config", "c.json", "--model", "haiku"]).permissionMode).toBe("auto")
  })

  it("is not isolating the Claude Code config unless asked", () => {
    expect(parseArgs(["--mcp-config", "c.json", "--model", "haiku"]).isolateConfig).toBe(false)
  })

  it("parses the isolate-config flag, which carries no value", () => {
    const config = parseArgs(["--mcp-config", "c.json", "--isolate-config", "--model", "haiku"])
    expect(config.isolateConfig).toBe(true)
    expect(config.model).toBe("haiku")
  })

  it("rejects an unknown permission mode", () => {
    expect(() =>
      parseArgs(["--mcp-config", "c.json", "--model", "haiku", "--permission-mode", "yolo"]),
    ).toThrow()
  })
})

describe("serializeEvent", () => {
  it("emits one newline terminated JSON object per event", () => {
    const line = serializeEvent({ type: "ready", protocolVersion: 1 })
    expect(line.endsWith("\n")).toBe(true)
    expect(line.indexOf("\n")).toBe(line.length - 1)
    expect(JSON.parse(line)).toEqual({ type: "ready", protocolVersion: 1 })
  })
})

describe("the turn line's credential (S59, D36)", () => {
  const CREDENTIAL = `${"Q".repeat(40)}_-9`

  function sessionConfig(): SidecarConfig {
    const dir = mkdtempSync(path.join(tmpdir(), "sidecar-turn-cred-"))
    return {
      mcpConfigPath: path.join(dir, "liaison-mcp-config.json"),
      cwd: dir,
      permissionMode: "manual",
      model: "claude-haiku-5-5",
      isolateConfig: false,
    }
  }

  /** What the turn file holds right now, with its mode, or "none". */
  function turnFile(config: SidecarConfig): string {
    const file = `${config.mcpConfigPath}.turn`
    if (!existsSync(file)) return "none"
    return `${readFileSync(file, "utf8")}:${(statSync(file).mode & 0o777).toString(8)}`
  }

  /**
   * A runner that logs every reconnect and every prompt with the turn file as
   * it was at that instant, and tells the control feed when a prompt arrived.
   */
  function loggingRunner(
    config: SidecarConfig,
    log: string[],
    reconnect: (name: string) => Promise<void>,
  ) {
    const arrived: Array<() => void> = []
    const runner: SessionRunner = ({ prompts }) => {
      async function* run() {
        for await (const prompt of prompts) {
          log.push(`prompt:${String(prompt.message.content)}:${turnFile(config)}`)
          arrived.shift()?.()
          yield { type: "result", subtype: "success" }
        }
      }
      const iterator = run()
      return {
        [Symbol.asyncIterator]: () => iterator,
        reconnectMcpServer: async (name: string) => {
          log.push(`reconnect:${name}:${turnFile(config)}`)
          await reconnect(name)
        },
      }
    }
    const nextPrompt = () => new Promise<void>((resolve) => arrived.push(resolve))
    return { runner, nextPrompt }
  }

  it("S59: a turn line with a credential writes the file 0600 and reconnects before the prompt; one without deletes it", async () => {
    const config = sessionConfig()
    const log: string[] = []
    const { runner, nextPrompt } = loggingRunner(config, log, async () => undefined)
    async function* control() {
      const first = nextPrompt()
      yield JSON.stringify({ type: "turn", prompt: "first", turnCredential: CREDENTIAL })
      await first
      const second = nextPrompt()
      yield JSON.stringify({ type: "turn", prompt: "second" })
      await second
      const third = nextPrompt()
      yield JSON.stringify({ type: "turn", prompt: "third", turnCredential: "not-a-credential" })
      await third
      yield JSON.stringify({ type: "shutdown" })
    }
    await runMain({ config, runner, write: () => undefined, control: control() })
    expect(log).toEqual([
      `reconnect:liaison:${CREDENTIAL}:600`,
      `prompt:first:${CREDENTIAL}:600`,
      // The previous turn's credential is dropped, and the connection made
      // again so the CLI stops presenting it.
      "reconnect:liaison:none",
      "prompt:second:none",
      // A malformed credential is treated as none: nothing written, nothing to drop.
      "prompt:third:none",
    ])
    // Never left behind once the session is over.
    expect(turnFile(config)).toBe("none")
  })

  it("S59: the session ends right after a turn with a credential → the turn file is deleted", async () => {
    const config = sessionConfig()
    const log: string[] = []
    const { runner, nextPrompt } = loggingRunner(config, log, async () => undefined)
    async function* control() {
      const first = nextPrompt()
      yield JSON.stringify({ type: "turn", prompt: "only", turnCredential: CREDENTIAL })
      await first
      yield JSON.stringify({ type: "shutdown" })
    }
    await runMain({ config, runner, write: () => undefined, control: control() })
    // The file was there for the turn, and the session's end took it away.
    expect(log).toEqual([`reconnect:liaison:${CREDENTIAL}:600`, `prompt:only:${CREDENTIAL}:600`])
    expect(turnFile(config)).toBe("none")
  })

  it("S59: a reconnect that fails or hangs still runs the turn", async () => {
    for (const reconnect of [
      async () => {
        throw new Error("reconnect refused")
      },
      () => new Promise<void>(() => undefined),
    ]) {
      const config = sessionConfig()
      const log: string[] = []
      const { runner, nextPrompt } = loggingRunner(config, log, reconnect)
      async function* control() {
        const first = nextPrompt()
        yield JSON.stringify({ type: "turn", prompt: "go", turnCredential: CREDENTIAL })
        await first
        yield JSON.stringify({ type: "shutdown" })
      }
      await runMain({
        config,
        runner,
        write: () => undefined,
        control: control(),
        turnReconnectTimeoutMs: 20,
      })
      expect(log).toEqual([`reconnect:liaison:${CREDENTIAL}:600`, `prompt:go:${CREDENTIAL}:600`])
    }
  })
})
