// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  attachSyncedSourceApp,
  createKnowledgeSourceRegistry,
  federatedKnowledgeSearch,
  type KnowledgeSearchHit,
  scrubSourceStatuses,
  sourceFriendlyMessage,
} from "./federated-search"

const actor = {
  orgId: "org-1",
  userId: "u1",
  scopes: ["knowledge:documents:read", "knowledge:sources:read"],
  dimensionGrants: {},
}

describe("Knowledge federated search", () => {
  it("does not call remote sources for empty queries", async () => {
    let remoteCalls = 0
    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "drive",
      searchRemote: async () => {
        remoteCalls++
        return { hits: [], status: { source: "drive", state: "complete", retryable: false } }
      },
    } as any)

    const result = await federatedKnowledgeSearch(
      { query: "", limit: 10, mode: "both", filters: {}, cursors: {} },
      {
        actor,
        registry,
        localSearch: async () => ({
          hits: [],
          status: { source: "knowledge", state: "complete", retryable: false },
        }),
      },
    )

    expect(remoteCalls).toBe(0)
    expect(result.sourceStatuses.map((status) => status.state)).toEqual(["skipped"])
  })

  it("returns partial results when one source fails", async () => {
    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "drive",
      searchRemote: async () => {
        throw new Error("rate limit")
      },
    } as any)

    const result = await federatedKnowledgeSearch(
      { query: "policy", limit: 10, mode: "both", filters: {}, cursors: {} },
      {
        actor,
        registry,
        localSearch: async () => ({
          hits: [
            {
              source: "knowledge",
              sourceEntityId: "d1",
              title: "Policy",
              type: "local_document",
              sourceRank: 1,
              duplicateKeys: ["url:https://x/policy"],
            },
          ],
          status: { source: "knowledge", state: "complete", retryable: false },
        }),
      },
    )

    expect(result.hits.map((hit) => hit.title)).toEqual(["Policy"])
    // Hits from the failed source must not appear in the merged output.
    expect(result.hits.every((h) => h.source !== "drive")).toBe(true)
    expect(result.sourceStatuses.find((status) => status.source === "drive")?.state).toBe("error")
    expect(result.final).toBe(true)
  })

  it("collapses duplicates and preserves source badges", async () => {
    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "google-drive",
      searchRemote: async () => ({
        hits: [
          {
            source: "google-drive",
            sourceEntityId: "g1",
            title: "Policy",
            type: "file",
            url: "https://x/policy",
            sourceRank: 1,
            duplicateKeys: ["url:https://x/policy"],
            canFetchContent: true,
            status: "available",
          },
        ],
        status: { source: "google-drive", state: "complete", retryable: false },
      }),
    } as any)

    const result = await federatedKnowledgeSearch(
      { query: "policy", limit: 10, mode: "both", filters: {}, cursors: {} },
      {
        actor,
        registry,
        localSearch: async () => ({
          hits: [
            {
              source: "knowledge",
              sourceEntityId: "d1",
              title: "Policy",
              type: "linked_document",
              url: "https://x/policy",
              sourceRank: 1,
              duplicateKeys: ["url:https://x/policy"],
              badges: ["linked"],
            },
          ],
          status: { source: "knowledge", state: "complete", retryable: false },
        }),
      },
    )

    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].badges).toEqual(
      expect.arrayContaining(["linked", "google-drive", "knowledge"]),
    )
  })

  it("I8: RRF ranking — fused score = 1/(k+rank), order deterministic with stable tie-break", async () => {
    // Two sources, each returning two hits. The RRF formula is 1/(60+rank).
    // Verify exact ordering: combined rank-1 hits beat single-source rank-1
    // hits, and ties break by title then primary id (deterministic).
    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "drive",
      searchRemote: async () =>
        ({
          hits: [
            {
              source: "drive",
              sourceEntityId: "d-alpha",
              title: "Alpha",
              type: "file",
              sourceRank: 1,
              duplicateKeys: ["url:alpha"],
            },
            {
              source: "drive",
              sourceEntityId: "d-bravo",
              title: "Bravo",
              type: "file",
              sourceRank: 2,
            },
          ],
          status: { source: "drive", state: "complete", retryable: false },
        }) as any,
    } as any)

    const result = await federatedKnowledgeSearch(
      { query: "alpha", limit: 10, mode: "both", filters: {}, cursors: {} },
      {
        actor,
        registry,
        localSearch: async () =>
          ({
            hits: [
              {
                source: "knowledge",
                sourceEntityId: "k-alpha",
                title: "Alpha",
                type: "local_document",
                sourceRank: 1,
                duplicateKeys: ["url:alpha"], // collides with drive d-alpha
              },
              {
                source: "knowledge",
                sourceEntityId: "k-charlie",
                title: "Charlie",
                type: "local_document",
                sourceRank: 3,
              },
            ],
            status: { source: "knowledge", state: "complete", retryable: false },
          }) as any,
      },
    )

    // 1. Alpha collapses (kept from knowledge since it was added first).
    // 2. Fused rank for kept Alpha = 1/(60+1) + 1/(60+1) ≈ 0.03279 (highest).
    // 3. Bravo single-source rank=2 → 1/(62) ≈ 0.01613.
    // 4. Charlie single-source rank=3 → 1/(63) ≈ 0.01587.
    expect(result.hits.map((h) => h.title)).toEqual(["Alpha", "Bravo", "Charlie"])
    const alpha = result.hits[0]!
    // Tolerance because of FP composition order
    expect(alpha.fusedRank).toBeGreaterThan(2 / 61 - 1e-9)
    expect(alpha.fusedRank).toBeLessThan(2 / 61 + 1e-9)
  })

  it("I9: rate-limit-style errors surface as state=rate-limited (not generic error)", async () => {
    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "drive",
      searchRemote: async () => {
        throw Object.assign(new Error("slow down"), { code: "RATE_LIMITED" })
      },
    } as any)
    const result = await federatedKnowledgeSearch(
      { query: "q", limit: 10, mode: "both", filters: {}, cursors: {} },
      {
        actor,
        registry,
        localSearch: async () => ({
          hits: [],
          status: { source: "knowledge", state: "complete", retryable: false },
        }),
      },
    )
    const drive = result.sourceStatuses.find((s) => s.source === "drive")!
    expect(drive.state).toBe("rate-limited")
    expect(drive.retryable).toBe(true)
  })

  it("I10: source that never resolves maps to error after timeoutMs", async () => {
    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "drive",
      searchRemote: () => new Promise(() => undefined), // never resolves
    } as any)
    const result = await federatedKnowledgeSearch(
      { query: "q", limit: 10, mode: "both", filters: {}, cursors: {} },
      {
        actor,
        registry,
        localSearch: async () => ({
          hits: [],
          status: { source: "knowledge", state: "complete", retryable: false },
        }),
        timeoutMs: 25,
      },
    )
    const drive = result.sourceStatuses.find((s) => s.source === "drive")!
    expect(drive.state).toBe("error")
    expect(drive.message).toMatch(/timed out/i)
    // A timed-out source must contribute zero hits to the merged output.
    expect(result.hits.every((h) => h.source !== "drive")).toBe(true)
  })

  it("M1: duplicate collapse across 3 sources merges badges from all", async () => {
    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "drive",
      searchRemote: async () =>
        ({
          hits: [
            {
              source: "drive",
              sourceEntityId: "d1",
              title: "Same",
              type: "file",
              sourceRank: 1,
              duplicateKeys: ["url:same"],
              badges: ["remote"],
            },
          ],
          status: { source: "drive", state: "complete", retryable: false },
        }) as any,
    } as any)
    registry.register({
      source: "github",
      searchRemote: async () =>
        ({
          hits: [
            {
              source: "github",
              sourceEntityId: "g1",
              title: "Same",
              type: "repo_file",
              sourceRank: 1,
              duplicateKeys: ["url:same"],
              badges: ["repo"],
            },
          ],
          status: { source: "github", state: "complete", retryable: false },
        }) as any,
    } as any)
    const result = await federatedKnowledgeSearch(
      { query: "same", limit: 10, mode: "both", filters: {}, cursors: {} },
      {
        actor,
        registry,
        localSearch: async () =>
          ({
            hits: [
              {
                source: "knowledge",
                sourceEntityId: "k1",
                title: "Same",
                type: "local_document",
                sourceRank: 1,
                duplicateKeys: ["url:same"],
                badges: ["linked"],
              },
            ],
            status: { source: "knowledge", state: "complete", retryable: false },
          }) as any,
      },
    )
    expect(result.hits).toHaveLength(1)
    const badges = result.hits[0]!.badges ?? []
    expect(badges).toEqual(
      expect.arrayContaining(["linked", "knowledge", "remote", "drive", "repo", "github"]),
    )
  })

  it("distinguishes all-source failure from no results and preserves remote results during local outage", async () => {
    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "google-drive",
      searchRemote: async () => ({
        hits: [
          {
            source: "google-drive",
            sourceEntityId: "g1",
            title: "Remote Policy",
            type: "file",
            sourceRank: 1,
          },
        ],
        status: { source: "google-drive", state: "complete", retryable: false },
      }),
    } as any)

    const result = await federatedKnowledgeSearch(
      { query: "policy", limit: 10, mode: "both", filters: {}, cursors: {} },
      {
        actor,
        registry,
        localSearch: async () => {
          throw new Error("meili down")
        },
      },
    )

    expect(result.hits.map((hit) => hit.title)).toEqual(["Remote Policy"])
    expect(result.sourceStatuses.find((status) => status.source === "knowledge")?.state).toBe(
      "error",
    )
  })

  it("BS-6: scrubSourceStatuses replaces adapter messages on every non-complete state", () => {
    const states = [
      "skipped",
      "loading",
      "partial",
      "unavailable",
      "unauthorized",
      "rate-limited",
      "error",
    ] as const
    for (const state of states) {
      const scrubbed = scrubSourceStatuses([
        {
          source: "drive",
          state,
          retryable: false,
          message: "bearer abc123 leak from internal.host tenant=acme ECONNRESET token=xyz",
          hitCount: 0,
        },
      ])
      expect(scrubbed[0]!.message).toBe(sourceFriendlyMessage(state))
      expect(scrubbed[0]!.message).not.toMatch(/bearer|token=|ECONNRESET|tenant=|internal\.host/i)
    }
  })

  it("BS-6: scrubSourceStatuses preserves messages on complete state (allowlist)", () => {
    const scrubbed = scrubSourceStatuses([
      {
        source: "drive",
        state: "complete",
        retryable: false,
        message: "Fetched 12 results",
        hitCount: 12,
      },
    ])
    expect(scrubbed[0]!.message).toBe("Fetched 12 results")
  })

  it("T24: RRF tie-break — equal fusedRank breaks deterministically by title then primaryId", async () => {
    // Both hits arrive at the same source rank from different sources, so
    // their RRF score is identical = 1/(60+1). The tie-break must order
    // by title ascending, then by primaryId ascending.
    const registry = createKnowledgeSourceRegistry()
    registry.register({
      source: "a",
      searchRemote: async () =>
        ({
          hits: [
            { source: "a", sourceEntityId: "z-id", title: "Zeta", type: "file", sourceRank: 1 },
          ],
          status: { source: "a", state: "complete", retryable: false },
        }) as any,
    } as any)
    registry.register({
      source: "b",
      searchRemote: async () =>
        ({
          hits: [
            { source: "b", sourceEntityId: "a-id", title: "Alpha", type: "file", sourceRank: 1 },
          ],
          status: { source: "b", state: "complete", retryable: false },
        }) as any,
    } as any)

    const result = await federatedKnowledgeSearch(
      { query: "q", limit: 10, mode: "both", filters: {}, cursors: {} },
      {
        actor,
        registry,
        localSearch: async () => ({
          hits: [],
          status: { source: "knowledge", state: "complete", retryable: false },
        }),
      },
    )
    // Title-asc: Alpha before Zeta.
    expect(result.hits.map((h) => h.title)).toEqual(["Alpha", "Zeta"])
    expect(result.hits[0]!.fusedRank).toBeCloseTo(result.hits[1]!.fusedRank!, 9)
  })
})

describe("attachSyncedSourceApp", () => {
  const hit = (over: Partial<KnowledgeSearchHit>): KnowledgeSearchHit => ({
    source: "knowledge",
    sourceEntityId: "d1",
    title: "Manual",
    type: "document",
    ...over,
  })

  it("tags a document hit whose id maps to a synced source app", () => {
    const out = attachSyncedSourceApp([hit({ sourceEntityId: "d1" })], new Map([["d1", "gitlab"]]))
    expect(out[0]!.syncedSourceApp).toBe("gitlab")
  })

  it("leaves non-synced document hits and source_link hits untouched", () => {
    const out = attachSyncedSourceApp(
      [
        hit({ sourceEntityId: "d1" }), // not in the map
        hit({ sourceEntityId: "sl1", type: "source_link" }),
      ],
      new Map([["sl1", "gitlab"]]), // even if a source_link id collides, skip it
    )
    expect(out[0]!.syncedSourceApp).toBeUndefined()
    expect(out[1]!.syncedSourceApp).toBeUndefined()
  })

  it("is a no-op when the map is empty (returns the same array reference)", () => {
    const hits = [hit({})]
    expect(attachSyncedSourceApp(hits, new Map())).toBe(hits)
  })
})
