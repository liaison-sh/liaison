// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A THREAD'S TOOL LIST KEEPS ITS ORDER from one turn to the next, and a tool
// a step loads joins its end: a provider's prompt cache reads a request only
// as far as it repeats the previous one.
import { describe, expect, it } from "bun:test"
import { lastToolOrder } from "~/modules/agent/context/discovery-window"
import { moveToolsToEnd, orderStartingToolsFirst } from "~/modules/agent/tools/tool-bridge"

const set = (...names: string[]) => Object.fromEntries(names.map((n) => [n, { n }]))

describe("orderStartingToolsFirst", () => {
  it("keeps the order the thread's last turn sent, new starting tools after it", () => {
    const tools = set("a__x", "b__y", "kernel__z", "c__w", "d__v")
    // The last turn sent kernel__z, then b__y loaded mid-turn, then a__x.
    orderStartingToolsFirst(tools, new Set(["a__x", "b__y", "kernel__z", "c__w"]), [
      "kernel__z",
      "b__y",
      "a__x",
    ])
    expect(Object.keys(tools)).toEqual(["kernel__z", "b__y", "a__x", "c__w", "d__v"])
  })

  it("sorts by name when the thread has no order yet", () => {
    const tools = set("b", "a", "c")
    orderStartingToolsFirst(tools, new Set(["b", "a"]))
    expect(Object.keys(tools)).toEqual(["a", "b", "c"])
  })
})

describe("moveToolsToEnd", () => {
  it("moves a tool loaded mid-turn to the end, whatever its name", () => {
    const tools = set("m", "z", "a")
    moveToolsToEnd(tools, ["a", "missing"])
    expect(Object.keys(tools)).toEqual(["m", "z", "a"])
    moveToolsToEnd(tools, ["m"])
    expect(Object.keys(tools)).toEqual(["z", "a", "m"])
  })
})

describe("lastToolOrder", () => {
  it("reads the newest agent row that recorded one", () => {
    expect(
      lastToolOrder(
        [
          { metadata: { toolOrder: ["a", "b"] } },
          { metadata: { toolOrder: ["b", "a", 3] } },
          { metadata: { toolCalls: [] } },
        ],
        null,
      ),
    ).toEqual(["b", "a"])
    expect(lastToolOrder([{ metadata: null }], null)).toEqual([])
  })

  it("reads only the acting agent's own rows", () => {
    const rows = [
      { authorAgentId: "agent-a", metadata: { toolOrder: ["a1", "a2"] } },
      { authorAgentId: "agent-b", metadata: { toolOrder: ["b1"] } },
      { authorAgentId: null, metadata: { toolOrder: ["n1"] } },
    ]
    expect(lastToolOrder(rows, "agent-a")).toEqual(["a1", "a2"])
    expect(lastToolOrder(rows, "agent-b")).toEqual(["b1"])
    expect(lastToolOrder(rows, "agent-c")).toEqual([])
    // No acting agent: the latest row, whoever it is filed under.
    expect(lastToolOrder(rows, null)).toEqual(["n1"])
    expect(lastToolOrder(rows.slice(0, 2), null)).toEqual(["b1"])
  })
})
