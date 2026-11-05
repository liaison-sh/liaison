// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The discovery window: a persisted discovery survives while the rows after
// the checkpoint boundary still show it (the turn that unlocked it, or a call
// to it). No boundary means no window.
import { describe, expect, it } from "bun:test"
import { evidencedTools, windowDiscoveries } from "~/modules/agent/context/discovery-window"

const unlockedRow = { metadata: { discoveredTools: ["mail__read", "mail__listAccounts"] } }
const calledRow = {
  metadata: { toolCalls: [{ toolCallId: "c1", toolName: "shopify__orders_get", args: {} }] },
}
const legacyRow = { metadata: { usage: { inputTokens: 3 } } }

describe("windowDiscoveries", () => {
  it("keeps every persisted discovery only when no window could be established", () => {
    const kept = windowDiscoveries(["gitlab__gitlab_read_file", "mail__read"], null)
    expect([...kept].sort()).toEqual(["gitlab__gitlab_read_file", "mail__read"])
  })

  it("keeps only the discoveries the rows after the boundary still show", () => {
    const persisted = [
      "gitlab__gitlab_read_file", // unlocked by a padded search long ago, never used
      "mail__read", // unlocked in a turn after the boundary
      "shopify__orders_get", // called after the boundary (a blind call is a discovery)
      "google-drive__read", // nothing after the boundary mentions it
    ]
    const kept = windowDiscoveries(persisted, [unlockedRow, calledRow, legacyRow])
    expect([...kept].sort()).toEqual(["mail__read", "shopify__orders_get"])
  })

  it("an empty window after the boundary keeps nothing", () => {
    expect(windowDiscoveries(["mail__read"], []).size).toBe(0)
  })

  it("evidence is the per turn unlock list plus every tool actually called", () => {
    const ev = evidencedTools([unlockedRow, calledRow, legacyRow, { metadata: null }])
    expect([...ev].sort()).toEqual(["mail__listAccounts", "mail__read", "shopify__orders_get"])
  })
})
