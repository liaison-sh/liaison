// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Source identity atoms shared by the sidebar, the Overview lanes and the
// source page: the hue square with the source monogram (a shield on an
// error-tinted square for an urgent source, which never shows its hue), the
// faint error wash of urgent rows, and the live hook that keeps every
// monitoring surface current without a manual refresh.
import { hueGlyphColor, hueTintColor } from "@liaison/app-ui/hue"
import { onEntityChange } from "@liaison/host"
import { type Component, onCleanup, Show } from "solid-js"
import { cx } from "./kit"
import type { SourceView } from "./sources"

/** Faint error wash (left to right) behind urgent rows, lane heads and the callout. */
export const URGENT_WASH =
  "bg-[linear-gradient(100deg,color-mix(in_srgb,var(--color-error)_16%,transparent)_0%,color-mix(in_srgb,var(--color-error)_5%,transparent)_55%,transparent_100%)]"

export const ShieldIcon: Component<{ size: number; alert?: boolean; strokeWidth?: number }> = (
  props,
) => (
  <svg
    width={props.size}
    height={props.size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={props.strokeWidth ?? 2}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />
    <Show when={props.alert}>
      <path d="M12 8v5" />
      <path d="M12 16h.01" />
    </Show>
  </svg>
)

const SIZES = {
  sm: { box: "h-4 w-4 rounded-[4px] text-[8.5px]", shield: 10, stroke: 3 },
  md: { box: "h-[22px] w-[22px] rounded-md text-[10px]", shield: 12, stroke: 2.5 },
  lg: { box: "h-10 w-10 rounded-[10px] text-[14px]", shield: 18, stroke: 2 },
} as const

/** The source's square: monogram on its hue tint, or a shield when urgent. */
export const SourceSquare: Component<{ source: SourceView; size: keyof typeof SIZES }> = (
  props,
) => {
  const size = () => SIZES[props.size]
  return (
    <span
      data-testid={`monitoring-source-square-${props.source.source}`}
      data-urgent={props.source.urgent ? "true" : undefined}
      class={cx(
        "grid shrink-0 place-items-center font-semibold leading-none",
        size().box,
        props.source.urgent && "border border-error-border bg-error-glow text-error",
      )}
      style={
        props.source.urgent
          ? undefined
          : { background: hueTintColor(props.source.hue), color: hueGlyphColor(props.source.hue) }
      }
    >
      <Show when={props.source.urgent} fallback={props.source.monogram}>
        <ShieldIcon size={size().shield} strokeWidth={size().stroke} />
      </Show>
    </span>
  )
}

/** The lane's 3px identity stripe colour (error for an urgent source). */
export function stripeStyle(source: SourceView): { background: string } {
  return { background: source.urgent ? "var(--color-error)" : hueGlyphColor(source.hue) }
}

/** Fired after the Sources panel saves, so every monitoring surface refetches. */
export const CONFIG_CHANGED_EVENT = "liaison:monitoring:config-changed"

export function announceConfigChanged(): void {
  window.dispatchEvent(new Event(CONFIG_CHANGED_EVENT))
}

/**
 * Refetch on any incident change (live WS events, coalesced) and after a
 * Sources settings save. Call synchronously in a component body: both
 * subscriptions are disposed with the component.
 */
export function onMonitoringChange(refetch: () => void): void {
  onEntityChange("monitoring:incident", () => refetch())
  const onConfig = () => refetch()
  window.addEventListener(CONFIG_CHANGED_EVENT, onConfig)
  onCleanup(() => window.removeEventListener(CONFIG_CHANGED_EVENT, onConfig))
}
