// SPDX-License-Identifier: FSL-1.1-ALv2
//
// F3. The phone Chats ROOT. It used to be the tablet Chats sheet opened over
// whatever the user was on: a full-screen overlay with its own `Chats ✕`
// header above the list's own large title, and no tab bar underneath, so Chats
// was the one seat that took the phone out of its own navigation.
//
// It is a tab type like any other now. The list itself is unchanged: the same
// `HomeSidebar` dock variant the sheet rendered, personal agent row first.
// Picking a row PUSHES `/threads/:id`, so the OS back gesture and the top bar's
// back control both return here.
//
// F3: this is a ROOT screen with a large title of its own (the "Chats" h1
// HomeSidebar renders in its phone-dock variant), so the registry entry sets
// `hidePhoneTopBar: true` and there is no `phoneHeader` for it any more — a
// bar left in place either doubled the title or printed the workspace name
// nowhere consistent. The org name now prints as a small muted line under
// that h1 (in HomeSidebar), not in a bar above it.
//
// Desktop and tablet (owner, 2026-10-12): the same tab is the Messages app,
// and there the list is the app's registered SIDEBAR (bootstrap.ts), in the
// shell's sidebar column or the tablet drawer like every other app's. The
// main panel then only waits for a pick; rendering the list here too put a
// full-width list where the sidebar should have been.
import { MessageSquare, PanelLeft } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { setChatsThreadId } from "~/modules/shell/chats-root-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { toggleTabletSidebar } from "~/modules/shell/tablet-sidebar-store"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { loadThreads } from "~/modules/threads/thread-store"
import { createPushNav } from "~/primitives/createPushNav"
import { PullToRefresh } from "~/ui/PullToRefresh"

/** The Messages main panel beside its sidebar, before a conversation is picked. */
const ChatsPick: Component = () => {
  const i18n = useI18n()
  return (
    <div
      data-testid="chats-pick"
      class="flex h-full min-h-0 flex-col items-center justify-center gap-3 px-6 text-center"
    >
      <span class="flex h-11 w-11 items-center justify-center rounded-full bg-surface-hover text-text-tertiary">
        <MessageSquare size={20} />
      </span>
      <p class="text-[15px] font-medium text-text-primary">
        {i18n.t("kernel.chatsList.pickTitle")}
      </p>
      <p class="max-w-[320px] text-[13px] text-text-secondary">
        {i18n.t("kernel.chatsList.pickBody")}
      </p>
      {/* Tablet: the sidebar is a drawer, closed by default. */}
      <Show when={shellTier() === "tablet"}>
        <button
          type="button"
          data-testid="chats-show-list"
          onClick={() => toggleTabletSidebar()}
          class="mt-1 inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-[13px] font-medium text-text-secondary hover:bg-surface-hover"
        >
          <PanelLeft size={16} />
          {i18n.t("kernel.chatsList.showList")}
        </button>
      </Show>
    </div>
  )
}

export const ChatsScreen: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const pushNav = createPushNav()

  function openThread(threadId: string): void {
    setChatsThreadId(threadId)
    pushNav.pushDetail(`/threads/${threadId}`, { fromLabel: i18n.t("kernel.phoneTabChats") })
  }

  return (
    <Show when={shellTier() === "phone"} fallback={<ChatsPick />}>
      <div data-testid="chats-screen" class="flex h-full min-h-0 flex-col">
        {/* The list owns the whole screen: no sheet header, no second title.
          The wrapper does not take the scroll over, it only catches the pull
          gesture as it bubbles out of the list (ui/PullToRefresh.tsx). */}
        <PullToRefresh
          onRefresh={() => loadThreads(api)}
          label={i18n.t("kernel.refreshing")}
          class="flex flex-col overflow-hidden"
        >
          <HomeSidebar variant="dock" onSelect={openThread} />
        </PullToRefresh>
      </div>
    </Show>
  )
}

export default ChatsScreen
