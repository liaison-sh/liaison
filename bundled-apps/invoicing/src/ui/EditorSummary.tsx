// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EditorSummary — right-side panel for the editor (spec §12). Treatment badge,
// totals breakdown, customs-readiness, validation warnings/errors, and the
// approval-threshold callout. Styled with the shared kit so it reads as one
// calm column of grouped facts.
import { tr } from "./i18n"
import { For, Show, type Component } from "solid-js"
import type { CustomsReadinessResult, DraftDocument, TotalsResult, ValidationResult } from "./Editor"
import { Badge, cx, SectionLabel } from "./kit"
import { formatMoneyMinor } from "../money"

export interface EditorSummaryProps {
  draft: DraftDocument
  totals: TotalsResult
  readiness: CustomsReadinessResult
  validation: ValidationResult
}

function fmtMoney(minor: bigint, currency: string): string {
  return formatMoneyMinor(minor, currency)
}

const humanize = (s: string): string => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())

const Row: Component<{ label: string; value: string; testid?: string; strong?: boolean }> = (p) => (
  <div class="flex items-baseline justify-between gap-3">
    <span class={cx("text-[12px]", p.strong ? "text-text" : "text-text-secondary")}>{p.label}</span>
    <span
      data-testid={p.testid}
      class={cx("font-mono tabular-nums", p.strong ? "font-semibold text-text" : "text-text")}
    >
      {p.value}
    </span>
  </div>
)

export const EditorSummary: Component<EditorSummaryProps> = (props) => {
  const thresholdInfo = () => {
    const thr = props.draft.invoice_approval_threshold_minor
    if (!thr) return null
    try {
      const thresh = BigInt(thr)
      return { exceeds: props.totals.grand_total_minor >= thresh, thresh }
    } catch {
      return null
    }
  }

  return (
    <div data-testid="editor-summary" class="flex h-full flex-col gap-5 p-5">
      <div class="flex flex-col gap-1.5">
        <SectionLabel>{tr("Treatment")}</SectionLabel>
        <div>
          <Badge tone="accent" testid="editor-summary-treatment">
            {humanize(props.draft.tax_treatment)}
          </Badge>
        </div>
      </div>

      <div class="flex flex-col gap-2">
        <SectionLabel>{tr("Totals")}</SectionLabel>
        <div class="flex flex-col gap-1.5">
          <Row label={tr("Subtotal")} testid="editor-summary-subtotal" value={fmtMoney(props.totals.subtotal_minor, props.draft.currency)} />
          <Row label="VAT" testid="editor-summary-tax" value={fmtMoney(props.totals.tax_total_minor, props.draft.currency)} />
          <div class="mt-1 border-t border-border-subtle pt-2">
            <Row label={tr("Grand total")} testid="editor-summary-grand-total" strong value={fmtMoney(props.totals.grand_total_minor, props.draft.currency)} />
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <SectionLabel>{tr("Customs")}</SectionLabel>
        <Show
          when={props.readiness.applicable}
          fallback={
            <div data-testid="editor-summary-customs-na" class="text-[12px] text-text-tertiary">
              {tr("Not applicable:")} {humanize(props.draft.tax_treatment)}.
            </div>
          }
        >
          <Show
            when={props.readiness.ready}
            fallback={
              <Badge tone="warning" testid="editor-summary-customs-gaps">
                {props.readiness.missing_hs} {tr("HS ·")} {props.readiness.missing_coo} {tr("CoO missing")}
              </Badge>
            }
          >
            <Badge tone="success" testid="editor-summary-customs-ready">
              {tr("✓ All lines have HS + CoO")}
            </Badge>
          </Show>
        </Show>
      </div>

      <Show when={thresholdInfo()}>
        {(info) => (
          <div
            data-testid="editor-summary-threshold"
            class={cx(
              "rounded-lg border px-3 py-2.5 text-[12px] leading-relaxed",
              info().exceeds
                ? "border-warning-border bg-warning-glow text-warning"
                : "border-border-subtle bg-surface text-text-secondary",
            )}
          >
            <Show when={info().exceeds} fallback={<>{tr("Under the approval threshold, issues directly.")}</>}>
              {tr("⚠ Approval required: the grand total exceeds the configured threshold.")}
            </Show>
          </div>
        )}
      </Show>

      <Show when={props.validation.warnings.length > 0}>
        <div class="flex flex-col gap-1.5">
          <SectionLabel>{tr("Warnings")}</SectionLabel>
          <ul class="flex flex-col gap-1.5">
            <For each={props.validation.warnings}>
              {(w) => (
                <li
                  data-testid={`editor-summary-warning-${w.field}`}
                  class="text-[12px] leading-relaxed text-warning"
                >
                  {w.message}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>

      <Show when={props.validation.errors.length > 0}>
        <div class="flex flex-col gap-1.5">
          <SectionLabel>{tr("Errors")}</SectionLabel>
          <ul class="flex flex-col gap-1.5">
            <For each={props.validation.errors}>
              {(e) => (
                <li
                  data-testid={`editor-summary-error-${e.field}`}
                  class="flex items-start gap-2 text-[12px] leading-relaxed text-error"
                >
                  <span class="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-error" />
                  <span>{e.message}</span>
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </div>
  )
}
