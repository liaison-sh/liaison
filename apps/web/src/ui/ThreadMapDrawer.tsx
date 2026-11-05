// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The thread map's phone form. A canvas strip has no room on a 390px screen,
// so the phone gets a LIST in a right-hand drawer: one row per message (kind
// bar, who, date, two lines of its first line), the current message
// highlighted; a tap closes the drawer and lands that message's top in view.
//
// Hidden by default (owner ruling). Two ways in: the button the phone header
// carries (it flips `thread-map-store`), and a "{i} / {n} · who" pill that
// appears while the conversation scrolls and fades 1.6 s after it stops. The
// right-edge swipe of the prototype was dropped: Android's back gesture owns
// that edge.
//
// Same cost rule as the desktop map: positions are measured on mount, item
// changes and resizes; a scroll reads scrollTop and clientHeight, once per
// frame, and binary-searches the current message.
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { OverlaySheet } from "~/ui/OverlaySheet"
import {
  currentThreadItemIndex,
  type MeasuredThreadItem,
  offsetInScroller,
  scrollToThreadItem,
  THREAD_MAP_ID_ATTR,
  type ThreadMapItem,
} from "~/ui/thread-map-model"
import { THREAD_MAP_MIN_MESSAGES } from "~/ui/thread-map-store"

export interface ThreadMapDrawerProps {
  /** The element that scrolls the conversation. */
  scrollEl: () => HTMLElement | undefined
  /** The scroller's content (or the scroller itself): holds the message roots. */
  contentEl: () => HTMLElement | undefined
  /** The conversation's messages (and events, which get no row), in order. */
  items: () => ThreadMapItem[]
  open: boolean
  onOpen: () => void
  onClose: () => void
  // Every string below is translated by the caller: `ui/` never imports i18n.
  title: string
  summary: (count: number, first: string, last: string) => string
  pill: (index: number, total: number, who: string) => string
  /** Accessible name of the pill (it opens the drawer). */
  openLabel: string
  closeLabel: string
  noteTag: string
}

// How long the pill stays after the last scroll frame.
export const THREAD_MAP_PILL_IDLE_MS = 1600

export function ThreadMapDrawer(props: ThreadMapDrawerProps) {
  const [activeId, setActiveId] = createSignal<string | null>(null)
  const [pillText, setPillText] = createSignal("")
  const [pillShown, setPillShown] = createSignal(false)
  const [heights, setHeights] = createSignal<Record<string, number>>({})

  const messages = () => props.items().filter((i) => i.kind !== "event")
  const available = () => messages().length >= THREAD_MAP_MIN_MESSAGES
  const tallest = () => Math.max(1, ...Object.values(heights()))

  // Plain state for the scroll path, as in ThreadMap.
  let measured: MeasuredThreadItem[] = []
  let activeIndex = -1
  let measureQueued = false
  let scrollQueued = false
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let resize: ResizeObserver | undefined
  const observed = new WeakSet<Element>()
  let listRef: HTMLDivElement | undefined

  function scheduleMeasure(): void {
    if (measureQueued) return
    measureQueued = true
    requestAnimationFrame(() => {
      measureQueued = false
      measure()
    })
  }

  function measure(): void {
    const scroller = props.scrollEl()
    const content = props.contentEl()
    if (!scroller || !content || scroller.clientHeight <= 0) return
    const byId = new Map<string, HTMLElement>()
    for (const el of content.querySelectorAll<HTMLElement>(`[${THREAD_MAP_ID_ATTR}]`)) {
      const id = el.getAttribute(THREAD_MAP_ID_ATTR)
      if (!id) continue
      byId.set(id, el)
      if (!observed.has(el)) {
        observed.add(el)
        resize?.observe(el)
      }
    }
    const next: MeasuredThreadItem[] = []
    for (const item of props.items()) {
      const el = byId.get(item.id)
      if (!el) continue
      const rect = el.getBoundingClientRect()
      next.push({ item, top: offsetInScroller(scroller, el), height: rect.height })
    }
    next.sort((a, b) => a.top - b.top)
    measured = next
    setHeights(Object.fromEntries(next.map((m) => [m.item.id, m.height])))
    activeIndex = -1
    locate()
  }

  // The scroll path: scrollTop and clientHeight, nothing else.
  function locate(): void {
    const scroller = props.scrollEl()
    if (!scroller || measured.length === 0) return
    const idx = currentThreadItemIndex(measured, scroller.scrollTop + scroller.clientHeight * 0.3)
    if (idx === activeIndex) return
    activeIndex = idx
    const current = measured[idx]!
    let position = 0
    for (let k = 0; k <= idx; k++) if (measured[k]!.item.kind !== "event") position++
    const total = measured.filter((m) => m.item.kind !== "event").length
    setActiveId(current.item.id)
    setPillText(props.pill(Math.max(1, position), total, current.item.who))
  }

  function handleScroll(): void {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      locate()
      if (!available()) return
      setPillShown(true)
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => setPillShown(false), THREAD_MAP_PILL_IDLE_MS)
    })
  }

  function jump(id: string): void {
    props.onClose()
    const scroller = props.scrollEl()
    const content = props.contentEl()
    if (scroller && content) scrollToThreadItem(scroller, content, id)
  }

  onMount(() => {
    const scroller = props.scrollEl()
    const content = props.contentEl()
    if (!scroller || !content) return
    scroller.addEventListener("scroll", handleScroll, { passive: true })
    const observer = new ResizeObserver(() => scheduleMeasure())
    resize = observer
    observer.observe(scroller)
    if (content !== scroller) observer.observe(content)
    onCleanup(() => {
      scroller.removeEventListener("scroll", handleScroll)
      observer.disconnect()
      resize = undefined
      clearTimeout(idleTimer)
    })
    scheduleMeasure()
  })

  createEffect(on(props.items, () => scheduleMeasure(), { defer: true }))

  // Opening: measure now (the drawer may be the first reader since a
  // resize), then bring the current row into the middle of the list.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        setPillShown(false)
        measure()
        requestAnimationFrame(() => {
          listRef
            ?.querySelector<HTMLElement>("[data-active='true']")
            ?.scrollIntoView({ block: "center" })
        })
      },
      { defer: true },
    ),
  )

  return (
    <Show when={available()}>
      <button
        type="button"
        data-testid="thread-map-pill"
        data-shown={pillShown() ? "true" : "false"}
        aria-label={props.openLabel}
        aria-hidden={pillShown() ? undefined : "true"}
        tabIndex={pillShown() ? 0 : -1}
        class={cn(
          "absolute bottom-3 right-3 z-10 flex min-h-9 items-center gap-1.5 rounded-full border border-border bg-elevated px-3 font-mono text-[11px] text-text-secondary shadow-popover transition-opacity duration-200 motion-reduce:transition-none",
          pillShown() ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => props.onOpen()}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M4 6h12M4 10h8M4 14h12" />
        </svg>
        {pillText()}
      </button>
      <OverlaySheet
        open={props.open}
        onClose={props.onClose}
        variant="side"
        anchor="right"
        width="82%"
        title={props.title}
        closeLabel={props.closeLabel}
      >
        <div data-testid="thread-map-drawer" class="flex flex-col">
          <p data-testid="thread-map-summary" class="px-4 pt-2 text-[12px] text-text-tertiary">
            {props.summary(
              messages().length,
              messages()[0]?.dateLabel ?? "",
              messages()[messages().length - 1]?.dateLabel ?? "",
            )}
          </p>
          <div ref={listRef} class="grid content-start gap-0.5 p-2 pb-8">
            <For each={messages()}>
              {(item) => (
                <button
                  type="button"
                  data-testid={`thread-map-row-${item.id}`}
                  data-active={activeId() === item.id ? "true" : undefined}
                  class={cn(
                    "grid min-h-11 grid-cols-[6px_minmax(0,1fr)] gap-2.5 rounded-lg p-2 text-left text-text hover:bg-surface-hover",
                    activeId() === item.id && "bg-surface-sunken ring-1 ring-inset ring-border",
                  )}
                  onClick={() => jump(item.id)}
                >
                  <span
                    aria-hidden="true"
                    class={cn(
                      "self-stretch rounded-[3px]",
                      item.kind === "out"
                        ? "bg-accent"
                        : item.kind === "note"
                          ? "bg-warning"
                          : "bg-text-tertiary",
                    )}
                    // A longer message wears a stronger bar: the list keeps a
                    // hint of the thread's shape the canvas map shows outright.
                    style={{ opacity: 0.35 + (0.65 * (heights()[item.id] ?? 0)) / tallest() }}
                  />
                  <span class="min-w-0">
                    <span class="flex items-baseline gap-1.5 text-[13px]">
                      <b class="min-w-0 truncate font-semibold">{item.who}</b>
                      <Show when={item.kind === "note"}>
                        <span class="font-mono text-[10px] text-text-tertiary">
                          {props.noteTag}
                        </span>
                      </Show>
                      <small class="ml-auto shrink-0 font-mono text-[10.5px] text-text-tertiary">
                        {item.dateLabel}
                      </small>
                    </span>
                    <span class="line-clamp-2 text-[12.5px] text-text-secondary">{item.line}</span>
                  </span>
                </button>
              )}
            </For>
          </div>
        </div>
      </OverlaySheet>
    </Show>
  )
}
