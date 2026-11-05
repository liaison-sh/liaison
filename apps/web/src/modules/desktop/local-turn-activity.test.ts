// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T11: a local turn's tool calls are the agent's own activity.

import { describe, expect, it } from "vitest"
import type { DesktopToolActivity } from "~/lib/desktop-shell-contract"
import { toLocalToolCalls } from "./local-turn-activity"

function activity(over: Partial<DesktopToolActivity> = {}): DesktopToolActivity {
  return {
    id: "toolu_01",
    toolName: "Read",
    summary: "src/main.ts",
    status: "running",
    startedAt: 1_000,
    ...over,
  }
}

describe("local-turn-activity", () => {
  it("local tool activity maps a sidecar tool use onto a tool call row state", () => {
    const [running] = toLocalToolCalls([activity()])
    expect(running).toMatchObject({
      toolCallId: "toolu_01",
      toolName: "Read",
      status: "running",
    })

    const [done] = toLocalToolCalls([activity({ id: "toolu_02", status: "done" })])
    expect(done).toMatchObject({ toolCallId: "toolu_02", status: "completed" })

    const [failed] = toLocalToolCalls([activity({ id: "toolu_03", status: "error" })])
    expect(failed).toMatchObject({ toolCallId: "toolu_03", status: "error" })
  })

  it("local tool activity keeps the order the sidecar reported", () => {
    const rows = toLocalToolCalls([
      activity({ id: "toolu_a", toolName: "Read", startedAt: 2_000 }),
      activity({ id: "toolu_b", toolName: "Bash", startedAt: 1_000 }),
    ])
    expect(rows.map((row) => row.toolCallId)).toEqual(["toolu_a", "toolu_b"])
  })

  it("local tool activity carries the summary the shell already computed", () => {
    const [row] = toLocalToolCalls([activity({ summary: "bun run build" })])
    expect(row?.args).toEqual({ summary: "bun run build" })
    expect(row?.result).toBeUndefined()
  })

  it("a status this build does not know is pending, never done", () => {
    const [row] = toLocalToolCalls([
      { ...activity(), status: "queued" as DesktopToolActivity["status"] },
    ])
    expect(row?.status).toBe("pending")
  })

  // P6d-FX2 (SK-5): switching to Bypass answers whatever prompt is parked, and
  // WHO said yes is not the same fact as that yes happened. The row that raised
  // the prompt is where the trail carries it.
  it("a call the mode change allowed says so in its own row", () => {
    const [allowed] = toLocalToolCalls([
      { ...activity({ summary: "rm -rf build" }), allowedByBypass: true },
    ])
    expect(allowed?.args).toEqual({ summary: "rm -rf build", allowedByBypass: true })
    const [asked] = toLocalToolCalls([activity({ summary: "rm -rf build" })])
    expect(asked?.args).toEqual({ summary: "rm -rf build" })
  })

  it("no activity is no rows", () => {
    expect(toLocalToolCalls([])).toEqual([])
  })
})
