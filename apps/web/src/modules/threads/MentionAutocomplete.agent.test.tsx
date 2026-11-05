// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { serializeMention } from "~/lib/mention-format"

const SUPPORT_ID = "11111111-1111-4111-8111-111111111111"

describe("agent mention serialization", () => {
  it("serializes an agent mention to the agent-id token the server parses", () => {
    const result = serializeMention({ type: "agent", id: SUPPORT_ID, label: "support" })
    expect(result).toBe(`@[support](agent:${SUPPORT_ID})`)
  })
})
