// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Knowledge store — synced-doc live update path (T-7).
 *
 * Verifies:
 *   - WS-driven document update populates documentsById and pulses the doc.
 *   - H-6: incoming externalRev matching local rev short-circuits the refetch.
 *   - M-4: a second event within 3s resets the pulse timer (does not stack).
 */
import { describe, expect, it, vi } from "vitest"
import {
  getPulseUpdated,
  handleKnowledgeDocumentUpdate,
  knowledgeStore,
  pulseDocumentUpdated,
  resetKnowledgeStore,
  setKnowledgeStoreDocument,
} from "./knowledge-store"

describe("knowledge-store synced-doc live update (T-7)", () => {
  it("refetches the document and updates the store on a synced-doc update event", async () => {
    resetKnowledgeStore()
    setKnowledgeStoreDocument({
      id: "d1",
      title: "old",
      body: "old body",
      externalRev: "rev-1",
    })
    const fetchDoc = vi.fn(async (_id: string) => ({
      id: "d1",
      title: "new",
      body: "new body",
      externalRev: "rev-2",
    }))
    await handleKnowledgeDocumentUpdate(
      { entityId: "d1", externalRev: "rev-2", lastSyncAt: "2026-05-24T00:01:00Z" },
      fetchDoc,
    )
    expect(fetchDoc).toHaveBeenCalledTimes(1)
    expect(knowledgeStore.documentsById["d1"]?.body).toBe("new body")
    expect(getPulseUpdated("d1")).toBe(true)
  })

  it("H-6: short-circuits when incoming externalRev matches local — no refetch", async () => {
    resetKnowledgeStore()
    setKnowledgeStoreDocument({
      id: "d1",
      title: "x",
      body: "x",
      externalRev: "rev-1",
    })
    const fetchDoc = vi.fn(async (_id: string) => null)
    await handleKnowledgeDocumentUpdate({ entityId: "d1", externalRev: "rev-1" }, fetchDoc)
    expect(fetchDoc).not.toHaveBeenCalled()
  })

  it("ignores events without an entity id", async () => {
    resetKnowledgeStore()
    const fetchDoc = vi.fn(async () => null)
    await handleKnowledgeDocumentUpdate({}, fetchDoc)
    expect(fetchDoc).not.toHaveBeenCalled()
  })

  it("pulse clears after 3s", async () => {
    vi.useFakeTimers()
    try {
      resetKnowledgeStore()
      pulseDocumentUpdated("d1")
      expect(getPulseUpdated("d1")).toBe(true)
      vi.advanceTimersByTime(2999)
      expect(getPulseUpdated("d1")).toBe(true)
      vi.advanceTimersByTime(2)
      expect(getPulseUpdated("d1")).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("M-4: second pulse within 3s resets the timer rather than stacking", async () => {
    vi.useFakeTimers()
    try {
      resetKnowledgeStore()
      pulseDocumentUpdated("d1")
      vi.advanceTimersByTime(2000)
      pulseDocumentUpdated("d1") // reset
      vi.advanceTimersByTime(2000)
      // Originally would have cleared at 3000ms; with reset it pulses until 4000ms from second call.
      expect(getPulseUpdated("d1")).toBe(true)
      vi.advanceTimersByTime(1001)
      expect(getPulseUpdated("d1")).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
