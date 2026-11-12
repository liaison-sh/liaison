// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shipment link store — the local `shipment` index is the only enumerable
// surface for Boxtal shipments and the authoritative create-lifecycle record.
//
// `link_state ∈ {create_in_flight, created, create_uncertain, create_abandoned}`
// is the LOCAL create lifecycle (`create_abandoned` = a person checked the Boxtal
// dashboard and confirmed an orphaned reservation never bought a label; see
// settleOrphanedCreate); `order_status` is Boxtal's ShippingOrderStatusEnum (null
// until the v3 order exists). They are distinct columns.
//
// reserveCreate does a check-then-insert against the document_ref partial-unique
// (`WHERE order_status IS DISTINCT FROM 'CANCELLED'` — note IS DISTINCT FROM, so
// a NULL/in-flight order_status PARTICIPATES in the uniqueness: two concurrent
// in-flight reservations for the same document_ref collide at INSERT time, not
// later at finalize). The MockDb cannot enforce a partial unique, so the helper
// queries for a live row first and only inserts when absent — mirroring (and
// defending in depth of) the real DB constraint.
//
// The reservation and its finalize are COMMITTED AT ONCE (`ctx.db.insertNow` /
// `updateNow`), not with the run. An approved create_shipment runs in ONE
// transaction (claim, handler, mark approved), so a sandbox kill after Boxtal sold
// the label ("App execution timed out") rolled a plain-insert reservation back with
// everything else, and the paid label was left with no local record at all. Boxtal
// has no order list to find it again, so the committed reservation is the only
// trace: the orphan sweep (reconcile-tracking.ts) and stuck_list read it.

import { isUniqueViolation } from "./db-errors"

export interface LinkStoreDb {
  findMany(
    entity: string,
    opts?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<unknown[]>
  insert(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(entity: string, id: string, data: Record<string, unknown>): Promise<void>
  /** Committed in its own transaction at once (SDK `DbClient.insertNow`). */
  insertNow?(entity: string, data: Record<string, unknown>): Promise<{ id: string }>
  /** Committed in its own transaction at once (SDK `DbClient.updateNow`). */
  updateNow?(entity: string, id: string, data: Record<string, unknown>): Promise<void>
}

/** The host's commit-now write, or a loud refusal: a reservation that rolls back with the run
 *  is exactly the lost-paid-label bug, so there is no silent fallback to a plain write. */
function committedNow<K extends "insertNow" | "updateNow">(
  ctx: LinkStoreCtx,
  method: K,
): NonNullable<LinkStoreDb[K]> {
  const fn = ctx.db[method]
  if (typeof fn !== "function") {
    throw new Error(
      `ctx.db.${method} is missing: this Liaison host cannot commit a label reservation ahead of the purchase, so no label is bought. Update Liaison.`,
    )
  }
  return fn.bind(ctx.db) as NonNullable<LinkStoreDb[K]>
}

export interface LinkStoreCtx {
  db: LinkStoreDb
}

export interface ReserveInput {
  document_ref: string
  external_id?: string | null
  contact_ref?: string | null
  offer_code?: string | null
  recipient_summary?: string | null
  route_summary?: string | null
  declared_total?: number | null
  currency?: string | null
  /** Shipment direction. A return ships customer→us and surfaces in returns_list. */
  kind?: "outbound" | "return"
  return_reason?: string | null
  created_by?: "agent" | "user" | null
  /** PARTIAL batch: the shipped line subset (line id, sku snapshot, units). Null or
   *  absent means the legacy full-invoice shipment. */
  line_quantities?: Array<{ line_id: string; external_id: string | null; quantity: number }> | null
}

export type ReserveResult = { ok: true; id: string } | { ok: false; reason: "duplicate" }

async function findByOrderId(
  ctx: LinkStoreCtx,
  boxtalOrderId: string,
): Promise<Record<string, unknown> | null> {
  const rows = (await ctx.db.findMany("shipment", {
    where: { boxtal_order_id: boxtalOrderId },
    limit: 1,
  })) as Array<Record<string, unknown>>
  return rows[0] ?? null
}

/** Insert a create_in_flight row, refusing a duplicate live shipment per (invoice, kind).
 *  Kind-scoped on purpose: an invoice legitimately carries ONE outbound leg AND ONE return
 *  leg (a warranty/RMA return opens from the ORIGINAL sale invoice, whose delivered outbound
 *  shipment must not block the return). The DB partial unique mirrors this on
 *  (document_ref, kind) WHERE order_status IS DISTINCT FROM 'CANCELLED'. */
export async function reserveCreate(
  ctx: LinkStoreCtx,
  input: ReserveInput,
): Promise<ReserveResult> {
  const kind = input.kind ?? "outbound"
  const existing = (await ctx.db.findMany("shipment", {
    where: { document_ref: input.document_ref },
    limit: 100,
  })) as Array<Record<string, unknown>>
  const sameKind = existing.filter((r) => ((r.kind as string | null) ?? "outbound") === kind)
  const liveSameKind = sameKind.filter((r) => isLiveShipment(r))
  // A released (`create_abandoned`) row no longer counts as a live shipment, but it keeps its
  // order_status NULL, so it still occupies its (document_ref, kind, batch_seq) key in the DB
  // partial unique (`order_status IS DISTINCT FROM 'CANCELLED'`). The next reservation therefore
  // takes a batch_seq past every row that holds a key, never seq 1 again.
  const keyHolders = sameKind.filter((r) => r.order_status !== "CANCELLED")
  const isPartial = Array.isArray(input.line_quantities) && input.line_quantities.length > 0
  if (liveSameKind.length > 0) {
    // A live FULL shipment (null line_quantities) covers the whole invoice: nothing
    // more can ship on this leg. A FULL request is likewise only allowed when no
    // batch at all is live. Only a partial-batch request alongside partial-batch
    // rows may proceed (the caller has already validated remaining quantities
    // against the invoice; the DB unique on (document_ref, kind, batch_seq) is the
    // concurrency backstop).
    const hasLiveFull = liveSameKind.some((r) => r.line_quantities == null)
    if (hasLiveFull || !isPartial) return { ok: false, reason: "duplicate" }
  }
  const nextBatchSeq =
    keyHolders.length === 0 ? 1 : Math.max(...existing.map((r) => Number(r.batch_seq ?? 1))) + 1
  const insertNow = committedNow(ctx, "insertNow")
  try {
    const { id } = await insertNow("shipment", {
      document_ref: input.document_ref,
      external_id: input.external_id ?? null,
      contact_ref: input.contact_ref ?? null,
      offer_code: input.offer_code ?? null,
      recipient_summary: input.recipient_summary ?? null,
      route_summary: input.route_summary ?? null,
      declared_total: input.declared_total ?? null,
      currency: input.currency ?? null,
      kind: input.kind ?? "outbound",
      return_reason: input.return_reason ?? null,
      created_by: input.created_by ?? null,
      batch_seq: nextBatchSeq,
      line_quantities: isPartial ? input.line_quantities : null,
      link_state: "create_in_flight",
      order_status: null,
      boxtal_order_id: null,
      tracking_number: null,
      tracking_status: null,
      status_fetched_at: null,
      documents: [],
    })
    return { ok: true, id }
  } catch (err) {
    // The `document_ref` partial-unique index rejected the insert — a concurrent
    // reservation won the race (the check-then-insert is not atomic, but the DB
    // constraint is). This is the durable no-double-create backstop firing. Any
    // other failure is not a duplicate and propagates: nothing was bought yet.
    if (isUniqueViolation(err)) return { ok: false, reason: "duplicate" }
    throw err
  }
}

/** Flip a reserved row to created with the live Boxtal order id. */
export async function finalizeCreated(
  ctx: LinkStoreCtx,
  rowId: string,
  data: {
    boxtal_order_id: string
    tracking_number?: string | null
    label_cost_ttc?: number | null
    /** Boxtal's own shipment reference — see shipmentRefFromLabelUrl. */
    boxtal_shipment_ref?: string | null
    /** Buy-time snapshot of what is in the box — see queue-facts.ts. */
    queue_facts?: unknown
  },
): Promise<void> {
  // Committed at once too: the Boxtal order id of a PAID label must survive a kill of the
  // rest of the run (label import, proforma), so the row never falls back to an orphan.
  await committedNow(ctx, "updateNow")("shipment", rowId, {
    link_state: "created",
    order_status: "PENDING",
    boxtal_order_id: data.boxtal_order_id,
    ...(data.boxtal_shipment_ref ? { boxtal_shipment_ref: data.boxtal_shipment_ref } : {}),
    ...(data.queue_facts !== undefined ? { queue_facts: data.queue_facts } : {}),
    ...(data.tracking_number !== undefined ? { tracking_number: data.tracking_number } : {}),
    ...(data.label_cost_ttc != null ? { label_cost_ttc: data.label_cost_ttc } : {}),
  })
}

/**
 * How long a `create_in_flight` / `create_uncertain` reservation may sit before
 * it is treated as ORPHANED and swept.
 *
 * WHY there is a hole to close: `create_shipment` is not atomic. The sandbox
 * kills a handler at its budget ("App execution timed out") and the run's
 * transaction ROLLS BACK; only the reservation survives, because it was
 * committed on its own before the POST (`insertNow`). A kill landing between
 * `client.v3.createShippingOrder` returning (the label is PAID) and
 * `finalizeCreated` committing the order id leaves a row with
 * `link_state: 'create_in_flight'` and `boxtal_order_id: null`. It has no
 * `tracking_status`, so the tracking-based queues classify it as nothing at all;
 * the orphan sweep and stuck_list (family `create_orphan`) are what surface it.
 *
 * The age gate is what keeps the sweep safe: a create that is legitimately
 * running right now is at most one tool budget old (60s), so 15 minutes is more
 * than an order of magnitude of headroom. A reservation younger than this is
 * NEVER touched and NEVER reported.
 */
export const STALE_RESERVATION_MS = 15 * 60 * 1000

/** The link states that mean "a create was started and never confirmed". */
export const UNFINISHED_LINK_STATES: ReadonlySet<string> = new Set([
  "create_in_flight",
  "create_uncertain",
])

/** The terminal LOCAL state of a reservation a person released: they checked the Boxtal
 *  dashboard and no label was bought. Never swept, never in stuck_list, never a live shipment. */
export const ABANDONED_LINK_STATE = "create_abandoned"

/**
 * Is this shipment row still in play for its document? Boxtal cancelled it (`order_status
 * CANCELLED`) or a person released it as never bought (`create_abandoned`): either way it no
 * longer covers the document, so a new label may be bought. The ONE liveness rule every
 * "is there already a shipment for this invoice" read uses.
 */
export function isLiveShipment(row: { order_status?: unknown; link_state?: unknown }): boolean {
  return row.order_status !== "CANCELLED" && row.link_state !== ABANDONED_LINK_STATE
}

/** The subset of a shipment row the staleness test reads. */
export interface ReservationRow {
  link_state?: string | null
  order_status?: string | null
  /** Framework-stamped insert time: for a shipment row, when the label was requested. */
  created_at?: string | null
}

/**
 * Is this row an ORPHANED reservation: a create that was started, never
 * finished, and is now older than `staleMs`?
 *
 * Conservative on every axis, because the money is on the other side of this
 * predicate: a CANCELLED row is out of play, a row whose `created_at` is missing
 * or unparseable is never swept (we cannot establish its age, so we leave it to
 * a human), and a row younger than `staleMs` is never swept.
 */
export function isStaleReservation(
  row: ReservationRow,
  nowMs: number,
  staleMs: number = STALE_RESERVATION_MS,
): boolean {
  const state = row.link_state ?? null
  if (state == null || !UNFINISHED_LINK_STATES.has(state)) return false
  if (row.order_status === "CANCELLED") return false
  if (!row.created_at) return false
  const created = Date.parse(row.created_at)
  if (Number.isNaN(created)) return false
  return nowMs - created >= staleMs
}

/** Flip a reserved row to create_uncertain (kept — still holds the doc_ref slot). */
export async function markUncertain(ctx: LinkStoreCtx, rowId: string): Promise<void> {
  await ctx.db.update("shipment", rowId, { link_state: "create_uncertain" })
}

/** Apply a tracking-changed event, ignoring events older than the stored one. */
export async function applyTrackingChanged(
  ctx: LinkStoreCtx,
  boxtalOrderId: string,
  evt: { tracking_status: string; tracking_number: string | null; at: string },
): Promise<{ applied: boolean }> {
  const row = await findByOrderId(ctx, boxtalOrderId)
  if (!row) return { applied: false }
  const storedAt = row.status_fetched_at as string | null
  // Compare by parsed epoch, not lexicographically — Boxtal timestamps may carry
  // timezone offsets (`+02:00` vs `Z`) or differing precision that break string
  // ordering (I4). A NaN parse (malformed timestamp) is treated as "not older"
  // so we never silently drop an event on an unparseable date.
  if (storedAt) {
    const incoming = Date.parse(evt.at)
    const stored = Date.parse(storedAt)
    if (!Number.isNaN(incoming) && !Number.isNaN(stored) && incoming <= stored) {
      return { applied: false }
    }
  }
  // A tracking-changed event with no number (Boxtal sends status-only updates)
  // must not overwrite a previously stored tracking number — that number gates
  // auto-fulfilment downstream (webhooks.ts), so nulling it silently blocks it.
  const update: Record<string, unknown> = {
    tracking_status: evt.tracking_status,
    status_fetched_at: evt.at,
  }
  if (typeof evt.tracking_number === "string" && evt.tracking_number.length > 0) {
    update.tracking_number = evt.tracking_number
    update.tracking_from_label = false
    update.tracking_to_confirm = false
  }
  await ctx.db.update("shipment", String(row.id), update)
  return { applied: true }
}

/**
 * Boxtal's OPERATOR-VISIBLE shipment reference, read out of a label document URL.
 *
 * Their label files are named `<REFERENCE>_bordereau_<n>.pdf` (e.g.
 * `2609141542FEDX1CS3FR_bordereau_1.pdf`), and that reference is exactly the code their own
 * shipment list shows — the one an operator reads off the Boxtal screen and expects to find on
 * ours. It is NOT the order payload's `shipmentId`, which is an internal numeric id (24315896)
 * that appears nowhere in their UI, and NOT the carrier tracking number.
 *
 * Returns null for any URL that does not match, so a Boxtal naming change degrades to "no
 * reference shown" rather than to a fabricated one.
 */
export function shipmentRefFromLabelUrl(url: string | null | undefined): string | null {
  if (!url) return null
  const m = /\/shipping-label\/([A-Za-z0-9-]+)_/.exec(url)
  return m?.[1] ?? null
}

/**
 * Whether a STORED reference is the one an operator can actually find in Boxtal.
 *
 * 0.13.16 briefly stored the order payload's `shipmentId`, which turned out to be an internal
 * numeric id (24315896) that appears nowhere in Boxtal's UI. Those values are recognisable (all
 * digits) and are treated as absent, so the label-URL capture overwrites them on the next document
 * read instead of leaving a reference nobody can look up.
 */
export function isOperatorVisibleRef(value: unknown): boolean {
  return typeof value === "string" && value !== "" && !/^\d+$/.test(value)
}

/** Apply a document-created event: persist url-stripped descriptors, bump status. */
export async function applyDocumentCreated(
  ctx: LinkStoreCtx,
  boxtalOrderId: string,
  descriptors: Array<{ url?: string; type: string; format: string }>,
): Promise<{ applied: boolean }> {
  const row = await findByOrderId(ctx, boxtalOrderId)
  if (!row) return { applied: false }
  const documents = descriptors.map((d) => ({ type: d.type, format: d.format }))
  const current = (row.order_status as string | null) ?? null
  const next = current === "CANCELLED" ? "CANCELLED" : "CONFIRMED"
  // The URLs are stripped before storage (they are short-lived signed links), but the label's
  // name carries Boxtal's shipment reference — capture it on the way past, once.
  const ref = isOperatorVisibleRef(row.boxtal_shipment_ref)
    ? null
    : (descriptors.map((d) => shipmentRefFromLabelUrl(d.url)).find((r) => r != null) ?? null)
  await ctx.db.update("shipment", String(row.id), {
    documents,
    order_status: next,
    ...(ref ? { boxtal_shipment_ref: ref } : {}),
  })
  return { applied: true }
}
