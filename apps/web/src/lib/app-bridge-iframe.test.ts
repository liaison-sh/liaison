// SPDX-License-Identifier: FSL-1.1-ALv2
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createIframeBridge } from "../../../../packages/app-ui/src/ctx-iframe"

const TEST_ORIGIN = "https://apps.liaison.test"

function createMockChannel() {
  const sent: Array<{ msg: string; targetOrigin: string }> = []
  const parsed: Array<{ type: string; payload: unknown }> = []

  const postMessage = vi.fn((msg: string, targetOrigin: string) => {
    sent.push({ msg, targetOrigin })
    parsed.push(JSON.parse(msg))
  })

  return { sent, parsed, postMessage }
}

describe("ctx-iframe bridge — postMessage protocol", () => {
  let channel: ReturnType<typeof createMockChannel>

  beforeEach(() => {
    channel = createMockChannel()
  })

  it("openTab sends { type: 'openTab' } postMessage to parent", () => {
    const bridge = createIframeBridge({
      postMessage: channel.postMessage,
      targetOrigin: TEST_ORIGIN,
    })
    bridge.openTab("contact-detail", "c123", "Alice")
    expect(channel.parsed).toHaveLength(1)
    expect(channel.parsed[0].type).toBe("openTab")
    expect(channel.parsed[0].payload).toMatchObject({
      tabType: "contact-detail",
      entityId: "c123",
      label: "Alice",
    })
  })

  it("postMessage is called with the configured targetOrigin", () => {
    const bridge = createIframeBridge({
      postMessage: channel.postMessage,
      targetOrigin: TEST_ORIGIN,
    })
    bridge.showToast("Saved!", "success")
    // The second argument to postMessage must be the expected host origin.
    expect(channel.sent[0].targetOrigin).toBe(TEST_ORIGIN)
  })

  it("showToast sends { type: 'toast' } postMessage to parent", () => {
    const bridge = createIframeBridge({
      postMessage: channel.postMessage,
      targetOrigin: TEST_ORIGIN,
    })
    bridge.showToast("Saved!", "success")
    expect(channel.parsed[0].type).toBe("toast")
    expect(channel.parsed[0].payload).toMatchObject({ message: "Saved!", variant: "success" })
  })

  it("closeTab sends { type: 'closeTab' } postMessage", () => {
    const bridge = createIframeBridge({
      postMessage: channel.postMessage,
      targetOrigin: TEST_ORIGIN,
    })
    bridge.closeTab()
    expect(channel.parsed[0].type).toBe("closeTab")
  })
})
