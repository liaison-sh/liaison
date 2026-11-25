// SPDX-License-Identifier: FSL-1.1-ALv2
// Every component/handler the knowledge manifest's `views` declares must be
// exported here — a missing export aborts the whole manifest-app registration.
import { lazy } from "solid-js"
import { getAttentionApi } from "~/modules/shell/attention-store"
import { getKnowledgeDocument } from "./knowledge-api"
import {
  handleKnowledgeDocumentUpdate,
  knowledgeStore,
  loadKnowledgeHome,
  markSyncedSourceArchived,
  scheduleCollectionsTreeReload,
} from "./knowledge-store"
import { refreshPageTitle } from "./page-links"

export { registerEntityPreviews } from "./entity-preview-renderers"
export { default as KnowledgeIcon } from "./KnowledgeIcon"
export const KnowledgeWorkspace = lazy(() => import("./KnowledgeWorkspace"))
export const KnowledgeSidebar = lazy(() => import("./KnowledgeSidebar"))
export const KnowledgeDocumentView = lazy(() => import("./KnowledgeDocumentView"))
export const KnowledgeLinkedSourceView = lazy(() => import("./KnowledgeLinkedSourceView"))
export const KnowledgeFolderView = lazy(() => import("./KnowledgeFolderView"))
export const SyncedSourceAddTab = lazy(() => import("./SyncedSourceAddTab"))
// Custom block of the Knowledge settings page (manifest `settings`).
export const SyncedSourceAdd = lazy(() =>
  import("./SyncedSourceAdd").then((m) => ({ default: m.SyncedSourceAdd })),
)

// Dynamic tab label for knowledge:document tabs — mirrors the kernel
// registration's former inline resolveLabel.
// Reads every place the client knows a page from: the page itself once opened
// or refreshed by an event, the recent list, then the folder tree (which holds
// every page the reader sees, not only the newest).
export function resolveKnowledgeDocLabel(entityId: string): string | undefined {
  if (!entityId) return undefined
  const cached = knowledgeStore.documentsById[entityId]?.title
  if (cached) return cached
  const listed = knowledgeStore.documents.find((d) => d.id === entityId)?.title
  if (listed) return listed
  const walk = (nodes: typeof knowledgeStore.collectionsTree): string | undefined => {
    for (const n of nodes) {
      const hit = n.documents.find((d) => d.id === entityId)?.title ?? walk(n.children)
      if (hit) return hit
    }
    return undefined
  }
  return walk(knowledgeStore.collectionsTree)
}

// Dynamic tab label for knowledge:folder tabs: the folder's name, as the tree shows it.
export function resolveKnowledgeFolderLabel(entityId: string): string | undefined {
  if (!entityId) return undefined
  const find = (nodes: typeof knowledgeStore.collectionsTree): string | undefined => {
    for (const node of nodes) {
      if (node.id === entityId) return node.name
      const below = find(node.children)
      if (below) return below
    }
    return undefined
  }
  return find(knowledgeStore.collectionsTree)
}

// WS handlers (manifest views.wsHandlers → these by name). Signatures/behavior
// moved verbatim from the former kernel registration's inline handlers, with
// the "create" branch added so the Knowledge home "Recently touched" feed
// updates live when the agent creates a document (Create-from-panel flow):
// - "create": the doc didn't exist locally — just refresh the home feed so
//   the new entry appears (no single-doc cache to refresh yet).
// - "update": refresh the single cached doc (H-6 rev short-circuit) AND
//   refresh the home feed so reordering/title changes stay live.
// - anything else: ignored.
export async function handleKnowledgeDocumentWsEvent(
  action: string,
  data: unknown,
  _ctx?: unknown,
): Promise<void> {
  const api = getAttentionApi()
  // Renamed, moved to Trash, restored, shared: the chips that show this page ask
  // again for its title (only those this reader has on screen; the server decides).
  if (action !== "create") {
    const changed = data as { entityId?: string; id?: string } | null
    refreshPageTitle(api, changed?.entityId ?? changed?.id)
  }
  if (!api) return
  // Any change to a page can change its row (title, place, gone): the tree
  // reloads once per burst, this reader's own changes included.
  scheduleCollectionsTreeReload(api)
  if (action !== "create" && action !== "update") return

  if (action === "create") {
    await loadKnowledgeHome(api)
    return
  }

  const payload = (data ?? {}) as {
    entityId?: string
    id?: string
    externalRev?: string | null
    lastSyncAt?: string
  }
  await handleKnowledgeDocumentUpdate(payload, async (id) => {
    try {
      const fresh = (await getKnowledgeDocument(api, id)) as unknown as {
        id: string
        title: string
        body: string
        externalRev?: string | null
        lastSyncedAt?: string | null
        syncedSourceId?: string | null
      }
      return fresh
    } catch {
      return null
    }
  })
  await loadKnowledgeHome(api)
}

// A folder or a filing changed. Frames carry ids only, and reach only readers
// of the folder (or those who just lost it): the tree reloads once per burst.
export function handleKnowledgeCollectionWsEvent(
  _action: string,
  _data: unknown,
  _ctx?: unknown,
): void {
  const api = getAttentionApi()
  if (!api) return
  scheduleCollectionsTreeReload(api)
}

export function handleSyncedSourceWsEvent(action: string, data: unknown, _ctx?: unknown): void {
  if (action !== "archive") return
  const id =
    (data as { id?: string; entityId?: string } | undefined)?.id ??
    (data as { entityId?: string } | undefined)?.entityId
  if (!id) return
  markSyncedSourceArchived(id)
}
