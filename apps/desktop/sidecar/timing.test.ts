// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Cold start to a connected tool catalog is a budget the product is held to
// (3 seconds), so the number has to come off the wire rather than out of a
// stopwatch somebody held once. The sidecar reports it itself, on the line
// that precedes the first streamed message.
import { describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs, runMain } from "./index"
import { turnSystemPromptChecksum } from "./sdk-runner"

function configFile(agentDefinition: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "sidecar-timing-")), "mcp.json")
  writeFileSync(
    file,
    JSON.stringify({
      liaisonMcpUrl: "http://127.0.0.1:9/mcp",
      agentScopedToken: "unused",
      agentDefinition,
    }),
  )
  return file
}

async function eventsFor(
  delayMs: number,
  systemPromptChecksum?: string,
): Promise<Array<Record<string, any>>> {
  const written: string[] = []
  await runMain({
    config: parseArgs(["--mcp-config", "c.json", "--model", "haiku"]),
    systemPromptChecksum,
    write: (line) => written.push(line),
    runner: () =>
      (async function* () {
        await Bun.sleep(delayMs)
        yield { type: "system", subtype: "init" }
        yield { type: "result", subtype: "success" }
      })(),
  })
  return written
    .join("")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe("cold start instrumentation", () => {
  it("emits a ready line with a non-negative sidecarReadyMs before the first message line", async () => {
    const events = await eventsFor(20)
    const readyIndex = events.findIndex((event) => event.type === "ready")
    const firstMessage = events.findIndex((event) => event.type === "message")
    expect(readyIndex).toBeGreaterThanOrEqual(0)
    expect(events[readyIndex].sidecarReadyMs).toBeGreaterThanOrEqual(20)
    expect(readyIndex).toBeLessThan(firstMessage)
  })

  it("emits exactly one ready line for a turn, however many messages stream", async () => {
    const events = await eventsFor(0)
    expect(events.filter((event) => event.type === "ready")).toHaveLength(1)
  })
  it("the ready line carries the system prompt checksum this turn ran with", async () => {
    const events = await eventsFor(0, "abc123")
    const ready = events.find((event) => event.type === "ready")
    expect(ready?.systemPromptChecksum).toBe("abc123")
  })

  it("the checksum changes when the definition changes and is stable when it does not", () => {
    const charter = configFile("You are the shipping agent. Handle @admin.")
    const other = configFile("You are a different agent entirely.")
    const first = turnSystemPromptChecksum(parseArgs(["--mcp-config", charter, "--model", "haiku"]))
    const again = turnSystemPromptChecksum(parseArgs(["--mcp-config", charter, "--model", "haiku"]))
    const different = turnSystemPromptChecksum(
      parseArgs(["--mcp-config", other, "--model", "haiku"]),
    )
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(again).toBe(first)
    expect(different).not.toBe(first)
  })
})
