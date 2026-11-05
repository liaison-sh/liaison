// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * P4c-T36: the agent page's Knowledge tab.
 *
 * POINTERS, NOT DOCUMENTS. An agent does not own knowledge; it is pointed at
 * collections, and each row here is one such pointer. The tab therefore lists
 * what the agent reads and sends the reader to the Knowledge workspace to act
 * on it: the collection's real home, with its own permissions and its own
 * editing surface, never a second half-copy of it here.
 *
 * BACKEND CONTRACT (P4c-T32):
 *   GET /api/agents/:agentId/knowledge
 *       -> { data: [{ id, collectionId, collectionName, documentCount,
 *                     lastUpdatedAt, createdAt }] }
 *
 * A backend without the route answers 404, which renders as an EMPTY list
 * rather than a failure: the tab is inert, never broken, the same way the
 * Memory tree degrades.
 */
import { BookOpen } from "lucide-solid"
import { type Component, createResource, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { formatRelativeTime, rowLocaleFrom } from "~/modules/shell/attention-row-format"
import { openTab } from "~/modules/shell/tab-store"

interface KnowledgePointer {
  id: string
  collectionId: string
  collectionName: string
  /** How many documents this reader may see in the collection, or null when
   *  the backend predates the join. */
  documentCount: number | null
  /** When the freshest of those documents last changed. */
  lastUpdatedAt: string | null
  createdAt?: string | null
}

function normalize(raw: any): KnowledgePointer | null {
  if (typeof raw?.collectionId !== "string") return null
  return {
    id: typeof raw.id === "string" ? raw.id : raw.collectionId,
    collectionId: raw.collectionId,
    collectionName:
      typeof raw.collectionName === "string" && raw.collectionName.length > 0
        ? raw.collectionName
        : raw.collectionId,
    documentCount: typeof raw.documentCount === "number" ? raw.documentCount : null,
    lastUpdatedAt: typeof raw.lastUpdatedAt === "string" ? raw.lastUpdatedAt : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : null,
  }
}

interface Props {
  agentId: string
}

const AgentKnowledgeTab: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()

  const [pointers] = createResource<KnowledgePointer[], string>(
    () => props.agentId || undefined,
    async (agentId) => {
      try {
        const res = await api.get<any>(`/agents/${agentId}/knowledge`)
        const raw = Array.isArray(res) ? res : (res?.data ?? [])
        return (Array.isArray(raw) ? raw : [])
          .map(normalize)
          .filter((p): p is KnowledgePointer => p !== null)
      } catch {
        return []
      }
    },
  )

  /** "1 document" / "12 documents" / "No documents yet", with no plural engine
   *  in the catalog to lean on. */
  function documentCountLabel(n: number): string {
    if (n === 0) return i18n.t("kernel.agents.knowledgeNoDocuments")
    if (n === 1) return i18n.t("kernel.agents.knowledgeDocumentOne")
    return i18n.t("kernel.agents.knowledgeDocumentsMany", { n })
  }

  /** The Knowledge workspace is a singleton tab, so this activates the one the
   *  reader already has rather than stacking another. */
  function openKnowledge() {
    openTab({
      type: "knowledge:home",
      entityId: "knowledge-home",
      label: i18n.t("kernel.agentUi.knowledge"),
    })
  }

  return (
    <div data-testid="agent-knowledge-tab" class="flex h-full min-h-0 flex-col">
      <Show
        when={(pointers() ?? []).length > 0}
        fallback={
          <div
            data-testid="agent-knowledge-empty"
            class="flex flex-col items-center gap-2 px-6 py-12 text-center text-text-tertiary"
          >
            <BookOpen size={20} class="text-text-tertiary" />
            <p class="text-[13px]">{i18n.t("kernel.agents.knowledgeEmpty")}</p>
          </div>
        }
      >
        <div class="min-h-0 flex-1 overflow-auto">
          <For each={pointers() ?? []}>
            {(p) => (
              <div
                data-testid={`agent-knowledge-row-${p.collectionId}`}
                class="flex items-center gap-3 border-b border-border-subtle px-4 py-3"
              >
                {/* A NAME ALONE SAID NOTHING. Every pointer row read as the
                    same row: what a reader wants to know about a collection an
                    agent reads is how much is in it and whether it is current. */}
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate text-[13px] text-text">{p.collectionName}</span>
                  <Show when={p.documentCount !== null}>
                    <span
                      data-testid={`agent-knowledge-meta-${p.collectionId}`}
                      class="truncate text-[11px] text-text-tertiary"
                    >
                      {documentCountLabel(p.documentCount as number)}
                      <Show when={p.lastUpdatedAt}>
                        {(at) => (
                          <>
                            <span aria-hidden="true"> · </span>
                            {i18n.t("kernel.agents.knowledgeUpdated", {
                              when: formatRelativeTime(at(), { i18n: rowLocaleFrom(i18n) }),
                            })}
                          </>
                        )}
                      </Show>
                    </span>
                  </Show>
                </div>
                <button
                  type="button"
                  data-testid={`agent-knowledge-open-${p.collectionId}`}
                  onClick={openKnowledge}
                  class="shrink-0 rounded-md border border-border-subtle px-2.5 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover"
                >
                  {i18n.t("kernel.agents.openInKnowledge")}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default AgentKnowledgeTab
