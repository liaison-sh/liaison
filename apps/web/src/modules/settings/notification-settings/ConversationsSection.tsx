// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings -> Notifications (etiquette rule 10): the conversations the person
// muted, each with Unmute, and the channels they set to notify on every
// message, each with "Mentions only". Both write the conversation's own state
// (PATCH /threads/:id/state), the same switch as the conversation's menu.

import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  type ConversationRef,
  fetchNotificationConversations,
  type NotificationConversations,
  patchThreadState,
} from "~/modules/settings/notification-settings/settings-store"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"

const rowButton =
  "min-h-11 shrink-0 rounded-sm border border-border px-3 py-1 text-[12.5px] text-text hover:bg-surface-hover lg:min-h-0"

export const ConversationsSection: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const k = (key: string) => i18n.t(`kernel.notificationSettings.${key}`)
  const [data, setData] = createSignal<NotificationConversations | null>(null)
  const [failed, setFailed] = createSignal(false)

  async function load(): Promise<void> {
    try {
      setData(await fetchNotificationConversations(api))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }
  onMount(() => void load())

  async function change(
    ref: ConversationRef,
    list: "muted" | "allPosts",
    state: { isMuted?: boolean; notifyAllPosts?: boolean },
  ): Promise<void> {
    const before = data()
    if (!before) return
    setData({ ...before, [list]: before[list].filter((c) => c.threadId !== ref.threadId) })
    try {
      await patchThreadState(api, ref.threadId, state)
    } catch {
      setData(before)
      addToast({ message: k("saveFailed"), type: "error" })
    }
  }

  const title = (ref: ConversationRef) => ref.title?.trim() || k("untitledConversation")

  const list = (
    items: ConversationRef[],
    kind: "muted" | "allPosts",
    empty: string,
    action: string,
    state: { isMuted?: boolean; notifyAllPosts?: boolean },
  ) => (
    <Show
      when={items.length > 0}
      fallback={
        <p data-testid={`notif-${kind}-empty`} class="text-[12px] text-text-secondary">
          {empty}
        </p>
      }
    >
      <ul data-testid={`notif-${kind}-list`} class="flex flex-col gap-2">
        <For each={items}>
          {(ref) => (
            <li
              data-testid={`notif-${kind}-${ref.threadId}`}
              class="flex items-center justify-between gap-4 rounded-md border border-border-subtle px-3 py-2"
            >
              <span class="min-w-0 truncate text-[13px] text-text">{title(ref)}</span>
              <button
                type="button"
                data-testid={`notif-${kind}-action-${ref.threadId}`}
                class={rowButton}
                onClick={() => void change(ref, kind, state)}
              >
                {action}
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )

  return (
    <section data-testid="notif-conversations" class="mb-10 border-t border-border-subtle pt-8">
      <Show when={failed()}>
        <p data-testid="notif-conversations-error" class="mb-4 text-[13px] text-error">
          {k("conversationsLoadFailed")}
        </p>
      </Show>
      <Show when={data()}>
        {(d) => (
          <>
            <h2 class={`mb-3 ${sectionHeading}`}>{k("mutedTitle")}</h2>
            <p class="mb-3 max-w-[60ch] text-[12px] leading-relaxed text-text-secondary">
              {k("mutedHint")}
            </p>
            {list(d().muted, "muted", k("mutedEmpty"), k("unmute"), { isMuted: false })}
            <h2 class={`mt-8 mb-3 ${sectionHeading}`}>{k("allPostsTitle")}</h2>
            <p class="mb-3 max-w-[60ch] text-[12px] leading-relaxed text-text-secondary">
              {k("allPostsHint")}
            </p>
            {list(d().allPosts, "allPosts", k("allPostsEmpty"), k("mentionsOnly"), {
              notifyAllPosts: false,
            })}
          </>
        )}
      </Show>
    </section>
  )
}
