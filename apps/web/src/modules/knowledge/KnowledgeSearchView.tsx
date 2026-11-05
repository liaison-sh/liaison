// SPDX-License-Identifier: FSL-1.1-ALv2

import type { KnowledgeSearchHit } from "@liaison/shared"
import { type Component, For, onCleanup, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { openEntity } from "~/modules/shell/entity-opener"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"
import { knowledgeStore, searchKnowledge } from "./knowledge-store"

// Map a search hit to its entity type for the entity-opener registry. Prefer
// the hit's own `type` field — the local-knowledge adapter emits the real
// `entityType` (document | source_link); fall back to source/heuristic only
// when the adapter omits it.
function entityTypeForHit(hit: KnowledgeSearchHit): "document" | "source_link" {
  if (hit.type === "document" || hit.type === "source_link") return hit.type
  // Local sources ("knowledge"/"local") default to documents; remote/other → source_link.
  return hit.source === "knowledge" || hit.source === "local" ? "document" : "source_link"
}

// IF-2: use semantic Tailwind tokens (see tailwind.config.cjs) — `text-warning`
// for partial/rate-limited, `text-danger` for hard errors, `text-text-secondary`
// for complete/skipped/pending. Avoids the raw colour escalation the design
// system bans.
// MT-4: every documented `KnowledgeSourceState` must map; missing states fall
// back to `text-text-secondary` rather than crashing.
const STATE_COLOR: Record<string, string> = {
  complete: "text-text-secondary",
  skipped: "text-text-secondary",
  loading: "text-text-secondary",
  pending: "text-text-secondary",
  partial: "text-warning",
  "rate-limited": "text-warning",
  timeout: "text-warning",
  unavailable: "text-warning",
  error: "text-danger",
  unauthorized: "text-danger",
}

const DEBOUNCE_MS = 250

const KnowledgeSearchView: Component<{ api: ApiClient }> = (props) => {
  const i18n = useI18n()
  let timer: ReturnType<typeof setTimeout> | undefined
  const runSearch = (value: string) => {
    void searchKnowledge(props.api, { query: value, limit: 25 })
  }
  const onInput = (event: Event) => {
    const value = (event.target as HTMLInputElement).value
    if (!value.trim()) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => runSearch(value), DEBOUNCE_MS)
  }
  onCleanup(() => {
    if (timer) clearTimeout(timer)
  })

  const retry = (source: string) => {
    const q = knowledgeStore.searchQuery
    if (!q) return
    void searchKnowledge(props.api, { query: q, limit: 25, sources: [source] })
  }

  return (
    <div data-testid="knowledge-search-view" class="flex flex-col gap-3 p-4">
      <Input
        type="text"
        placeholder={i18n.t("knowledge.searchKnowledgeAndSources")}
        data-testid="knowledge-search-input"
        onInput={onInput}
      />

      <Show when={knowledgeStore.error}>
        <p data-testid="knowledge-search-error" class="text-sm text-danger">
          {knowledgeStore.error}
        </p>
      </Show>

      <Show when={knowledgeStore.searchLoading}>
        <p data-testid="knowledge-search-loading" class="text-xs text-text-secondary">
          {i18n.t("knowledge.searching")}
        </p>
      </Show>

      <Show when={knowledgeStore.sourceStatuses.length > 0}>
        <ul data-testid="knowledge-source-statuses" class="flex flex-col gap-1 text-xs">
          <For each={knowledgeStore.sourceStatuses}>
            {(status) => (
              <li
                data-testid={`knowledge-source-status-${status.source}`}
                class="flex items-center gap-2"
              >
                <span class="font-medium">{status.source}</span>
                <span class={STATE_COLOR[status.state] ?? "text-text-secondary"}>
                  {status.state}
                </span>
                <Show when={status.message}>
                  <span class="text-text-secondary">({status.message})</span>
                </Show>
                <Show when={status.retryable}>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`knowledge-source-retry-${status.source}`}
                    onClick={() => retry(status.source)}
                  >
                    {i18n.t("kernel.common.retry2")}
                  </Button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show
        when={knowledgeStore.searchResults.length > 0}
        fallback={
          <Show when={!knowledgeStore.searchLoading && knowledgeStore.searchQuery}>
            <p class="text-sm text-text-secondary">{i18n.t("knowledge.noResults")}</p>
          </Show>
        }
      >
        <ul data-testid="knowledge-search-results" class="flex flex-col gap-1">
          <For each={knowledgeStore.searchResults}>
            {(hit) => {
              const entityType = entityTypeForHit(hit)
              const onActivate = () => {
                void openEntity(props.api, "knowledge", entityType, hit.sourceEntityId, hit.title)
              }
              return (
                <li>
                  <button
                    type="button"
                    data-testid={`knowledge-search-result-${entityType}-${hit.sourceEntityId}`}
                    class="flex w-full flex-col gap-1.5 rounded-md px-3 py-2.5 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
                    onClick={onActivate}
                  >
                    <div class="flex items-center gap-2">
                      <span class="text-[13px] font-medium text-text">{hit.title}</span>
                      <span
                        data-testid={`knowledge-search-result-source-${hit.source}`}
                        class="rounded bg-surface px-1.5 text-[11px] text-text-tertiary"
                      >
                        {hit.source}
                      </span>
                      <Show when={hit.badges?.length}>
                        <For each={hit.badges}>
                          {(badge) => (
                            <span class="rounded bg-surface px-1.5 text-[11px] text-text-tertiary">
                              {badge}
                            </span>
                          )}
                        </For>
                      </Show>
                    </div>
                    <Show when={hit.snippet}>
                      <p class="text-[12px] leading-relaxed text-text-tertiary">{hit.snippet}</p>
                    </Show>
                  </button>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </div>
  )
}

export default KnowledgeSearchView
