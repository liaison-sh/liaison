// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import KnowledgeHome from "./KnowledgeHome"
import KnowledgeSearchView from "./KnowledgeSearchView"
import KnowledgeUnfiledView from "./KnowledgeUnfiledView"
import { knowledgeStore, loadKnowledgeHome } from "./knowledge-store"

const KnowledgeWorkspace: Component = () => {
  const i18n = useI18n()
  const api = useOptionalApi()

  onMount(() => {
    if (api) void loadKnowledgeHome(api)
  })

  return (
    <div data-testid="knowledge-workspace" class="flex h-full flex-col overflow-hidden bg-bg">
      <Show when={knowledgeStore.view === "home"}>
        <KnowledgeHome />
      </Show>
      <Show when={knowledgeStore.view === "search"}>
        <Show
          when={api}
          fallback={
            <p class="p-4 text-sm text-text-tertiary">{i18n.t("knowledge.apiUnavailable")}</p>
          }
        >
          <KnowledgeSearchView api={api!} />
        </Show>
      </Show>
      <Show when={knowledgeStore.view === "unfiled"}>
        <KnowledgeUnfiledView />
      </Show>
    </div>
  )
}

export default KnowledgeWorkspace
