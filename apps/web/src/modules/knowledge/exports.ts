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
} from "./knowledge-store"

export { registerEntityPreviews } from "./entity-preview-renderers"
export { default as KnowledgeIcon } from "./KnowledgeIcon"
export const KnowledgeWorkspace = lazy(() => import("./KnowledgeWorkspace"))
export const KnowledgeSidebar = lazy(() => import("./KnowledgeSidebar"))
export const KnowledgeDocumentView = lazy(() => import("./KnowledgeDocumentView"))
export const KnowledgeLinkedSourceView = lazy(() => import("./KnowledgeLinkedSourceView"))
export const SyncedSourceAddTab = lazy(() => import("./SyncedSourceAddTab"))
// Custom block of the Knowledge settings page (manifest `settings`).
export const SyncedSourceAdd = lazy(() =>
  import("./SyncedSourceAdd").then((m) => ({ default: m.SyncedSourceAdd })),
)

// Dynamic tab label for knowledge:document tabs — mirrors the kernel
// registration's former inline resolveLabel.
export function resolveKnowledgeDocLabel(entityId: string): string | undefined {
  if (!entityId) return undefined
  return knowledgeStore.documents.find((d) => d.id === entityId)?.title
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
  if (action !== "create" && action !== "update") return
  const api = getAttentionApi()
  if (!api) return

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

export function handleSyncedSourceWsEvent(action: string, data: unknown, _ctx?: unknown): void {
  if (action !== "archive") return
  const id =
    (data as { id?: string; entityId?: string } | undefined)?.id ??
    (data as { entityId?: string } | undefined)?.entityId
  if (!id) return
  markSyncedSourceArchived(id)
}
