// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A project status as a pill: a dot in the status's own colour on a light wash of
 * it. The colour is the project's data (the status's `color`), never a theme
 * choice; a status without one wears the tertiary text colour on the hover
 * surface. The same pill sits on Kanban cards, the list view, the task detail
 * and inside automation copy, so a status looks the same everywhere.
 */
import type { Component, JSX } from "solid-js"

/** The dot colour for a status (its own, else the neutral tertiary text). */
export function statusDot(color: string | null | undefined): string {
  return color || "var(--color-text-tertiary)"
}

/** The pill's wash: the status colour mixed light into transparency. */
export function statusWash(color: string | null | undefined): string {
  return color ? `color-mix(in oklch, ${color} 18%, transparent)` : "var(--color-surface-hover)"
}

interface StatusPillProps {
  label: string
  color?: string | null
  size?: "sm" | "md"
  "data-testid"?: string
  class?: string
  title?: string
  children?: JSX.Element
}

export const StatusPill: Component<StatusPillProps> = (props) => (
  <span
    data-testid={props["data-testid"]}
    data-status-pill=""
    title={props.title}
    class={`inline-flex max-w-full items-center gap-1.5 rounded-full align-baseline text-text ${
      props.size === "md" ? "px-2.5 py-0.5 text-[12.5px]" : "px-2 text-[11.5px] leading-[18px]"
    } ${props.class ?? ""}`}
    style={{ background: statusWash(props.color) }}
  >
    <span
      aria-hidden="true"
      class="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: statusDot(props.color) }}
    />
    <span class="truncate">{props.label}</span>
    {props.children}
  </span>
)

export default StatusPill
