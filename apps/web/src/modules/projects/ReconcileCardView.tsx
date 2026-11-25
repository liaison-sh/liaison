// SPDX-License-Identifier: FSL-1.1-ALv2
// A planned vs done card on its own page: the link a coding agent hands a person opens the card
// itself, with Create invoice on it, outside any conversation. The card is the one reconcile_get
// draws; its actions run on the person's own scopes, as from a conversation.
import type { ResolvedCard } from "@liaison/shared"
import { type Component, createResource, Show } from "solid-js"
import { ToolCard } from "~/modules/agent/ToolCard"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

export const ReconcileCardView: Component<{ entityId: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [card] = createResource(
    () => props.entityId,
    async (reconciliationId): Promise<ResolvedCard | null> => {
      try {
        const res = await api.rawPost(
          "/apps/projects/tools/reconcile_get",
          { params: { reconciliationId }, withCard: true },
          { suppressGlobalError: true },
        )
        if (!res.ok) return null
        const body = (await res.json().catch(() => ({}))) as {
          meta?: { card?: ResolvedCard | null }
        }
        return body.meta?.card ?? null
      } catch {
        return null
      }
    },
  )
  return (
    <div class="mx-auto flex w-full max-w-4xl flex-col gap-3 p-4" data-testid="reconcile-card-page">
      <Show
        when={card()}
        fallback={
          <Show when={!card.loading}>
            <p class="text-text-secondary" data-testid="reconcile-card-page-none">
              {i18n.t("projects.reconcileCard.none")}
            </p>
          </Show>
        }
      >
        {(c) => (
          <ToolCard
            toolCall={{
              toolCallId: `reconcile-page-${props.entityId}`,
              toolName: "projects__reconcile_get",
              status: "completed",
              card: c(),
            }}
          />
        )}
      </Show>
    </div>
  )
}
