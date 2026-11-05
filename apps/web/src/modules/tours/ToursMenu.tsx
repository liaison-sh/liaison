// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Show me how": the tours available for the org's installed apps (the
 * server filters the catalogue), each with its status and Start/Resume. A
 * popup menu off the activity bar on desktop and tablet; a list in a bottom
 * sheet from the Work screen on phone.
 */
import type { TourListItem } from "@liaison/shared"
import { ChevronRight, CircleHelp } from "lucide-solid"
import { type Component, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { OverlaySheet } from "~/ui/OverlaySheet"
import { PopupMenu } from "~/ui/PopupMenu"
import { Tooltip } from "~/ui/Tooltip"
import { tourStore } from "./tour-store"

type T = ReturnType<typeof useI18n>["t"]

/** "New", "Step k of n", "Done", "Stopped" (ended before the last beat): the row's status line. */
export function tourStatusLabel(item: TourListItem, t: T): string {
  const p = item.progress
  if (!p) return t("tours.engine.statusNew")
  if (p.status === "abandoned") return t("tours.engine.statusStopped")
  if (p.status === "completed") return t("tours.engine.statusDone")
  const k = Math.min(p.beatIndex + 1, p.beatCount)
  return t("tours.engine.statusInProgress", { k, n: p.beatCount })
}

/** "Start", "Resume", "Play again" or "Start again". */
export function tourActionLabel(item: TourListItem, t: T): string {
  const p = item.progress
  if (p?.status === "active" || p?.status === "paused") return t("tours.engine.resume")
  if (p?.status === "completed") return t("tours.engine.playAgain")
  if (p?.status === "abandoned") return t("tours.engine.startAgain")
  return t("tours.engine.start")
}

function statusOf(item: TourListItem): string {
  return item.progress?.status ?? "new"
}

const RowText: Component<{ item: TourListItem }> = (props) => {
  const i18n = useI18n()
  return (
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-text">{i18n.t(props.item.title)}</span>
      <span data-testid="tours-menu-status" class="truncate text-[11.5px] text-text-tertiary">
        {tourStatusLabel(props.item, i18n.t)}
      </span>
    </span>
  )
}

/** Desktop/tablet: the "?" in the activity bar's bottom cluster. */
export const ToursHelpButton: Component<{ buttonClass: (extra?: string) => string }> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) void tourStore.refreshList()
  }
  return (
    <PopupMenu open={open()} onOpenChange={onOpenChange} placement="right-end">
      <Tooltip placement="right" content={i18n.t("tours.engine.showMeHow")}>
        <PopupMenu.Trigger
          aria-label={i18n.t("tours.engine.showMeHow")}
          data-testid="tours-help-button"
          class={props.buttonClass(
            open()
              ? "bg-surface-hover text-text-secondary"
              : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary",
          )}
        >
          <CircleHelp size={18} />
        </PopupMenu.Trigger>
      </Tooltip>
      <PopupMenu.Content
        aria-label={i18n.t("tours.engine.showMeHow")}
        data-testid="tours-menu"
        class="w-72"
      >
        <PopupMenu.Group>
          <PopupMenu.Label>{i18n.t("tours.engine.showMeHow")}</PopupMenu.Label>
          <Show
            when={tourStore.items.length > 0}
            fallback={
              <p data-testid="tours-menu-empty" class="px-3 py-2 text-[12.5px] text-text-tertiary">
                {tourStore.itemsLoaded
                  ? i18n.t("tours.engine.noTours")
                  : i18n.t("tours.engine.loading")}
              </p>
            }
          >
            <For each={tourStore.items}>
              {(item) => (
                <PopupMenu.Item
                  data-testid="tours-menu-item"
                  textValue={i18n.t(item.title)}
                  onSelect={() => void tourStore.resume(item.tourId, "help")}
                >
                  <span
                    class="flex w-full min-w-0 items-center gap-2"
                    data-tour-id={item.tourId}
                    data-status={statusOf(item)}
                  >
                    <RowText item={item} />
                    <span
                      data-testid="tours-menu-action"
                      class="shrink-0 text-[12px] font-medium text-accent"
                    >
                      {tourActionLabel(item, i18n.t)}
                    </span>
                  </span>
                </PopupMenu.Item>
              )}
            </For>
          </Show>
        </PopupMenu.Group>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

/** Phone: the same list as plain rows (it lives in a sheet). */
export const ToursList: Component<{ onPicked?: () => void }> = (props) => {
  const i18n = useI18n()
  return (
    <div data-testid="tours-sheet" class="flex flex-col py-1">
      <Show
        when={tourStore.items.length > 0}
        fallback={
          <p data-testid="tours-menu-empty" class="px-4 py-3 text-[14px] text-text-tertiary">
            {tourStore.itemsLoaded
              ? i18n.t("tours.engine.noTours")
              : i18n.t("tours.engine.loading")}
          </p>
        }
      >
        <For each={tourStore.items}>
          {(item) => (
            <button
              type="button"
              data-testid="tours-menu-item"
              data-tour-id={item.tourId}
              data-status={statusOf(item)}
              onClick={() => {
                props.onPicked?.()
                void tourStore.resume(item.tourId, "help")
              }}
              class="flex min-h-[52px] w-full items-center gap-3 px-4 text-left text-[15px] hover:bg-surface-hover"
            >
              <RowText item={item} />
              <span
                data-testid="tours-menu-action"
                class="shrink-0 text-[13px] font-medium text-accent"
              >
                {tourActionLabel(item, i18n.t)}
              </span>
            </button>
          )}
        </For>
      </Show>
    </div>
  )
}

/**
 * Phone entry: the Work screen's "Show me how" row (the five-seat tab bar has
 * no overflow), opening the list in a bottom sheet.
 */
export const ToursWorkRow: Component = () => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <button
        type="button"
        data-testid="work-row-tours"
        onClick={() => {
          setOpen(true)
          void tourStore.refreshList()
        }}
        class="flex h-[46px] w-full shrink-0 items-center gap-3 px-4 text-left text-[16px] text-text hover:bg-surface-hover"
      >
        <span
          aria-hidden="true"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-text-secondary"
        >
          <CircleHelp size={16} />
        </span>
        <span class="min-w-0 flex-1 truncate">{i18n.t("tours.engine.showMeHow")}</span>
        <ChevronRight size={16} class="shrink-0 text-text-tertiary" />
      </button>
      <OverlaySheet
        open={open()}
        onClose={() => setOpen(false)}
        variant="bottom"
        title={i18n.t("tours.engine.showMeHow")}
        closeLabel={i18n.t("tours.engine.close")}
      >
        <ToursList onPicked={() => setOpen(false)} />
      </OverlaySheet>
    </>
  )
}
