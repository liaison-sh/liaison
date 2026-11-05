// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A spawned e2e server on placeholder provider keys (the sub-agent Playwright
// fixture) must make no outbound model call of its own. LIAISON_OFFLINE_SIDE_CALLS
// stands the side calls down: message-search embeddings resolve no embedder,
// before any key is looked up.
import { afterEach, describe, expect, it } from "bun:test"
import { offlineSideCalls } from "~/lib/env"
import { embeddingLegOffLoggedFor, resolveOrgEmbedder } from "~/modules/search/message-indexer"

const ORG = "00000000-0000-4000-8000-00000000f501"

describe("offline side calls (test servers on placeholder keys)", () => {
  afterEach(() => {
    delete process.env.LIAISON_OFFLINE_SIDE_CALLS
  })

  it("is off unless the flag is set", () => {
    expect(offlineSideCalls()).toBe(false)
    process.env.LIAISON_OFFLINE_SIDE_CALLS = "1"
    expect(offlineSideCalls()).toBe(true)
  })

  it("resolves no embedder, so message search runs keyword-only with no provider call", async () => {
    process.env.LIAISON_OFFLINE_SIDE_CALLS = "1"
    expect(await resolveOrgEmbedder(ORG)).toBeNull()
    expect(embeddingLegOffLoggedFor(ORG)).toBe(true)
  })
})
