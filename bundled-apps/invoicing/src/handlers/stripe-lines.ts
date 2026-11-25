// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What Home says of the Stripe invoices that wait. Each has one line under its park
// (`stripe_invoice:needs_person`), whose text is kept on the park (`blocked_on.line`): it is said
// again only when it changes. Past the last automatic retry only a person issues, so the line says
// what to do; above LINES_MAX such invoices one grouped line replaces theirs
// (`stripe_invoice:many_need_person`, under the park LINES_PARK that keeps what it said). A line
// closes with its park: issued, voided, invoiced by hand, dropped.
import {
  type DeferredRow,
  isStalled,
  openRowsOf,
  STRIPE_INVOICE_PARK,
  toDeferredRow,
} from "../deferred"

type Row = Record<string, unknown>

export interface LinesCtx {
  db: {
    findMany(entity: string, opts?: Row): Promise<unknown[]>
    insert?(entity: string, data: Row): Promise<unknown>
    update?(entity: string, id: string, data: Row): Promise<void>
  }
  emit?(event: { entity: string; action: string; entityId?: string; data?: unknown }): Promise<void>
}

/** Most invoices past their retries that have a line each; above, one line speaks for all. */
export const LINES_MAX = 10
/** The one park behind the grouped line. Nothing retries it. */
export const LINES_PARK = "stripe_invoices_waiting"
const LINES_EVENT = "stripe:invoices_waiting"
/** Invoices the grouped line names. */
const NAMED = 5
/** Lines and parks one run touches, so it ends well inside its time. */
export const TOUCH_MAX = 200

/** A Stripe invoice only a person issues: past its last automatic retry. */
export const isPersonOnly = (r: DeferredRow) =>
  isStalled(r) && r.blocked_on.kind === STRIPE_INVOICE_PARK && r.event_id.startsWith("stripe:in_")

export const invoiceIdOf = (r: Pick<DeferredRow, "event_id">) => r.event_id.slice("stripe:".length)

const lineOf = (r: Pick<DeferredRow, "blocked_on">) =>
  typeof r.blocked_on.line === "string" ? r.blocked_on.line : null

/** Say `text` on the park's line, when it is not what the line says already. */
export async function sayLine(
  ctx: LinesCtx,
  row: Pick<DeferredRow, "id" | "event_id" | "blocked_on">,
  text: string,
): Promise<void> {
  if (!ctx.emit || lineOf(row) === text) return
  await ctx.emit({
    entity: "stripe_invoice",
    action: "needs_person",
    entityId: row.id,
    data: {
      deferred_id: row.id,
      stripe_invoice_id: invoiceIdOf(row),
      reason: text,
      resolved: false,
    },
  })
  await ctx.db.update?.("deferred_events", row.id, {
    blocked_on: { ...row.blocked_on, line: text },
  })
}

/** `sayLine` by the park's id, on the park as it is stored now. */
export async function sayLineOf(ctx: LinesCtx, id: string, text: string): Promise<void> {
  const [row] = (await ctx.db.findMany("deferred_events", { where: { id }, limit: 1 })) as Row[]
  if (!row) return
  const r = toDeferredRow(row)
  if (isPersonOnly(r) && (await openGroup(ctx))) return
  await sayLine(ctx, r, text)
}

async function openGroup(ctx: LinesCtx): Promise<Row | null> {
  const rows = (await ctx.db.findMany("deferred_events", {
    where: { event_id: LINES_EVENT, status: "awaiting_dependency" },
    limit: 1,
  })) as Row[]
  return rows[0] ?? null
}

async function closeGroup(ctx: LinesCtx, group: Row): Promise<void> {
  await ctx.db.update?.("deferred_events", String(group.id), {
    status: "resolved",
    reason: "lines_each",
  })
  await ctx.emit?.({
    entity: "stripe_invoice",
    action: "many_need_person",
    entityId: String(group.id),
    data: { deferred_id: String(group.id), resolved: true },
  })
}

function groupText(count: number, ready: string[]): string {
  const shown = ready.slice(0, NAMED)
  const more = ready.length - shown.length
  const names = `${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`
  const rest = count - ready.length
  return [
    ...(ready.length > 0 ? [`${ready.length} can be issued now (${names}): issue each one`] : []),
    ...(rest > 0
      ? [
          `${rest} still ${rest === 1 ? "waits" : "wait"} for what is missing in Stripe or in the issuer settings`,
        ]
      : []),
  ].join(". ")
}

/** Say the grouped line for `ids`, of which `ready` can be issued now; nothing when it says it. */
async function sayGroup(
  ctx: LinesCtx,
  group: Row | null,
  ids: string[],
  ready: string[],
): Promise<void> {
  const text = groupText(ids.length, ready)
  const stored = {
    event_payload_json: { kind: LINES_PARK, ready },
    blocked_on: { kind: LINES_PARK, count: ids.length, line: text },
  }
  let id: string
  if (group) {
    if ((group.blocked_on as Row | null)?.line === text) return
    id = String(group.id)
    await ctx.db.update?.("deferred_events", id, stored)
  } else {
    const made = (await ctx.db.insert?.("deferred_events", {
      ...stored,
      event_id: LINES_EVENT,
      status: "awaiting_dependency",
      reason: "waits_for_a_person",
      contact_id: null,
      retry_count: 0,
      retried_at: null,
    })) as Row | undefined
    if (!made) return
    id = String(made.id)
  }
  await ctx.emit?.({
    entity: "stripe_invoice",
    action: "many_need_person",
    entityId: id,
    data: { deferred_id: id, count: ids.length, ready: ready.length, text, resolved: false },
  })
}

/** An invoice only a person issues, and what Home says of it. */
export interface PersonInvoice {
  row: DeferredRow
  text: string
  /** Nothing is missing any more: a click issues it. */
  ready: boolean
}

/** The safety job's pass over every invoice only a person issues. */
export async function sayPersonLines(ctx: LinesCtx, waiting: PersonInvoice[]): Promise<void> {
  const group = await openGroup(ctx)
  if (waiting.length <= LINES_MAX) {
    if (group) await closeGroup(ctx, group)
    for (const w of waiting) await sayLine(ctx, w.row, w.text)
    return
  }
  let touched = 0
  for (const { row } of waiting) {
    if (lineOf(row) === null) continue
    if (touched >= TOUCH_MAX) break
    touched += 1
    await ctx.emit?.({
      entity: "stripe_invoice",
      action: "needs_person",
      entityId: row.id,
      data: { deferred_id: row.id, resolved: true },
    })
    await ctx.db.update?.("deferred_events", row.id, {
      blocked_on: { ...row.blocked_on, line: null },
    })
  }
  await sayGroup(
    ctx,
    group,
    waiting.map((w) => invoiceIdOf(w.row)),
    waiting.filter((w) => w.ready).map((w) => invoiceIdOf(w.row)),
  )
}

/** A park behind the grouped line closed: the line counts again, and goes with the last one. */
export async function recountGroup(ctx: LinesCtx): Promise<void> {
  const group = await openGroup(ctx)
  if (!group) return
  const ids: string[] = []
  for await (const r of openRowsOf(ctx, "stripe:in_")) if (isPersonOnly(r)) ids.push(invoiceIdOf(r))
  if (ids.length === 0) return closeGroup(ctx, group)
  const was = ((group.event_payload_json as Row | null)?.ready ?? []) as string[]
  const open = new Set(ids)
  await sayGroup(
    ctx,
    group,
    ids,
    was.filter((id) => open.has(id)),
  )
}
