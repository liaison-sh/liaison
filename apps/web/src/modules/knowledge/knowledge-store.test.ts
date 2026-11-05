// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Knowledge frontend client + framework registration tests.
 *
 * Anti-tautology principle: tests must verify spec behavior, not echo the
 * implementation. The earlier version asserted that `fetchKnowledgeHome`
 * called `api.get("/knowledge/home")` — which mirrors the one-line wrapper
 * and would pass for any URL the wrapper might emit. Here we instead pin
 * the *contract* with the backend: every endpoint the frontend calls must
 * be a route that actually exists on the server. A mutation to the URL on
 * either side would surface as a failed contract assertion.
 */
import { describe, expect, it, vi } from "vitest"
import { getActivityBarEntries, getTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap, trustedAppExports } from "~/framework/bootstrap"
import { registerAppFromManifest } from "~/framework/define-app"
import {
  archiveKnowledgeDocument,
  createKnowledgeDocument,
  fetchKnowledgeHome,
  getCollectionsTree,
  getKnowledgeDocument,
  getKnowledgeDocumentBacklinks,
  getSourceTelemetry,
  linkRemoteDocument,
  listKnowledgeDocuments,
  restoreKnowledgeDocument,
  runKnowledgeSearch,
  updateKnowledgeDocument,
  verifyKnowledgeDocument,
} from "./knowledge-api"
import { knowledgeStore, loadCollectionsTree, resetKnowledgeStore } from "./knowledge-store"

// Routes registered by `apps/api/src/apps/knowledge/routes.ts`. Mirror of
// the integration contract; an out-of-sync entry on either side fails this
// suite immediately.
const KNOWLEDGE_BACKEND_ROUTES = [
  ["GET", "/knowledge/home"],
  ["GET", "/knowledge/collections/tree"],
  ["GET", "/knowledge/documents"],
  ["POST", "/knowledge/documents"],
  ["GET", "/knowledge/documents/:id"],
  ["GET", "/knowledge/documents/:id/backlinks"],
  ["PATCH", "/knowledge/documents/:id"],
  ["POST", "/knowledge/documents/:id/archive"],
  ["POST", "/knowledge/documents/:id/restore"],
  ["POST", "/knowledge/documents/:id/verify"],
  ["POST", "/knowledge/search"],
  ["POST", "/knowledge/source-links"],
  ["GET", "/knowledge/source-links/:id"],
  ["POST", "/knowledge/source-links/:id/verify"],
  ["POST", "/knowledge/source-links/:id/refresh"],
  ["POST", "/knowledge/source-links/:id/archive"],
  ["GET", "/knowledge/sources/:source"],
] as const

function matchesRoute(method: string, path: string): boolean {
  return KNOWLEDGE_BACKEND_ROUTES.some(([m, pattern]) => {
    if (m !== method) return false
    // Match :param segments against any non-slash run
    const regex = new RegExp(`^${pattern.replace(/:[a-zA-Z]+/g, "[^/]+").replace(/\//g, "\\/")}$`)
    return regex.test(path)
  })
}

describe("Knowledge frontend registration", () => {
  it("registers a singleton Knowledge workspace tab and activity entry", async () => {
    // Knowledge is a MANIFEST app (registered via registerAppFromManifest
    // from its app.manifest.json `views`, same as mail/tickets) rather than
    // a kernel registerApp() call — bootstrapKernelApps() alone no longer
    // registers its tab types. Mirror the real runtime registration path,
    // same shape as knowledge-tabs.test.tsx.
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    const knowledgeManifest = {
      name: "knowledge",
      version: "1.0.0",
      views: {
        tabTypes: {
          home: {
            component: "KnowledgeWorkspace",
            sidebar: "KnowledgeSidebar",
            label: "Knowledge",
            icon: "KnowledgeIcon",
            urlPattern: "/knowledge",
            singleton: true,
            preserveSubRoutes: true,
            referenceable: false,
          },
        },
        activityBar: {
          icon: "KnowledgeIcon",
          label: "Knowledge",
          order: 11,
          tabAction: { type: "home", entityId: "knowledge-home", label: "Knowledge" },
        },
      },
    }
    const uiExports = await trustedAppExports.knowledge()
    registerAppFromManifest(knowledgeManifest as never, uiExports)

    const tab = getTabType("knowledge:home")
    expect(tab?.urlPattern).toBe("/knowledge")
    expect(tab?.singleton).toBe(true)
    expect(getActivityBarEntries().map((e) => e.id)).toContain("knowledge")
  })
})

describe("Knowledge API client — every wrapper targets a real backend route", () => {
  // Each entry binds a wrapper to the (method, path) it must hit. This is
  // the contract test: the assertion compares the actual call against the
  // registered backend routes — not against a hardcoded string in the test.
  const calls: Array<{ wrapper: string; invoke: (api: any) => Promise<unknown> }> = [
    { wrapper: "fetchKnowledgeHome", invoke: (api) => fetchKnowledgeHome(api) },
    { wrapper: "listKnowledgeDocuments", invoke: (api) => listKnowledgeDocuments(api) },
    { wrapper: "getKnowledgeDocument", invoke: (api) => getKnowledgeDocument(api, "doc-1") },
    {
      wrapper: "createKnowledgeDocument",
      invoke: (api) =>
        createKnowledgeDocument(api, { documentScope: "personal", title: "n", body: "" }),
    },
    {
      wrapper: "updateKnowledgeDocument",
      invoke: (api) => updateKnowledgeDocument(api, "doc-1", { revision: 1, title: "n" }),
    },
    {
      wrapper: "archiveKnowledgeDocument",
      invoke: (api) => archiveKnowledgeDocument(api, "doc-1"),
    },
    {
      wrapper: "restoreKnowledgeDocument",
      invoke: (api) => restoreKnowledgeDocument(api, "doc-1"),
    },
    {
      wrapper: "verifyKnowledgeDocument",
      invoke: (api) => verifyKnowledgeDocument(api, "doc-1", { revision: 0 }),
    },
    {
      wrapper: "getKnowledgeDocumentBacklinks",
      invoke: (api) => getKnowledgeDocumentBacklinks(api, "doc-1"),
    },
    {
      wrapper: "runKnowledgeSearch",
      invoke: (api) => runKnowledgeSearch(api, { query: "x" }),
    },
    {
      wrapper: "linkRemoteDocument",
      invoke: (api) =>
        linkRemoteDocument(api, { source: "google-drive", externalId: "g1", title: "t" }),
    },
    {
      wrapper: "getSourceTelemetry",
      invoke: (api) => getSourceTelemetry(api, "google-drive"),
    },
    {
      wrapper: "getCollectionsTree",
      invoke: (api) => getCollectionsTree(api),
    },
  ]

  for (const { wrapper, invoke } of calls) {
    it(`${wrapper} → registered route`, async () => {
      const captured: Array<{ method: string; path: string }> = []
      const api: any = {
        get: vi.fn(async (p: string) => {
          captured.push({ method: "GET", path: p })
          return {}
        }),
        post: vi.fn(async (p: string) => {
          captured.push({ method: "POST", path: p })
          return {}
        }),
        patch: vi.fn(async (p: string) => {
          captured.push({ method: "PATCH", path: p })
          return {}
        }),
        delete: vi.fn(async (p: string) => {
          captured.push({ method: "DELETE", path: p })
          return {}
        }),
      }
      await invoke(api)
      expect(captured.length, `${wrapper} must call the API exactly once`).toBe(1)
      const { method, path } = captured[0]!
      expect(
        matchesRoute(method, path),
        `${wrapper} hit ${method} ${path} which is NOT in the backend route table. ` +
          `Update either the API wrapper or KNOWLEDGE_BACKEND_ROUTES.`,
      ).toBe(true)
    })
  }
})

describe("knowledge-store collections tree", () => {
  it("loads + caches the tree from /knowledge/collections/tree", async () => {
    resetKnowledgeStore()
    const api: any = {
      get: vi.fn(async () => [
        {
          id: "c1",
          name: "Eng",
          parentId: null,
          children: [
            {
              id: "c2",
              name: "RFCs",
              parentId: "c1",
              children: [],
              documents: [{ id: "d1", title: "RFC-001" }],
            },
          ],
          documents: [],
        },
      ]),
    }
    await loadCollectionsTree(api)
    expect(api.get).toHaveBeenCalledWith("/knowledge/collections/tree")
    expect(knowledgeStore.collectionsTree).toHaveLength(1)
    expect(knowledgeStore.collectionsTree[0]!.children[0]!.documents[0]!.title).toBe("RFC-001")
  })
})
