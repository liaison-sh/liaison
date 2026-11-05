// SPDX-License-Identifier: FSL-1.1-ALv2
import type { JSX } from "solid-js"
import { type ParentComponent, splitProps } from "solid-js"
import { cn } from "~/lib/cn"
import { createScrollOverflow } from "~/primitives/createScrollOverflow"

interface ScrollFadeProps {
  class?: string
  scrollClass?: string
  scrollRef?: (el: HTMLDivElement) => void
  /** `data-testid` applied to the inner scroll element (for e2e scroll-position assertions). */
  scrollTestId?: string
  orientation?: "vertical" | "horizontal"
  /** CSS color for the fade edge, should match the parent background. Defaults to --color-surface. */
  fadeColor?: string
}

/**
 * Scrollable container with gradient fades at the edges that blend
 * into the parent background when content overflows.
 *
 * Use `scrollRef` to access the underlying scroll element (e.g. for
 * programmatic scrolling or attaching extra event listeners).
 */
export const ScrollFade: ParentComponent<ScrollFadeProps> = (allProps) => {
  const [props] = splitProps(allProps, [
    "class",
    "scrollClass",
    "scrollRef",
    "scrollTestId",
    "orientation",
    "fadeColor",
    "children",
  ])
  let scrollEl!: HTMLDivElement
  const orient = () => props.orientation ?? "vertical"
  const isV = () => orient() === "vertical"
  const color = () => props.fadeColor ?? "var(--color-surface)"

  const { canScrollStart, canScrollEnd } = createScrollOverflow(() => scrollEl, orient())

  const fadeStyle = (side: "start" | "end"): JSX.CSSProperties => {
    const c = color()
    const dir = isV()
      ? side === "start"
        ? "to bottom"
        : "to top"
      : side === "start"
        ? "to right"
        : "to left"
    return { background: `linear-gradient(${dir}, ${c}, transparent)` }
  }

  return (
    <div class={cn("relative flex overflow-hidden", isV() ? "flex-col" : "flex-row", props.class)}>
      <div
        data-testid="scroll-fade-start"
        class={cn(
          "pointer-events-none absolute z-10 transition-opacity duration-150",
          isV() ? "inset-x-0 top-0 h-4" : "inset-y-0 left-0 w-4",
          canScrollStart() ? "opacity-100" : "opacity-0",
        )}
        style={fadeStyle("start")}
      />

      <div
        ref={(el) => {
          scrollEl = el
          props.scrollRef?.(el)
        }}
        data-testid={props.scrollTestId}
        class={cn(
          "min-h-0 min-w-0 flex-1",
          isV() ? "overflow-y-auto overflow-x-hidden" : "overflow-x-auto overflow-y-hidden",
          props.scrollClass,
        )}
      >
        {props.children}
      </div>

      <div
        data-testid="scroll-fade-end"
        class={cn(
          "pointer-events-none absolute z-10 transition-opacity duration-150",
          isV() ? "inset-x-0 bottom-0 h-4" : "inset-y-0 right-0 w-4",
          canScrollEnd() ? "opacity-100" : "opacity-0",
        )}
        style={fadeStyle("end")}
      />
    </div>
  )
}
