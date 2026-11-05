// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MonitoringDashboard — the app's home tab (/monitoring), the Overview board
// by source: an urgent callout while an urgent source (or, with no urgent
// profile, any source with a live critical) has live incidents; the stat
// strip; then one lane per source in the sidebar's order, each listing its
// live incidents with inline ack/resolve, quiet lanes collapsed to one "All
// clear" line. The severity segment applies to every lane. Data comes from
// incidents_summary + the live incident lists and follows incident changes
// live (onEntityChange), so Refresh only sits in the overflow menu.
import { app, navigate } from "@liaison/host"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import type { IncidentsSummaryWithConfig } from "../lib/summarize"
import { formatAge, liveIncidentsLabel } from "./format"
import { tr } from "./i18n"
import { IncidentRow, type TriageAction } from "./incident-row"
import { Button, Card, cx, EmptyState, Segmented } from "./kit"
import { onMonitoringChange, ShieldIcon, SourceSquare, stripeStyle, URGENT_WASH } from "./source-glyph"
import {
  buildSourceViews,
  groupBySource,
  type IncidentLike,
  type Lane,
  type SeverityFilter,
  sourcePath,
  urgentCallouts,
} from "./sources"

/** Kept for callers that typed rows against the dashboard. */
export type IncidentRowView = IncidentLike

const SEVERITY_OPTIONS: ReadonlyArray<{ value: SeverityFilter; label: string }> = [
  { value: "all", label: "Any" },
  { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" },
]

export async function loadLiveIncidents(source?: string): Promise<IncidentLike[]> {
  const base: Record<string, unknown> = { limit: 200 }
  if (source) base.source = source
  const [open, acked] = await Promise.all([
    app.invokeTool<{ data: IncidentLike[] }>("incidents_list", { ...base, status: "open" }),
    app.invokeTool<{ data: IncidentLike[] }>("incidents_list", { ...base, status: "acknowledged" }),
  ])
  return [...(open?.data ?? []), ...(acked?.data ?? [])]
}

export const StatTile: Component<{
  label: string
  value: number | undefined
  tone?: "error" | "warning" | "success"
  testid: string
}> = (props) => (
  <div
    data-testid={props.testid}
    class="flex flex-col gap-[7px] rounded-[10px] border border-border-subtle bg-surface px-[13px] py-[11px]"
  >
    <span class="text-[10.5px] font-medium uppercase tracking-[0.07em] text-text-tertiary">{props.label}</span>
    <span
      class={cx(
        "font-mono text-[24px] font-semibold leading-none tabular-nums",
        props.tone === "error" && "text-error",
        props.tone === "warning" && "text-warning",
        props.tone === "success" && "text-success",
        !props.tone && "text-text",
      )}
    >
      {props.value ?? "-"}
    </span>
  </div>
)

/** The "Live" dot + text line under a page title. */
export const LiveLine: Component<{ children: unknown }> = (props) => (
  <div class="mt-1 flex items-center gap-[7px] text-[12px] text-text-tertiary">
    <span class="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_0_3px_var(--color-success-glow)]" aria-hidden="true" />
    {props.children as never}
  </div>
)

/** Overflow menu holding the manual refresh (the board is live). */
export const OverflowMenu: Component<{ onRefresh: () => void; testid: string }> = (props) => {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="relative">
      <button
        type="button"
        data-testid={`${props.testid}-overflow`}
        aria-label={tr("More actions")}
        title={tr("More actions")}
        aria-expanded={open()}
        onClick={() => setOpen(!open())}
        class="grid h-[30px] w-[30px] place-items-center rounded-[7px] border border-border-subtle text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.3" />
          <circle cx="8" cy="8" r="1.3" />
          <circle cx="12.5" cy="8" r="1.3" />
        </svg>
      </button>
      <Show when={open()}>
        <div class="absolute right-0 top-[34px] z-20 min-w-[140px] rounded-lg border border-border bg-elevated p-1 shadow-xl">
          <button
            type="button"
            data-testid={`${props.testid}-refresh`}
            onClick={() => {
              setOpen(false)
              props.onRefresh()
            }}
            class="w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-text-secondary hover:bg-surface-hover hover:text-text"
          >
            {tr("Refresh")}
          </button>
        </div>
      </Show>
    </div>
  )
}

const LanePill: Component<{ lane: Lane }> = (props) => {
  const counts = createMemo(() => {
    let critical = 0
    let warning = 0
    for (const i of props.lane.incidents) {
      if (i.severity === "critical") critical += 1
      else if (i.severity === "warning") warning += 1
    }
    return { critical, warning, total: props.lane.incidents.length }
  })
  const base = "inline-flex items-center gap-[5px] rounded-full border px-[7px] py-0.5 text-[11px]"
  return (
    <Show
      when={!props.lane.collapsed}
      fallback={
        <Show
          when={props.lane.source.live === 0}
          fallback={
            <span class={cx(base, "border-border-subtle font-mono text-text-secondary")}>
              {tr("{{count}} live", { count: props.lane.source.live })}
            </span>
          }
        >
          <span class={cx(base, "border-success-border bg-success-glow text-success")}>✓ {tr("All clear")}</span>
        </Show>
      }
    >
      <Show
        when={counts().critical > 0}
        fallback={
          <Show
            when={counts().warning > 0}
            fallback={
              <span class={cx(base, "border-accent-border bg-accent-tint font-mono text-accent")}>
                ● {tr("{{count}} info", { count: counts().total })}
              </span>
            }
          >
            <span class={cx(base, "border-warning-border bg-warning-glow font-mono text-warning")}>
              ● {tr("{{count}} warning", { count: counts().warning })}
            </span>
          </Show>
        }
      >
        <span class={cx(base, "border-error-border bg-error-glow font-mono text-error")}>
          ● {tr("{{count}} critical", { count: counts().critical })}
        </span>
      </Show>
    </Show>
  )
}

export const UrgentTag: Component = () => (
  <span class="rounded-[5px] border border-error-border bg-error-glow px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-error">
    {tr("Urgent")}
  </span>
)

const SourceLane: Component<{
  lane: Lane
  nowMs: number
  busyId: string | null
  onTriage: (id: string, action: TriageAction) => void
}> = (props) => {
  const s = () => props.lane.source
  return (
    <section
      data-testid={`monitoring-lane-${s().source}`}
      data-collapsed={props.lane.collapsed ? "true" : undefined}
      data-urgent={s().urgent ? "true" : undefined}
      class={cx(
        "relative overflow-hidden rounded-xl border bg-surface",
        s().urgent ? "border-error-border" : "border-border-subtle",
      )}
    >
      <span class="absolute inset-y-0 left-0 w-[3px]" style={stripeStyle(s())} aria-hidden="true" />
      <div
        role="link"
        tabindex="0"
        data-testid={`monitoring-lane-head-${s().source}`}
        onClick={() => navigate(sourcePath(s().source))}
        onKeyDown={(e) => {
          if (e.key === "Enter") navigate(sourcePath(s().source))
        }}
        class={cx(
          "flex cursor-pointer items-center gap-2.5 py-2.5 pl-4 pr-3.5",
          s().urgent && URGENT_WASH,
        )}
      >
        <SourceSquare source={s()} size="md" />
        <span class={cx("truncate", props.lane.collapsed ? "font-medium text-text-secondary" : "font-semibold text-text")}>
          {s().label}
        </span>
        <Show when={s().label !== s().source}>
          <span class="truncate font-mono text-[11px] text-text-tertiary">{s().source}</span>
        </Show>
        <Show when={s().urgent}>
          <UrgentTag />
        </Show>
        <div class="ml-auto flex shrink-0 items-center gap-2 text-[12px] text-text-tertiary">
          <LanePill lane={props.lane} />
          <Show when={s().lastSeenAt}>
            <span>{formatAge(s().lastSeenAt, props.nowMs)}</span>
          </Show>
        </div>
      </div>
      <Show when={!props.lane.collapsed}>
        <div class="border-t border-border-subtle">
          <For each={props.lane.incidents}>
            {(inc) => (
              <IncidentRow
                incident={inc}
                nowMs={props.nowMs}
                busy={props.busyId === inc.id}
                onTriage={props.onTriage}
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

export const MonitoringDashboard: Component<{ entityId?: string }> = () => {
  const [severity, setSeverity] = createSignal<SeverityFilter>("all")
  const [busyId, setBusyId] = createSignal<string | null>(null)
  const [triageError, setTriageError] = createSignal<string | null>(null)
  const nowMs = () => Date.now()

  // Plain Solid createResource (the boxtal/invoicing pattern) — NOT the host
  // resource factory, whose Suspense integration intermittently never resolved
  // on cold plugin-tab mounts (blank dashboard, prod 2026-07-11).
  const [summary, { refetch: refetchSummary }] = createResource<IncidentsSummaryWithConfig | undefined>(async () => {
    const res = await app.invokeTool<{ data: IncidentsSummaryWithConfig }>("incidents_summary", {})
    return res?.data
  })
  const [incidents, { refetch: refetchIncidents }] = createResource(() => loadLiveIncidents())

  const refetch = () => {
    void refetchSummary()
    void refetchIncidents()
  }
  onMonitoringChange(refetch)

  const triage = async (id: string, action: TriageAction) => {
    setBusyId(id)
    setTriageError(null)
    try {
      await app.invokeTool(action, { incidentId: id })
      refetch()
    } catch (err) {
      setTriageError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const live = createMemo(() => incidents.latest ?? [])
  const sources = createMemo(() => {
    const s = summary.latest
    return s ? buildSourceViews(s, live().map((i) => i.source)) : []
  })
  const lanes = createMemo(() => groupBySource(sources(), live(), severity()))
  const callouts = createMemo(() => urgentCallouts(sources(), live()))
  const openTotal = () => summary.latest?.open.total ?? 0
  const loudSources = () => sources().filter((s) => s.live > 0).length
  const loadError = () => (summary.error ?? incidents.error) as unknown

  return (
    <div class="flex h-full flex-col overflow-hidden" data-testid="monitoring-dashboard">
      <div class="flex-1 overflow-y-auto">
        <div class="mx-auto flex max-w-[1000px] flex-col gap-[18px] px-6 pb-12 pt-5">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 class="text-[18px] font-semibold tracking-[-0.01em] text-text">{tr("Overview")}</h1>
              <Show when={summary.latest}>
                <LiveLine>
                  <span data-testid="monitoring-overview-live">
                    {openTotal() > 0
                      ? tr("Live · {{open}} open across {{sources}} sources", { open: openTotal(), sources: loudSources() })
                      : tr("Live · all quiet")}
                  </span>
                </LiveLine>
              </Show>
            </div>
            <div class="flex items-center gap-2">
              <Segmented
                options={SEVERITY_OPTIONS.map((o) => ({ ...o, label: tr(o.label) }))}
                value={severity()}
                onChange={setSeverity}
                testidPrefix="monitoring-filter-severity"
                ariaLabel={tr("Filter incidents by severity")}
              />
              <OverflowMenu testid="monitoring" onRefresh={refetch} />
            </div>
          </div>

          <Show when={loadError()}>
            <Card class="flex items-center justify-between gap-3 border-error-border bg-error-glow px-4 py-3" testid="monitoring-load-error">
              <span class="text-[12.5px] text-error">
                {tr("Monitoring could not load: {{message}}", {
                  message: loadError() instanceof Error ? (loadError() as Error).message : String(loadError()),
                })}
              </span>
              <Button variant="danger" onClick={refetch} testid="monitoring-load-retry">
                {tr("Retry")}
              </Button>
            </Card>
          </Show>

          <Show when={triageError()}>
            <Card class="border-error-border bg-error-glow px-4 py-2.5 text-[12px] text-error" testid="monitoring-triage-error">
              {triageError()}
            </Card>
          </Show>

          <For each={callouts()}>
            {(c) => (
              <div
                data-testid={`monitoring-callout-${c.source.source}`}
                class={cx(
                  "relative flex items-center gap-3.5 overflow-hidden rounded-xl border border-error-border bg-surface py-3.5 pl-[18px] pr-4",
                )}
              >
                <span class={cx("absolute inset-0", URGENT_WASH)} aria-hidden="true" />
                <span class="absolute inset-y-0 left-0 w-[3px] bg-error" aria-hidden="true" />
                <div class="relative grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-error-border bg-error-glow text-error">
                  <span
                    class="absolute -inset-px animate-ping rounded-[9px] border border-error opacity-50 [animation-duration:2.4s]"
                    aria-hidden="true"
                  />
                  <ShieldIcon size={17} alert />
                </div>
                <div class="relative min-w-0 flex-1">
                  <div class="font-semibold text-text">
                    {c.source.label} ·{" "}
                    <span class="text-error">{liveIncidentsLabel(c.open, c.acknowledged)}</span>
                  </div>
                  <Show when={c.newest}>
                    {(n) => (
                      <div class="mt-0.5 truncate text-[12.5px] text-text-secondary">
                        {n().ref ? `${n().ref} ` : ""}
                        {n().title} · {formatAge(n().lastSeenAt, nowMs())}
                      </div>
                    )}
                  </Show>
                </div>
                <Button
                  variant="danger"
                  class="relative"
                  testid={`monitoring-callout-review-${c.source.source}`}
                  onClick={() => navigate(sourcePath(c.source.source))}
                >
                  {tr("Review")}
                </Button>
              </div>
            )}
          </For>

          <div class="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <StatTile
              label={tr("Open critical")}
              value={summary.latest?.open.critical}
              tone={(summary.latest?.open.critical ?? 0) > 0 ? "error" : undefined}
              testid="monitoring-stat-critical"
            />
            <StatTile
              label={tr("Open warning")}
              value={summary.latest?.open.warning}
              tone={(summary.latest?.open.warning ?? 0) > 0 ? "warning" : undefined}
              testid="monitoring-stat-warning"
            />
            <StatTile label={tr("Acknowledged")} value={summary.latest?.acknowledged} testid="monitoring-stat-acknowledged" />
            <StatTile
              label={tr("Resolved · 24h")}
              value={summary.latest?.resolved24h}
              tone="success"
              testid="monitoring-stat-resolved24h"
            />
          </div>

          <Show
            when={summary.latest}
            fallback={
              <Show when={!loadError()}>
                <p class="py-6 text-center text-[12px] text-text-tertiary" data-testid="monitoring-loading">
                  {tr("Loading…")}
                </p>
              </Show>
            }
          >
            <Show
              when={lanes().length > 0}
              fallback={
                <Card class="flex">
                  <EmptyState title={tr("No source yet")} testid="monitoring-sources-empty">
                    {tr("No alert source has reported yet. Sources appear the first time they deliver an alert to the webhook.")}
                  </EmptyState>
                </Card>
              }
            >
              <div class="flex flex-col gap-2.5" data-testid="monitoring-lanes">
                <For each={lanes()}>
                  {(lane) => <SourceLane lane={lane} nowMs={nowMs()} busyId={busyId()} onTriage={(id, a) => void triage(id, a)} />}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}
