// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The wrapper that puts a spinner above a list and reloads it when the list is
// pulled down (the gesture itself is `primitives/createPullToRefresh`).
//
// It does NOT become the scroller. The screens it wraps already own their
// scroll, in their own root or inside a list component, and taking that over
// would mean each of them losing a scroll position that survives tab switches.
// It is a plain positioned box: the touch handlers sit on it and catch the
// gesture as it bubbles up out of whatever is actually scrolling, and the
// indicator is drawn over the top edge.
//
// `ui/` owns no strings, so the label comes from the caller.
import { type Component, type JSX, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { createPullToRefresh, PULL_THRESHOLD_PX } from "~/primitives/createPullToRefresh"

export interface PullToRefreshProps {
  onRefresh: () => void | Promise<unknown>
  /** Announced while a refresh is running. */
  label: string
  class?: string
  children: JSX.Element
}

export const PullToRefresh: Component<PullToRefreshProps> = (props) => {
  const pull = createPullToRefresh({ onRefresh: () => props.onRefresh() })
  const visible = () => pull.refreshing() || pull.distance() > 0
  // While refreshing the indicator parks at the threshold rather than
  // wherever the finger left it, so every refresh looks the same.
  const offset = () => (pull.refreshing() ? PULL_THRESHOLD_PX : pull.distance())

  return (
    <div
      data-testid="pull-to-refresh"
      data-pull-armed={pull.armed() ? "true" : "false"}
      data-pull-refreshing={pull.refreshing() ? "true" : "false"}
      class={cn("relative min-h-0 flex-1", props.class)}
      onTouchStart={pull.handlers.onTouchStart}
      onTouchMove={pull.handlers.onTouchMove}
      onTouchEnd={pull.handlers.onTouchEnd}
      onTouchCancel={pull.handlers.onTouchCancel}
    >
      <Show when={visible()}>
        <div
          data-testid="pull-to-refresh-indicator"
          role="status"
          aria-label={props.label}
          // Pointer events off: the indicator is drawn over the list's first
          // row while the finger is still on it.
          class={cn(
            "pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center",
            // Under reduced motion it appears and disappears, never slides.
            pull.animated() && !pull.refreshing() ? "" : "transition-transform duration-150",
          )}
          style={{ transform: `translateY(${Math.max(0, offset() - 24)}px)` }}
        >
          <span
            class={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border-2 border-border border-t-accent",
              pull.refreshing() && pull.animated() && "animate-spin",
            )}
            aria-hidden="true"
          />
        </div>
      </Show>
      {props.children}
    </div>
  )
}
