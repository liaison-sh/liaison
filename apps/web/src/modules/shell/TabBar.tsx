// SPDX-License-Identifier: FSL-1.1-ALv2

import { ChevronRight, MessageSquare, X } from "lucide-solid"
import { type Component, createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Dynamic, Portal } from "solid-js/web"
import { executeCommand, getTabType, tabDisplayLabel } from "~/framework/app-registry"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { appIconColor, appIdOfTabType } from "~/modules/shell/app-color"
import { copyLink } from "~/modules/shell/entity-link"
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  closeTabsToRight,
  hasClosableOthers,
  hasClosableToRight,
  isHomeTab,
  promoteTab,
  reorderTabs,
  tabStore,
  tabToUrl,
} from "~/modules/shell/tab-store"
import { ScrollFade } from "~/ui/ScrollFade"

const TabMenuItem: Component<{
  testid: string
  label: string
  disabled: boolean
  onSelect: () => void
}> = (props) => (
  <button
    type="button"
    role="menuitem"
    data-testid={props.testid}
    disabled={props.disabled}
    onClick={() => props.onSelect()}
    class="flex w-full items-center px-3 py-1.5 text-left text-[12.5px] text-text outline-none hover:bg-surface-hover focus-visible:bg-surface-hover disabled:cursor-default disabled:text-text-tertiary disabled:hover:bg-transparent"
  >
    {props.label}
  </button>
)

export const TabBar: Component = () => {
  const i18n = useI18n()
  let containerRef!: HTMLDivElement

  // --- Hover + custom scrollbar ---
  const [isHovered, setIsHovered] = createSignal(false)
  const [scrollThumb, setScrollThumb] = createSignal<{ left: number; width: number } | null>(null)
  // Tabs past the right edge with nothing on screen saying so: the strip
  // scrolls, but only a wheel or a drag discovers it, so a tab someone just
  // opened reads as lost. True while there is still strip to the right.
  const [hasHiddenTabsRight, setHasHiddenTabsRight] = createSignal(false)

  // --- Context menu (right-click, ContextMenu key or Shift+F10 on a tab) ---
  const [menu, setMenu] = createSignal<{ tabId: string; x: number; y: number } | null>(null)
  let menuRef: HTMLDivElement | undefined
  let menuOpener: HTMLElement | null = null

  function openMenu(tabId: string, x: number, y: number, opener: HTMLElement) {
    menuOpener = opener
    setMenu({ tabId, x, y })
    requestAnimationFrame(() => focusMenuItem(0))
    // Focus synchronously too: the menu is mounted by the time setMenu returns.
    focusMenuItem(0)
  }

  function closeMenu(refocus: boolean) {
    setMenu(null)
    if (refocus) menuOpener?.focus()
    menuOpener = null
  }

  function menuItems(): HTMLButtonElement[] {
    return Array.from(menuRef?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])
  }

  function focusMenuItem(index: number) {
    const items = menuItems()
    if (items.length === 0) return
    items[(index + items.length) % items.length].focus()
  }

  /** The route a tab answers at, or null where it has none worth sharing (Home). */
  function tabLink(tabId: string): string | null {
    const tab = tabStore.tabs.find((t) => t.id === tabId)
    if (!tab || isHomeTab(tab)) return null
    const path = tabToUrl(tab)
    return path === "/" ? null : path
  }

  function runMenuAction(action: (tabId: string) => void) {
    const m = menu()
    if (!m) return
    closeMenu(false)
    action(m.tabId)
  }

  const onDocPointerDown = (e: PointerEvent) => {
    if (menu() && !menuRef?.contains(e.target as Node)) closeMenu(false)
  }
  onMount(() => document.addEventListener("pointerdown", onDocPointerDown, true))
  onCleanup(() => document.removeEventListener("pointerdown", onDocPointerDown, true))

  // --- Drag state ---
  // Signals (reactive, drive CSS classes)
  const [dragTabId, setDragTabId] = createSignal<string | null>(null)
  const [dragActive, setDragActive] = createSignal(false)

  // Plain vars (imperative, used only inside handlers)
  let _pointerId = -1
  let _startX = 0
  let _originalIndex = -1
  let _targetIndex = -1
  let _draggedEl: HTMLElement | null = null
  let _rects: Array<{ mid: number; width: number }> = []
  // Outer refs to the currently-registered document listeners, so any
  // cleanup path (pointerup, lostpointercapture, pointercancel) can remove
  // exactly the pair that's live, without duplicating the closures.
  let _onMove: ((ev: PointerEvent) => void) | null = null
  let _onUp: ((ev: PointerEvent) => void) | null = null
  let _onCancel: ((ev: PointerEvent) => void) | null = null

  function removeDragListeners() {
    if (_onMove) document.removeEventListener("pointermove", _onMove)
    if (_onUp) document.removeEventListener("pointerup", _onUp)
    if (_onCancel) document.removeEventListener("pointercancel", _onCancel)
    _onMove = null
    _onUp = null
    _onCancel = null
  }

  function handlePointerDown(e: PointerEvent, tabId: string) {
    if (e.button !== 0) return
    const el = e.currentTarget as HTMLElement

    _pointerId = e.pointerId
    _startX = e.clientX
    _draggedEl = el
    _originalIndex = tabStore.tabs.findIndex((t) => t.id === tabId)
    _targetIndex = _originalIndex

    // Snapshot all tab rects once (stable for the entire drag)
    const tabEls = containerRef.querySelectorAll<HTMLElement>("[data-tab]")
    _rects = Array.from(tabEls).map((t) => {
      const r = t.getBoundingClientRect()
      return { mid: r.left + r.width / 2, width: r.width }
    })

    setDragTabId(tabId)
    setDragActive(false)

    // Listen on document for move/up so drag works outside the tab element
    removeDragListeners()
    _onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== _pointerId) return
      handlePointerMove(ev)
    }
    _onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== _pointerId) return
      handlePointerUp(ev)
      removeDragListeners()
    }
    _onCancel = (ev: PointerEvent) => {
      if (ev.pointerId !== _pointerId) return
      handlePointerCancel(ev)
    }
    document.addEventListener("pointermove", _onMove)
    document.addEventListener("pointerup", _onUp)
    document.addEventListener("pointercancel", _onCancel)
  }

  function handlePointerMove(e: PointerEvent) {
    if (!dragTabId()) return

    const dx = e.clientX - _startX

    // Threshold before activating drag
    if (!dragActive() && Math.abs(dx) < 4) return
    if (!dragActive()) {
      setDragActive(true)
      document.body.style.cursor = "grabbing"
    }

    // Move dragged tab to follow cursor (no transition)
    if (_draggedEl) _draggedEl.style.transform = `translateX(${dx}px)`

    // Determine target index by comparing dragged tab center vs idle tab centers
    const draggedCenter = _rects[_originalIndex].mid + dx
    let target = _originalIndex

    for (let i = 0; i < _rects.length; i++) {
      if (i === _originalIndex) continue
      if (i < _originalIndex && draggedCenter < _rects[i].mid) {
        target = i
        break
      }
      if (i > _originalIndex && draggedCenter > _rects[i].mid) {
        target = i
      }
    }
    _targetIndex = target

    // Shift idle tabs to make room (with CSS transitions on idle items)
    const tabEls = containerRef.querySelectorAll<HTMLElement>("[data-tab]")
    const dragW = _rects[_originalIndex].width
    for (let i = 0; i < tabEls.length; i++) {
      if (i === _originalIndex) continue
      let shift = 0
      if (_originalIndex < _targetIndex && i > _originalIndex && i <= _targetIndex) {
        shift = -dragW // items between old and new slide left
      } else if (_originalIndex > _targetIndex && i >= _targetIndex && i < _originalIndex) {
        shift = dragW // items between new and old slide right
      }
      tabEls[i].style.transform = shift ? `translateX(${shift}px)` : ""
    }
  }

  function handlePointerUp(e: PointerEvent) {
    if (e.pointerId !== _pointerId) return
    const wasDrag = dragActive()
    const tabId = dragTabId()

    // Clear all inline transforms + transitions
    const tabEls = containerRef.querySelectorAll<HTMLElement>("[data-tab]")
    tabEls.forEach((el) => {
      el.style.transform = ""
    })

    // Commit reorder if drag happened and position changed
    if (wasDrag && _originalIndex !== _targetIndex) {
      if (tabStore.tabs[_originalIndex]?.id === tabId) {
        reorderTabs(_originalIndex, _targetIndex)
      }
      // else: tabs changed during drag — abort silently
    }

    // If no drag, treat as click
    if (!wasDrag && tabId) {
      activateTab(tabId)
    }

    // Reset state
    setDragTabId(null)
    setDragActive(false)
    _pointerId = -1
    _draggedEl = null
    _rects = []
    document.body.style.cursor = ""
  }

  function handleLostCapture(e: PointerEvent) {
    if (e.pointerId !== _pointerId) return
    const tabEls = containerRef.querySelectorAll<HTMLElement>("[data-tab]")
    tabEls.forEach((el) => {
      el.style.transform = ""
    })
    setDragTabId(null)
    setDragActive(false)
    _pointerId = -1
    _draggedEl = null
    _rects = []
    document.body.style.cursor = ""
    removeDragListeners()
  }

  function handlePointerCancel(e: PointerEvent) {
    if (e.pointerId !== _pointerId) return
    const tabEls = containerRef.querySelectorAll<HTMLElement>("[data-tab]")
    tabEls.forEach((el) => {
      el.style.transform = ""
    })
    setDragTabId(null)
    setDragActive(false)
    _pointerId = -1
    _draggedEl = null
    _rects = []
    document.body.style.cursor = ""
    removeDragListeners()
  }

  // --- Scroll logic ---
  function updateScrollState() {
    if (!containerRef) return
    const { scrollLeft, scrollWidth, clientWidth } = containerRef
    const atStart = scrollLeft <= 0
    const atEnd = scrollLeft + clientWidth >= scrollWidth - 1

    if (atStart) containerRef.setAttribute("data-scroll-start", "")
    else containerRef.removeAttribute("data-scroll-start")

    if (atEnd) containerRef.setAttribute("data-scroll-end", "")
    else containerRef.removeAttribute("data-scroll-end")

    setHasHiddenTabsRight(scrollWidth > clientWidth && !atEnd)

    // Custom scrollbar thumb
    if (scrollWidth <= clientWidth) {
      setScrollThumb(null)
    } else {
      const ratio = clientWidth / scrollWidth
      const thumbWidth = Math.max(ratio * clientWidth, 24)
      const maxScroll = scrollWidth - clientWidth
      const thumbLeft = maxScroll > 0 ? (scrollLeft / maxScroll) * (clientWidth - thumbWidth) : 0
      setScrollThumb({ left: thumbLeft, width: thumbWidth })
    }
  }

  /** Brings the far end of the strip into view, so the right-most tab is
   *  always reachable without a wheel. */
  function revealEnd() {
    if (!containerRef) return
    containerRef.scrollLeft = containerRef.scrollWidth - containerRef.clientWidth
    updateScrollState()
  }

  function handleWheel(e: WheelEvent) {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault()
      containerRef.scrollLeft += e.deltaY
    }
  }

  // Auto-scroll active tab into view, again when its label changes (a rename
  // can widen it past the strip's right edge).
  createEffect(() => {
    tabStore.activeTabId
    tabStore.tabs.find((t) => t.id === tabStore.activeTabId)?.label
    requestAnimationFrame(() => {
      if (!containerRef) return
      const el = containerRef.querySelector<HTMLElement>('[aria-selected="true"]')
      if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" })
    })
  })

  onMount(() => {
    containerRef.addEventListener("scroll", updateScrollState, { passive: true })
    containerRef.addEventListener("wheel", handleWheel, { passive: false })
    containerRef.addEventListener("lostpointercapture", handleLostCapture as EventListener)
    const ro = new ResizeObserver(updateScrollState)
    ro.observe(containerRef)
    updateScrollState()
    onCleanup(() => {
      containerRef.removeEventListener("scroll", updateScrollState)
      containerRef.removeEventListener("wheel", handleWheel)
      containerRef.removeEventListener("lostpointercapture", handleLostCapture as EventListener)
      removeDragListeners()
      ro.disconnect()
    })
  })

  return (
    <div class="flex shrink-0 border-b border-border-subtle bg-surface">
      {/* Scrollable tabs + custom scrollbar */}
      <div
        class="relative min-w-0 flex-1"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <ScrollFade
          orientation="horizontal"
          scrollRef={(el) => {
            containerRef = el
          }}
          scrollClass="tab-bar [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div
            role="tablist"
            data-testid="tabstrip"
            class="flex"
            onKeyDown={(e) => {
              const tabs = tabStore.tabs
              if (!tabs.length) return
              const currentIdx = tabs.findIndex((t) => t.id === tabStore.activeTabId)
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault()
                const next =
                  e.key === "ArrowRight"
                    ? (currentIdx + 1) % tabs.length
                    : (currentIdx - 1 + tabs.length) % tabs.length
                activateTab(tabs[next].id)
                const el = containerRef?.querySelector(
                  `[data-tab-id="${tabs[next].id}"]`,
                ) as HTMLElement
                el?.focus()
              } else if (e.key === "Home") {
                e.preventDefault()
                activateTab(tabs[0].id)
                const el = containerRef?.querySelector(
                  `[data-tab-id="${tabs[0].id}"]`,
                ) as HTMLElement
                el?.focus()
              } else if (e.key === "End") {
                e.preventDefault()
                activateTab(tabs[tabs.length - 1].id)
                const el = containerRef?.querySelector(
                  `[data-tab-id="${tabs[tabs.length - 1].id}"]`,
                ) as HTMLElement
                el?.focus()
              }
            }}
          >
            <For each={tabStore.tabs}>
              {(tab) => {
                const isActive = () => tabStore.activeTabId === tab.id
                const isDragging = () => dragTabId() === tab.id && dragActive()
                const isIdleDuringDrag = () =>
                  dragTabId() !== null && dragActive() && dragTabId() !== tab.id
                const reg = () => getTabType(tab.type)
                const Icon = () => reg()?.icon ?? MessageSquare
                // A tab type with a FIXED name (Home, Settings, Search, Mail)
                // is named from the catalog, so the strip follows the reader's
                // language; the stored `tab.label` stays the English fallback
                // for an entity tab and for an app that ships no key. The
                // phone header names the same tab the same way.
                const displayLabel = () => tabDisplayLabel(i18n.t, tab)

                return (
                  <button
                    type="button"
                    data-tab
                    data-tab-id={tab.id}
                    data-tab-type={tab.type}
                    data-active={isActive()}
                    role="tab"
                    aria-selected={isActive()}
                    tabIndex={isActive() ? 0 : -1}
                    class={cn(
                      "group relative flex h-9 max-w-[200px] shrink-0 select-none items-center gap-1.5 border-r border-border-subtle px-3 text-[12.5px]",
                      isActive()
                        ? "bg-bg text-text"
                        : "bg-surface text-text-secondary hover:bg-surface-hover hover:text-text",
                      isDragging() && "z-20 opacity-75 shadow-sm",
                      isIdleDuringDrag() && "transition-transform duration-150 ease-out",
                      !dragActive() && "transition-colors duration-100",
                    )}
                    onPointerDown={(e) => handlePointerDown(e, tab.id)}
                    onClick={() => activateTab(tab.id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      openMenu(tab.id, e.clientX, e.clientY, e.currentTarget)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
                        e.preventDefault()
                        e.stopPropagation()
                        const r = e.currentTarget.getBoundingClientRect()
                        openMenu(tab.id, r.left, r.bottom, e.currentTarget)
                      }
                    }}
                    onDblClick={() => promoteTab(tab.id)}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault()
                        closeTab(tab.id)
                      }
                    }}
                  >
                    {/* Active indicator */}
                    <Show when={isActive()}>
                      <span class="absolute bottom-0 left-0 right-0 h-[2px] bg-accent" />
                    </Show>

                    {/* Same per-app colour as the rail: a strip of eight grey
                        glyphs told the reader nothing the label did not. */}
                    <span
                      data-app-glyph={appIdOfTabType(tab.type)}
                      class="flex shrink-0 items-center justify-center"
                      style={{ color: appIconColor(appIdOfTabType(tab.type)) }}
                    >
                      <Show
                        when={reg()?.entityIcon}
                        fallback={<Dynamic component={Icon()} size={14} />}
                      >
                        {(EntityIcon) => (
                          <Dynamic component={EntityIcon()} entityId={tab.entityId} size={14} />
                        )}
                      </Show>
                    </span>

                    <span class={cn("min-w-0 truncate", tab.isPreview && "italic pr-0.5")}>
                      {displayLabel()}
                    </span>

                    {/* Close button: always visible on active, hover on others */}
                    <span
                      data-tab-close
                      class={cn(
                        "ml-0.5 flex h-4 w-4 items-center justify-center rounded-sm transition-colors hover:bg-surface-hover",
                        isActive()
                          ? "opacity-60 hover:opacity-100"
                          : "opacity-0 group-hover:opacity-60 group-hover:hover:opacity-100",
                      )}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation()
                        closeTab(tab.id)
                      }}
                    >
                      <X size={12} />
                    </span>
                  </button>
                )
              }}
            </For>
          </div>
        </ScrollFade>

        <Show when={menu()}>
          {(m) => {
            const isHome = () =>
              tabStore.tabs.find((t) => t.id === m().tabId)?.type === "kernel:home"
            return (
              <Portal>
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: keys handled by onKeyDown */}
                <div
                  ref={(el) => {
                    menuRef = el
                  }}
                  role="menu"
                  data-testid="tab-context-menu"
                  aria-label={i18n.t("kernel.nav.tabMenu")}
                  class="fixed z-50 min-w-[180px] rounded-md border border-border bg-elevated py-1 shadow-popover"
                  style={{ left: `${m().x}px`, top: `${m().y}px` }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault()
                      e.stopPropagation()
                      closeMenu(true)
                    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault()
                      const items = menuItems()
                      const at = items.indexOf(document.activeElement as HTMLButtonElement)
                      focusMenuItem(at + (e.key === "ArrowDown" ? 1 : -1))
                    } else if (e.key === "Tab") {
                      closeMenu(true)
                    }
                  }}
                >
                  <TabMenuItem
                    testid="tab-context-close"
                    label={i18n.t("kernel.nav.tabClose")}
                    disabled={isHome()}
                    onSelect={() => runMenuAction(closeTab)}
                  />
                  <TabMenuItem
                    testid="tab-context-close-others"
                    label={i18n.t("kernel.nav.tabCloseOthers")}
                    disabled={!hasClosableOthers(m().tabId)}
                    onSelect={() => runMenuAction(closeOtherTabs)}
                  />
                  <TabMenuItem
                    testid="tab-context-close-right"
                    label={i18n.t("kernel.nav.tabCloseRight")}
                    disabled={!hasClosableToRight(m().tabId)}
                    onSelect={() => runMenuAction(closeTabsToRight)}
                  />
                  <Show when={tabLink(m().tabId)}>
                    {(path) => (
                      <TabMenuItem
                        testid="tab-context-copy-link"
                        label={i18n.t("kernel.copyLink")}
                        disabled={false}
                        onSelect={() => runMenuAction(() => void copyLink(path()))}
                      />
                    )}
                  </Show>
                </div>
              </Portal>
            )
          }}
        </Show>

        {/* Custom floating scrollbar */}
        <Show when={scrollThumb()}>
          {(thumb) => (
            <div
              class={cn(
                "pointer-events-none absolute bottom-0 left-0 right-0 z-20 h-[3px] transition-opacity duration-200 ease-out",
                isHovered() ? "opacity-100" : "opacity-0",
              )}
            >
              <div
                class="absolute top-0 h-full rounded-full bg-text-tertiary/40"
                style={{ left: `${thumb().left}px`, width: `${thumb().width}px` }}
              />
            </div>
          )}
        </Show>
      </div>

      {/* Toolbar — overflow affordance + command palette. No panel toggle: nothing
          opens the right panel any more, so the button toggled an empty column. */}
      <div class="flex shrink-0 items-center">
        <Show when={hasHiddenTabsRight()}>
          <button
            type="button"
            data-testid="tabstrip-overflow"
            aria-label={i18n.t("kernel.nav.moreTabs")}
            title={i18n.t("kernel.nav.moreTabs")}
            onClick={revealEnd}
            class="flex h-9 w-6 items-center justify-center border-l border-border-subtle text-text-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-text-secondary"
          >
            <ChevronRight size={15} />
          </button>
        </Show>
        <button
          type="button"
          aria-label={i18n.t("kernel.commandPalette2")}
          onClick={() => executeCommand("kernel:command-palette")}
          class="flex h-9 w-9 items-center justify-center text-text-tertiary transition-colors duration-150 hover:bg-surface-hover hover:text-text-secondary"
        >
          <span class="flex h-[13px] w-[13px] items-center justify-center rounded-[1.5px] border border-current text-[9px] font-medium leading-none opacity-70">
            /
          </span>
        </button>
      </div>
    </div>
  )
}
