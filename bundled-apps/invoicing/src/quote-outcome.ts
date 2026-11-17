// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sent quote's outcome: accepted, rejected or expired, set once. The tool
// (`quote_set_outcome`, gated for an agent) and invoicing's own subscriber on
// `kernel/client_action:decided` (a client's answer on a link, system origin)
// both go through `setQuoteOutcome`, one guarded update on the quote still
// `sent`. No outcome creates an invoice: converting an accepted quote stays its
// own step, so no invoice ever waits on a client.

import { formatMoneyMinor } from "./money"
import type { ErrorEnvelope, MutationsCtx } from "./mutations/shared"
import { transition } from "./state"

export const QUOTE_OUTCOMES = ["accepted", "rejected", "expired"] as const
export type QuoteOutcome = (typeof QUOTE_OUTCOMES)[number]

const EVENT_OF: Record<QuoteOutcome, string> = {
  accepted: "accept",
  rejected: "reject",
  expired: "expire",
}

/** The client action target this app declares for a quote's acceptance. */
export const QUOTE_TARGET_TYPE = "document"

type OutcomeCtx = Pick<MutationsCtx, "db" | "emit"> & { getUserId?: () => Promise<string> }

const fail = (code: string, message: string): ErrorEnvelope => ({
  status: "error",
  error: { code, message },
})

export interface OutcomeResult {
  status: "completed"
  document_id: string
  number: string | null
  outcome: QuoteOutcome
  message: string
}

/**
 * Sets a sent quote's outcome once. `via` says who answered: a person here
 * (`person`), or the client on their link (`client_action`, with its id).
 */
export async function setQuoteOutcome(
  ctx: OutcomeCtx,
  input: {
    document_id: string
    outcome: string
    via: "person" | "client_action"
    client_action_id?: string | null
  },
): Promise<OutcomeResult | ErrorEnvelope> {
  const checked = await checkOutcome(ctx, input)
  if ("status" in checked) return checked
  const { doc, next, label, outcome } = checked
  const actor = ctx.getUserId ? await ctx.getUserId().catch(() => null) : null
  // Set once: the quote is re-read just before the write and only a sent one changes. A client's
  // answer reaches here once (the kernel's decide is one guarded update per link), and a
  // person's call re-checks the same way.
  const fresh = (await ctx.db.findOne("documents", doc.id)) as { status: string } | null
  if (fresh?.status !== "sent") return refusedFor(label, fresh?.status ?? doc.status)
  await ctx.db.update("documents", doc.id, {
    status: next.next,
    lifecycle_log: [
      ...(Array.isArray(doc.lifecycle_log) ? doc.lifecycle_log : []),
      {
        event: `quote_${outcome}`,
        actor: input.via === "person" ? actor : null,
        via: input.via,
        client_action_id: input.client_action_id ?? null,
        ts: new Date().toISOString(),
      },
    ],
  })
  await ctx.emit?.({
    entity: "document",
    action: "updated",
    entityId: doc.id,
    data: {
      document_id: doc.id,
      type: "quote",
      number: doc.number,
      status: next.next,
      outcome,
      via: input.via,
    },
  })
  return {
    status: "completed",
    document_id: doc.id,
    number: doc.number,
    outcome,
    message: `${label} is now ${outcome}. No invoice was created.${
      outcome === "accepted"
        ? " Next: documents_convert_to_invoice on this quote when it is time to bill."
        : ""
    }`,
  }
}

interface QuoteRow {
  id: string
  type: string
  status: string
  number: string | null
  lifecycle_log?: unknown[]
}

/** The read-only checks of an outcome, shared by the call and its stage-time preflight. */
async function checkOutcome(
  ctx: Pick<OutcomeCtx, "db">,
  input: { document_id: string; outcome: string },
): Promise<
  ErrorEnvelope | { doc: QuoteRow; next: { next: string }; label: string; outcome: QuoteOutcome }
> {
  const outcome = input.outcome as QuoteOutcome
  if (!QUOTE_OUTCOMES.includes(outcome))
    return fail(
      "INVALID_INPUT",
      `outcome is one of ${QUOTE_OUTCOMES.join(", ")}. Nothing was changed.`,
    )
  const doc = (await ctx.db.findOne("documents", input.document_id)) as QuoteRow | null
  if (!doc) return fail("NOT_FOUND", `No document ${input.document_id}. Nothing was changed.`)
  const label = doc.number ? `Quote ${doc.number}` : `Quote ${doc.id}`
  if (doc.type !== "quote")
    return fail(
      "NOT_A_QUOTE",
      `${doc.number ?? doc.id} is a ${doc.type.replace("_", " ")}, not a quote. Nothing was changed.`,
    )
  const next = transition({ type: "quote", status: doc.status }, EVENT_OF[outcome])
  if (next.status !== "ok") return refusedFor(label, doc.status)
  return { doc, next, label, outcome }
}

/** Stage-time check: an agent's call on something that is not a sent quote is refused before it parks. */
export async function quoteOutcomePreflight(
  ctx: Pick<OutcomeCtx, "db">,
  input: { document_id: string; outcome: string },
): Promise<{ ok: true } | { error: { code: string; message: string } }> {
  const checked = await checkOutcome(ctx, input)
  return "status" in checked ? { error: checked.error } : { ok: true }
}

function refusedFor(label: string, status: string): ErrorEnvelope {
  if (
    status === "accepted" ||
    status === "rejected" ||
    status === "expired" ||
    status === "invoiced"
  )
    return fail(
      "OUTCOME_ALREADY_SET",
      `${label} is already ${status}: its outcome is set once. Nothing was changed.`,
    )
  return fail(
    "NOT_SENT",
    `${label} is ${status}: only a sent quote takes an outcome. Nothing was changed.`,
  )
}

interface DecidedEvent {
  data?: {
    id?: string
    target?: { app?: string; type?: string; id?: string }
  }
}

type DecidedCtx = OutcomeCtx & {
  client_actions_record?: (p: { id: string }) => Promise<unknown>
}

/**
 * Invoicing's subscriber on `kernel/client_action:decided`: a client's answer on
 * a quote's link sets its outcome (system origin). Any other target, another
 * app's included, is not this app's and is left alone at once.
 */
export async function onQuoteClientActionDecided(ctx: DecidedCtx, event: DecidedEvent) {
  const d = event?.data
  if (d?.target?.app !== "invoicing" || d.target.type !== QUOTE_TARGET_TYPE)
    return { status: "ignored" }
  if (!d.id || !d.target.id || !ctx.client_actions_record) return { status: "ignored" }
  const raw = await ctx.client_actions_record({ id: d.id })
  const rec = (typeof raw === "string" ? JSON.parse(raw) : raw) as {
    record?: { kind?: string; decision?: string | null; target_id?: string; replaced?: boolean }
  }
  const r = rec?.record
  if (!r || r.target_id !== d.target.id || r.replaced === true) return { status: "ignored" }
  const outcome =
    r.kind === "accept" && r.decision === "accepted"
      ? "accepted"
      : r.decision === "declined"
        ? "rejected"
        : null
  if (!outcome) return { status: "ignored" }
  const out = await setQuoteOutcome(ctx, {
    document_id: d.target.id,
    outcome,
    via: "client_action",
    client_action_id: d.id,
  })
  return out.status === "completed"
    ? { status: outcome }
    : { status: "unchanged", error: out.error }
}

/** A quote a client can be asked to accept, or still sees once they answered. */
const VIEWABLE = new Set(["sent", "accepted", "rejected", "expired"])

/**
 * What the client is shown on a quote's acceptance link (internal: the kernel's client action
 * page): its title, a short summary, its issued lines and its issued PDF. It names the PDF and no hash: the kernel
 * fingerprints the stored file itself, and checks that fingerprint again when the client answers.
 */
export async function quoteClientActionView(
  ctx: Pick<OutcomeCtx, "db">,
  p: { targetType: string; targetId: string },
) {
  if (p.targetType !== QUOTE_TARGET_TYPE) return fail("NOT_FOUND", "Not an invoicing document.")
  const doc = (await ctx.db.findOne("documents", p.targetId)) as
    | (QuoteRow & {
        pdf_file_id?: string | null
        currency?: string | null
        grand_total_minor?: unknown
        due_at?: string | null
        counterparty_name?: string | null
      })
    | null
  if (!doc || doc.type !== "quote") return fail("NOT_FOUND", `No quote ${p.targetId}.`)
  const label = doc.number ? `Quote ${doc.number}` : `Quote ${doc.id}`
  if (!VIEWABLE.has(doc.status))
    return fail("NOT_SENT", `${label} is ${doc.status}: only a sent quote is shown to a client.`)
  if (!doc.pdf_file_id) return fail("NOT_READABLE", `${label} has no PDF yet.`)
  const currency = doc.currency ?? "EUR"
  const total =
    typeof doc.grand_total_minor === "bigint" ||
    typeof doc.grand_total_minor === "number" ||
    (typeof doc.grand_total_minor === "string" && /^-?\d+$/.test(doc.grand_total_minor))
      ? formatMoneyMinor(doc.grand_total_minor, currency)
      : null
  // The quote as the client reads it on the page, from its issued lines: what shows the quote
  // before an answer. The fingerprint stays the issued PDF's.
  const lines = (
    ((await ctx.db.findMany("document_lines", {
      where: { document_id: doc.id },
      limit: 500,
    })) ?? []) as Array<{ position?: unknown; description?: unknown; subtotal_minor?: unknown }>
  ).sort((a, b) => Number(a.position) - Number(b.position))
  const money = (v: unknown) =>
    typeof v === "bigint" || typeof v === "number" || (typeof v === "string" && /^-?\d+$/.test(v))
      ? formatMoneyMinor(v, currency)
      : null
  const blocks = [
    { type: "heading", text: label },
    ...lines.map((l) => {
      const amount = money(l.subtotal_minor)
      return {
        type: "paragraph",
        text: `${String(l.description ?? "").trim() || "Line"}${amount ? `: ${amount} excl. VAT` : ""}`,
      }
    }),
    ...(total ? [{ type: "paragraph", text: `Total incl. VAT: ${total}` }] : []),
  ]
  return {
    title: label,
    summary: [
      { k: "Quote", v: doc.number ?? doc.id },
      ...(total ? [{ k: "Total incl. VAT", v: total }] : []),
      ...(doc.counterparty_name ? [{ k: "For", v: doc.counterparty_name }] : []),
    ],
    source_blocks: blocks,
    text: null,
    pdf_file_id: doc.pdf_file_id,
    words_params: { number: doc.number ?? doc.id },
    copies: {},
  }
}
