// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test-only ctx double for the calls app (monitoring test-ctx convention,
// extended with an `executeTool` fake because — unlike monitoring — this app
// owns NO tables: every write goes cross-app into knowledge via
// `ctx.executeTool`, so the double simulates knowledge's create/update/get/
// search semantics faithfully:
//   • create: exact-title upsert guard (rpc-bridge.ts knowledge_create BL-275
//     redirect — an org create colliding with an existing non-archived org doc
//     of the EXACT same title returns that doc with `redirectedToUpdate: true`
//     and a bumped revision, applying body/summary ONLY when present in params)
//   • update: optimistic-concurrency `revision` compare → REVISION_CONFLICT
//     error envelope on mismatch (service.ts:1027-1028)
//   • get: `{ status: "available", document }` shape (knowledge_get bridge)
//   • search: `{ hits: [{ source, sourceEntityId, title, type }] }` shape
//     (federatedKnowledgeSearch → FederatedKnowledgeSearchResult)
// Imported only from *.test.ts files — never bundled.
import { noopLogger, TEST_ORG_ID, TEST_USER_ID } from "@liaison/test-helpers/app-ctx"
import type { CallsCtx, CrossAppEnvelope } from "./ctx"

export interface FakeKnowledgeDoc {
  id: string
  title: string
  body: string
  revision: number
  summary?: string | null
}

export interface KnowledgeSpy {
  docs: Map<string, FakeKnowledgeDoc> // keyed by id
  calls: Array<{ target: string; args: Record<string, unknown> }>
  /** Fire once right before the FIRST knowledge:update executes — lets a test
   *  interleave a competing write to force a deterministic REVISION_CONFLICT. */
  onBeforeFirstUpdate?: () => Promise<void> | void
  /** When >0, the next N knowledge:update calls fail with a transient error. */
  failUpdatesRemaining: number
  /** When >0, the next N knowledge:get calls return a non-"available" envelope
   *  (simulates a transient read hiccup — e.g. mid-REVISION_CONFLICT-retry
   *  re-read failing — the C1/C2 edge: readDoc's fallback-to-resolveOrCreateDoc
   *  path when the post-conflict re-read itself comes back null). */
  failGetsRemaining: number
  /** When true, knowledge:search returns no hits (simulates Meili index lag). */
  searchReturnsNothing: boolean
  /** When true, knowledge:find_by_title errors out (simulates the tool being unavailable —
   *  the resolution fallback-to-search path this forces is what U5.8's fallback test proves). */
  findByTitleErrors: boolean
  config: Record<string, unknown>
}

let nextDocId = 1

export function makeCtx(overrides?: { config?: Record<string, unknown> }): {
  ctx: CallsCtx
  spy: KnowledgeSpy
} {
  const spy: KnowledgeSpy = {
    docs: new Map(),
    calls: [],
    failUpdatesRemaining: 0,
    failGetsRemaining: 0,
    searchReturnsNothing: false,
    findByTitleErrors: false,
    config: overrides?.config ?? {},
  }
  let firstUpdateHookPending = true

  const executeTool = async (
    target: string,
    args: Record<string, unknown>,
  ): Promise<CrossAppEnvelope> => {
    spy.calls.push({ target, args })

    if (target === "knowledge:create") {
      const title = String(args.title ?? "").trim()
      // Exact-title upsert guard (BL-275 redirect) — mirrors knowledge_create.
      const existing = [...spy.docs.values()].find((d) => d.title === title)
      if (existing) {
        existing.revision += 1
        if (args.body !== undefined) existing.body = String(args.body)
        if (args.summary !== undefined) existing.summary = args.summary as string | null
        return { status: "completed", result: { ...existing, redirectedToUpdate: true } }
      }
      const doc: FakeKnowledgeDoc = {
        id: `doc-${nextDocId++}`,
        title,
        body: args.body !== undefined ? String(args.body) : "",
        revision: 1,
        summary: (args.summary as string | null) ?? null,
      }
      spy.docs.set(doc.id, doc)
      return { status: "completed", result: { ...doc } }
    }

    if (target === "knowledge:update") {
      if (firstUpdateHookPending && spy.onBeforeFirstUpdate) {
        firstUpdateHookPending = false
        await spy.onBeforeFirstUpdate()
      }
      if (spy.failUpdatesRemaining > 0) {
        spy.failUpdatesRemaining -= 1
        return {
          status: "error",
          error: { code: "tool_error", message: "transient failure (test)", retryable: true },
        }
      }
      const doc = spy.docs.get(String(args.id))
      if (!doc) {
        return {
          status: "error",
          error: {
            code: "tool_error",
            message: "NOT_FOUND: Knowledge item not found",
            retryable: false,
          },
        }
      }
      if (doc.revision !== args.revision) {
        // service.ts:1027-1028 — KnowledgeError("REVISION_CONFLICT", "Revision conflict")
        return {
          status: "error",
          error: {
            code: "tool_error",
            message: "REVISION_CONFLICT: Revision conflict",
            retryable: false,
          },
        }
      }
      doc.revision += 1
      if (args.body !== undefined) doc.body = String(args.body)
      if (args.summary !== undefined) doc.summary = args.summary as string | null
      return { status: "completed", result: { ...doc } }
    }

    if (target === "knowledge:get") {
      if (spy.failGetsRemaining > 0) {
        spy.failGetsRemaining -= 1
        return { status: "completed", result: { status: "not_found" } }
      }
      const doc = spy.docs.get(String(args.id))
      if (!doc) return { status: "completed", result: { status: "not_found" } }
      return { status: "completed", result: { status: "available", document: { ...doc } } }
    }

    if (target === "knowledge:find_by_title") {
      if (spy.findByTitleErrors) {
        return {
          status: "error",
          error: {
            code: "tool_error",
            message: "find_by_title unavailable (test)",
            retryable: true,
          },
        }
      }
      const title = String(args.title ?? "").trim()
      const includeArchived = Boolean(args.includeArchived)
      const doc = [...spy.docs.values()].find((d) => d.title === title)
      if (!doc || (!includeArchived && (doc as { archived?: boolean }).archived)) {
        return { status: "completed", result: { found: false, document: null } }
      }
      return {
        status: "completed",
        result: {
          found: true,
          document: {
            id: doc.id,
            revision: doc.revision,
            title: doc.title,
            archived: Boolean((doc as { archived?: boolean }).archived),
          },
        },
      }
    }

    if (target === "knowledge:search") {
      if (spy.searchReturnsNothing) return { status: "completed", result: { hits: [] } }
      const q = String(args.query ?? "").toLowerCase()
      const hits = [...spy.docs.values()]
        .filter((d) => d.title.toLowerCase().includes(q))
        .map((d, i) => ({
          source: "knowledge",
          sourceEntityId: d.id,
          title: d.title,
          type: "document",
          sourceRank: i + 1,
        }))
      return { status: "completed", result: { hits } }
    }

    return {
      status: "error",
      error: { code: "unknown_tool", message: `unmocked tool ${target}`, retryable: false },
    }
  }

  const ctx = {
    userId: TEST_USER_ID,
    orgId: TEST_ORG_ID,
    executeTool,
    config: {
      get: async (key: string) => spy.config[key] ?? null,
      has: async (key: string) => {
        const v = spy.config[key]
        return v !== undefined && v !== null && v !== ""
      },
    },
    logger: noopLogger(),
  } as unknown as CallsCtx

  return { ctx, spy }
}

/** The single doc whose title matches the call title convention, or null. */
export function docByTitle(spy: KnowledgeSpy, title: string): FakeKnowledgeDoc | null {
  return [...spy.docs.values()].find((d) => d.title === title) ?? null
}
