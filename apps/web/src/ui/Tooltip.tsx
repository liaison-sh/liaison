// SPDX-License-Identifier: FSL-1.1-ALv2
import { Tooltip as KobalteTooltip } from "@kobalte/core/tooltip"
import { createSignal, type JSX, type ParentComponent, splitProps } from "solid-js"
import { cn } from "~/lib/cn"

type TooltipPlacement = "top" | "bottom" | "left" | "right"

interface TooltipProps {
  content: string
  class?: string
  triggerClass?: string
  triggerStyle?: JSX.CSSProperties
  /** Side of the trigger the hint opens on. Default `bottom`. */
  placement?: TooltipPlacement
  /** Hover time before the hint opens, in ms. Default 300; 0 for an icon-only
   *  control whose name IS the hint (the rail). */
  openDelay?: number
}

/**
 * A hover hint. Two rules keep it from ever getting in the way of the next
 * control (a live walk could not click Mail for 30 s after clicking Search:
 * the Search hint had opened over the Mail icon and swallowed the click):
 *
 * 1. The hint takes no pointer events. It is read, never clicked, so a pointer
 *    aimed at whatever it overlaps reaches that control. This is the fix for
 *    the walk: an open hint sat over the next icon and received its clicks.
 * 2. Pressing the trigger keeps the hint shut until the pointer leaves it. A
 *    click that opens a panel can hand focus back to the trigger, and Kobalte
 *    opens a tooltip on focus; the person who just clicked needs no hint.
 */
export const Tooltip: ParentComponent<TooltipProps> = (props) => {
  const [local, forwarded] = splitProps(props, [
    "children",
    "content",
    "class",
    "triggerClass",
    "triggerStyle",
    "placement",
    "openDelay",
  ])
  const [open, setOpen] = createSignal(false)
  const [suppressed, setSuppressed] = createSignal(false)
  return (
    <KobalteTooltip
      gutter={4}
      openDelay={local.openDelay ?? 300}
      placement={local.placement ?? "bottom"}
      open={open() && !suppressed()}
      onOpenChange={setOpen}
    >
      <KobalteTooltip.Trigger
        as="span"
        class={cn("inline-flex", local.triggerClass)}
        style={local.triggerStyle}
        onPointerDown={() => setSuppressed(true)}
        onPointerLeave={() => {
          setSuppressed(false)
          setOpen(false)
        }}
        {...forwarded}
      >
        {local.children}
      </KobalteTooltip.Trigger>
      <KobalteTooltip.Portal>
        <KobalteTooltip.Content
          data-testid="tooltip-content"
          class={cn(
            "pointer-events-none z-50 rounded-md border border-border bg-elevated px-2.5 py-1.5 text-xs text-text shadow-popover",
            local.class,
          )}
        >
          <KobalteTooltip.Arrow />
          {local.content}
        </KobalteTooltip.Content>
      </KobalteTooltip.Portal>
    </KobalteTooltip>
  )
}
