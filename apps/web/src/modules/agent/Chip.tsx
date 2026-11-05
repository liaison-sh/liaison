// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Chip — one shared pill treatment for every chip/badge across the Skills and
 * Routines surfaces (source, status, visibility). Small, background-tinted,
 * `text-[11px]`, muted by default; status-colored only for `warn` (amber) and
 * `done` (dimmed). No per-component chip styling anywhere else.
 */
import { type Component, type JSX, splitProps } from "solid-js"
import { cn } from "~/lib/cn"

export type ChipTone = "default" | "accent" | "warn" | "done"

interface ChipProps {
  tone?: ChipTone
  class?: string
  children: JSX.Element
  /** Hover/assistive detail, e.g. the raw permission id behind a label. */
  title?: string
  "data-testid"?: string
}

const TONE: Record<ChipTone, string> = {
  default: "bg-surface text-text-tertiary",
  accent: "bg-accent/10 text-accent",
  warn: "bg-amber-500/10 text-amber-500",
  done: "bg-surface text-text-tertiary opacity-70",
}

const Chip: Component<ChipProps> = (props) => {
  const [local, rest] = splitProps(props, ["tone", "class", "children"])
  return (
    <span
      {...rest}
      class={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] leading-none",
        TONE[local.tone ?? "default"],
        local.class,
      )}
    >
      {local.children}
    </span>
  )
}

export default Chip
