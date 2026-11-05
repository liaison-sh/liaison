// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Lists Knowledge documents that have no collection_membership row. Reached
 * via the auto-appearing "Unfiled" sidebar entry. Loads on mount from
 * `GET /api/knowledge/documents?filter=unfiled`.
 */

import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { ScrollFade } from "~/ui/ScrollFade"
import { listUnfiledKnowledgeDocuments } from "./knowledge-api"

interface DocRow {
  id: string
  title: string
  updatedAt?: string
}

const KnowledgeUnfiledView: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [docs, setDocs] = createSignal<DocRow[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string | null>(null)

  onMount(async () => {
    try {
      const data = (await listUnfiledKnowledgeDocuments(api as any)) as DocRow[]
      setDocs(Array.isArray(data) ? data : [])
    } catch (err) {
      // Surface the error explicitly — never let a failure look like an
      // empty success (the rest of the knowledge module follows the same
      // pattern via `loadKnowledgeHome`).
      setError(err instanceof Error ? err.message : "Failed to load unfiled documents")
    } finally {
      setLoading(false)
    }
  })

  return (
    <ScrollFade class="min-h-0 flex-1" fadeColor="var(--color-bg)">
      <div data-testid="knowledge-unfiled" class="mx-auto w-full max-w-2xl px-8 py-10">
        <header class="mb-4">
          <h1 class="text-[15px] font-medium text-text">{i18n.t("knowledge.unfiled")}</h1>
          <p class="text-[12px] text-text-tertiary">
            {i18n.t("knowledge.documentsNotInAnyCollectionAdd")}
          </p>
        </header>
        <Show when={error()}>
          <p data-testid="knowledge-unfiled-error" class="mb-3 text-[13px] text-red-300">
            {error()}
          </p>
        </Show>
        <Show
          when={!loading() && !error() && docs().length > 0}
          fallback={
            <Show when={!error()}>
              <p data-testid="knowledge-unfiled-empty" class="text-[13px] text-text-tertiary">
                {loading() ? i18n.t("kernel.common.loading2") : i18n.t("knowledge.nothingUnfiled")}
              </p>
            </Show>
          }
        >
          <ul class="flex flex-col gap-1">
            <For each={docs()}>
              {(doc) => (
                <li>
                  <button
                    type="button"
                    data-testid={`knowledge-unfiled-${doc.id}`}
                    class="flex w-full items-center justify-between rounded-md px-3 py-2 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
                    onClick={() =>
                      openTab({
                        type: "knowledge:document",
                        entityId: doc.id,
                        label: doc.title,
                      })
                    }
                  >
                    <span class="text-[13px] text-text">{doc.title}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </ScrollFade>
  )
}

export default KnowledgeUnfiledView
