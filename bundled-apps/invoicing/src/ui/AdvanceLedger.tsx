// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An advance invoice's own page: its own number in the normal series, the VAT it carries (due
// when the money came in), where it goes (the final invoice that deducts it, with the deduction
// line worded by the one function the draft uses), the accountant note, and what became of it:
// deducted by a named final, cancelled, paid ahead for a retainer month, or still open, in which
// case a project that stops gives it back with a credit note citing it. A deducted advance offers
// no credit: the final already takes it off what the client pays. Refusals are said in words.
//
// It reads only what the app already reads (documents_get, billing_plan_get, documents_search);
// it issues nothing. Calm: one quiet panel at the top of the document, no alarm colours, no modal.

import { app, navigate } from "@liaison/host"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { type DeductionLine, renderDeductionLines } from "../deduction-lines"
import { tr } from "./i18n"
import { Button, formatMoneyMinor } from "./kit"

type Row = Record<string, unknown>

/** The parts of the advance this page reads (documents_get). */
export interface AdvanceDocument {
  id: string
  status: string
  number?: string | null
  currency: string
  subtotal_minor: string | number
  tax_total_minor: string | number
  grand_total_minor: string | number
  issued_at?: string | null
  external_ref?: string | null
  billing_project_id?: string | null
  invoice_role?: string | null
}

/** The parts of a line this page reads. */
export interface AdvanceLine {
  description?: string
  subtotal_minor: string | number
  tax_rate_bp: number | null
  external_id?: string | null
}

/** A billing plan step, as billing_plan_get returns it. */
export interface AdvancePlanStep {
  id: string
  kind: string
  label: string
  amountMinor: number
  currency: string
  state: string
  document: { id: string; number: string | null; status: string } | null
}

/** A final invoice of the project, with its lines (documents_get). */
export interface ProjectFinal {
  id: string
  number: string | null
  status: string
  lines: AdvanceLine[]
}

/** What the page shows, worked out from the reads. */
export interface AdvanceLedgerView {
  state: "draft" | "open" | "deducted" | "cancelled"
  number: string | null
  exclMinor: bigint
  vatMinor: bigint
  inclMinor: bigint
  /** YYYY-MM: a prepaid retainer's month, deducted by that month's invoice. */
  retainerMonth: string | null
  /** The plan's final step this advance goes to; null for a retainer month or with no plan. */
  target: { label: string; amountMinor: bigint } | null
  /** The deduction lines the final carries for this advance; empty until it has a number. */
  deductions: DeductionLine[]
  /** What is left of the final, excl. VAT, once the advance is taken off. */
  leftMinor: bigint | null
  /** The advance is larger than the final it would be deducted from: the final is refused. */
  exceeds: boolean
  /** The live final that deducts it. */
  takenBy: { id: string; number: string | null } | null
}

const DEAD = new Set(["cancelled", "voided"])
const RETAINER_KEY = /^advance:[0-9a-f-]{36}:(\d{4}-\d{2})$/i

const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v))
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim())
  return 0n
}

/** An amount as the app prints one: grouped digits, then the currency. */
function money(minor: bigint, currency: string): string {
  return `${formatMoneyMinor(minor, currency)} ${currency}`
}

/** Whether a final's lines deduct this advance. */
export function deducts(final: ProjectFinal, advanceId: string): boolean {
  return final.lines.some(
    (l) =>
      typeof l.external_id === "string" &&
      l.external_id.startsWith(`advance_deduction:${advanceId}:`),
  )
}

/** The page, from the advance, its lines, its project's plan steps and the project's finals. */
export function advanceLedgerView(
  doc: AdvanceDocument,
  lines: AdvanceLine[],
  steps: AdvancePlanStep[],
  finals: ProjectFinal[],
): AdvanceLedgerView {
  const number = typeof doc.number === "string" && doc.number !== "" ? doc.number : null
  const exclMinor = big(doc.subtotal_minor)
  const vatMinor = big(doc.tax_total_minor)
  const inclMinor = big(doc.grand_total_minor)
  const month = RETAINER_KEY.exec(String(doc.external_ref ?? ""))?.[1] ?? null
  const final = month ? null : steps.find((s) => s.kind === "final" && s.state !== "cancelled")
  const target = final ? { label: final.label, amountMinor: big(final.amountMinor) } : null
  const deductions = number
    ? renderDeductionLines([{ doc: doc as unknown as Row, lines: lines as unknown as Row[] }])
    : []
  const taken = deductions.reduce((a, d) => a + BigInt(d.amountMinor), 0n)
  const takenBy = finals.find((f) => !DEAD.has(f.status) && deducts(f, doc.id)) ?? null
  const state = DEAD.has(doc.status)
    ? "cancelled"
    : takenBy
      ? "deducted"
      : number
        ? "open"
        : "draft"
  return {
    state,
    number,
    exclMinor,
    vatMinor,
    inclMinor,
    retainerMonth: month,
    target,
    deductions,
    leftMinor: target && number ? target.amountMinor - taken : null,
    exceeds: target !== null && number !== null && taken > target.amountMinor,
    takenBy: takenBy ? { id: takenBy.id, number: takenBy.number } : null,
  }
}

/** How a final is named: by its number, or as a draft until it has one. */
export function finalName(final: { number: string | null }): string {
  return final.number
    ? tr("invoice {{number}}", { number: final.number })
    : tr("its draft, no number yet")
}

/** A tool's answer in one sentence: the tool's own words when it gives them. */
export function toolNote(result: unknown, fallback: string): { text: string; isError: boolean } {
  const r = (result ?? {}) as { status?: string; message?: unknown; error?: { message?: unknown } }
  if (r.status === "error")
    return {
      text: typeof r.error?.message === "string" ? r.error.message : fallback,
      isError: true,
    }
  return { text: typeof r.message === "string" ? r.message : fallback, isError: false }
}

/** The project's plan steps and its final invoices, through the app's existing reads. */
export async function loadAdvanceContext(
  doc: AdvanceDocument,
): Promise<{ steps: AdvancePlanStep[]; finals: ProjectFinal[] }> {
  const projectId = doc.billing_project_id
  if (!projectId) return { steps: [], finals: [] }
  const [plan, found] = await Promise.all([
    app.invokeTool<{ steps?: AdvancePlanStep[] }>("billing_plan_get", { projectId }),
    app.invokeTool<unknown>("documents_search", {
      project_id: projectId,
      type: "invoice",
      limit: 100,
    }),
  ])
  const headers = (
    Array.isArray(found) ? found : ((found as { results?: unknown[] })?.results ?? [])
  ) as Row[]
  const finals: ProjectFinal[] = []
  for (const h of headers) {
    if (h.id === doc.id || h.invoice_role !== "final" || DEAD.has(String(h.status))) continue
    const full = await app.invokeTool<Row | null>("documents_get", { id: String(h.id) })
    if (!full) continue
    finals.push({
      id: String(full.id),
      number: typeof full.number === "string" ? full.number : null,
      status: String(full.status),
      lines: Array.isArray(full.lines) ? (full.lines as AdvanceLine[]) : [],
    })
  }
  return { steps: Array.isArray(plan?.steps) ? plan.steps : [], finals }
}

export const AdvanceLedgerBody: Component<{
  doc: AdvanceDocument
  view: AdvanceLedgerView
  onDone?: () => void
}> = (props) => {
  const cur = () => props.doc.currency
  const v = () => props.view
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ text: string; isError: boolean } | null>(null)

  const refund = async () => {
    if (busy()) return
    setBusy(true)
    setNote(null)
    try {
      setNote(
        toolNote(
          await app.invokeTool<unknown>("advance_refund_prepare", {
            advanceDocumentId: props.doc.id,
          }),
          tr("No credit note was made."),
        ),
      )
      props.onDone?.()
    } catch (e) {
      setNote({
        text: e instanceof Error ? e.message : tr("No credit note was made."),
        isError: true,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="advance-ledger"
      data-state={v().state}
      class="flex flex-col gap-3 border-b border-border-subtle px-5 py-3.5 text-[12px]"
    >
      <p data-testid="advance-ledger-number" class="text-text-secondary">
        {v().number
          ? tr("Advance invoice {{number}}: its own number in the normal invoice series.", {
              number: v().number ?? "",
            })
          : tr(
              "No number yet: an advance takes its own number in the normal series when it issues.",
            )}
      </p>

      <div data-testid="advance-ledger-own" class="flex flex-col gap-0.5">
        <span class="font-medium text-text">{tr("This advance")}</span>
        <span class="text-text-secondary">
          {tr("{{excl}} excl. VAT, {{vat}} VAT, {{incl}} incl. VAT", {
            excl: money(v().exclMinor, cur()),
            vat: money(v().vatMinor, cur()),
            incl: money(v().inclMinor, cur()),
          })}
        </span>
        <span class="text-text-tertiary">
          {tr(
            "VAT was due when the money came in, so it is on this invoice and not on the deducted part.",
          )}
        </span>
      </div>

      <Show when={v().state === "cancelled"}>
        <p data-testid="advance-ledger-cancelled" class="text-text-secondary">
          {tr("Cancelled: nothing is deducted from it.")}
        </p>
      </Show>

      <Show when={v().state !== "cancelled" && v().retainerMonth}>
        {(month) => (
          <p data-testid="advance-ledger-retainer" class="text-text-secondary">
            {tr("Paid in advance for {{month}}: that month's retainer invoice deducts it.", {
              month: month(),
            })}
          </p>
        )}
      </Show>

      <Show when={v().state !== "cancelled" && v().target}>
        {(target) => (
          <div data-testid="advance-preview" class="flex flex-col gap-1">
            <span class="font-medium text-text">
              {tr("Where it goes: {{label}}", { label: target().label })}
            </span>
            <Show
              when={v().deductions.length > 0}
              fallback={
                <span data-testid="advance-preview-pending" class="text-text-tertiary">
                  {tr(
                    "The deduction cites this advance's number and date, so it is worked out once the advance issues.",
                  )}
                </span>
              }
            >
              <ul class="flex flex-col gap-0.5 text-text-secondary">
                <li>
                  {tr("{{label}}, excl. VAT: {{amount}}", {
                    label: target().label,
                    amount: money(target().amountMinor, cur()),
                  })}
                </li>
                <For each={v().deductions}>
                  {(d) => (
                    <li data-testid="advance-preview-deduction">
                      {tr("Less {{description}}: {{amount}}", {
                        description: d.description,
                        amount: `-${money(BigInt(d.amountMinor), cur())}`,
                      })}
                    </li>
                  )}
                </For>
                <Show when={!v().exceeds && v().leftMinor !== null}>
                  <li data-testid="advance-preview-left">
                    {tr("Left to invoice on {{label}}, excl. VAT: {{amount}}", {
                      label: target().label,
                      amount: money(v().leftMinor ?? 0n, cur()),
                    })}
                  </li>
                </Show>
              </ul>
            </Show>
            <Show when={v().exceeds}>
              <p data-testid="advance-preview-exceeds" class="text-text-secondary">
                {tr(
                  "This advance is larger than {{label}} ({{amount}}), so that invoice cannot deduct it and will not be drafted: refund the part above it, or change the plan.",
                  { label: target().label, amount: money(target().amountMinor, cur()) },
                )}
              </p>
            </Show>
          </div>
        )}
      </Show>

      <aside data-testid="advance-accountant-note" class="flex flex-col gap-0.5 text-text-tertiary">
        <span class="font-medium text-text-secondary">
          {tr("Have your accountant check this layout once")}
        </span>
        <span>
          {tr(
            "An advance must have its own invoice, linked to the final one: that part is firm. How the final invoice shows the deduction is less clear in current French rules. Liaison prints what you see here.",
          )}
        </span>
      </aside>

      <Show when={v().state === "deducted" && v().takenBy}>
        {(final) => (
          <div data-testid="advance-taken-by" class="flex flex-wrap items-center gap-2">
            <span class="text-text-secondary">
              {tr("Deducted from {{name}}.", { name: finalName(final()) })}{" "}
              {tr(
                "It cannot be fully credited while {{name}} stands: refunding it too would pay it back twice. Credit {{name}} first.",
                { name: finalName(final()) },
              )}
            </span>
            <Button
              testid="advance-open-final"
              onClick={() => navigate(`/invoicing/document/${final().id}`)}
            >
              {tr("Open")}
            </Button>
          </div>
        )}
      </Show>

      <Show when={v().state === "open"}>
        <div data-testid="advance-refund" class="flex flex-wrap items-center gap-2">
          <span class="text-text-secondary">
            {tr(
              "If the project stops before its final invoice, a credit note citing this advance gives back what remains of it.",
            )}
          </span>
          <Button testid="advance-refund-prepare" disabled={busy()} onClick={() => void refund()}>
            {tr("Prepare a credit note")}
          </Button>
        </div>
      </Show>

      <Show when={note()}>
        {(n) => (
          <p
            data-testid="advance-ledger-note"
            class={n().isError ? "text-error" : "text-text-secondary"}
          >
            {n().text}
          </p>
        )}
      </Show>
    </section>
  )
}

/** The advance's panel on its document page: reads its project, then shows the ledger. */
export const AdvanceLedgerPanel: Component<{
  doc: AdvanceDocument
  lines: AdvanceLine[]
  onDone?: () => void
}> = (props) => {
  const [ctx, { refetch }] = createResource(
    () => (props.doc.invoice_role === "advance" ? props.doc : null),
    (doc) => loadAdvanceContext(doc),
  )
  return (
    <Show when={props.doc.invoice_role === "advance"}>
      <AdvanceLedgerBody
        doc={props.doc}
        view={advanceLedgerView(props.doc, props.lines, ctx()?.steps ?? [], ctx()?.finals ?? [])}
        onDone={() => {
          void refetch()
          props.onDone?.()
        }}
      />
    </Show>
  )
}

/**
 * Money first: money came in before the plan's advance had an invoice. The person chooses: draft
 * the advance invoice (a draft with no number, its issue waiting on approval) or say it is not an
 * advance (then the payment is invoiced or linked as any other, from its line on Home). Neither
 * issues anything.
 */
export const MoneyFirstChoices: Component<{
  projectId: string
  stepId: string
  onDrafted?: () => void
}> = (props) => {
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ text: string; isError: boolean } | null>(null)

  const draft = async () => {
    if (busy()) return
    setBusy(true)
    setNote(null)
    try {
      const r = await app.invokeTool<unknown>("advance_draft_create", {
        projectId: props.projectId,
        stepId: props.stepId,
      })
      setNote(toolNote(r, tr("Nothing was drafted.")))
      const draftId = (r as { draftId?: unknown } | null)?.draftId
      if (typeof draftId === "string") {
        props.onDrafted?.()
        navigate(`/invoicing/document/${draftId}`)
      }
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : tr("Nothing was drafted."), isError: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid={`money-first-${props.stepId}`} class="flex flex-col gap-1.5 text-[11.5px]">
      <span class="text-text-tertiary">
        {tr(
          "Money in before this advance has an invoice? Money received before delivery needs an advance invoice. Neither choice issues anything.",
        )}
      </span>
      <div class="flex flex-wrap gap-2">
        <Button
          testid={`money-first-draft-${props.stepId}`}
          disabled={busy()}
          onClick={() => void draft()}
        >
          {tr("Draft the advance invoice")}
        </Button>
        <Button
          testid={`money-first-not-${props.stepId}`}
          disabled={busy()}
          onClick={() =>
            setNote({
              text: tr(
                "Then invoice or link the payment as any other payment, from its line on Home. Nothing was drafted.",
              ),
              isError: false,
            })
          }
        >
          {tr("Not an advance")}
        </Button>
      </div>
      <Show when={note()}>
        {(n) => (
          <span
            data-testid={`money-first-note-${props.stepId}`}
            class={n().isError ? "text-error" : "text-text-secondary"}
          >
            {n().text}
          </span>
        )}
      </Show>
    </div>
  )
}
