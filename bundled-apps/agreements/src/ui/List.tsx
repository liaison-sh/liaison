// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agreements list: Needs you, then one table in the order of what needs someone first,
// and the sentence that says so. Its states: the list, empty, loading and an error that says
// what failed. Only the rows the reader may see come back from the server (restricted rows by
// RLS), so a count here never names a document the reader cannot open.

import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { Badge, Button, PageHeader } from "@liaison/app-ui/kit"
import { app } from "@liaison/host"
import { type Component, createResource, For, Match, Show, Switch } from "solid-js"
import { go, loadCompanyNames, paths } from "./host"
import { tr, uiLocale } from "./i18n"
import {
  type AgreementBrief,
  filterRows,
  formatMoney,
  KIND_LABEL,
  needsYou,
  statusLabel,
  statusTone,
} from "./model"
import { SigningOff } from "./signing"

const today = () => new Date().toISOString().slice(0, 10)

export const StatusBadge: Component<{ status: string; kind?: string; testid?: string }> = (
  props,
) => (
  <Badge tone={statusTone(props.status)} testid={props.testid} variant={props.status}>
    {tr(statusLabel(props.status, props.kind))}
  </Badge>
)

const FILTER_TITLE: Record<string, string> = {
  all: "Agreements",
  waiting: "Waiting on a signature",
  ending: "Ending or renewing soon",
}

export const AgreementsList: Component<{ entityId?: string }> = (props) => {
  const filter = () => {
    const f = props.entityId ?? ""
    return f === "waiting" || f === "ending" || f in KIND_LABEL ? f : "all"
  }
  const [rows, { refetch }] = createResource(async () => {
    const out = await app.invokeTool<{ items?: AgreementBrief[] }>("home_load", {})
    return out?.items ?? []
  })
  // A failed load throws on read: every read below goes through this, so the error state draws.
  const items = () => (rows.error ? undefined : rows())
  const [companies] = createResource(loadCompanyNames)
  const shown = () => filterRows(items() ?? [], filter(), today())
  const title = () => tr(FILTER_TITLE[filter()] ?? KIND_LABEL[filter()] ?? "Agreements")
  const company = (r: AgreementBrief) =>
    r.company_id ? (companies()?.get(r.company_id) ?? "") : ""

  const columns: Array<CardTableColumn<AgreementBrief>> = [
    {
      key: "number",
      header: tr("Number"),
      role: "meta",
      fit: true,
      cell: (r) => <span class="font-mono text-[12px] text-text-secondary">{r.number}</span>,
    },
    {
      key: "title",
      header: tr("Title"),
      role: "anchor",
      cell: (r) => (
        <span class="flex flex-col">
          <span class="text-text">{r.title}</span>
          <span class="text-[11.5px] text-text-tertiary">
            {tr(KIND_LABEL[r.kind] ?? "Other document")}
          </span>
        </span>
      ),
    },
    {
      key: "company",
      header: tr("Company"),
      role: "secondary",
      cell: (r) => <span>{company(r)}</span>,
    },
    {
      key: "status",
      header: tr("Status"),
      role: "meta",
      fit: true,
      cell: (r) => (
        <StatusBadge status={r.status} kind={r.kind} testid={`agreements-row-status-${r.id}`} />
      ),
    },
    {
      key: "when",
      header: tr("Next date"),
      role: "fold",
      cell: (r) => <span class="tabular-nums">{r.renews_on ?? ""}</span>,
    },
    {
      key: "amount",
      header: tr("Amount excl. VAT"),
      role: "meta",
      numeric: true,
      align: "right",
      cell: (r) => <span>{formatMoney(r.price_minor, r.currency, uiLocale())}</span>,
    },
  ]

  return (
    <div data-testid="agreements-list" class="flex h-full min-h-0 flex-col bg-bg">
      <PageHeader
        title={title()}
        count={items() ? shown().length : undefined}
        actions={
          <Button variant="primary" testid="agreements-new" onClick={() => go(paths.create())}>
            {tr("New agreement")}
          </Button>
        }
      />
      <SigningOff />
      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <Switch>
          <Match when={rows.error}>
            <div data-testid="agreements-list-error" class="flex flex-col items-start gap-2 py-10">
              <p class="text-[13px] font-medium text-text">
                {tr("Could not load your agreements")}
              </p>
              <p class="text-[12px] text-text-tertiary">
                {tr("Nothing changed. Try again, or ask the agent.")}
              </p>
              <Button testid="agreements-list-retry" onClick={() => void refetch()}>
                {tr("Try again")}
              </Button>
            </div>
          </Match>
          <Match when={rows.loading && !items()}>
            <div
              data-testid="agreements-list-loading"
              class="flex flex-col gap-2 py-4"
              aria-busy="true"
            >
              <For each={[0, 1, 2, 3]}>{() => <div class="h-9 rounded-md bg-surface" />}</For>
            </div>
          </Match>
          <Match when={(items() ?? []).length === 0}>
            <div data-testid="agreements-list-empty" class="flex flex-col items-start gap-2 py-10">
              <p class="text-[13px] font-medium text-text">{tr("No agreements yet")}</p>
              <p class="max-w-md text-[12px] text-text-tertiary">
                {tr(
                  "Give the agent a brief, or your past contracts as PDFs. It drafts or files them here, and you check them.",
                )}
              </p>
              <Button testid="agreements-empty-new" onClick={() => go(paths.create())}>
                {tr("Start from a template")}
              </Button>
            </div>
          </Match>
          <Match when={true}>
            <Show when={filter() === "all" && needsYou(shown()).length > 0}>
              <section data-testid="agreements-needs-you" class="mb-5">
                <h2 class="mb-2 text-[12px] font-medium text-text-secondary">
                  {tr("Needs you")}{" "}
                  <span class="tabular-nums text-text-tertiary">{needsYou(shown()).length}</span>
                </h2>
                <ul class="flex flex-col gap-1.5">
                  <For each={needsYou(shown())}>
                    {(r) => (
                      <li>
                        <button
                          type="button"
                          data-testid={`agreements-needs-${r.id}`}
                          class="flex w-full items-center gap-3 rounded-md border border-border-subtle bg-surface px-3 py-2 text-left hover:bg-surface-hover"
                          onClick={() => go(paths.agreement(r.id))}
                        >
                          <StatusBadge status={r.status} kind={r.kind} />
                          <span class="min-w-0 flex-1 truncate text-[12.5px] text-text">
                            {r.number} · {r.title}
                          </span>
                          <span class="text-[12px] text-text-secondary">{tr("Open")}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            </Show>
            <CardTable
              rows={shown()}
              rowKey={(r) => r.id}
              columns={columns}
              rowTestid={(r) => `agreements-row-${r.id}`}
              onRowClick={(r) => go(paths.agreement(r.id))}
              emptyState={
                <p
                  data-testid="agreements-filter-empty"
                  class="py-6 text-[12px] text-text-tertiary"
                >
                  {tr("Nothing here right now.")}
                </p>
              }
            />
            <p data-testid="agreements-sort-sentence" class="mt-4 text-[12px] text-text-tertiary">
              {tr(
                "Agreements that need someone come first. Ask the agent for anything else, such as what renews before March.",
              )}
            </p>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
