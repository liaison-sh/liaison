// SPDX-License-Identifier: FSL-1.1-ALv2

import { MoreHorizontal } from "lucide-solid"
import { type Component, createSignal, For } from "solid-js"
import { OverlaySheet } from "~/ui/OverlaySheet"

export interface SheetAction {
  label: string
  onClick: () => void
  testid: string
  /** The entity the action acts on, as `data-entity-id` on both its buttons. */
  entityId?: string
}

export interface BottomSheetActionsProps {
  actions: SheetAction[]
  /** Accessible name and sheet title for the phone trigger. The CALLER
   *  translates: `ui/` never imports a domain module, i18n included. */
  moreLabel: string
  /** Accessible name for the sheet's close control. */
  closeLabel?: string
  class?: string
}

/**
 * A desktop inline action row that collapses to a single "more" trigger at
 * phone width, opening the same actions as full width rows in a bottom
 * OverlaySheet. Both markups are always in the DOM and Tailwind's `md:`
 * breakpoint decides which one paints, the way the rest of the responsive
 * primitives work.
 *
 * Sheet rows carry a `<testid>-sheet` testid so they never collide with the
 * inline row's own testids.
 */
export const BottomSheetActions: Component<BottomSheetActionsProps> = (props) => {
  const [open, setOpen] = createSignal(false)

  return (
    <>
      <div
        data-testid="actions-inline-row"
        class={`hidden items-center gap-2 md:flex ${props.class ?? ""}`}
      >
        <For each={props.actions}>
          {(action) => (
            <button
              type="button"
              data-testid={action.testid}
              data-entity-id={action.entityId}
              onClick={() => action.onClick()}
              class="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-text-secondary hover:bg-surface-hover"
            >
              {action.label}
            </button>
          )}
        </For>
      </div>

      <button
        type="button"
        data-testid="actions-more-trigger"
        aria-label={props.moreLabel}
        onClick={() => setOpen(true)}
        class="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover md:hidden"
      >
        <MoreHorizontal size={20} />
      </button>

      <OverlaySheet
        open={open()}
        onClose={() => setOpen(false)}
        variant="bottom"
        title={props.moreLabel}
        closeLabel={props.closeLabel}
      >
        <For each={props.actions}>
          {(action) => (
            <button
              type="button"
              data-testid={`${action.testid}-sheet`}
              data-entity-id={action.entityId}
              onClick={() => {
                setOpen(false)
                action.onClick()
              }}
              class="flex min-h-11 w-full items-center px-4 py-3 text-left text-sm text-text hover:bg-surface-hover"
            >
              {action.label}
            </button>
          )}
        </For>
      </OverlaySheet>
    </>
  )
}
