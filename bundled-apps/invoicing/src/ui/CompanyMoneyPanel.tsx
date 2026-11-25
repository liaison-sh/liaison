// SPDX-License-Identifier: FSL-1.1-ALv2
//
// CompanyMoneyPanel — the Money section of the kernel's company page
// (`slots.company_detail`, group `money`). Lists the documents made out to the
// company's people, read with `documents_search({ company_id })` as the
// viewer: the kernel lists the panel only for a viewer holding
// `invoicing:documents:read`, and the read returns only what they may see.

import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import { app, navigate } from "@liaison/host"
import { type Component, createResource, For, Show } from "solid-js"
import { currencyExponent } from "../money"
import { type DocumentRow, displayTotal } from "./ContactDocumentsPanel"
import { tr, uiLocale } from "./i18n"
import { billsText, type ListRow } from "./RecurringList"

export interface CompanyMoneyPanelProps {
  /** The company id: the slot host mounts every panel with it as `entityId`. */
  entityId?: string
}

export const COMPANY_MONEY_LIMIT = 20

/** The company's documents, newest first; none when the read fails. */
export async function loadCompanyMoney(companyId: string): Promise<DocumentRow[]> {
  const rows = await app
    .invokeTool<DocumentRow[]>("documents_search", {
      company_id: companyId,
      limit: COMPANY_MONEY_LIMIT,
    })
    .catch(() => [] as DocumentRow[])
  return Array.isArray(rows) ? rows : []
}

/** The recurring schedules that bill the company, soonest first; none when the read fails. */
export async function loadCompanySchedules(companyId: string): Promise<ListRow[]> {
  const out = await app
    .invokeTool<{ rows?: ListRow[] }>("recurring_list", {
      company_id: companyId,
      limit: COMPANY_MONEY_LIMIT,
    })
    .catch(() => null)
  return Array.isArray(out?.rows) ? out.rows.filter((r) => r.status !== "ended") : []
}

/** A document's date in the reader's words ("29 Jun 2026"); a date-only value is read as UTC. */
export function companyMoneyDate(iso: string | null | undefined, locale = uiLocale()): string {
  if (!iso) return "-"
  const at = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso)
  if (Number.isNaN(at.getTime())) return iso.slice(0, 10)
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(at)
}

/**
 * A document's total as the rest of the company page writes money ("€19,200.00"). A draft keeps
 * the total its lines give (`displayTotal`), since its stored total is 0 until it is issued.
 */
export function companyMoneyTotal(row: DocumentRow, locale = uiLocale()): string {
  if (row.status === "draft" || row.grand_total_minor == null) return displayTotal(row)
  const minor = Number(row.grand_total_minor)
  if (!Number.isFinite(minor)) return displayTotal(row)
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency: row.currency }).format(
      minor / 10 ** currencyExponent(row.currency),
    )
  } catch {
    return displayTotal(row)
  }
}

export const CompanyMoneyPanel: Component<CompanyMoneyPanelProps> = (props) => {
  const [docs] = createResource(() => props.entityId || undefined, loadCompanyMoney)
  const [schedules] = createResource(() => props.entityId || undefined, loadCompanySchedules)
  return (
    <section data-testid="company-money-panel" class="flex flex-col gap-2 text-[12.5px]">
      <Show when={(schedules()?.length ?? 0) > 0}>
        <ul data-testid="company-money-schedules" class="flex flex-col">
          <For each={schedules() ?? []}>
            {(r) => (
              <li>
                <a
                  href={`/invoicing/schedule/${r.id}`}
                  data-testid={`company-money-schedule-${r.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    navigate(`/invoicing/schedule/${r.id}`)
                  }}
                  class="flex flex-wrap gap-x-2 py-1 hover:bg-surface-hover"
                >
                  <span class="font-medium text-text">{tr("Recurring schedule")}</span>
                  <span class="text-text-secondary">{billsText(r)}</span>
                  <Show when={r.next_issue_on}>
                    {(day) => (
                      <span class="text-text-tertiary">
                        {tr("Next invoice")} {companyMoneyDate(day())}
                      </span>
                    )}
                  </Show>
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show
        when={(docs()?.length ?? 0) > 0}
        fallback={
          <div data-testid="company-money-panel-empty" class="text-text-tertiary">
            {tr("No invoices or quotes for this company yet.")}
          </div>
        }
      >
        <CardTable
          rows={docs() ?? []}
          rowKey={(row) => row.id}
          rowTestid={(row) => `company-money-panel-row-${row.id}`}
          onRowClick={(row) => navigate(`/invoicing/document/${row.id}`)}
          columns={
            [
              {
                key: "number",
                header: "#",
                role: "anchor",
                cell: (row) => <span class="font-mono">{row.number ?? tr("Draft")}</span>,
              },
              { key: "type", header: tr("Type"), role: "secondary", cell: (row) => row.type },
              {
                key: "date",
                header: tr("Date"),
                role: "meta",
                cell: (row) => companyMoneyDate(row.issued_at),
              },
              { key: "status", header: tr("Status"), role: "meta", cell: (row) => row.status },
              {
                key: "total",
                header: tr("Total"),
                role: "meta",
                numeric: true,
                align: "right",
                cell: (row) => companyMoneyTotal(row),
              },
            ] as Array<CardTableColumn<DocumentRow>>
          }
        />
      </Show>
    </section>
  )
}
