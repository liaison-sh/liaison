// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A draft made from somewhere else, shown on its document page: a month's planned vs done card,
// a milestone of the project's billing plan, a retainer month, an advance. It says where it came
// from, that it has no number yet, what stays inside (never sent to the customer), whether it is
// late, and the deductions a final invoice takes; its one button issues it. The button reads
// `Issue, <amount>` once the draft is approved and `Approve <amount>` while it waits: both issue,
// a person without the deciding scope is told it went for approval. Calm: one quiet panel at the
// top of the page, no alarm colours, no modal.

import { app, navigate } from "@liaison/host"
import { type Component, createSignal, For, Show } from "solid-js"
import { issueLateness } from "../issue-date"
import { tr } from "./i18n"
import { Badge, Button, formatMoneyMinor } from "./kit"

export type DraftSource = "reconcile" | "milestone" | "retainer" | "advance"

/** The parts of a document this panel reads (documents_get). */
export interface SourcedDocument {
  id: string
  status: string
  currency: string
  grand_total_minor: string | number
  external_ref?: string | null
  approved_by?: string | null
  latest_issue_on?: string | null
  external_refs?: Record<string, unknown>
  /** The files a send mails beside the invoice (its activity report, a filed timesheet), as
   *  documents_get lists them. */
  annexes?: Array<{ kind: string }>
  /** The project the draft bills, for its billing plan. */
  billing_project_id?: string | null
}

/** The parts of a line this panel reads. */
export interface SourcedLine {
  description: string
  subtotal_minor: string | number
  external_id?: string | null
}

const PREFIXES: ReadonlyArray<[string, DraftSource]> = [
  ["reconcile:", "reconcile"],
  ["milestone:", "milestone"],
  ["retainer:", "retainer"],
  ["advance:", "advance"],
]

/** An amount as the app prints one: grouped digits, then the currency. */
function money(minor: bigint, currency: string): string {
  return `${formatMoneyMinor(minor, currency)} ${currency}`
}

/** Where a document was drafted from, by the key it carries; null for one typed by hand. */
export function draftSource(doc: Pick<SourcedDocument, "external_ref">): DraftSource | null {
  const ref = typeof doc.external_ref === "string" ? doc.external_ref : ""
  for (const [prefix, source] of PREFIXES) if (ref.startsWith(prefix)) return source
  return null
}

/** The source badge, in words a person reads. */
export function sourceBadge(source: DraftSource): string {
  switch (source) {
    case "reconcile":
      return tr("From planned vs done")
    case "retainer":
      return tr("Retainer month, from planned vs done")
    case "milestone":
      return tr("From a milestone")
    case "advance":
      return tr("Advance")
  }
}

/** Whether a person holding the deciding scope approved this draft for issue. */
export function isApproved(doc: Pick<SourcedDocument, "approved_by">): boolean {
  return typeof doc.approved_by === "string" && doc.approved_by !== ""
}

/**
 * The amount a button names: the document's total once it has one (a draft's, as documents_get
 * works it out from its lines); with none, its lines' sum, said excluding VAT.
 */
export function shownAmount(doc: SourcedDocument, lines: SourcedLine[]): string {
  const total = BigInt(String(doc.grand_total_minor ?? "0"))
  if (total !== 0n || lines.length === 0) return money(total, doc.currency)
  const excl = lines.reduce((a, l) => a + BigInt(String(l.subtotal_minor ?? "0")), 0n)
  return tr("{{amount}} excl. VAT", { amount: money(excl, doc.currency) })
}

/** How many documents go out with this invoice: itself, its activity report, a filed timesheet. */
export function documentsGoingOut(doc: Pick<SourcedDocument, "annexes">): number {
  const kinds = new Set((doc.annexes ?? []).map((a) => a.kind))
  return 1 + (kinds.has("activity_report") ? 1 : 0) + (kinds.has("timesheet") ? 1 : 0)
}

/**
 * The issue button: `Issue, <amount>` when approved, `Approve <amount>` when not. A retainer
 * month's invoice goes with its activity report, and with its timesheet when one is filed: its
 * button says all three only then, both with the report alone.
 */
export function issueButtonLabel(doc: SourcedDocument, lines: SourcedLine[] = []): string {
  const amount = shownAmount(doc, lines)
  const approved = isApproved(doc)
  const going = draftSource(doc) === "retainer" ? documentsGoingOut(doc) : 1
  if (going === 3)
    return approved
      ? tr("Issue all three, {{amount}}", { amount })
      : tr("Approve all three, {{amount}}", { amount })
  if (going === 2)
    return approved
      ? tr("Issue both, {{amount}}", { amount })
      : tr("Approve both, {{amount}}", { amount })
  return approved ? tr("Issue, {{amount}}", { amount }) : tr("Approve {{amount}}", { amount })
}

/** What stays inside: never on the invoice, its report or its mail. */
export function staysInside(source: DraftSource): string[] {
  if (source === "milestone" || source === "advance")
    return [tr("Real time spent and its notes"), tr("Team members' names"), tr("Internal notes")]
  return [
    tr("Real time spent and its notes"),
    tr("Team members' names"),
    tr("Lines left off the bill"),
    tr("Internal notes"),
  ]
}

/** Each deduction a final invoice takes, with the advance's number and date. */
export interface ShownDeduction {
  number: string
  date: string
  amountMinor: bigint
  description: string
}

/** The deduction lines of a final (milestone or retainer) draft, as its lines carry them. */
export function deductionsOf(doc: SourcedDocument, lines: SourcedLine[]): ShownDeduction[] {
  const preceding = Array.isArray(doc.external_refs?.preceding_invoices)
    ? (doc.external_refs?.preceding_invoices as Array<Record<string, unknown>>)
    : []
  const out: ShownDeduction[] = []
  for (const l of lines) {
    const id = typeof l.external_id === "string" ? l.external_id : ""
    if (!id.startsWith("advance_deduction:")) continue
    const advanceId = id.split(":")[1] ?? ""
    const cited = preceding.find((p) => p.document_id === advanceId)
    const raw = BigInt(String(l.subtotal_minor ?? "0"))
    out.push({
      number: typeof cited?.number === "string" ? cited.number : "",
      date: typeof cited?.issue_date === "string" ? cited.issue_date : "",
      amountMinor: raw < 0n ? -raw : raw,
      description: l.description,
    })
  }
  return out
}

/** Today's civil date where the reader is. */
function localToday(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** The issue tool's answer, in one sentence, and the issued invoice to open when there is one. */
export function issueNote(result: unknown): { text: string; isError: boolean; openId?: string } {
  const r = (result ?? {}) as {
    status?: string
    document_id?: string
    number?: string
    error?: { message?: string; code?: string }
    blocked?: unknown
  }
  if (r.status === "completed" && typeof r.number === "string")
    return {
      text: tr("Issued as {{number}}.", { number: r.number }),
      isError: false,
      openId: r.document_id,
    }
  if (r.status === "pending_approval" || r.blocked)
    return {
      text: tr("Sent for approval: it issues once someone who can issue invoices approves it."),
      isError: false,
    }
  if (r.status === "error")
    return { text: r.error?.message ?? r.error?.code ?? tr("Not issued."), isError: true }
  return { text: tr("Not issued."), isError: true }
}

export const SourcedDraftPanel: Component<{
  doc: SourcedDocument
  lines: SourcedLine[]
  today?: string
  onDone?: () => void
}> = (props) => {
  const source = () => draftSource(props.doc)
  const late = () => issueLateness(props.doc.latest_issue_on, props.today ?? localToday())
  const deductions = () => deductionsOf(props.doc, props.lines)
  const [busy, setBusy] = createSignal(false)
  const [note, setNote] = createSignal<{ text: string; isError: boolean } | null>(null)

  const issue = async () => {
    if (busy()) return
    setBusy(true)
    setNote(null)
    try {
      const out = issueNote(
        await app.invokeTool<unknown>("invoice_issue", { draft_id: props.doc.id }),
      )
      setNote(out)
      if (out.openId) {
        props.onDone?.()
        navigate(`/invoicing/document/${out.openId}`)
      }
    } catch (e) {
      setNote({ text: e instanceof Error ? e.message : tr("Not issued."), isError: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={source()}>
      {(s) => (
        <section
          data-testid="sourced-draft"
          data-source={s()}
          class="flex flex-col gap-3 border-b border-border-subtle px-5 py-3.5 md:flex-row md:items-start md:justify-between"
        >
          <div class="flex min-w-0 flex-col gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <span data-testid="sourced-draft-badge">
                <Badge tone="neutral">{sourceBadge(s())}</Badge>
              </span>
              <Show when={props.doc.status === "draft"}>
                <span data-testid="sourced-draft-no-number" class="text-[12px] text-text-tertiary">
                  {tr("No number yet: it is taken when the invoice issues.")}
                </span>
              </Show>
            </div>
            <Show when={s() === "milestone"}>
              <p data-testid="sourced-draft-milestone" class="text-[12px] text-text-secondary">
                {tr("The amount comes from the billing plan. Hours do not move it.")}
              </p>
            </Show>
            <Show when={(s() === "milestone" || s() === "advance") && props.doc.billing_project_id}>
              {(projectId) => (
                <button
                  type="button"
                  data-testid="sourced-draft-plan"
                  class="self-start text-[12px] text-text-secondary underline-offset-2 hover:text-text hover:underline"
                  onClick={() => navigate(`/invoicing/billing-plan/${projectId()}`)}
                >
                  {tr("See the billing plan")}
                </button>
              )}
            </Show>
            <Show when={props.doc.status === "draft" && late()}>
              {(state) => (
                <p
                  data-testid="sourced-draft-late"
                  data-state={state()}
                  class="text-[12px] text-text-secondary"
                >
                  {state() === "late"
                    ? tr("Late: its latest issue day was {{day}}. It issues with today's date.", {
                        day: props.doc.latest_issue_on ?? "",
                      })
                    : tr("Latest issue day: {{day}}.", { day: props.doc.latest_issue_on ?? "" })}
                </p>
              )}
            </Show>
            <Show when={deductions().length > 0}>
              <ul data-testid="sourced-draft-deductions" class="flex flex-col gap-0.5 text-[12px]">
                <For each={deductions()}>
                  {(d) => (
                    <li data-testid="sourced-draft-deduction" class="text-text-secondary">
                      {tr("Deducted: advance invoice {{number}} of {{date}}, {{amount}}", {
                        number: d.number,
                        date: d.date,
                        amount: `-${money(d.amountMinor, props.doc.currency)}`,
                      })}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={note()}>
              {(n) => (
                <p
                  data-testid="sourced-draft-note"
                  class={n().isError ? "text-[12px] text-error" : "text-[12px] text-text-secondary"}
                >
                  {n().text}
                </p>
              )}
            </Show>
          </div>
          <div class="flex shrink-0 flex-col items-start gap-2 md:items-end">
            <Show when={props.doc.status === "draft"}>
              <Button
                variant="primary"
                testid="sourced-draft-issue"
                disabled={busy()}
                onClick={() => void issue()}
              >
                {issueButtonLabel(props.doc, props.lines)}
              </Button>
            </Show>
            <aside
              data-testid="sourced-draft-stays-inside"
              class="flex flex-col gap-0.5 text-[11.5px] text-text-tertiary"
            >
              <span class="font-medium text-text-secondary">{tr("Stays inside")}</span>
              <For each={staysInside(s())}>{(item) => <span>{item}</span>}</For>
            </aside>
          </div>
        </section>
      )}
    </Show>
  )
}
