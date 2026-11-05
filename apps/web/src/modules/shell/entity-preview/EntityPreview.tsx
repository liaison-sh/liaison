// SPDX-License-Identifier: FSL-1.1-ALv2

import { createSignal, For, onCleanup, type ParentComponent, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { capitalize, formatDateTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"
import { FloatingPanel } from "~/ui/FloatingPanel"
import { getCached, loadPreview, previewStore } from "./entity-preview-store"
import { getEntityPreviewRenderer } from "./registry"

interface EntityPreviewProps {
  app: string
  entityType: string
  entityId: string
  trigger?: "click-or-hover" | "hover"
  interactiveChild?: boolean
  /** Extra classes for the anchor, so a caller in a tight row can let it
   *  shrink (`min-w-0`) and truncate the label inside it. */
  class?: string
  /** The anchor sits INSIDE a line of prose (a mention chip in a message).
   *  It stays a plain inline box and opts out of the compact tiers' 44px touch
   *  floor: as an inline-flex `role="button"` it inherited `min-height: 44px`
   *  on phone and the chip grew into a two-line slab that broke the paragraph.
   *  The finger-sized hit area comes from the chip's own `::after` instead
   *  (index.css, `.mention-pill`), which enlarges the target without moving
   *  a single line of text. */
  inline?: boolean
}

const EntityPreview: ParentComponent<EntityPreviewProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [open, setOpen] = createSignal(false)
  const [pinned, setPinned] = createSignal(false)
  let hoverTimer: number | undefined
  const cacheKey = () => `${props.app}:${props.entityType}:${props.entityId}`
  const entry = () => previewStore.byKey[cacheKey()]
  const renderer = () => getEntityPreviewRenderer(props.app, props.entityType)

  function ensureLoaded(): void {
    const registered = renderer()
    const fetcher = registered?.fetch ?? (async () => null)
    if (!getCached(props.app, props.entityType, props.entityId)?.loading) {
      void loadPreview(api, props.app, props.entityType, props.entityId, fetcher)
    }
  }

  function onPointerEnter(event?: PointerEvent | MouseEvent | FocusEvent): void {
    const currentTarget = event?.currentTarget
    const relatedTarget = event?.relatedTarget
    if (
      currentTarget instanceof Node &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    )
      return
    if (hoverTimer) clearTimeout(hoverTimer)
    hoverTimer = window.setTimeout(() => {
      ensureLoaded()
      setOpen(true)
    }, 500)
  }

  function onPointerLeave(event?: PointerEvent | MouseEvent | FocusEvent): void {
    const currentTarget = event?.currentTarget
    const relatedTarget = event?.relatedTarget
    if (
      currentTarget instanceof Node &&
      relatedTarget instanceof Node &&
      currentTarget.contains(relatedTarget)
    )
      return
    if (hoverTimer) {
      clearTimeout(hoverTimer)
      hoverTimer = undefined
    }
    if (!pinned()) setOpen(false)
  }

  function onChildClick(event: MouseEvent): void {
    if (props.trigger === "hover") return
    event.stopPropagation()
    ensureLoaded()
    setPinned(true)
    setOpen(true)
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape" && pinned()) {
      setPinned(false)
      setOpen(false)
    }
  }

  function onFloatingOpenChange(nextOpen: boolean): void {
    if (!nextOpen) {
      setOpen(false)
      return
    }
    if (props.trigger === "hover") return
    ensureLoaded()
    setPinned(true)
    setOpen(true)
  }

  // Open the entity in its own tab (or, for an external-only entity like a
  // Shopify order, its external deep link) — the routing lives in `openEntity`.
  // Called directly from the click handler so the external-link path opens its
  // window inside the user gesture (popup-blocker safe).
  function handleOpen(): void {
    setPinned(false)
    setOpen(false)
    void openEntity(api, props.app, props.entityType, props.entityId)
  }

  onCleanup(() => {
    if (hoverTimer) clearTimeout(hoverTimer)
  })

  // Anchor element for the popover. Without it (no FloatingPanel.Trigger in this
  // tree either) Kobalte had no reference rect and rendered the preview detached
  // at the top-right corner of the viewport instead of at the mention.
  const [anchorEl, setAnchorEl] = createSignal<HTMLElement | undefined>()

  return (
    <FloatingPanel open={open()} onOpenChange={onFloatingOpenChange} anchorRef={anchorEl}>
      <span
        ref={setAnchorEl}
        data-testid="entity-preview"
        class={cn(props.inline ? "inline" : "inline-flex", props.class)}
        data-touch-dense={props.inline ? "" : undefined}
        role={props.interactiveChild ? "presentation" : "button"}
        tabIndex={props.interactiveChild ? undefined : 0}
        onPointerOver={onPointerEnter}
        onPointerOut={onPointerLeave}
        onFocus={onPointerEnter}
        onBlur={onPointerLeave}
        onClick={props.trigger === "hover" ? undefined : onChildClick}
        onKeyDown={props.trigger === "hover" ? undefined : onKeyDown}
      >
        {props.children}
      </span>
      <Show when={open()}>
        <FloatingPanel.Content class="w-80 p-3" data-testid="entity-preview-content">
          <Show when={entry()?.loading}>
            <div class="text-[12px] text-text-tertiary">{i18n.t("kernel.common.loading3")}</div>
          </Show>
          <Show when={entry()?.error}>
            <div class="text-[12px] text-error">{i18n.t("kernel.couldnTLoadPreview")}</div>
          </Show>
          <Show when={entry()?.deleted}>
            <div class="text-[12px] text-text-tertiary">
              {i18n.t("kernel.shellUi.this")} {props.entityType}{" "}
              {i18n.t("kernel.shellUi.noLongerExists")}
            </div>
          </Show>
          <Show when={entry()?.entity && renderer()}>
            <div>{renderer()!.render(entry()!.entity)}</div>
          </Show>
          <Show when={entry()?.entity}>
            <div class="mt-2 flex justify-end border-t border-border-subtle pt-2">
              <button
                data-testid="entity-preview-open"
                type="button"
                onClick={handleOpen}
                class="rounded bg-accent px-3 py-1 text-[12px] font-medium text-accent-foreground hover:bg-accent-hover"
              >
                {i18n.t("kernel.entityActions.open")}
              </button>
            </div>
          </Show>
          <Show when={!renderer() && !entry()?.loading && !entry()?.error && !entry()?.deleted}>
            <div class="text-[12px] text-text-tertiary">
              {props.entityType}: {props.entityId}
            </div>
          </Show>
          <Show when={entry()?.timeline?.length}>
            <div class="mt-2 space-y-1 border-t border-border-subtle pt-2 text-[11px] text-text-tertiary">
              <For each={entry()!.timeline!}>
                {(timelineEntry) => (
                  <div data-testid="entity-preview-timeline-entry">
                    {timelineEntry.actor
                      ? `${timelineEntry.actor} ${timelineEntry.action}`
                      : capitalize(timelineEntry.action)}{" "}
                    · {formatDateTime(timelineEntry.occurredAt, i18n.locale())}
                  </div>
                )}
              </For>
            </div>
          </Show>
        </FloatingPanel.Content>
      </Show>
    </FloatingPanel>
  )
}

export default EntityPreview
