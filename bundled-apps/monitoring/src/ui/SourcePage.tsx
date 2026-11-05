// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MonitoringSourcePage — one alert source (tab type `monitoring:source`, URL
// /monitoring/source/<encoded source id>). Header: the large hue square (a
// shield for an urgent source), label, raw id, Urgent tag, live dot and last
// alert. Stats for that source (open critical, open warning, resolved in 24 h,
// auto-resolved in 7 days), its live incidents with inline triage, and the
// recently resolved ones: "Auto-resolved" with the source's own note when the
// source cleared it, the resolver and their note otherwise. Live.
import { app } from "@liaison/host"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import type { IncidentsSummaryWithConfig } from "../lib/summarize"
import { LiveLine, loadLiveIncidents, OverflowMenu, StatTile, UrgentTag } from "./Dashboard"
import { formatAge } from "./format"
import { tr } from "./i18n"
import { IncidentRow, type TriageAction } from "./incident-row"
import { Button, Card, cx, SectionLabel } from "./kit"
import { loadMemberNames } from "./members"
import { onMonitoringChange, SourceSquare } from "./source-glyph"
import { rememberSourceLabels } from "./tab-labels"
import { buildSourceViews, decodeSourceId, type IncidentLike, isAutoResolved, sourceStats } from "./sources"

export const MonitoringSourcePage: Component<{ entityId?: string; id?: string }> = (props) => {
  const sourceId = () => decodeSourceId(props.entityId ?? props.id ?? "")
  const [busyId, setBusyId] = createSignal<string | null>(null)
  const [triageError, setTriageError] = createSignal<string | null>(null)
  const nowMs = () => Date.now()

  const [summary, { refetch: refetchSummary }] = createResource<IncidentsSummaryWithConfig | undefined>(async () => {
    const res = await app.invokeTool<{ data: IncidentsSummaryWithConfig }>("incidents_summary", {})
    return res?.data
  })
  const [live, { refetch: refetchLive }] = createResource(
    () => sourceId() || null,
    (id) => loadLiveIncidents(id),
  )
  const [resolved, { refetch: refetchResolved }] = createResource(
    () => sourceId() || null,
    async (id): Promise<IncidentLike[]> => {
      const res = await app.invokeTool<{ data: IncidentLike[] }>("incidents_list", {
        source: id,
        status: "resolved",
        limit: 50,
      })
      return (res?.data ?? []).sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""))
    },
  )
  // Names only when a person resolved something here.
  const needsNames = () => (resolved.latest ?? []).some((i) => i.resolvedBy && !isAutoResolved(i))
  const [names] = createResource(() => (needsNames() ? true : null), loadMemberNames)

  const refetch = () => {
    void refetchSummary()
    void refetchLive()
    void refetchResolved()
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

  const view = createMemo(() => {
    const s = summary.latest
    if (!s) return null
    const views = buildSourceViews(s, [sourceId()])
    rememberSourceLabels(views)
    return views.find((v) => v.source === sourceId()) ?? null
  })
  const liveRows = createMemo(() =>
    [...(live.latest ?? [])].sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "")),
  )
  const stats = createMemo(() => sourceStats([...(live.latest ?? []), ...(resolved.latest ?? [])], nowMs()))
  const lastAlert = createMemo(() => {
    const all = [view()?.lastSeenAt, ...liveRows().map((i) => i.lastSeenAt)].filter((x): x is string => !!x)
    return all.sort().at(-1) ?? null
  })
  const loadError = () => (summary.error ?? live.error ?? resolved.error) as unknown

  return (
    <div class="flex h-full flex-col overflow-hidden" data-testid="monitoring-source-page">
      <div class="flex-1 overflow-y-auto">
        <div class="mx-auto flex max-w-[1000px] flex-col gap-[18px] px-6 pb-12 pt-5">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <Show when={view()} fallback={<h1 class="font-mono text-[18px] font-semibold text-text">{sourceId()}</h1>}>
              {(v) => (
                <div class="flex min-w-0 items-center gap-3.5" data-testid="monitoring-source-header">
                  <SourceSquare source={v()} size="lg" />
                  <div class="min-w-0">
                    <h1 class="flex items-center gap-2 text-[18px] font-semibold text-text">
                      <span class="truncate">{v().label}</span>
                      <Show when={v().urgent}>
                        <UrgentTag />
                      </Show>
                    </h1>
                    <LiveLine>
                      <span class="font-mono" data-testid="monitoring-source-id">
                        {v().source}
                      </span>
                      <span>
                        ·{" "}
                        {lastAlert()
                          ? tr("Live · last alert {{when}}", { when: formatAge(lastAlert(), nowMs()) })
                          : tr("Live · no alert yet")}
                      </span>
                    </LiveLine>
                  </div>
                </div>
              )}
            </Show>
            <OverflowMenu testid="monitoring-source" onRefresh={refetch} />
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

          <div class="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <StatTile
              label={tr("Open critical")}
              value={stats().openCritical}
              tone={stats().openCritical > 0 ? "error" : undefined}
              testid="monitoring-source-stat-critical"
            />
            <StatTile
              label={tr("Open warning")}
              value={stats().openWarning}
              tone={stats().openWarning > 0 ? "warning" : undefined}
              testid="monitoring-source-stat-warning"
            />
            <StatTile label={tr("Resolved · 24h")} value={stats().resolved24h} tone="success" testid="monitoring-source-stat-resolved24h" />
            <StatTile label={tr("Auto-resolved · 7d")} value={stats().autoResolved7d} testid="monitoring-source-stat-auto7d" />
          </div>

          <SectionLabel>{tr("Live incidents")}</SectionLabel>
          <Card class="overflow-hidden rounded-xl" testid="monitoring-source-live">
            <Show
              when={liveRows().length > 0}
              fallback={
                <p class={cx("px-4 py-3 text-[12.5px]", live.latest ? "text-success" : "text-text-tertiary")}>
                  {live.latest ? `✓ ${tr("All clear")}` : tr("Loading…")}
                </p>
              }
            >
              <For each={liveRows()}>
                {(inc) => (
                  <IncidentRow
                    incident={inc}
                    nowMs={nowMs()}
                    busy={busyId() === inc.id}
                    onTriage={(id, a) => void triage(id, a)}
                  />
                )}
              </For>
            </Show>
          </Card>

          <SectionLabel>{tr("Recently resolved")}</SectionLabel>
          <Card class="overflow-hidden rounded-xl" testid="monitoring-source-resolved">
            <Show
              when={(resolved.latest ?? []).length > 0}
              fallback={
                <p class="px-4 py-3 text-[12.5px] text-text-tertiary">
                  {resolved.latest ? tr("Nothing resolved yet.") : tr("Loading…")}
                </p>
              }
            >
              <For each={resolved.latest}>
                {(inc) => (
                  <IncidentRow
                    incident={inc}
                    nowMs={nowMs()}
                    resolverName={inc.resolvedBy ? (names.latest?.get(inc.resolvedBy) ?? null) : null}
                  />
                )}
              </For>
            </Show>
          </Card>
        </div>
      </div>
    </div>
  )
}
