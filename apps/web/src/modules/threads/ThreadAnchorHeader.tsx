// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The entity a thread belongs to, above the conversation. A task's comments
// (any thread created FROM an entity) are read where the entity is: opened
// directly, from an old link or a bookmark, the thread says whose
// conversation it is and offers the way there. The entity's page answers for
// the reader's access, as it does when opened from anywhere else. An entity whose app is
// switched off has no page to offer: the header says so instead.
import { type ThreadAnchor, threadAnchorTitle } from "@liaison/shared"
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"

export const ThreadAnchorHeader: Component<{ anchor: ThreadAnchor }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const openLabel = (): string => {
    const key = `kernel.threadAnchor.openKind.${props.anchor.app}.${props.anchor.entityType}`
    const word = i18n.t(key)
    return word && word !== key ? word : i18n.t("kernel.threadAnchor.open")
  }
  return (
    <div
      data-testid="thread-anchor-header"
      class="flex min-w-0 items-center gap-3 border-b border-border-subtle px-4 py-2"
    >
      <span
        data-testid="thread-anchor-header.title"
        class="min-w-0 flex-1 truncate text-[13px] text-text-secondary"
        title={threadAnchorTitle(props.anchor, i18n.t)}
      >
        {threadAnchorTitle(props.anchor, i18n.t)}
      </span>
      <Show
        when={props.anchor.state !== "gone"}
        fallback={
          <span
            data-testid="thread-anchor-header.gone"
            class="shrink-0 text-[12.5px] text-text-tertiary"
          >
            {i18n.t("kernel.threadAnchor.gone")}
          </span>
        }
      >
        <button
          type="button"
          data-testid="thread-anchor-header.open"
          class="shrink-0 rounded-md border border-border px-2.5 py-1 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
          onClick={() =>
            void openEntity(
              api,
              props.anchor.app,
              props.anchor.entityType,
              props.anchor.entityId,
              props.anchor.label ?? undefined,
            )
          }
        >
          {openLabel()}
        </button>
      </Show>
    </div>
  )
}

export default ThreadAnchorHeader
