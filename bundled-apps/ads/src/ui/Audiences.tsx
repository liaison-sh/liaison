// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Show } from "solid-js"
import { app } from "@liaison/host"
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { Badge, type BadgeTone, EmptyState, PageHeader } from "./kit"
import { audienceCountLabel, toolRows } from "./ui-logic"

interface AudienceRow {
  id: string
  name: string
  subtype?: string | null
  description?: string | null
  approximate_count?: number | null
  approximate_count_lower_bound?: number | null
  approximate_count_upper_bound?: number | null
  delivery_status?: { code?: number | null; description?: string | null } | null
  operation_status?: { code?: number | null; description?: string | null } | null
  retention_days?: number | null
  data_source?: { type?: string | null; sub_type?: string | null } | null
}

function deliveryTone(code: number | null | undefined): BadgeTone {
  if (code === 200) return "success"
  if (code != null && code >= 400) return "error"
  if (code != null && code >= 300) return "warning"
  return "neutral"
}

function humanRuleSummary(audience: AudienceRow): string {
  const sub = audience.subtype ?? ""
  const src = audience.data_source?.type ?? ""
  const ret = audience.retention_days != null ? `, last ${audience.retention_days} days` : ""
  if (sub === "WEBSITE") return `Website visitors${ret}`
  if (sub === "CUSTOM_COMBINATION") return "Custom combination"
  if (sub === "LOOKALIKE") return "Lookalike audience"
  if (sub === "ENGAGEMENT") return "Engagement audience"
  if (sub === "APP_USERS") return "App users"
  if (src) return `${src.toLowerCase().replace(/_/g, " ")} audience`
  return sub ? sub.toLowerCase().replace(/_/g, " ") : "Custom audience"
}

export const AudiencesTab: Component = () => {
  const [result] = app.createResource(() =>
    app.invokeTool<{ data: AudienceRow[] }>("audiences_list", {})
  )

  const rows = () => toolRows<AudienceRow>(result())

  return (
    <div class="flex h-full min-h-0 flex-col">
      <PageHeader title="Audiences" subtitle="Custom audiences with delivery and size information" />
      <Show when={result.error}>
        <div class="p-4 text-[12.5px] text-error">Failed to load audiences.</div>
      </Show>
      <Show when={!result.error && !result.loading && rows().length === 0}>
        <EmptyState title="No audiences yet">Create a custom audience in Ads Manager.</EmptyState>
      </Show>
      <Show when={rows().length > 0}>
        <div class="overflow-auto" data-testid="ads-audiences-table">
          <CardTable
            rows={rows()}
            rowKey={(r) => r.id}
            columns={
              [
                {
                  key: "name",
                  header: "Name",
                  role: "anchor",
                  cell: (r) => r.name,
                },
                {
                  key: "summary",
                  header: "Type",
                  role: "secondary",
                  cell: (r) => humanRuleSummary(r),
                },
                {
                  key: "size",
                  header: "Size",
                  role: "meta",
                  numeric: true,
                  cell: (r) =>
                    audienceCountLabel(
                      r.approximate_count_lower_bound ?? null,
                      r.approximate_count_upper_bound ?? null,
                    ),
                },
                {
                  key: "delivery",
                  header: "Delivery",
                  role: "meta",
                  cell: (r) => (
                    <Badge tone={deliveryTone(r.delivery_status?.code)}>
                      {r.delivery_status?.description ?? "-"}
                    </Badge>
                  ),
                },
                {
                  key: "operation",
                  header: "Operation",
                  role: "meta",
                  cell: (r) => (
                    <Badge tone={r.operation_status?.code === 200 ? "success" : "muted"}>
                      {r.operation_status?.description ?? "-"}
                    </Badge>
                  ),
                },
                {
                  key: "retention",
                  header: "Retention",
                  role: "fold",
                  cell: (r) => (r.retention_days != null ? `${r.retention_days}d` : "-"),
                },
              ] as Array<CardTableColumn<AudienceRow>>
            }
          />
        </div>
      </Show>
    </div>
  )
}
