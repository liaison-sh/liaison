// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One incident line, shared by the Overview lanes and the source page:
// severity dot, title (with the alert's first detail line, or the resolution
// for a resolved incident), status tag, fire count, age, and the ack/resolve
// actions revealed on hover. An auto-resolved incident (cleared by its source)
// carries the "Auto-resolved" tag and the source's note; a human resolve shows
// who resolved it and their note.
import { navigate } from "@liaison/host"
import { type Component, Show } from "solid-js"
import { formatAge, incidentPath } from "./format"
import { tr } from "./i18n"
import { cx } from "./kit"
import { RefTag } from "./ref-tag"
import { type IncidentLike, isAutoResolved } from "./sources"

export type TriageAction = "incidents_ack" | "incidents_resolve"

const DOT: Record<string, string> = {
  critical: "bg-error shadow-[0_0_0_3px_var(--color-error-glow)]",
  warning: "bg-warning",
  info: "bg-accent",
}

/** The prototype's small row button (the kit Button's padding is not overridable). */
const SmallButton: Component<{
  testid: string
  disabled?: boolean
  onClick: (e: MouseEvent) => void
  children: string
}> = (props) => (
  <button
    type="button"
    data-testid={props.testid}
    disabled={props.disabled}
    onClick={props.onClick}
    class="whitespace-nowrap rounded-[7px] border border-border bg-surface px-2 py-[3px] text-[11.5px] font-medium text-text transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
  >
    {props.children}
  </button>
)

function firstLine(text: string | null | undefined): string | null {
  const line = text?.split("\n").find((l) => l.trim() !== "")
  return line ? line.trim() : null
}

/**
 * The line under an incident's title: the alert's first detail line while it
 * is live; once resolved, the source's own note for an auto resolve, else who
 * resolved it and their note.
 */
export function incidentDetailLine(inc: IncidentLike, resolverName?: string | null): string | null {
  if (inc.status !== "resolved") return firstLine(inc.body)
  const note = inc.resolutionNote?.trim() || null
  if (isAutoResolved(inc)) return note
  const who = resolverName || tr("a teammate")
  return note
    ? tr("Resolved by {{name}} · “{{note}}”", { name: who, note })
    : tr("Resolved by {{name}}", { name: who })
}

/** Status tag label and style ("Auto-resolved" for a source-cleared incident). */
export function incidentTag(inc: IncidentLike): { label: string; cls: string } {
  if (isAutoResolved(inc))
    return { label: tr("Auto-resolved"), cls: "bg-success-glow text-success" }
  if (inc.status === "resolved")
    return {
      label: tr("Resolved"),
      cls: "border border-dashed border-border-strong text-text-secondary",
    }
  if (inc.status === "acknowledged")
    return {
      label: tr("Acknowledged"),
      cls: "border border-dashed border-border-strong text-text-secondary",
    }
  return { label: tr("Open"), cls: "bg-surface-active text-text" }
}

export const IncidentRow: Component<{
  incident: IncidentLike
  nowMs: number
  busy?: boolean
  onTriage?: (id: string, action: TriageAction) => void
  /** Display name of a human resolver, when known. */
  resolverName?: string | null
  /** Prefix the detail line with the source label (lists mixing sources). */
  sourceLabel?: string
}> = (props) => {
  const inc = () => props.incident
  const resolved = () => inc().status === "resolved"
  const auto = () => isAutoResolved(inc())
  const detail = () => {
    const text = incidentDetailLine(inc(), props.resolverName)
    if (!props.sourceLabel) return text
    return text ? `${props.sourceLabel} · ${text}` : props.sourceLabel
  }
  const tag = () => incidentTag(inc())
  const act = (e: MouseEvent, action: TriageAction) => {
    e.stopPropagation()
    props.onTriage?.(inc().id, action)
  }
  return (
    <div
      role="button"
      tabindex="0"
      data-testid={`monitoring-incident-row-${inc().id}`}
      data-status={inc().status}
      data-auto-resolved={auto() ? "true" : undefined}
      onClick={() => navigate(incidentPath(inc().id))}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(incidentPath(inc().id))
      }}
      class="group grid cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border-subtle py-[9px] pl-4 pr-3.5 first:border-t-0 hover:bg-surface-hover md:grid-cols-[16px_minmax(0,1fr)_96px_52px_84px_208px]"
    >
      <span
        class={cx(
          "h-2 w-2 rounded-full",
          resolved() ? "bg-success" : (DOT[inc().severity] ?? "bg-text-tertiary"),
        )}
      />
      <div class="min-w-0">
        <div class="flex min-w-0 items-baseline gap-1.5 text-[13px] text-text">
          <RefTag value={inc().ref} testid={`monitoring-incident-ref-${inc().id}`} />
          <span class="min-w-0 truncate" title={inc().title}>
            {inc().title}
          </span>
        </div>
        <Show when={detail()}>
          {(d) => (
            <div
              class="mt-px truncate text-[11.5px] text-text-tertiary"
              title={d()}
              data-testid={`monitoring-incident-detail-${inc().id}`}
            >
              {d()}
            </div>
          )}
        </Show>
      </div>
      <span
        class={cx(
          "justify-self-start whitespace-nowrap rounded-[5px] px-[7px] py-0.5 text-[11px] font-medium max-md:hidden",
          tag().cls,
        )}
        data-testid={`monitoring-incident-tag-${inc().id}`}
      >
        {tag().label}
      </span>
      <span class="text-right font-mono text-[11.5px] text-text-secondary max-md:hidden">
        ×{inc().count}
      </span>
      <span class="text-right text-[12px] text-text-tertiary">
        {formatAge(
          resolved() ? (inc().resolvedAt ?? inc().lastSeenAt) : inc().lastSeenAt,
          props.nowMs,
        )}
      </span>
      <div class="flex justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:hidden">
        <Show when={props.onTriage && !resolved()}>
          <Show when={inc().status === "open"}>
            <SmallButton
              testid={`monitoring-ack-${inc().id}`}
              disabled={props.busy}
              onClick={(e) => act(e, "incidents_ack")}
            >
              {tr("Ack")}
            </SmallButton>
          </Show>
          <SmallButton
            testid={`monitoring-resolve-${inc().id}`}
            disabled={props.busy}
            onClick={(e) => act(e, "incidents_resolve")}
          >
            {tr("Resolve")}
          </SmallButton>
        </Show>
      </div>
    </div>
  )
}
