// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "?" (Help): opens the docs in the Help tab (HelpTab.tsx). On a demo
 * deployment it opens a menu instead, Documentation first and the guided tours
 * of the demo's scenarios under it ("Show me how", tours/ToursMenu.tsx): the
 * tours walk a seeded demo workspace, so an ordinary deployment never lists them.
 * The "?" sits in the activity bar's bottom cluster on desktop and tablet; the
 * phone has a Help row on its Work screen.
 */
import { BookOpen, ChevronRight, CircleHelp } from "lucide-solid"
import { type Component, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { demoMode } from "~/modules/shell/branding-store"
import { ToursList, ToursMenuGroup } from "~/modules/tours/ToursMenu"
import { tourStore } from "~/modules/tours/tour-store"
import { OverlaySheet } from "~/ui/OverlaySheet"
import { PopupMenu } from "~/ui/PopupMenu"
import { Tooltip } from "~/ui/Tooltip"
import { openHelp } from "./help-store"

/** Desktop/tablet: the "?" in the activity bar. */
export const HelpButton: Component<{ buttonClass: (extra?: string) => string }> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const label = () => i18n.t("kernel.help.title")
  const openDocs = () => openHelp(undefined, label())
  const idle = "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
  return (
    <Show
      when={demoMode()}
      fallback={
        <Tooltip placement="right" content={label()}>
          <button
            type="button"
            aria-label={label()}
            data-testid="help-button"
            onClick={openDocs}
            class={props.buttonClass(idle)}
          >
            <CircleHelp size={18} />
          </button>
        </Tooltip>
      }
    >
      <PopupMenu
        open={open()}
        onOpenChange={(next) => {
          setOpen(next)
          if (next) void tourStore.refreshList()
        }}
        placement="right-end"
      >
        <Tooltip placement="right" content={label()}>
          <PopupMenu.Trigger
            aria-label={label()}
            data-testid="help-button"
            class={props.buttonClass(open() ? "bg-surface-hover text-text-secondary" : idle)}
          >
            <CircleHelp size={18} />
          </PopupMenu.Trigger>
        </Tooltip>
        <PopupMenu.Content aria-label={label()} data-testid="help-menu" class="w-72">
          <PopupMenu.Item
            data-testid="help-menu-docs"
            textValue={i18n.t("kernel.help.documentation")}
            onSelect={openDocs}
          >
            <span class="flex items-center gap-2">
              <BookOpen size={14} class="shrink-0 text-text-tertiary" />
              {i18n.t("kernel.help.documentation")}
            </span>
          </PopupMenu.Item>
          <PopupMenu.Separator />
          <ToursMenuGroup />
        </PopupMenu.Content>
      </PopupMenu>
    </Show>
  )
}

const rowClass =
  "flex h-[46px] w-full shrink-0 items-center gap-3 px-4 text-left text-[16px] text-text hover:bg-surface-hover"

const RowIcon: Component<{ icon: typeof CircleHelp }> = (props) => (
  <span
    aria-hidden="true"
    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-sunken text-text-secondary"
  >
    <props.icon size={16} />
  </span>
)

/**
 * Phone: the Work screen's Help row (the five-seat tab bar has no overflow).
 * It opens the docs; on a demo deployment, a bottom sheet with Documentation
 * and the tours.
 */
export const HelpWorkRow: Component = () => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const label = () => i18n.t("kernel.help.title")
  return (
    <>
      <button
        type="button"
        data-testid="work-row-help"
        onClick={() => {
          if (!demoMode()) {
            openHelp(undefined, label())
            return
          }
          setOpen(true)
          void tourStore.refreshList()
        }}
        class={rowClass}
      >
        <RowIcon icon={CircleHelp} />
        <span class="min-w-0 flex-1 truncate">{label()}</span>
        <ChevronRight size={16} class="shrink-0 text-text-tertiary" />
      </button>
      <Show when={demoMode()}>
        <OverlaySheet
          open={open()}
          onClose={() => setOpen(false)}
          variant="bottom"
          title={label()}
          closeLabel={i18n.t("tours.engine.close")}
        >
          <button
            type="button"
            data-testid="help-sheet-docs"
            onClick={() => {
              setOpen(false)
              openHelp(undefined, label())
            }}
            class={rowClass}
          >
            <RowIcon icon={BookOpen} />
            <span class="min-w-0 flex-1 truncate">{i18n.t("kernel.help.documentation")}</span>
          </button>
          <h3 class="px-4 pb-1 pt-3 text-[12px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
            {i18n.t("tours.engine.showMeHow")}
          </h3>
          <ToursList onPicked={() => setOpen(false)} />
        </OverlaySheet>
      </Show>
    </>
  )
}
