// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MonitoringStatusList — the sidebar's "Acknowledged" and "Resolved" entries
// (tab type `monitoring:status`, URL /monitoring/status/<status>): every
// incident in that status across sources, newest first, as the shared
// CardTable (a comparison table: it declares its phone columns), each row with
// its source square and label. Live.
import { CardTable } from "@liaison/app-ui/card-table"
import { app, navigate } from "@liaison/host"
import { type Component, createMemo, createResource, createSignal, Show } from "solid-js"
import type { IncidentsSummaryWithConfig } from "../lib/summarize"
import { LiveLine, OverflowMenu } from "./Dashboard"
import { tr } from "./i18n"
import { formatAge, incidentPath, severityMeta } from "./format"
import { incidentDetailLine, incidentTag, type TriageAction } from "./incident-row"
import { Badge, Button, Card, cx, EmptyState } from "./kit"
import { loadMemberNames } from "./members"
import { RefTag } from "./ref-tag"
import { onMonitoringChange, SourceSquare } from "./source-glyph"
import { buildSourceViews, type IncidentLike, isAutoResolved, type SourceView } from "./sources"

type ListStatus = "acknowledged" | "resolved"

export const MonitoringStatusList: Component<{ entityId?: string; id?: string }> = (props) => {
  const status = (): ListStatus => ((props.entityId ?? props.id) === "resolved" ? "resolved" : "acknowledged")
  const [busyId, setBusyId] = createSignal<string | null>(null)
  const [triageError, setTriageError] = createSignal<string | null>(null)
  const nowMs = () => Date.now()

  const [summary, { refetch: refetchSummary }] = createResource<IncidentsSummaryWithConfig | undefined>(async () => {
    const res = await app.invokeTool<{ data: IncidentsSummaryWithConfig }>("incidents_summary", {})
    return res?.data
  })
  const [rows, { refetch: refetchRows }] = createResource(status, async (s): Promise<IncidentLike[]> => {
    const res = await app.invokeTool<{ data: IncidentLike[] }>("incidents_list", { status: s, limit: 100 })
    return res?.data ?? []
  })
  const needsNames = () => (rows.latest ?? []).some((i) => i.resolvedBy && !isAutoResolved(i))
  const [names] = createResource(() => (needsNames() ? true : null), loadMemberNames)

  const refetch = () => {
    void refetchSummary()
    void refetchRows()
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

  const sourceViews = createMemo(() => {
    const s = summary.latest
    const map = new Map<string, SourceView>()
    if (s) for (const v of buildSourceViews(s, (rows.latest ?? []).map((i) => i.source))) map.set(v.source, v)
    return map
  })

  return (
    <div class="flex h-full flex-col overflow-hidden" data-testid={`monitoring-status-${status()}`}>
      <div class="flex-1 overflow-y-auto">
        <div class="mx-auto flex max-w-[1000px] flex-col gap-[18px] px-6 pb-12 pt-5">
          <div class="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 class="text-[18px] font-semibold tracking-[-0.01em] text-text">
                {status() === "resolved" ? tr("Resolved") : tr("Acknowledged")}
              </h1>
              <LiveLine>{tr("Live")}</LiveLine>
            </div>
            <OverflowMenu testid="monitoring-status" onRefresh={refetch} />
          </div>
          <Show when={rows.error || triageError()}>
            <Card class="border-error-border bg-error-glow px-4 py-2.5 text-[12px] text-error" testid="monitoring-load-error">
              {triageError() ?? (rows.error instanceof Error ? rows.error.message : String(rows.error))}
            </Card>
          </Show>
          <Card class="overflow-hidden rounded-xl">
            <Show
              when={(rows.latest ?? []).length > 0}
              fallback={
                <EmptyState title={tr("Nothing here")} testid="monitoring-incidents-empty">
                  {rows.latest ? tr("No incident in this state.") : tr("Loading…")}
                </EmptyState>
              }
            >
              <CardTable
                rows={rows.latest ?? []}
                rowKey={(inc) => inc.id}
                rowTestid={(inc) => `monitoring-incident-row-${inc.id}`}
                onRowClick={(inc) => navigate(incidentPath(inc.id))}
                columns={[
                  {
                    key: "incident",
                    header: tr("Incident"),
                    role: "anchor",
                    cell: (inc) => {
                      const line = incidentDetailLine(
                        inc,
                        inc.resolvedBy ? (names.latest?.get(inc.resolvedBy) ?? null) : null,
                      )
                      return (
                        <span class="flex min-w-0 max-w-[420px] flex-col">
                          <span class="flex min-w-0 items-baseline gap-1.5">
                            <RefTag value={inc.ref} testid={`monitoring-incident-ref-${inc.id}`} />
                            <span class="min-w-0 truncate" title={inc.title}>
                              {inc.title}
                            </span>
                          </span>
                          <Show when={line}>
                            <span class="truncate text-[11.5px] text-text-tertiary" title={line ?? undefined}>
                              {line}
                            </span>
                          </Show>
                        </span>
                      )
                    },
                  },
                  {
                    key: "source",
                    header: tr("Source"),
                    role: "secondary",
                    cell: (inc) => {
                      const v = sourceViews().get(inc.source)
                      return (
                        <span class="inline-flex min-w-0 items-center gap-2">
                          <Show when={v}>{(sv) => <SourceSquare source={sv()} size="sm" />}</Show>
                          <span class="truncate text-[12px]">{v?.label ?? inc.source}</span>
                        </span>
                      )
                    },
                  },
                  {
                    key: "severity",
                    header: tr("Severity"),
                    role: "meta",
                    cell: (inc) => {
                      const sev = severityMeta(inc.severity)
                      return (
                        <Badge tone={sev.tone} dot>
                          {sev.label}
                        </Badge>
                      )
                    },
                  },
                  {
                    key: "status",
                    header: tr("Status"),
                    role: "meta",
                    cell: (inc) => {
                      const t = incidentTag(inc)
                      return <span class={cx("whitespace-nowrap rounded-[5px] px-[7px] py-0.5 text-[11px] font-medium", t.cls)}>{t.label}</span>
                    },
                  },
                  {
                    key: "age",
                    header: status() === "resolved" ? tr("Resolved") : tr("Last seen"),
                    role: "meta",
                    cell: (inc) => formatAge(status() === "resolved" ? (inc.resolvedAt ?? inc.lastSeenAt) : inc.lastSeenAt, nowMs()),
                  },
                  {
                    key: "count",
                    header: tr("Count"),
                    role: "fold",
                    numeric: true,
                    align: "right",
                    cell: (inc) => inc.count,
                  },
                  {
                    key: "actions",
                    header: tr("Actions"),
                    role: "fold",
                    cell: (inc) => (
                      <Show when={inc.status === "acknowledged"}>
                        <Button
                          variant="ghost"
                          class="whitespace-nowrap"
                          testid={`monitoring-resolve-${inc.id}`}
                          disabled={busyId() === inc.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            void triage(inc.id, "incidents_resolve")
                          }}
                        >
                          {tr("Resolve")}
                        </Button>
                      </Show>
                    ),
                  },
                ]}
              />
            </Show>
          </Card>
        </div>
      </div>
    </div>
  )
}
