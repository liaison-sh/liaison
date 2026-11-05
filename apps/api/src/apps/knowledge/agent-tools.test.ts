// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  handleKnowledgeAddToCollection,
  handleKnowledgeCollectionCreate,
  handleKnowledgeCollectionDelete,
  handleKnowledgeCollectionUpdate,
  handleKnowledgeFindByTitle,
  handleKnowledgeRemoveFromCollection,
  handleKnowledgeSearch,
  KnowledgeAgentToolsTestAccess,
} from "./agent-tools"
import { KnowledgeError } from "./service"

const actor = {
  orgId: "org-1",
  userId: "u1",
  scopes: ["knowledge:documents:read", "knowledge:sources:read"],
  dimensionGrants: {},
}

describe("Knowledge agent tools", () => {
  beforeEach(() => KnowledgeAgentToolsTestAccess.resetDedupe())
  afterEach(() => KnowledgeAgentToolsTestAccess.setClock(null))

  it("search returns candidates and source statuses without fetching remote bodies", async () => {
    let fetched = 0
    const result = await handleKnowledgeSearch({ query: "policy", limit: 10 }, {
      actor,
      orgId: "org-1",
      federatedSearch: async () => ({
        hits: [
          {
            source: "google-drive",
            sourceEntityId: "g1",
            title: "Policy",
            canFetchContent: true,
            status: "available",
          },
        ],
        sourceStatuses: [{ source: "google-drive", state: "complete", retryable: false }],
        final: true,
      }),
      fetchRemoteContent: async () => {
        fetched++
        return {}
      },
    } as any)
    expect(result.hits[0].title).toBe("Policy")
    expect(fetched).toBe(0)
  })

  it("find_by_title returns found:true + the doc's id/revision/title/archived for an exact match", async () => {
    const result = await handleKnowledgeFindByTitle({ title: "Appel — call-123" }, {
      actor,
      orgId: "org-1",
      findByTitle: async (title: string) => {
        expect(title).toBe("Appel — call-123")
        return { id: "doc-1", revision: 3, title: "Appel — call-123", archivedAt: null }
      },
    } as any)
    expect(result).toEqual({
      found: true,
      document: { id: "doc-1", revision: 3, title: "Appel — call-123", archived: false },
    })
  })

  it("find_by_title returns found:false + null document when no match exists (DB-backed, no error)", async () => {
    const result = await handleKnowledgeFindByTitle({ title: "Appel — nope" }, {
      actor,
      orgId: "org-1",
      findByTitle: async () => null,
    } as any)
    expect(result).toEqual({ found: false, document: null })
  })

  it("find_by_title reports archived:true for an archived doc only when includeArchived was passed through", async () => {
    let capturedOpts: { includeArchived?: boolean } | undefined
    const result = await handleKnowledgeFindByTitle(
      { title: "Appel — archived-call", includeArchived: true },
      {
        actor,
        orgId: "org-1",
        findByTitle: async (_title: string, _a: unknown, opts: { includeArchived?: boolean }) => {
          capturedOpts = opts
          return {
            id: "doc-2",
            revision: 1,
            title: "Appel — archived-call",
            archivedAt: "2026-07-01T00:00:00Z",
          }
        },
      } as any,
    )
    expect(capturedOpts).toEqual({ includeArchived: true })
    expect(result.document?.archived).toBe(true)
  })

  it("find_by_title trims the title before lookup and rejects an empty title", async () => {
    await expect(
      handleKnowledgeFindByTitle({ title: "   " }, {
        actor,
        orgId: "org-1",
        findByTitle: async () => null,
      } as any),
    ).rejects.toThrow(/title is required/i)
  })

  // U5.8 staging gate regression: the CROSS-APP caller (calls app) holds the scope in
  // WILDCARD form (e.g. `knowledge:*` from the cross-app attribution), not the literal
  // string — a literal scopes.includes() check 403'd every calls_segments_since call on
  // staging ("Missing knowledge:documents:read scope") while knowledge:search passed
  // (its enforcement is wildcard-honoring). find_by_title must honor wildcards too.
  it("find_by_title accepts a wildcard scope grant (knowledge:* / *), like every other scope gate", async () => {
    for (const scopes of [["knowledge:*"], ["*"]]) {
      const result = await handleKnowledgeFindByTitle({ title: "Appel — call-123" }, {
        actor: { ...actor, scopes },
        orgId: "org-1",
        findByTitle: async () => ({
          id: "doc-1",
          revision: 1,
          title: "Appel — call-123",
          archivedAt: null,
        }),
      } as any)
      expect(result.found).toBe(true)
    }
  })

  it("find_by_title requires knowledge:documents:read scope", async () => {
    await expect(
      handleKnowledgeFindByTitle({ title: "Appel — call-123" }, {
        actor: { ...actor, scopes: [] },
        orgId: "org-1",
        findByTitle: async () => null,
      } as any),
    ).rejects.toThrow(/knowledge:documents:read/)
  })

  it("emits agent_requested attention when knowledge_search returns zero authorized hits", async () => {
    const emitted: Array<Record<string, unknown>> = []
    const deps = {
      actor,
      orgId: "org-1",
      federatedSearch: async () => ({
        hits: [],
        sourceStatuses: [{ source: "knowledge", state: "complete", retryable: false }],
        final: true,
      }),
      emitAttention: async (item: Record<string, unknown>) => {
        emitted.push(item)
      },
    }
    await handleKnowledgeSearch(
      { query: "nonexistent policy", limit: 10, sources: ["knowledge"] },
      deps as any,
    )
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      kind: "knowledge_review",
      reason: "agent_requested",
    })
    expect((emitted[0].data as Record<string, unknown>).query).toBe("nonexistent policy")
  })

  it("does not emit agent_requested attention when at least one authorized hit is returned", async () => {
    const emitted: Array<Record<string, unknown>> = []
    const deps = {
      actor,
      orgId: "org-1",
      federatedSearch: async () => ({
        hits: [{ source: "knowledge", sourceEntityId: "d1", title: "Found" }],
        sourceStatuses: [{ source: "knowledge", state: "complete", retryable: false }],
        final: true,
      }),
      emitAttention: async (item: Record<string, unknown>) => {
        emitted.push(item)
      },
    }
    await handleKnowledgeSearch({ query: "found policy", limit: 10 }, deps as any)
    expect(emitted).toHaveLength(0)
  })

  it("dedupes agent_requested attention within a short window per (orgId, normalizedQuery)", async () => {
    const emitted: Array<Record<string, unknown>> = []
    const deps = {
      actor,
      orgId: "org-1",
      federatedSearch: async () => ({ hits: [], sourceStatuses: [], final: true }),
      emitAttention: async (item: Record<string, unknown>) => {
        emitted.push(item)
      },
    }
    await handleKnowledgeSearch({ query: "  POLICY  ", limit: 10 }, deps as any)
    await handleKnowledgeSearch({ query: "policy", limit: 10 }, deps as any)
    await handleKnowledgeSearch({ query: "Policy", limit: 10 }, deps as any)
    expect(emitted).toHaveLength(1)
  })

  it("I12: emits again after the 5-minute dedupe window expires", async () => {
    const emitted: Array<Record<string, unknown>> = []
    let clock = 1_000_000
    KnowledgeAgentToolsTestAccess.setClock(() => clock)
    const deps = {
      actor,
      orgId: "org-1",
      federatedSearch: async () => ({ hits: [], sourceStatuses: [], final: true }),
      emitAttention: async (item: Record<string, unknown>) => {
        emitted.push(item)
      },
    }
    // First call → emits
    await handleKnowledgeSearch({ query: "policy", limit: 10 }, deps as any)
    // Still within window → no second emit
    clock += 4 * 60 * 1000
    await handleKnowledgeSearch({ query: "policy", limit: 10 }, deps as any)
    // Past 5 min boundary → emits again
    clock += 2 * 60 * 1000
    await handleKnowledgeSearch({ query: "policy", limit: 10 }, deps as any)
    expect(emitted).toHaveLength(2)
  })

  it("E1: sweep clears expired dedupe entries so the map does not grow unboundedly", async () => {
    let clock = 1_000_000
    KnowledgeAgentToolsTestAccess.setClock(() => clock)
    const deps = {
      actor,
      orgId: "org-1",
      federatedSearch: async () => ({ hits: [], sourceStatuses: [], final: true }),
      emitAttention: async () => {},
    }
    // 2000 distinct queries -> 2000 distinct dedupe keys, all created "now".
    for (let i = 0; i < 2000; i++) {
      await handleKnowledgeSearch({ query: `query-${i}`, limit: 10 }, deps as any)
    }
    expect(KnowledgeAgentToolsTestAccess.dedupeSize()).toBe(2000)

    // Advance well past the 5-minute window, then force a sweep (mirrors the
    // opportunistic sweep that fires automatically once size > threshold).
    clock += 10 * 60 * 1000
    KnowledgeAgentToolsTestAccess.sweepDedupe()
    expect(KnowledgeAgentToolsTestAccess.dedupeSize()).toBe(0)
  })

  it("E1: sweep does not disturb entries still inside their dedupe window", async () => {
    const clock = 1_000_000
    KnowledgeAgentToolsTestAccess.setClock(() => clock)
    const emitted: Array<Record<string, unknown>> = []
    const deps = {
      actor,
      orgId: "org-1",
      federatedSearch: async () => ({ hits: [], sourceStatuses: [], final: true }),
      emitAttention: async (item: Record<string, unknown>) => {
        emitted.push(item)
      },
    }
    // A recent key...
    await handleKnowledgeSearch({ query: "recent-key", limit: 10 }, deps as any)
    // ...plus enough padding keys to trigger the opportunistic sweep threshold
    // on the NEXT call, all created at the same "now" so none are expired yet.
    for (let i = 0; i < 1200; i++) {
      await handleKnowledgeSearch({ query: `pad-${i}`, limit: 10 }, deps as any)
    }
    // Still within the window — the sweep (if it fired) must not have evicted
    // "recent-key", so a repeat search is still deduped (no second emit).
    await handleKnowledgeSearch({ query: "recent-key", limit: 10 }, deps as any)
    const recentEmits = emitted.filter((e) => (e.data as any)?.query === "recent-key")
    expect(recentEmits).toHaveLength(1)
  })
})

const collActor = {
  orgId: "org-1",
  userId: "u1",
  scopes: ["knowledge:collections:manage"],
  dimensionGrants: {},
}

describe("Knowledge agent tools — collections", () => {
  it("collection_create calls deps.createCollection with the actor's grants", async () => {
    const calls: unknown[] = []
    const result = await handleKnowledgeCollectionCreate(
      { name: "RFCs", parentCollectionId: "p1" },
      {
        actor: collActor as never,
        createCollection: async (input: never, actor: never) => {
          calls.push([input, actor])
          return {
            id: "c1",
            orgId: "org-1",
            name: "RFCs",
            description: null,
            parentCollectionId: "p1",
            ownerUserId: "u1",
            maintainerUserIds: [],
            archivedAt: null,
            createdAt: "",
            updatedAt: "",
          } as never
        },
      } as never,
    )
    expect(result.id).toBe("c1")
    expect(calls).toHaveLength(1)
  })

  it("collection_create rejects without knowledge:collections:manage scope", async () => {
    const actor = { ...collActor, scopes: ["knowledge:documents:read"] }
    await expect(
      handleKnowledgeCollectionCreate({ name: "X" }, {
        actor: actor as never,
        createCollection: async () => ({}) as never,
      } as never),
    ).rejects.toThrow(/knowledge:collections:manage/i)
  })

  it("collection_update reparent propagates a cycle error from the service", async () => {
    await expect(
      handleKnowledgeCollectionUpdate({ id: "c1", parentCollectionId: "c1-child" }, {
        actor: collActor as never,
        updateCollection: async () => {
          throw new KnowledgeError("VALIDATION", "Collection hierarchy cycle is not allowed")
        },
      } as never),
    ).rejects.toThrow(/cycle/i)
  })

  it("collection_delete refuses when caller lacks knowledge:collections:manage", async () => {
    const actor = { ...collActor, scopes: ["knowledge:documents:read"] }
    await expect(
      handleKnowledgeCollectionDelete({ id: "c1" }, {
        actor: actor as never,
        archiveCollection: async () => ({}) as never,
      } as never),
    ).rejects.toThrow(/knowledge:collections:manage/i)
  })

  it("add_to_collection wires through addCollectionMembership", async () => {
    const calls: unknown[] = []
    await handleKnowledgeAddToCollection({ collectionId: "c1", documentId: "d1" }, {
      actor: collActor as never,
      addMembership: async (input: never, actor: never) => {
        calls.push([input, actor])
        return { id: "m1" }
      },
    } as never)
    expect(calls).toEqual([
      [{ collectionId: "c1", targetType: "document", targetId: "d1" }, collActor],
    ])
  })

  it("remove_from_collection wires through removeCollectionMembership", async () => {
    const calls: unknown[] = []
    const result = await handleKnowledgeRemoveFromCollection(
      { collectionId: "c1", documentId: "d1" },
      {
        actor: collActor as never,
        removeMembership: async (input: never) => {
          calls.push(input)
        },
      } as never,
    )
    expect(result.ok).toBe(true)
    expect(calls).toEqual([{ collectionId: "c1", targetType: "document", targetId: "d1" }])
  })

  it("add_to_collection propagates NOT_FOUND for unreadable target", async () => {
    await expect(
      handleKnowledgeAddToCollection({ collectionId: "c1", documentId: "d1" }, {
        actor: collActor as never,
        addMembership: async () => {
          throw new KnowledgeError("NOT_FOUND", "Knowledge item not found")
        },
      } as never),
    ).rejects.toThrow(/not found/i)
  })
})
