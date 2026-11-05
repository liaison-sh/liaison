// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-D T4 (F15): the agent activity timeline says where a turn ran. Node
// jobs persist through persistAgentTurn with `runLocation: "node"` (A19), and
// the mapping used to fold anything that was not "local" into "liaison".
import { describe, expect, it } from "bun:test"
import { activityRunLocation } from "./definition-routes"

describe("activityRunLocation", () => {
  it("names a node turn as node", () => {
    expect(activityRunLocation({ runLocation: "node" })).toBe("node")
  })

  it("keeps local and cloud as they were", () => {
    expect(activityRunLocation({ runLocation: "local" })).toBe("local")
    expect(activityRunLocation({ runLocation: "liaison" })).toBe("liaison")
    expect(activityRunLocation({})).toBe("liaison")
    expect(activityRunLocation(null)).toBe("liaison")
    expect(activityRunLocation({ runLocation: "elsewhere" })).toBe("liaison")
  })
})
