// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createEffect, createResource, onCleanup, Show } from "solid-js"
import { isSafeUserUrl } from "~/lib/sanitize"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { makeTabId, updateTabLabel } from "~/modules/shell/tab-store"

interface LinkedSource {
  id: string
  title: string
  source: string
  url?: string
  reviewStatus?: string
  status?: string
}

const KnowledgeLinkedSourceView: Component<{ entityId: string }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  let activeController: AbortController | null = null
  onCleanup(() => activeController?.abort())
  const [link] = createResource(
    () => props.entityId,
    async (id: string): Promise<LinkedSource | null> => {
      if (!id || !api) return null
      activeController?.abort()
      const ac = new AbortController()
      activeController = ac
      try {
        return (await api.get(`/knowledge/source-links/${id}`, {
          signal: ac.signal,
        })) as LinkedSource
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err
        return null
      }
    },
  )

  createEffect(() => {
    const l = link()
    if (l?.title) updateTabLabel(makeTabId("knowledge:source_link", props.entityId), l.title)
  })

  return (
    <div data-testid="knowledge-linked-source-view" class="flex flex-col gap-3 p-4">
      <Show
        when={link()}
        fallback={
          <p data-testid="knowledge-linked-not-found" class="text-sm text-text-secondary">
            {i18n.t("knowledge.linkedSourceNotFound")}
          </p>
        }
      >
        {(l) => (
          <>
            <header class="flex flex-col gap-1">
              <h2 data-testid="knowledge-linked-title" class="text-lg font-semibold">
                {l().title}
              </h2>
              <div class="flex flex-wrap gap-2 text-xs">
                <span
                  data-testid="knowledge-linked-source-badge"
                  class="rounded bg-surface-hover px-1.5 text-text-secondary"
                >
                  {l().source}
                </span>
                <Show when={l().reviewStatus}>
                  <span class="rounded bg-surface-hover px-1.5 text-text-secondary">
                    {l().reviewStatus}
                  </span>
                </Show>
              </div>
            </header>
            <Show when={isSafeUserUrl(l().url)}>
              {(safeUrl) => (
                <a
                  data-testid="knowledge-linked-open-original"
                  href={safeUrl()}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-sm text-accent hover:underline"
                >
                  {i18n.t("knowledge.openOriginal")}
                </a>
              )}
            </Show>
            <p class="text-xs text-text-secondary">
              {i18n.t("knowledge.remoteSourceLiaisonAttachmentsAreNot")}
            </p>
          </>
        )}
      </Show>
    </div>
  )
}

export default KnowledgeLinkedSourceView
