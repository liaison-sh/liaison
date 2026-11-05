// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dock bar's Chats item (P4c-T07), its rightmost end: the org-wide unread
// total (the server's, A14), and a toggle for a window hosting the SAME list Home shows, in
// "dock" variant so a row click opens a dock conversation instead of a Shell
// tab.
//
// The window is the dock's own floating window (DockWindow), not a PopupMenu:
// chatsOpen() is dock-store's persisted signal (shared with the conversation
// windows, which it excludes), not a trigger-owned Kobalte open state, and
// the window needs neither an overlay sheet nor a focus trap.
import { MessageCircle } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { pluralFormFor } from "~/modules/projects/plural"
import { DockSurfaceBoundary } from "~/modules/shell/DockSurfaceBoundary"
import HomeSidebar from "~/modules/threads/HomeSidebar"
import { messagesUnreadCount } from "~/modules/threads/unread-count-store"
import { DockWindow } from "./DockWindow"
import {
  chatsOpen,
  DOCK_BADGE_CLASS,
  DOCK_PILL_CLASS,
  openConversation,
  toggleChats,
} from "./dock-store"

export const ChatsTab: Component = () => {
  const i18n = useI18n()
  // The server total (A14), the same number the Messages entry and the phone
  // Chats seat show, not the sum over the 50 threads the client list holds.
  const unread = () => messagesUnreadCount()

  return (
    <div class="relative flex h-full">
      <button
        type="button"
        data-dock-pill
        data-testid="dock-chats"
        class={cn(DOCK_PILL_CLASS, "gap-2 px-3 text-text", chatsOpen() && "bg-surface-hover")}
        aria-label={i18n.t("kernel.dock.chats")}
        aria-expanded={chatsOpen() ? "true" : "false"}
        onClick={() => toggleChats()}
      >
        <MessageCircle size={15} class="shrink-0 text-text-secondary" aria-hidden="true" />
        <span class="font-semibold">{i18n.t("kernel.dock.chats")}</span>
        <Show when={unread() > 0}>
          <span
            role="status"
            aria-label={i18n.t(
              pluralFormFor(i18n.locale(), unread()) === "one"
                ? "kernel.dock.unreadOne"
                : "kernel.dock.unreadMany",
              { count: unread() },
            )}
            class={DOCK_BADGE_CLASS}
          >
            {unread() > 99 ? "99+" : unread()}
          </span>
        </Show>
        <Show when={chatsOpen()}>
          <span
            aria-hidden="true"
            class="pointer-events-none absolute right-2 bottom-0 left-2 h-0.5 rounded-full bg-accent"
          />
        </Show>
      </button>
      <Show when={chatsOpen()}>
        <DockWindow data-testid="chats-panel">
          <DockSurfaceBoundary>
            <HomeSidebar variant="dock" onSelect={(id) => openConversation(id)} />
          </DockSurfaceBoundary>
        </DockWindow>
      </Show>
    </div>
  )
}
