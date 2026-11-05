// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The thread map: a narrow strip right of a long conversation, drawn like an
// editor minimap. One canvas block per message tinted by kind, a band for the
// viewport, a "{i} / {n}" counter, and titles (who · date · first line) that
// appear only while the strip is hovered or focused (owner ruling: never at
// rest). Clicking a block or a title lands that message's top in view;
// dragging on the strip scrolls.
//
// Cost is the design constraint: a 200 message thread must scroll as cheaply
// as a 3 message one. Positions are measured only when they can change (mount,
// items change, a resize of the content or the scroller, a theme flip). A
// scroll event reads scrollTop and clientHeight, once per animation frame,
// moves the band with a transform and finds the current message by binary
// search; it never reads an item's layout and never repaints the canvas.
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { cn } from "~/lib/cn"
import {
  currentThreadItemIndex,
  type MeasuredThreadItem,
  offsetInScroller,
  scrollToThreadItem,
  THREAD_MAP_ID_ATTR,
  type ThreadMapItem,
} from "~/ui/thread-map-model"

export interface ThreadMapProps {
  /** The element that scrolls the conversation. */
  scrollEl: () => HTMLElement | undefined
  /** The scroller's content: holds every `[data-thread-map-id]` message root.
   *  May be the scroller itself when its children are the messages. */
  contentEl: () => HTMLElement | undefined
  /** The conversation's messages and events, in thread order. */
  items: () => ThreadMapItem[]
  /** Accessible name of the strip. Callers translate: `ui/` never imports i18n. */
  label: string
  /** The counter's text for message `index` (1-based) of `total`. */
  counter: (index: number, total: number) => string
}

// Show once the thread is 2.5 screens long; hide again only below 2.2. The
// strip takes 84px from the scroller, which rewraps the text taller, so one
// threshold would flicker at the boundary (shown → narrower → taller → ...).
const SHOW_RATIO = 2.5
const HIDE_RATIO = 2.2
// Titles closer than this collide; they are pushed down, then clamped back up
// from the bottom so the last one never falls off the strip.
const TITLE_GAP = 19

interface PlacedTitle {
  item: ThreadMapItem
  y: number
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback
}

export function ThreadMap(props: ThreadMapProps) {
  const [visible, setVisible] = createSignal(false)
  const [titles, setTitles] = createSignal<PlacedTitle[]>([])
  const [activeId, setActiveId] = createSignal<string | null>(null)
  const [counterText, setCounterText] = createSignal("")
  // Hover OR focus inside the strip: the only states that show titles.
  const [hovered, setHovered] = createSignal(false)
  const [focused, setFocused] = createSignal(false)
  const titlesShown = () => hovered() || focused()

  let rootRef: HTMLElement | undefined
  let canvasRef: HTMLCanvasElement | undefined
  let bandRef: HTMLDivElement | undefined

  // Layout as of the last measure. Plain variables, not signals: the scroll
  // path reads them every frame and must not touch the reactive graph.
  let measured: MeasuredThreadItem[] = []
  let messageCount = 0
  let scale = 1
  let activeIndex = -1

  let measureQueued = false
  let scrollQueued = false
  let resize: ResizeObserver | undefined
  const observed = new WeakSet<Element>()

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
    if (!scroller || !content) return
    const total = scroller.scrollHeight
    const viewport = scroller.clientHeight
    // A hidden tab (display: none) reads 0 everywhere: keep the last layout,
    // the resize observer measures again when the tab is shown.
    if (viewport <= 0) return
    const byId = new Map<string, HTMLElement>()
    for (const el of content.querySelectorAll<HTMLElement>(`[${THREAD_MAP_ID_ATTR}]`)) {
      const id = el.getAttribute(THREAD_MAP_ID_ATTR)
      if (!id) continue
      byId.set(id, el)
      // Each message root is watched too, map shown or not: an inline image
      // or a mail iframe that finishes loading grows one message without
      // resizing a container the caller can name (the ticket stream's content
      // IS its scroller), and that growth can be what makes the thread long.
      if (!observed.has(el)) {
        observed.add(el)
        resize?.observe(el)
      }
    }

    const ratio = total / viewport
    const show = visible() ? ratio >= HIDE_RATIO : ratio >= SHOW_RATIO
    setVisible(show && props.items().length > 0)
    if (!visible()) return
    // Just shown from inside a reactive batch: the strip mounts when the batch
    // ends, so measure again on the next frame, with a canvas to paint on.
    if (!rootRef?.isConnected) {
      scheduleMeasure()
      return
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
    messageCount = next.filter((m) => m.item.kind !== "event").length
    const stripHeight = rootRef?.clientHeight || viewport
    scale = total > 0 ? stripHeight / total : 1
    activeIndex = -1
    if (bandRef) bandRef.style.height = `${Math.max(8, viewport * scale)}px`
    draw(stripHeight)
    placeTitles(stripHeight)
    onScroll()
  }

  function draw(stripHeight: number): void {
    const canvas = canvasRef
    if (!canvas || !rootRef) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const w = rootRef.clientWidth || 84
    const h = stripHeight
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    // Read at draw time from the live tokens, so a theme flip repaints in the
    // new palette (the theme observer below schedules this).
    const colour = {
      in: cssVar(rootRef, "--color-text-tertiary", "#888"),
      out: cssVar(rootRef, "--color-accent", "#666"),
      note: cssVar(rootRef, "--color-warning", "#b80"),
      event: cssVar(rootRef, "--color-text-tertiary", "#888"),
    }
    const text = colour.event
    for (const m of measured) {
      const y = m.top * scale
      const bh = Math.max(2, m.height * scale)
      if (m.item.kind === "event") {
        ctx.globalAlpha = 0.7
        ctx.fillStyle = colour.event
        ctx.fillRect(26, y, w - 52, 1)
        ctx.globalAlpha = 1
        continue
      }
      ctx.fillStyle = colour[m.item.kind]
      ctx.globalAlpha = 0.16
      ctx.fillRect(8, y, w - 14, bh)
      ctx.globalAlpha = 1
      ctx.fillRect(8, y, 2, bh)
      ctx.fillRect(14, y + 1, 14, Math.min(2, bh))
      // Pseudo text lines, only where the block is tall enough to hold them.
      if (bh >= 8) {
        ctx.fillStyle = text
        ctx.globalAlpha = 0.45
        const lines = Math.floor((bh - 5) / 3)
        for (let k = 0; k < lines; k++) {
          ctx.fillRect(14, y + 5 + k * 3, 22 + ((k * 37 + Math.round(m.top)) % 29) * 1.3, 1)
        }
        ctx.globalAlpha = 1
      }
    }
  }

  function placeTitles(stripHeight: number): void {
    const messages = measured.filter((m) => m.item.kind !== "event")
    let last = -100
    const ys = messages.map((m) => {
      last = Math.max(m.top * scale + 9, last + TITLE_GAP)
      return last
    })
    for (let k = ys.length - 1, limit = stripHeight - 10; k >= 0; k--) {
      if (ys[k]! > limit) ys[k] = limit
      limit = ys[k]! - TITLE_GAP
    }
    setTitles(messages.map((m, k) => ({ item: m.item, y: ys[k]! })))
  }

  // The scroll path: scrollTop and clientHeight, nothing else.
  function onScroll(): void {
    const scroller = props.scrollEl()
    if (!scroller || !visible() || measured.length === 0) return
    const top = scroller.scrollTop
    if (bandRef) bandRef.style.transform = `translateY(${top * scale}px)`
    const idx = currentThreadItemIndex(measured, top + scroller.clientHeight * 0.3)
    if (idx === activeIndex) return
    activeIndex = idx
    const current = measured[idx]!
    let position = 0
    for (let k = 0; k <= idx; k++) if (measured[k]!.item.kind !== "event") position++
    setActiveId(current.item.id)
    setCounterText(props.counter(Math.max(1, position), messageCount))
  }

  function handleScroll(): void {
    if (scrollQueued) return
    scrollQueued = true
    requestAnimationFrame(() => {
      scrollQueued = false
      onScroll()
    })
  }

  function jump(id: string): void {
    const scroller = props.scrollEl()
    const content = props.contentEl()
    if (scroller && content) scrollToThreadItem(scroller, content, id)
  }

  // Canvas: a click jumps to the message under the pointer, a drag scrolls.
  let dragging = false
  let moved = false
  let startY = 0
  const localY = (e: PointerEvent): number =>
    e.clientY - (canvasRef?.getBoundingClientRect().top ?? 0)

  function onPointerDown(e: PointerEvent): void {
    dragging = true
    moved = false
    startY = e.clientY
    canvasRef?.setPointerCapture?.(e.pointerId)
  }
  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return
    if (Math.abs(e.clientY - startY) > 3) moved = true
    const scroller = props.scrollEl()
    if (moved && scroller && scale > 0) {
      scroller.scrollTop = localY(e) / scale - scroller.clientHeight / 2
    }
  }
  function onPointerUp(e: PointerEvent): void {
    const wasDrag = moved
    dragging = false
    moved = false
    if (wasDrag || scale <= 0) return
    const y = localY(e) / scale
    const messages = measured.filter((m) => m.item.kind !== "event")
    const pick = messages.filter((m) => m.top <= y).pop() ?? messages[0]
    if (pick) jump(pick.item.id)
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
    // The app flips theme by rewriting `data-theme` on <html> (theme-store);
    // the canvas holds pixels, not tokens, so it has to be painted again.
    const theme = new MutationObserver(() => scheduleMeasure())
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    })
    onCleanup(() => {
      scroller.removeEventListener("scroll", handleScroll)
      observer.disconnect()
      resize = undefined
      theme.disconnect()
    })
    scheduleMeasure()
  })

  createEffect(on(props.items, () => scheduleMeasure(), { defer: true }))

  return (
    <Show when={visible()}>
      <nav
        ref={rootRef}
        data-testid="thread-map"
        aria-label={props.label}
        class="relative w-[84px] shrink-0 select-none border-l border-border bg-surface"
        style={{ "touch-action": "none" }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocusIn={() => setFocused(true)}
        onFocusOut={(e) => {
          const next = e.relatedTarget
          if (!(next instanceof Node) || !rootRef?.contains(next)) setFocused(false)
        }}
      >
        <canvas
          ref={canvasRef}
          data-testid="thread-map-canvas"
          class="absolute inset-0 h-full w-full cursor-pointer"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
        />
        <div
          ref={bandRef}
          data-testid="thread-map-band"
          aria-hidden="true"
          class="pointer-events-none absolute inset-x-0 top-0 border-y border-accent-border bg-accent-wash will-change-transform"
        />
        <div
          data-testid="thread-map-counter"
          aria-live="off"
          class="pointer-events-none absolute left-1/2 top-1.5 z-[2] -translate-x-1/2 whitespace-nowrap rounded border border-border bg-elevated px-1.5 font-mono text-[10px] text-text-tertiary"
        >
          {counterText()}
        </div>
        <div
          data-testid="thread-map-titles"
          data-shown={titlesShown() ? "true" : "false"}
          class={cn(
            "absolute inset-y-0 right-[calc(100%+1px)] z-[3] w-[300px] bg-linear-to-l from-surface from-60% to-transparent transition-[opacity,transform] duration-100 motion-reduce:transition-none",
            titlesShown()
              ? "visible translate-x-0 opacity-100"
              : // Transparent, not `invisible`: the titles stay in the Tab
                // order, and tabbing onto one is the focus that shows them.
                "pointer-events-none translate-x-1.5 opacity-0",
          )}
        >
          <For each={titles()}>
            {(t) => (
              <button
                type="button"
                data-testid={`thread-map-title-${t.item.id}`}
                data-active={activeId() === t.item.id ? "true" : undefined}
                class={cn(
                  "absolute right-1.5 flex max-w-[290px] -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded px-1.5 py-px text-[11.5px] text-text-secondary hover:bg-elevated hover:text-text hover:ring-1 hover:ring-border",
                  activeId() === t.item.id && "bg-elevated text-text ring-1 ring-border",
                )}
                style={{ top: `${t.y}px` }}
                onClick={() => jump(t.item.id)}
              >
                <span class="font-mono text-[10px] text-text-tertiary">{t.item.dateLabel}</span>
                <b class="font-semibold">{t.item.who}</b>
                <span class="min-w-0 truncate">{t.item.line}</span>
                <span
                  aria-hidden="true"
                  class={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    t.item.kind === "out"
                      ? "bg-accent"
                      : t.item.kind === "note"
                        ? "bg-warning"
                        : "bg-text-tertiary",
                  )}
                />
              </button>
            )}
          </For>
        </div>
      </nav>
    </Show>
  )
}
