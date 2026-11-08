// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Invoicing's rows for a company's or a contact's timeline (the `activity_read`
 * source the kernel calls): a document issued, an invoice paid, a credit note
 * issued. Never a draft. Read live, so a deleted document is gone at once.
 *
 * Rows are ordered newest first by (time, `<prefix><id>`), and only rows
 * strictly older than the cursor come back. A document's issue date is a day,
 * so many share one time; the read takes at most `cap` documents, and when it
 * is cut it says where its window starts (the day after its oldest document),
 * so the timeline pages on from there instead of losing documents of that day.
 */
import type { ReadsDb } from "./reads"

/** Documents one read takes; a company with more on one day than this loses the rest of that day. */
export const ACTIVITY_READ_CAP = 5000

interface Cursor {
  at: string
  id: string
}

interface Input {
  contactIds: string[]
  before: Cursor | null
  limit: number
  prefix: string
}

interface Row {
  id: string
  at: string
  title: string
  who: string | null
  contactId: string | null
  href: { app: string; entityType: string; entityId: string } | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function readInput(raw: unknown): Input {
  const v = (raw ?? {}) as Record<string, unknown>
  const ids = Array.isArray(v.contactIds)
    ? v.contactIds.filter((x): x is string => typeof x === "string" && UUID.test(x)).slice(0, 50)
    : []
  const b = v.before as { at?: unknown; id?: unknown } | null | undefined
  return {
    contactIds: ids,
    before:
      b && typeof b.at === "string" && typeof b.id === "string"
        ? { at: new Date(b.at).toISOString(), id: b.id }
        : null,
    limit: Math.min(100, Math.max(1, Number(v.limit) || 30)),
    prefix: typeof v.prefix === "string" ? v.prefix : "",
  }
}

/** Newest first, then by id as code units: the kernel's own order. */
function compare(a: Cursor, b: Cursor): number {
  const ta = Date.parse(a.at)
  const tb = Date.parse(b.at)
  if (ta !== tb) return tb - ta
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

function dayStart(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`)
}

function amount(minor: unknown, currency: unknown): string {
  const n = Number(minor)
  if (!Number.isFinite(n)) return ""
  return `, ${(n / 100).toFixed(2)} ${typeof currency === "string" ? currency : ""}`.trimEnd()
}

const LABEL: Record<string, string> = {
  invoice: "Invoice",
  quote: "Quote",
  proforma: "Proforma",
  purchase_order: "Purchase order",
  credit_note: "Credit note",
}

export async function activityRead(ctx: { db: ReadsDb }, raw: unknown, cap = ACTIVITY_READ_CAP) {
  const input = readInput(raw)
  if (input.contactIds.length === 0) return { rows: [] }
  const where: Record<string, unknown> = {
    counterparty_contact_id: { in: input.contactIds },
    // Paid follows issued, so nothing older than the cursor was issued after its day.
    ...(input.before ? { issued_at: { lte: input.before.at.slice(0, 10) } } : {}),
  }
  const docs = (await ctx.db.findMany("documents", {
    where,
    orderBy: { issued_at: "desc", number_int: "desc" },
    limit: cap,
  })) as Array<Record<string, unknown>>
  // A cut read is complete only after the day of its oldest document.
  const last = docs.at(-1)
  const cutAfter =
    docs.length === cap && typeof last?.issued_at === "string"
      ? new Date(dayStart(last.issued_at).getTime() + 86_400_000).toISOString()
      : null
  // A cut on the cursor's own day cannot move on by days: that day's rows are given as read.
  const windowStart =
    cutAfter && !(input.before && Date.parse(cutAfter) > Date.parse(input.before.at)) ? cutAfter : null
  const rows: Row[] = []
  const push = (row: Row) => {
    if (windowStart && Date.parse(row.at) <= Date.parse(windowStart)) return
    if (input.before && compare({ at: row.at, id: `${input.prefix}${row.id}` }, input.before) <= 0)
      return
    rows.push(row)
  }
  for (const d of docs) {
    const id = String(d.id)
    if (d.status === "draft" || typeof d.issued_at !== "string") continue
    const type = String(d.type ?? "invoice")
    const name = `${LABEL[type] ?? "Document"} ${d.number ?? ""}`.trim()
    const base = {
      who: typeof d.counterparty_name === "string" ? d.counterparty_name : null,
      contactId: typeof d.counterparty_contact_id === "string" ? d.counterparty_contact_id : null,
      href: { app: "invoicing", entityType: "document", entityId: id },
    }
    push({
      ...base,
      id: `${id}:issued`,
      at: dayStart(d.issued_at).toISOString(),
      title: `${name} ${type === "credit_note" ? "credited" : "issued"}${amount(d.grand_total_minor, d.currency)}`,
    })
    if (type === "invoice" && typeof d.paid_at === "string") {
      push({
        ...base,
        id: `${id}:paid`,
        at: new Date(d.paid_at).toISOString(),
        title: `${name} paid`,
      })
    }
  }
  rows.sort((a, b) =>
    compare({ at: a.at, id: `${input.prefix}${a.id}` }, { at: b.at, id: `${input.prefix}${b.id}` }),
  )
  return { rows: rows.slice(0, input.limit), windowStart }
}
