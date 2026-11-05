// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The per-org embedding spend is a per-UTC-day running total: a new day starts
// from zero and drops the past days' keys, so the map holds one day's orgs.

import { afterEach, describe, expect, it, setSystemTime } from "bun:test"
import { MessageIndexerTestAccess, recordEmbeddingTokens } from "~/modules/search/message-indexer"

afterEach(() => {
  setSystemTime()
})

describe("recordEmbeddingTokens", () => {
  it("adds up within a day and drops the past days on a new one", () => {
    const orgA = crypto.randomUUID()
    const orgB = crypto.randomUUID()
    setSystemTime(new Date("2026-03-01T23:59:00Z"))
    recordEmbeddingTokens(orgA, 10)
    recordEmbeddingTokens(orgA, 5)
    recordEmbeddingTokens(orgA, 0)
    expect(MessageIndexerTestAccess.embeddingTokens(orgA)).toBe(15)

    setSystemTime(new Date("2026-03-02T00:01:00Z"))
    recordEmbeddingTokens(orgB, 7)
    expect(MessageIndexerTestAccess.embeddingTokens(orgB)).toBe(7)
    expect(MessageIndexerTestAccess.embeddingTokens(orgA)).toBe(0)
    expect(MessageIndexerTestAccess.embeddingTokens(orgA, "2026-03-01")).toBe(0)
  })
})
