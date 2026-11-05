// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org purge removes Redis state whose key name does not carry the org uuid:
// a live agent turn is keyed by a hash of thread/agent/turn and holds the turn's
// text and tool calls. The verify step counts it, and another org's turn stays.
import { beforeEach, describe, expect, it } from "bun:test"
import {
  AgentStreamRegistryTestAccess,
  getLiveAgentStream,
  recordAgentStreamEvent,
} from "~/modules/agent/runtime/stream-registry"
import { countOrgRedisKeys, deleteOrgRedisKeys } from "~/modules/org/purge/external"

const ORG = crypto.randomUUID()
const OTHER_ORG = crypto.randomUUID()
const THREAD = crypto.randomUUID()
const OTHER_THREAD = crypto.randomUUID()

describe("org purge removes the org's live agent turns", () => {
  beforeEach(async () => {
    await AgentStreamRegistryTestAccess.reset()
  })

  it("deletes the turn, counts it before, and leaves another org's turn", async () => {
    await recordAgentStreamEvent(THREAD, ORG, "start")
    await recordAgentStreamEvent(THREAD, ORG, "tool_call", {
      toolCallId: "t1",
      toolName: "mail__search",
      args: { q: "salary review Q4" },
    })
    await recordAgentStreamEvent(THREAD, ORG, "delta", { delta: "Confidential answer" })
    await recordAgentStreamEvent(OTHER_THREAD, OTHER_ORG, "start")
    await recordAgentStreamEvent(OTHER_THREAD, OTHER_ORG, "delta", { delta: "neighbour" })
    expect((await getLiveAgentStream(THREAD))?.orgId).toBe(ORG)

    // The verify step sees it before the purge.
    expect(await countOrgRedisKeys(ORG)).toBeGreaterThan(0)

    await deleteOrgRedisKeys(ORG)

    const counted = await countOrgRedisKeys(ORG)
    const left = await getLiveAgentStream(THREAD)
    expect({ counted, leftContent: left?.content ?? null }).toEqual({
      counted: 0,
      leftContent: null,
    })
    expect((await getLiveAgentStream(OTHER_THREAD))?.content).toBe("neighbour")
  })
})
