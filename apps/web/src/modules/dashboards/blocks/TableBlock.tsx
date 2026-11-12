// SPDX-License-Identifier: FSL-1.1-ALv2
import { CardTable, type CardTableColumn } from "@liaison/app-ui/card-table"
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { DashboardColumn, TableData } from "../dashboards-client"
import { formatValue } from "./format"

export interface TableBlockProps {
  /** The org's time zone: timestamps read in it. */
  timeZone?: string
  data: TableData
  currency?: string
  locale?: string
  /** Shown instead of "No data for this block yet" (names the range the block follows). */
  emptyText?: string
  /** A row picked: the dashboard opens the rows behind it. Its first cell is then a button. */
  onPickRow?: (index: number) => void
}

interface KeyedRow {
  key: string
  row: Record<string, unknown>
}

const NUMERIC = new Set(["number", "currency", "percent"])
/** Columns past this many fold behind a row's chevron on a phone card. */
const VISIBLE_COLUMNS = 4

/** The table's columns as CardTable sees them: the first anchors the row, figures align right. */
export function tableColumns(
  columns: DashboardColumn[],
  fmt: (value: unknown, column: DashboardColumn) => string,
  pick?: { onPick: (index: number) => void; label: (text: string) => string },
): Array<CardTableColumn<KeyedRow>> {
  return columns.map((c, i) => {
    const numeric = c.format !== undefined && NUMERIC.has(c.format)
    return {
      key: c.field,
      header: c.label,
      cell: (r: KeyedRow) => {
        const text = fmt(r.row[c.field], c)
        if (i !== 0 || !pick) return text
        return (
          <button
            type="button"
            data-testid={`block-table-pick-${r.key}`}
            aria-label={pick.label(text)}
            onClick={(e) => {
              e.stopPropagation()
              pick.onPick(Number(r.key))
            }}
            class="max-w-full truncate text-left underline decoration-border underline-offset-2 hover:text-text hover:decoration-text-tertiary"
          >
            {text}
          </button>
        )
      },
      role:
        i === 0
          ? "anchor"
          : i >= VISIBLE_COLUMNS
            ? "fold"
            : numeric || c.format === "date"
              ? "meta"
              : "secondary",
      align: numeric ? "right" : undefined,
      numeric: numeric || undefined,
    }
  })
}

/** Rows and columns on the shared CardTable: a table on a desktop, cards on a phone. */
export const TableBlock: Component<TableBlockProps> = (props) => {
  const i18n = useI18n()
  const locale = () => props.locale ?? i18n.locale()
  const rows = (): KeyedRow[] => props.data.rows.map((row, i) => ({ key: String(i), row }))
  const columns = () =>
    tableColumns(
      props.data.columns,
      (value, c) =>
        formatValue(value, {
          format: c.format,
          currency: props.currency,
          locale: locale(),
          timeZone: props.timeZone,
        }),
      props.onPickRow
        ? {
            onPick: props.onPickRow,
            label: (label) => i18n.t("kernel.dashboards.drillShowFor", { label }),
          }
        : undefined,
    )
  return (
    <div data-testid="block-table" class="min-w-0 overflow-x-auto">
      <CardTable
        rows={rows()}
        rowKey={(r) => r.key}
        columns={columns()}
        floor="flexible"
        rowTestid={(r) => `block-table-row-${r.key}`}
        onRowClick={props.onPickRow ? (r) => props.onPickRow?.(Number(r.key)) : undefined}
        emptyState={
          <p data-testid="block-empty" class="py-4 text-[13px] text-text-tertiary">
            {props.emptyText ?? i18n.t("kernel.dashboards.noData")}
          </p>
        }
      />
    </div>
  )
}
