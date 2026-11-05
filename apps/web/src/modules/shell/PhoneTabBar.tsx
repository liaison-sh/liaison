// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The phone bottom bar (M1-A T2). It replaces the activity bar's `bar` layout,
// which seated the first four registry entries plus an overflow sheet: the row
// then RESHUFFLED under the thumb as apps registered over the first half second
// after a reload, and the same finger position meant a different app on every
// load. Five FIXED seats, in one order, forever: what is under the thumb never
// depends on which apps are installed.
//
// Everything else the workspace carries is one tap away on the Work screen
// (`kernel:work`), so nothing is lost by dropping the overflow.
import { Home, LayoutGrid, MessageSquare, Search, User } from "lucide-solid"
import type { JSX } from "solid-js"
import { type Component, createMemo, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { resolveRegisteredTabType } from "~/framework/app-registry"
import { cn } from "~/lib/cn"
import { nativeHaptic } from "~/lib/native-bridge"
import { useI18n } from "~/modules/i18n/i18n-context"
import { chatsThreadId } from "~/modules/shell/chats-root-store"
import { homeActionCount } from "~/modules/shell/home-action-count"
import { openTab, tabStore } from "~/modules/shell/tab-store"
import { messagesUnreadCount } from "~/modules/threads/unread-count-store"

interface Seat {
  id: "home" | "chats" | "work" | "search" | "you"
  label: string
  icon: Component<{ size?: number }>
  /** The registered tab type this seat lands on, when it opens a tab. */
  tabType?: string
  activate: () => void
  /** A count worth showing on the seat, or 0 for none. */
  badge: () => number
}

interface PhoneTabBarProps {
  style?: JSX.CSSProperties
}

export const PhoneTabBar: Component<PhoneTabBarProps> = (props) => {
  const i18n = useI18n()

  const activeTab = createMemo(() => tabStore.tabs.find((t) => t.id === tabStore.activeTabId))
  const activeTabType = createMemo(() => {
    const tab = activeTab()
    if (!tab) return undefined
    return resolveRegisteredTabType(tab.type) ?? tab.type
  })

  // Chats is a root screen (F3), so the seat is lit on `/chats` AND on the
  // conversation Chats pushed: a thread read from the Chats stack is still
  // inside Chats, exactly as a phone user expects the seat to behave.
  const chatsActive = () =>
    activeTabType() === "kernel:chats" ||
    (activeTabType() === "kernel:thread" &&
      chatsThreadId() !== null &&
      activeTab()?.entityId === chatsThreadId())

  const seats = (): Seat[] => [
    {
      id: "home",
      label: i18n.t("kernel.phoneTabHome"),
      icon: Home,
      tabType: "kernel:home",
      activate: () =>
        openTab({
          type: "kernel:home",
          entityId: "home",
          label: i18n.t("kernel.shellUi.home"),
          preview: false,
        }),
      // The Home badge (D21): what needs the viewer, the desktop rail's number.
      badge: () => homeActionCount(),
    },
    {
      id: "chats",
      label: i18n.t("kernel.phoneTabChats"),
      icon: MessageSquare,
      tabType: "kernel:chats",
      activate: () =>
        openTab({
          type: "kernel:chats",
          entityId: "chats",
          label: i18n.t("kernel.shellUi.chats"),
          preview: false,
        }),
      // The server total (A14): the same number the dock pill and the
      // Messages rail entry show.
      badge: () => messagesUnreadCount(),
    },
    {
      id: "work",
      label: i18n.t("kernel.phoneTabWork"),
      icon: LayoutGrid,
      tabType: "kernel:work",
      activate: () =>
        openTab({
          type: "kernel:work",
          entityId: "work",
          label: i18n.t("kernel.shellUi.work"),
          preview: false,
        }),
      // Work is a launcher: its number only repeated Home's (D21).
      badge: () => 0,
    },
    {
      id: "search",
      label: i18n.t("kernel.phoneTabSearch"),
      icon: Search,
      tabType: "kernel:search",
      activate: () =>
        openTab({
          type: "kernel:search",
          entityId: "search",
          label: i18n.t("kernel.common.search"),
          preview: false,
        }),
      badge: () => 0,
    },
    {
      id: "you",
      label: i18n.t("kernel.phoneTabYou"),
      icon: User,
      tabType: "kernel:settings",
      activate: () =>
        openTab({
          type: "kernel:settings",
          entityId: "settings",
          label: i18n.t("kernel.common.settings"),
          // The user's own profile section, not whichever admin page the tab
          // was last left on.
          routePath: "/settings",
          preview: false,
        }),
      badge: () => 0,
    },
  ]

  const isActive = (seat: Seat) =>
    seat.id === "chats" ? chatsActive() : Boolean(seat.tabType) && activeTabType() === seat.tabType

  /**
   * A tap on a seat. The tick marks a seat CHANGE only: tapping the seat you
   * are already on is a scroll-to-top or a no-op, and buzzing for it makes the
   * bar feel like it did something it did not. No-op off a native shell.
   */
  function selectSeat(seat: Seat): void {
    if (!isActive(seat)) nativeHaptic("selection")
    seat.activate()
  }

  return (
    <nav
      data-testid="phone-tab-bar"
      data-tour-tier="phone"
      class="flex h-full min-h-0 w-full min-w-0 flex-row items-stretch justify-around gap-1 overflow-hidden border-t border-border-subtle bg-bg px-2"
      style={props.style}
    >
      <For each={seats()}>
        {(seat) => (
          <button
            type="button"
            aria-label={seat.label}
            aria-current={isActive(seat) ? "page" : undefined}
            data-testid={`phone-tab-${seat.id}`}
            onClick={() => selectSeat(seat)}
            class={cn(
              "relative flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md transition-colors duration-150",
              isActive(seat)
                ? "text-accent"
                : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary",
            )}
          >
            <Dynamic component={seat.icon} size={18} />
            <span class="text-[10px] leading-none">{seat.label}</span>
            <Show when={seat.badge() > 0}>
              <span
                data-testid={`phone-tab-badge-${seat.id}`}
                role="status"
                aria-label={`${seat.badge()} ${seat.label}`}
                class="pointer-events-none absolute right-1.5 top-1 flex h-[15px] min-w-[15px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-none text-accent-foreground"
              >
                {seat.badge() > 99 ? "99+" : seat.badge()}
              </span>
            </Show>
          </button>
        )}
      </For>
    </nav>
  )
}
