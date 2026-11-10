// SPDX-License-Identifier: FSL-1.1-ALv2
// Home card chrome: drag-handle header, count pill, collapse chevron, drop
// indicator — per the validated demo. Content-agnostic; callers pass the
// card body as children. Drag/collapse state lives in home-card-layout.ts so
// every card instance reads/writes the same store.

import { ChevronRight } from "lucide-solid"
import type { Component, JSX } from "solid-js"
import { Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  beginCardDrag,
  type CardId,
  draggedId,
  dropTargetId,
  endCardDrag,
  isCardCollapsed,
  reorderCards,
  setCardDropTarget,
  toggleCardCollapsed,
} from "~/modules/shell/home-card-layout"

interface HomeCardProps {
  id: CardId
  title: string
  count?: number
  children: JSX.Element
}

const HANDLE_TESTID_PREFIX = "home-card-handle-"

const HomeCard: Component<HomeCardProps> = (props) => {
  const i18n = useI18n()
  const collapsed = () => isCardCollapsed(props.id)
  const isDragging = () => draggedId() === props.id
  const isDropTarget = () => dropTargetId() === props.id && draggedId() !== props.id
  let sectionEl: HTMLElement | undefined

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the card is a drop zone for the header drag; the drag source is the header.
    <section
      ref={sectionEl}
      data-testid={`home-card-${props.id}`}
      class={cn(
        "mb-5 rounded-md border border-border-subtle bg-surface transition-opacity duration-150",
        isDragging() && "opacity-40",
        isDropTarget() && "ring-1 ring-accent",
      )}
      onDragStart={(e) => {
        // Only the header is draggable (below): a card body inside a draggable
        // element gets `user-select: none` in Chromium and a text drag there
        // turns into a card drag, so nobody could select or copy text out of
        // a card. The gate also accepts a dragstart dispatched on the handle
        // itself (the DnD e2e helper, projects-dnd.scenario.test.ts, does).
        // A drag of selected text targets a Text node, which has no closest().
        const target = e.target instanceof Element ? e.target : null
        if (!target?.closest(`[data-home-card-drag="${props.id}"]`)) {
          e.preventDefault()
          return
        }
        e.dataTransfer?.setData("text/plain", props.id)
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move"
          // The ghost still shows the whole card, not only its header.
          if (sectionEl && typeof e.dataTransfer.setDragImage === "function") {
            const rect = sectionEl.getBoundingClientRect()
            e.dataTransfer.setDragImage(sectionEl, e.clientX - rect.left, e.clientY - rect.top)
          }
        }
        beginCardDrag(props.id)
      }}
      onDragOver={(e) => {
        if (!draggedId()) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
        setCardDropTarget(props.id)
      }}
      onDragLeave={() => {
        if (dropTargetId() === props.id) setCardDropTarget(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        const dragged = draggedId()
        if (dragged) reorderCards(dragged, props.id)
        endCardDrag()
      }}
      onDragEnd={() => {
        endCardDrag()
      }}
    >
      <header
        draggable={true}
        data-home-card-drag={props.id}
        data-testid={`home-card-header-${props.id}`}
        class="flex cursor-grab select-none items-center gap-2 px-4 py-2.5 active:cursor-grabbing"
      >
        <button
          type="button"
          data-testid={`home-card-collapse-${props.id}`}
          aria-expanded={!collapsed()}
          aria-label={
            collapsed()
              ? i18n.t("kernel.shellUi.expandCard", { title: props.title })
              : i18n.t("kernel.shellUi.collapseCard", { title: props.title })
          }
          onClick={(e) => {
            e.stopPropagation()
            toggleCardCollapsed(props.id)
          }}
          class="flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <ChevronRight
            size={13}
            class={cn("transition-transform duration-150", !collapsed() && "rotate-90")}
          />
        </button>
        <span data-testid={HANDLE_TESTID_PREFIX + props.id} class="flex flex-1 items-center gap-2">
          <span class="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-text-tertiary">
            {props.title}
          </span>
        </span>
        <Show when={props.count !== undefined}>
          <span
            data-testid={`home-card-count-${props.id}`}
            class="shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary"
          >
            {props.count}
          </span>
        </Show>
      </header>
      <Show when={!collapsed()}>
        <div data-testid={`home-card-body-${props.id}`} class="border-t border-border-subtle">
          {props.children}
        </div>
      </Show>
    </section>
  )
}

export default HomeCard
