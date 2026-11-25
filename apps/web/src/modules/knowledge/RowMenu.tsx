// SPDX-License-Identifier: FSL-1.1-ALv2

import { MoreHorizontal } from "lucide-solid"
import { type Component, For, type JSX, Show } from "solid-js"
import { shellTier } from "~/modules/shell/shell-tier"
import { PopupMenu } from "~/ui/PopupMenu"

export interface RowMenuItem {
  /** Stable name of the action; the item's test id is `knowledge-tree-menu-<id>`. */
  id: string
  label: string
  icon?: Component<{ size?: number; class?: string }>
  onSelect: () => void
  danger?: boolean
  /** Draw a divider above this item. */
  separatorBefore?: boolean
}

/**
 * The "…" menu of one tree row. Opens by click, Enter or Space, and touch;
 * Escape closes it and gives focus back to its button; it never closes because
 * the pointer left it. The tree also opens it on right click (`open`).
 */
const RowMenu: Component<{
  label: string
  triggerTestId: string
  items: RowMenuItem[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Classes of the button (its visibility on hover and focus). */
  triggerClass?: string
}> = (props) => {
  const touch = () => shellTier() !== "desktop"
  return (
    <PopupMenu open={props.open} onOpenChange={props.onOpenChange}>
      {/* A tap on it must not close the phone navigator the tree sits in. */}
      <span data-keep-navigator class="flex shrink-0">
        <PopupMenu.Trigger
          aria-label={props.label}
          title={props.label}
          data-testid={props.triggerTestId}
          class={props.triggerClass}
        >
          <MoreHorizontal size={14} />
        </PopupMenu.Trigger>
      </span>
      <PopupMenu.Content aria-label={props.label} class="min-w-[180px]">
        <For each={props.items}>
          {(item) => (
            <>
              <Show when={item.separatorBefore}>
                <PopupMenu.Separator />
              </Show>
              <PopupMenu.Item
                data-testid={`knowledge-tree-menu-${item.id}`}
                variant={item.danger ? "danger" : undefined}
                class={touch() ? "min-h-11" : undefined}
                onSelect={item.onSelect}
              >
                {item.icon ? (item.icon({ size: 14, class: "shrink-0" }) as JSX.Element) : null}
                <span>{item.label}</span>
              </PopupMenu.Item>
            </>
          )}
        </For>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

export default RowMenu
