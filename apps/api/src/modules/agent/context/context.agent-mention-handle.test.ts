// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An agent mention token carries the handle its writer saw. A personal
// agent's handle moved from `@ada` (which read as the person Ada) to
// `@adas-agent`; the replayed history names the agent by its current handle,
// by id, so the model never reads the old spelling as a person.
import { describe, expect, it } from "bun:test"
import { convertToCoreMessages } from "./context"

const AGENT_ID = "6f0c2a52-6b8e-4f5e-9a59-0d3c9a1e2b7f"

describe("the replay names a mentioned agent by its current handle", () => {
  it("relabels an old-label agent mention by id", () => {
    const out = convertToCoreMessages(
      [{ authorType: "user", content: `@[ada](agent:${AGENT_ID}) check this`, metadata: null }],
      undefined,
      { agentHandles: new Map([[AGENT_ID, "@adas-agent"]]) },
    )
    expect(out).toEqual([{ role: "user", content: `@[adas-agent](agent:${AGENT_ID}) check this` }])
  })

  it("keeps the stored label without a handle map", () => {
    const out = convertToCoreMessages([
      { authorType: "user", content: `@[ada](agent:${AGENT_ID}) check this`, metadata: null },
    ])
    expect(out).toEqual([{ role: "user", content: `@[ada](agent:${AGENT_ID}) check this` }])
  })
})
