// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The dock: ONE connected bar anchored flush to the bottom right corner of the
// main panel. Right to left: the Chats item, one item per open conversation,
// the overflow item, and the control that folds every chat into Chats. An
// open conversation (or the Chats roster) is a window resting on the bar,
// right aligned with its item. The strip owns the
// positioning, the bar, capacity and overflow; the Shell supplies the real
// items through `chatsTab` and `renderTab`.
import { ChevronsLeft, ChevronsRight } from "lucide-solid"
import { type Component, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { pluralFormFor } from "~/modules/projects/plural"
import { conversationDisplayName } from "~/modules/threads/conversation-display"
import { getThread } from "~/modules/threads/thread-store"
import { setDockBarRect } from "~/primitives/dockLift"
import { PopupMenu } from "~/ui/PopupMenu"
import { DockAvatar } from "./DockAvatar"
import {
  allCollapsed,
  chatsOpen,
  collapseAll,
  DOCK_EDGE_RESERVE,
  DOCK_FOLD_FADE_MS,
  DOCK_FOLD_MS,
  DOCK_FOLD_STAGGER_MS,
  DOCK_GAP,
  DOCK_ITEM_MAX_WIDTH,
  DOCK_OVERFLOW_ITEM_WIDTH,
  DOCK_PILL_CLASS,
  DOCK_PILL_HEIGHT,
  DOCK_STRIP_HEIGHT,
  DOCK_TAB_HEIGHT,
  DOCK_TAB_WIDTH,
  DOCK_TOGGLE_ITEM_WIDTH,
  type DockTab,
  expandAll,
  overflow,
  promoteFromOverflow,
  setDockPanelSize,
  setVisibleCapacity,
  tabs,
  toggleChats,
  visibleTabs,
} from "./dock-store"

export interface ChatDockProps {
  /** The real Chats pill (unread count, click to toggleChats()). The Shell
   *  always supplies it; the minimal inline pill below is the bare fallback. */
  chatsTab?: JSX.Element
  /** The real ConversationTab (avatar, title, close, expand/collapse). The
   *  Shell always supplies it; without it a minimal pill stands in, sized to
   *  the expanded/collapsed constants either way. */
  renderTab?: (tab: DockTab) => JSX.Element
}

/**
 * The name a dock tab shows, derived exactly the way ConversationTab derives
 * it (ConversationTab.tsx). Every surface that names a conversation — the
 * strip, the overflow menu, the fallback pill — reads it from here, so none of
 * them can drift back to showing a raw thread id.
 */
export function dockTabName(threadId: string, unnamed: string): string {
  const thread = getThread(threadId)
  if (!thread) return unnamed
  return conversationDisplayName(thread, userFromToken()?.userId ?? "")
}

/**
 * How many conversation items fit on the bar: the strip's width, less the
 * edge reserve, the Chats item, the overflow item and the collapse-all
 * control, in
 * items at their widest. Items are collapsed on the bar whatever their window
 * does, so the widest collapsed item is the unit, never the window: a 360px
 * unit sent items into the overflow menu with room to spare beside them.
 *
 * The overflow item's room is always kept, whether or not anything overflows:
 * a capacity that depended on the tab count would need a second measuring
 * pass every time a conversation arrived, for at most one more item.
 */
export function dockCapacity(stripWidth: number, chatsItemWidth: number): number {
  const room =
    stripWidth -
    DOCK_EDGE_RESERVE -
    chatsItemWidth -
    DOCK_OVERFLOW_ITEM_WIDTH -
    DOCK_TOGGLE_ITEM_WIDTH
  return Math.max(0, Math.floor(room / DOCK_ITEM_MAX_WIDTH))
}

// Bare fallback: the Shell passes the real ChatsTab.
function DefaultChatsPill(): JSX.Element {
  const i18n = useI18n()
  return (
    <button
      type="button"
      data-dock-pill
      class={`${DOCK_PILL_CLASS} text-text`}
      onClick={() => toggleChats()}
    >
      {i18n.t("kernel.dock.chats")}
    </button>
  )
}

// Bare fallback: the Shell passes the real ConversationTab.
function DefaultConversationPill(tab: DockTab): JSX.Element {
  const i18n = useI18n()
  return (
    <div
      class="relative flex h-full"
      data-dock-tab={tab.threadId}
      data-expanded={tab.expanded ? "true" : "false"}
    >
      <span
        data-dock-pill
        class={`${DOCK_PILL_CLASS} truncate text-text`}
        style={{ "max-width": `${DOCK_ITEM_MAX_WIDTH}px` }}
      >
        {dockTabName(tab.threadId, i18n.t("kernel.dock.conversation"))}
      </span>
    </div>
  )
}

/** The overflow item: up to three overlapped faces of what it holds, "+N". */
function OverflowFaces(): JSX.Element {
  return (
    <span class="flex items-center">
      <For each={overflow().slice(0, 3)}>
        {(tab, i) => (
          <span
            class="flex rounded-full bg-elevated"
            style={{
              padding: "1.5px",
              "margin-left": i() === 0 ? "0" : "-6px",
              "z-index": 3 - i(),
            }}
          >
            <DockAvatar threadId={tab.threadId} size={18} />
          </span>
        )}
      </For>
    </span>
  )
}

const FOLD_EASE = "cubic-bezier(.4,0,.2,1)"

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  } catch {
    return false
  }
}

/** Where `el` lands to fly into `into`: its centre on Chats' centre, at Chats' height. */
function intoTransform(el: HTMLElement, into: HTMLElement): string {
  const r = el.getBoundingClientRect()
  const c = into.getBoundingClientRect()
  const dx = c.left + c.width / 2 - (r.left + r.width / 2)
  const dy = c.top + c.height / 2 - (r.top + r.height / 2)
  const k =
    r.width > 0 && r.height > 0
      ? Math.max(0.06, Math.min(c.height / r.height, c.width / r.width))
      : 0.06
  return `translate(${dx}px, ${dy}px) scale(${k})`
}

/**
 * Fly `targets` into Chats (`out`) or back out of it, one after the other.
 * Transform and opacity only, so nothing lays out mid-flight; with reduced
 * motion they fade in place. Without the Web Animations API it resolves at once.
 */
function fold(targets: HTMLElement[], into: HTMLElement | undefined, out: boolean): Promise<void> {
  if (!into || typeof Element === "undefined" || typeof Element.prototype.animate !== "function") {
    return Promise.resolve()
  }
  const reduce = prefersReducedMotion()
  const fill: FillMode = out ? "forwards" : "backwards"
  const animations = targets.map((el, i) => {
    if (reduce) {
      const frames = [{ opacity: 1 }, { opacity: 0 }]
      return el.animate(out ? frames : frames.reverse(), { duration: DOCK_FOLD_FADE_MS, fill })
    }
    el.style.transformOrigin = "50% 50%"
    const shrunk = { transform: intoTransform(el, into), opacity: 0 }
    const shown = { transform: "none", opacity: 1 }
    return el.animate(out ? [shown, shrunk] : [shrunk, shown], {
      duration: DOCK_FOLD_MS,
      delay: i * DOCK_FOLD_STAGGER_MS,
      easing: FOLD_EASE,
      fill,
    })
  })
  return Promise.all(animations.map((a) => a.finished.catch(() => undefined))).then(() => undefined)
}

export const ChatDock: Component<ChatDockProps> = (props) => {
  const i18n = useI18n()
  let stripRef: HTMLDivElement | undefined
  let barRef: HTMLDivElement | undefined
  let chatsRef: HTMLDivElement | undefined
  let toggleRef: HTMLDivElement | undefined
  const [overflowOpen, setOverflowOpen] = createSignal(false)
  const [folding, setFolding] = createSignal(false)
  const [status, setStatus] = createSignal("")

  const plural = (base: string, count: number) =>
    i18n.t(`${base}${pluralFormFor(i18n.locale(), count) === "one" ? "One" : "Many"}`, { count })

  /** The open windows first, then the bar's items nearest Chats first. */
  function foldTargets(): HTMLElement[] {
    if (!barRef) return []
    const slots = [...barRef.querySelectorAll<HTMLElement>(":scope > [data-dock-slot]")]
    const windows = slots.flatMap((slot) => [
      ...slot.querySelectorAll<HTMLElement>("[data-dock-window]"),
    ])
    return [...windows, ...slots]
  }

  /** Moves the control to its new seat beside Chats (or back) by FLIP. */
  function moveToggle(apply: () => void): void {
    const before = toggleRef?.getBoundingClientRect().left ?? 0
    apply()
    const el = toggleRef
    if (!el || typeof el.animate !== "function" || prefersReducedMotion()) return
    const dx = before - el.getBoundingClientRect().left
    if (Math.abs(dx) > 1) {
      el.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], {
        duration: 220,
        easing: FOLD_EASE,
      })
    }
  }

  async function toggleAll(): Promise<void> {
    if (folding()) return
    setFolding(true)
    try {
      const count = tabs().length
      if (allCollapsed()) {
        moveToggle(() => expandAll())
        // Out of Chats: the bar's items nearest first, the window last.
        const targets = foldTargets()
        const windows = targets.filter((el) => el.hasAttribute("data-dock-window"))
        const items = targets.filter((el) => !el.hasAttribute("data-dock-window"))
        await fold([...items, ...windows], chatsRef, false)
        setStatus(plural("kernel.dock.shown", count))
      } else {
        await fold(foldTargets(), chatsRef, true)
        moveToggle(() => collapseAll())
        setStatus(plural("kernel.dock.folded", count))
      }
    } finally {
      setFolding(false)
    }
  }

  onMount(() => {
    // jsdom (unit tests) polyfills ResizeObserver as a no-op that never fires;
    // capacity there comes from setVisibleCapacity() called directly in tests.
    if (typeof ResizeObserver === "undefined" || !stripRef) return
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0
      const chatsItemWidth = chatsRef?.getBoundingClientRect().width ?? 0
      setVisibleCapacity(dockCapacity(width, chatsItemWidth))
    })
    ro.observe(stripRef)
    // The strip spans the main panel's width; its positioned parent is the
    // panel itself, whose height sizes an agent's window.
    const panel = stripRef.parentElement
    const measurePanel = () => {
      if (!stripRef || !panel) return
      const width = stripRef.getBoundingClientRect().width
      const height = panel.getBoundingClientRect().height
      setDockPanelSize(width > 0 && height > 0 ? { width, height } : null)
    }
    const panelRo = new ResizeObserver(measurePanel)
    panelRo.observe(stripRef)
    if (panel) panelRo.observe(panel)
    measurePanel()
    // The bar's place on screen, for a bottom-pinned composer that must rise
    // above it once the bar grows far enough left to reach its controls
    // (dock-lift.ts). The bar's width follows its items; its place follows
    // the panel (the strip) and the window.
    const measureBar = () => {
      const r = barRef?.getBoundingClientRect()
      setDockBarRect(
        r && r.width > 0 && r.height > 0
          ? { left: r.left, right: r.right, top: r.top, bottom: r.bottom }
          : null,
      )
    }
    const barRo = new ResizeObserver(measureBar)
    if (barRef) barRo.observe(barRef)
    barRo.observe(stripRef)
    window.addEventListener("resize", measureBar)
    measureBar()
    onCleanup(() => {
      ro.disconnect()
      panelRo.disconnect()
      barRo.disconnect()
      window.removeEventListener("resize", measureBar)
      setDockPanelSize(null)
      setDockBarRect(null)
    })
  })

  // The divider between two joined items is the LEFT item's right border (the
  // bar runs right to left, so every slot but the Chats one has a neighbour
  // on its right). The end items round their hover surface into the bar's
  // corners.
  const SLOT = "relative flex h-full border-r border-border"
  const toggleLabel = () =>
    allCollapsed()
      ? plural("kernel.dock.showAll", tabs().length)
      : i18n.t("kernel.dock.collapseAll")

  return (
    <div
      ref={stripRef}
      data-chat-dock
      data-open={chatsOpen() ? "true" : "false"}
      style={{
        position: "absolute",
        bottom: "0",
        // The strip lies over the page and reserves nothing (dock-store.ts
        // DOCK_STRIP_HEIGHT): the bar alone, anchored to the panel's bottom
        // edge. A window overflows upward out of this box.
        height: `${DOCK_STRIP_HEIGHT}px`,
        // Both edges pinned: the strip spans the main panel cell so the
        // ResizeObserver measures the CELL's width, not the bar's own
        // shrink-wrapped width (which is a function of the items it renders
        // and could never satisfy the capacity formula).
        left: "0",
        right: "0",
        "pointer-events": "none",
        "z-index": 49,
        display: "flex",
        "justify-content": "flex-end",
        "align-items": "flex-start",
        "--dock-tab-width": `${DOCK_TAB_WIDTH}px`,
        "--dock-tab-height": `${DOCK_TAB_HEIGHT}px`,
        "--dock-pill-height": `${DOCK_PILL_HEIGHT}px`,
        "--dock-gap": `${DOCK_GAP}px`,
      }}
    >
      {/* Anchored: the bar's bottom and right edges are the panel's, so it
          draws only its top and left borders, no shadow and no float gap. */}
      <div
        ref={barRef}
        data-dock-bar
        class="flex flex-row-reverse items-stretch rounded-tl-lg border-t border-l border-border-strong bg-elevated [&>*:last-child_[data-dock-pill]]:rounded-tl-[7px]"
        style={{ height: `${DOCK_PILL_HEIGHT}px`, "pointer-events": "auto" }}
      >
        <div ref={chatsRef} class="relative flex h-full">
          {props.chatsTab ?? <DefaultChatsPill />}
        </div>
        <For each={visibleTabs()}>
          {(tab) => (
            <div class={SLOT} data-dock-slot>
              {props.renderTab ? props.renderTab(tab) : DefaultConversationPill(tab)}
            </div>
          )}
        </For>
        <Show when={overflow().length > 0}>
          <div class={SLOT} data-dock-slot>
            <PopupMenu open={overflowOpen()} onOpenChange={setOverflowOpen}>
              <PopupMenu.Trigger
                aria-label={i18n.t("kernel.dock.moreConversations")}
                data-testid="dock-overflow"
                class="flex h-full focus-visible:rounded-none focus-visible:ring-0"
              >
                <span
                  data-dock-pill
                  data-overflow-count={overflow().length}
                  class={`${DOCK_PILL_CLASS} gap-1.5 text-text`}
                >
                  <OverflowFaces />
                  <span class="font-semibold tabular-nums">
                    {i18n.t("kernel.dock.more", { count: overflow().length })}
                  </span>
                </span>
              </PopupMenu.Trigger>
              <PopupMenu.Content>
                <For each={overflow()}>
                  {(tab) => (
                    <PopupMenu.Item
                      onSelect={() => {
                        promoteFromOverflow(tab.threadId)
                        setOverflowOpen(false)
                      }}
                    >
                      {dockTabName(tab.threadId, i18n.t("kernel.dock.conversation"))}
                    </PopupMenu.Item>
                  )}
                </For>
              </PopupMenu.Content>
            </PopupMenu>
          </div>
        </Show>
        {/* The far left: fold every chat into Chats, or bring them back.
            Folded, it shows how many chats it holds so they never vanish. */}
        <Show when={tabs().length > 0}>
          <div ref={toggleRef} class={SLOT}>
            <button
              type="button"
              data-dock-pill
              data-testid="dock-collapse-all"
              aria-expanded={allCollapsed() ? "false" : "true"}
              aria-label={toggleLabel()}
              title={allCollapsed() ? toggleLabel() : i18n.t("kernel.dock.collapseAllShort")}
              class={`${DOCK_PILL_CLASS} gap-1 px-2 text-text-secondary hover:text-text`}
              onClick={() => void toggleAll()}
            >
              <Show
                when={allCollapsed()}
                fallback={<ChevronsRight size={14} stroke-width={2} aria-hidden="true" />}
              >
                <ChevronsLeft size={14} stroke-width={2} aria-hidden="true" />
                <span class="tabular-nums" data-testid="dock-collapse-all-count">
                  {tabs().length}
                </span>
              </Show>
            </button>
          </div>
        </Show>
      </div>
      <span class="sr-only" aria-live="polite" data-testid="dock-collapse-all-status">
        {status()}
      </span>
    </div>
  )
}
