// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createMemo, For, Show } from "solid-js"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { findDocumentPlace, knowledgeStore } from "./knowledge-store"

/**
 * Where the open page sits, read from the sidebar's tree: its section, then
 * its folders from the top down ("Shared with org / Policies"). A page in no
 * folder reads "Shared with org / Unfiled" or "Personal / Personal notes".
 * Nothing is drawn until the tree knows the page.
 */
const Breadcrumb: Component<{ docId: string }> = (props) => {
  const i18n = useI18n()
  const crumbs = createMemo(() => {
    const place = findDocumentPlace(knowledgeStore.collectionsTree, props.docId)
    if (!place) return null
    const me = userFromToken()?.userId ?? null
    const personal = me !== null && place.top.ownerUserId === me
    const names = place.top.virtual
      ? [
          place.top.kind === "personal_notes" || place.top.id === "__personal_notes__"
            ? i18n.t("knowledge.personalNotes")
            : i18n.t("knowledge.unfiled"),
        ]
      : place.folders.map((f) => f.name)
    return {
      section: personal ? i18n.t("knowledge.personal") : i18n.t("knowledge.sharedWithOrg"),
      names,
    }
  })
  return (
    <Show when={crumbs()}>
      {(c) => (
        <nav
          aria-label={i18n.t("knowledge.breadcrumb")}
          data-testid="knowledge-breadcrumb"
          class="flex min-w-0 items-center gap-1 text-[12px] text-text-tertiary"
        >
          <span class="shrink-0">{c().section}</span>
          <For each={c().names}>
            {(name) => (
              <>
                <span class="shrink-0" aria-hidden="true">
                  /
                </span>
                <span class="min-w-0 truncate">{name}</span>
              </>
            )}
          </For>
        </nav>
      )}
    </Show>
  )
}

export default Breadcrumb
