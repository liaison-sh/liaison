// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tablet/phone counterpart to the desktop chat dock (P4c-T14). The dock
// is a floating strip that only fits a wide viewport; under 1024px the SAME
// dock-store state (`activeThreadId`, `chatsOpen`) instead drives this
// full-screen sheet, reusing exactly the pieces the dock already uses at
// desktop — HomeSidebar's "dock" variant (ChatsTab.tsx) and ThreadView's
// "dock" surface (ConversationTab.tsx). No second store: opening a
// conversation from anywhere (mod+., the Knowledge "discuss" CTA,
// togglePersonalAgentChat, a row click here) always goes through
// dock-store's `openConversation`, so this sheet has nothing of its own to
// keep in sync.
import { ChevronLeft } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { DockSurfaceBoundary } from "~/modules/shell/DockSurfaceBoundary"
import {
  activeThreadId,
  chatsOpen,
  deactivate,
  dockAvailable,
  openConversation,
  toggleChats,
} from "~/modules/shell/dock-store"
import { shellTier } from "~/modules/shell/shell-tier"
import { conversationDisplayName } from "~/modules/threads/conversation-display"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import ThreadView from "~/modules/threads/ThreadView"
import { getThread } from "~/modules/threads/thread-store"
import { OverlaySheet } from "~/ui/OverlaySheet"

export const ChatsSheet: Component = () => {
  const i18n = useI18n()

  // TABLET only (F3). Open whenever the dock has something to show and the
  // dock itself isn't the one showing it: a thread was opened
  // (activeThreadId), or the list was asked for (chatsOpen) — via the floating
  // opener, or the same `toggleChats()` the desktop Chats pill calls. At phone
  // tier Chats is a root screen and a thread is a pushed route, so nothing
  // there drives this sheet any more.
  const open = () =>
    !dockAvailable() && shellTier() !== "phone" && (activeThreadId() !== null || chatsOpen())

  // The sheet's own close control / Escape: drop back to dock-store's idle
  // state. Both of these are NAVIGATION, not eviction: `deactivate()` drops
  // the active thread and keeps its tab, so a user who closes the sheet and
  // then widens to desktop still finds the conversation in the dock. `close()`
  // here threw the conversation away on a back gesture.
  function closeSheet() {
    deactivate()
    if (chatsOpen()) toggleChats()
  }

  // The list pane's own focus anchor. Back unmounts the button that was
  // clicked, so without this focus lands on document.body: outside the dialog,
  // where the sheet's focus trap and its Escape handling no longer apply and a
  // keyboard user is stranded (P4c FX-B4 N4). Focus moves to the list pane
  // instead, which is also where a screen reader should resume reading.
  let listRef: HTMLDivElement | undefined

  // The header NAMES what is on screen. With the title pinned to "Chats" the
  // sheet was the only surface where an open conversation was anonymous: the
  // roster row it was opened from carries a name, and it is the same resolver
  // here, so a channel reads as its title and a DM as its counterpart.
  const currentUserId = () => userFromToken()?.userId ?? ""
  const openThreadName = () => {
    const id = activeThreadId()
    if (!id) return null
    const thread = getThread(id)
    if (!thread) return null
    const name = conversationDisplayName(thread, currentUserId())
    return name.length > 0 ? name : null
  }
  const sheetTitle = () => openThreadName() ?? i18n.t("kernel.dock.chats")

  // Back, from a selected thread to the list: the same non-destructive step,
  // without touching `chatsOpen` — the sheet stays open, showing the list
  // underneath.
  function backToList() {
    deactivate()
    // The list pane mounts in the same synchronous Solid update; focus it once
    // that has flushed.
    queueMicrotask(() => listRef?.focus())
  }

  return (
    <OverlaySheet
      open={open()}
      onClose={closeSheet}
      variant="full"
      title={sheetTitle()}
      closeLabel={i18n.t("kernel.close")}
    >
      <Show
        when={activeThreadId()}
        // `keepChats`: the list and the thread are two states of THIS sheet,
        // so selecting a row must not put the roster away the way the desktop
        // strip's own roster panel is put away.
        fallback={
          <div ref={listRef} tabindex="-1" class="h-full focus:outline-none">
            <HomeSidebar
              variant="dock"
              onSelect={(id) => openConversation(id, { keepChats: true })}
            />
          </div>
        }
      >
        {(threadId) => (
          <div class="flex h-full min-h-0 flex-col">
            <div class="flex shrink-0 items-center border-b border-border-subtle px-1 py-1">
              <button
                type="button"
                data-testid="chats-sheet-back"
                aria-label={i18n.t("kernel.back")}
                onClick={backToList}
                class="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
              >
                <ChevronLeft size={20} />
              </button>
            </div>
            <div class="min-h-0 flex-1">
              <DockSurfaceBoundary>
                <ThreadView entityId={threadId()} surface="dock" isActive={() => true} />
              </DockSurfaceBoundary>
            </div>
          </div>
        )}
      </Show>
    </OverlaySheet>
  )
}
