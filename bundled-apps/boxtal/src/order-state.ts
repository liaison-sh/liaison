// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-ORDER prep state (`prep_order_state`), keyed by `order_key`.
//
// The prep worklist used to be keyed by `document_ref` (the issued invoice), which meant an order
// with no invoice could not carry ANY operator state: it could not be excluded, could not be put on
// hold, could not be validated, because there was no row to hang the flag on. The rework makes the
// ORDER the row identity and leaves the per-document tables (`prep_meta`, `prep_quote`,
// `prep_state`) describing the ANCHOR document they always described.
//
//   order_key = `so:<numeric shopify order id>`   an order row
//             | `doc:<document id>`               an order-less row anchored on an app-issued proforma
//             | `pending:<token>`                 an order-less row whose proforma awaits approval
//
// FIRST-WRITE SEEDING. Legacy rows carry `prep_state.validated` / `prep_state.excluded` against the
// anchor document. Those flags are real operator decisions, so the FIRST write that creates an
// order-state row (whatever the write is: a category change, an exclusion, a status set) seeds
// `status` and `excluded` from the legacy flags BEFORE applying its own patch. Without that, an
// unrelated first write would silently clear a row the operator had already validated.

import { ToolError } from "@liaison/app-sdk"
import type { AddressChoiceRecord } from "./address-check"
import type { BoxtalToolCtx } from "./ctx"
import type { PrepCategory } from "./customs"
import { isUniqueViolation } from "./db-errors"

/** One status per row, shown on the whole row (see the charter's whole-row tint rule). */
export type PrepStatus = "to_prepare" | "validated" | "on_hold"

export const PREP_STATUSES: readonly PrepStatus[] = ["to_prepare", "validated", "on_hold"]

export function isPrepStatus(v: unknown): v is PrepStatus {
  return typeof v === "string" && (PREP_STATUSES as readonly string[]).includes(v)
}

/** Structured recipient carried by an order-less row (no Shopify order to read it from). */
export interface PrepRecipient {
  name?: string | null
  company?: string | null
  email?: string | null
  phone?: string | null
  street?: string | null
  city?: string | null
  postalCode?: string | null
  countryIsoCode?: string | null
  /** State/province code. Only checked for completeness on a country that requires it (US/CA,
   *  address.ts's `stateRequired`) -- a Boxtal create hard-fails on a US/CA label without one. */
  state?: string | null
}

/** One physical item on an order-less row (the proforma line source). */
export interface PrepOrderItem {
  external_id?: string | null
  product_source?: string | null
  name: string
  quantity: number
  hs_code?: string | null
  customs_description?: string | null
  country_of_origin?: string | null
  unit_price_minor?: number | null
  currency?: string | null
}

export interface PrepOrderStateRow {
  order_key: string
  shopify_order_id?: string | null
  status?: PrepStatus | null
  status_note?: string | null
  status_changed_at?: string | null
  category?: PrepCategory | null
  excluded?: boolean | null
  /** The app-issued proforma that anchors this row while the category is repair/gift. */
  proforma_document_ref?: string | null
  /** Set instead when the proforma issue came back `pending_approval`. */
  proforma_pending_approval_id?: string | null
  proforma_requested_at?: string | null
  recipient?: PrepRecipient | null
  items?: PrepOrderItem[] | null
  /** A person's pick between the order's address and the customer's verified one, when they
   *  differ (prep_set_address_choice, address-check.ts). */
  address_choice?: AddressChoiceRecord | null
  /** Written by the kernel's DDL on every app table; never declared in the manifest schema. */
  created_at?: string | null
  proforma_number?: string | null
}

/** The legacy per-document flags this module seeds from. */
export interface LegacyPrepStateRow {
  document_ref: string
  category?: PrepCategory | null
  excluded?: boolean | null
  validated?: boolean | null
  validated_at?: string | null
  selected_offer_code?: string | null
}

// ── order_key helpers ────────────────────────────────────────────────────────

export type OrderKeyKind = "order" | "document" | "pending"

export function orderKeyForShopifyOrder(shopifyOrderId: string | number): string {
  return `so:${numericOrderId(shopifyOrderId) ?? String(shopifyOrderId)}`
}

export function orderKeyForDocument(documentId: string): string {
  return `doc:${documentId}`
}

export function orderKeyForPendingProforma(token: string): string {
  return `pending:${token}`
}

export function parseOrderKey(key: string): { kind: OrderKeyKind; id: string } | null {
  if (typeof key !== "string") return null
  const i = key.indexOf(":")
  if (i <= 0) return null
  const prefix = key.slice(0, i)
  const id = key.slice(i + 1)
  if (id === "") return null
  if (prefix === "so") return { kind: "order", id }
  if (prefix === "doc") return { kind: "document", id }
  if (prefix === "pending") return { kind: "pending", id }
  return null
}

/** Numeric Shopify order id out of a gid or a bare number; null when neither. */
export function numericOrderId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw)
  if (typeof raw !== "string" || raw === "") return null
  const m = raw.match(/(\d+)\s*$/)
  return m ? m[1]! : null
}

// ── reads ────────────────────────────────────────────────────────────────────

type StoredOrderState = PrepOrderStateRow & { id: string }

/** Every order-state row, keyed by `order_key`. Mirrors prep.ts's loadByDocumentRef bound (the db
 *  bridge has no IN support, so a full scan then a client-side index is the established pattern). */
export async function loadOrderStates(ctx: BoxtalToolCtx): Promise<Map<string, StoredOrderState>> {
  const rows = (await ctx.db.findMany("prep_order_state", { limit: 1000 })) as StoredOrderState[]
  const out = new Map<string, StoredOrderState>()
  for (const r of rows) if (r.order_key) out.set(r.order_key, r)
  return out
}

export async function getOrderState(
  ctx: BoxtalToolCtx,
  orderKey: string,
): Promise<StoredOrderState | undefined> {
  const rows = (await ctx.db.findMany("prep_order_state", {
    where: { order_key: orderKey },
    limit: 1,
  })) as StoredOrderState[]
  return rows[0]
}

/**
 * The legacy `prep_state` row that an order_key's flags should be seeded from: the row keyed by the
 * order's CURRENT anchor document. `doc:` keys anchor on themselves; `so:` keys resolve their anchor
 * through `prep_meta.shopify_order_id` (what the pre-rework worklist wrote), unless the caller
 * already knows the anchor and passes it.
 */
export async function legacyStateForOrderKey(
  ctx: BoxtalToolCtx,
  orderKey: string,
  anchorRef?: string | null,
): Promise<LegacyPrepStateRow | undefined> {
  let ref = anchorRef ?? null
  if (!ref) {
    const parsed = parseOrderKey(orderKey)
    if (!parsed) return undefined
    if (parsed.kind === "document") {
      ref = parsed.id
    } else if (parsed.kind === "order") {
      const metas = (await ctx.db.findMany("prep_meta", {
        where: { shopify_order_id: parsed.id },
        limit: 5,
      })) as Array<{ document_ref?: string | null }>
      ref = metas.find((m) => m.document_ref)?.document_ref ?? null
    }
  }
  if (!ref) return undefined
  const rows = (await ctx.db.findMany("prep_state", {
    where: { document_ref: ref },
    limit: 1,
  })) as LegacyPrepStateRow[]
  return rows[0]
}

// ── derived reads (the two flags the whole grid keys off) ────────────────────

/** The row's status: the order-state row when it exists, else the legacy validated flag. */
export function effectiveStatus(
  orderState: PrepOrderStateRow | undefined | null,
  legacy?: LegacyPrepStateRow | null,
): PrepStatus {
  if (orderState && isPrepStatus(orderState.status)) return orderState.status
  if (orderState) return "to_prepare"
  return legacy?.validated ? "validated" : "to_prepare"
}

/** The row's exclusion: the order-state row when it exists, else the legacy per-document flag. */
export function isExcluded(
  orderState: PrepOrderStateRow | undefined | null,
  legacy?: LegacyPrepStateRow | null,
): boolean {
  if (orderState) return Boolean(orderState.excluded)
  return Boolean(legacy?.excluded)
}

// ── write ────────────────────────────────────────────────────────────────────

export interface UpsertOrderStateOptions {
  /** The row's current anchor document, when the caller already knows it (saves a prep_meta read). */
  anchorRef?: string | null
  /** Stamped on creation so the scan can join order rows without re-parsing the key. */
  shopifyOrderId?: string | null
}

/**
 * Create or patch the order-state row for `orderKey`.
 *
 * On CREATE the legacy per-document flags are seeded first, so the very first write against a row
 * the operator had already validated or excluded under the old per-document keying keeps that
 * decision instead of resetting it to the schema defaults.
 */
export async function upsertPrepOrderState(
  ctx: BoxtalToolCtx,
  orderKey: string,
  patch: Partial<PrepOrderStateRow>,
  opts: UpsertOrderStateOptions = {},
): Promise<PrepOrderStateRow> {
  const existing = await getOrderState(ctx, orderKey)
  if (existing) {
    const merged = { ...existing, ...patch }
    await ctx.db.update("prep_order_state", existing.id, { ...patch })
    return merged
  }
  const legacy = await legacyStateForOrderKey(ctx, orderKey, opts.anchorRef)
  const parsed = parseOrderKey(orderKey)
  const base: PrepOrderStateRow = {
    order_key: orderKey,
    shopify_order_id:
      opts.shopifyOrderId ?? (parsed?.kind === "order" ? parsed.id : null),
    status: effectiveStatus(null, legacy),
    category: legacy?.category ?? "sale",
    excluded: isExcluded(null, legacy),
  }
  const row = { ...base, ...patch }
  try {
    await ctx.db.insert("prep_order_state", { ...row })
  } catch (err) {
    // `prep_order_state` is UNIQUE on order_key and this is a read-then-insert, so two FIRST writes
    // for the same row (two operators, or a row action racing the grid's own 5 s poll) both see no
    // row and both insert. The loser gets a 23505 it has nothing to say about, and the operator's
    // click fails on a race that has already converged. Re-read the winner and apply the patch as
    // an update instead (same shape as setLastSyncAt / saveDraftOverride).
    if (!isUniqueViolation(err)) throw err
    const winner = await getOrderState(ctx, orderKey)
    if (!winner) throw err // genuinely gone: not a recoverable race, surface the original error
    await ctx.db.update("prep_order_state", winner.id, { ...patch })
    return { ...winner, ...patch }
  }
  return row
}

// ── prep_set_status ──────────────────────────────────────────────────────────

export interface PrepSetStatusInput {
  /** The row key. A caller holding only the invoice id passes `document_ref` instead. */
  order_key?: string
  document_ref?: string
  status: PrepStatus
  note?: string | null
}

/**
 * Set the row's single status: To prepare / Validated / On hold.
 *
 * `On hold` is a warehouse fact (waiting on stock, on a customer answer, on a repair), so it lives
 * here and not in Shopify tags: it must be settable on a row with no invoice and no document, and it
 * must disable Ship without touching the store. The change timestamp is bumped only when the status
 * actually CHANGES, so "validated three weeks ago" stays visible through unrelated rewrites.
 */
export async function prepSetStatus(
  ctx: BoxtalToolCtx,
  input: PrepSetStatusInput,
): Promise<PrepOrderStateRow> {
  if (!isPrepStatus(input?.status)) {
    throw new ToolError(
      `Unknown prep status "${String(input?.status)}". Use one of: ${PREP_STATUSES.join(", ")}.`,
      { code: "invalid_status", retryable: false },
    )
  }
  const orderKey =
    input.order_key ??
    (input.document_ref ? await orderKeyForDocumentRef(ctx, input.document_ref) : undefined)
  if (typeof orderKey !== "string" || !parseOrderKey(orderKey)) {
    throw new ToolError(
      `"${String(orderKey)}" is not a prep row key. Expected so:<order id>, doc:<document id> or pending:<token>.`,
      { code: "invalid_order_key", retryable: false },
    )
  }
  const existing = await getOrderState(ctx, orderKey)
  const changed = !existing || existing.status !== input.status
  const patch: Partial<PrepOrderStateRow> = {
    status: input.status,
    ...(changed ? { status_changed_at: new Date().toISOString() } : {}),
    ...(input.note !== undefined ? { status_note: input.note ?? null } : {}),
  }
  return upsertPrepOrderState(ctx, orderKey, patch)
}

// ── prep_set_validated (legacy alias) ────────────────────────────────────────

export interface PrepSetValidatedInput {
  /** The invoice id of the row, as the pre-rework tool took it. */
  document_ref?: string
  /** The new key, accepted so an agent that already has one does not have to go back to a document. */
  order_key?: string
  validated: boolean
}

/** Resolve the order_key a document_ref belongs to: its linked Shopify order when one is known,
 *  else the document itself (an order-less proforma row). */
export async function orderKeyForDocumentRef(
  ctx: BoxtalToolCtx,
  documentRef: string,
): Promise<string> {
  const metas = (await ctx.db.findMany("prep_meta", {
    where: { document_ref: documentRef },
    limit: 1,
  })) as Array<{ shopify_order_id?: string | null }>
  const cached = numericOrderId(metas[0]?.shopify_order_id)
  if (cached) return orderKeyForShopifyOrder(cached)
  // prep_meta is only written by a sync pass, so a document the worklist has never synced needs the
  // authoritative answer: the document itself carries the order it bills.
  //
  // A FAILED read is not an answer. Falling through to `doc:<ref>` on a failure minted a SECOND
  // identity for a row that already exists as `so:<order id>`: the scan lists every `doc:` state row
  // as an order-less row, so the grid grew a duplicate row while the real row kept its old flags
  // (an exclude appeared to do nothing, and the two keys held divergent status and category for the
  // same parcel). So: `doc:` only when invoicing ANSWERED and reported no order behind the document.
  let env: Awaited<ReturnType<BoxtalToolCtx["executeTool"]>>
  try {
    env = await ctx.executeTool("invoicing:documents_get", { id: documentRef })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    ctx.logger?.warn?.("prep: documents_get threw while resolving an order key", {
      document_ref: documentRef,
      err: message,
    })
    throw new ToolError(
      `Could not tell which order document ${documentRef} belongs to: ${message}. Try again in a moment.`,
      { code: "order_key_unresolved", retryable: true },
    )
  }
  if (env.status !== "completed") {
    const message = env.status === "error" ? env.error.message : "the read is awaiting approval"
    ctx.logger?.warn?.("prep: documents_get did not complete while resolving an order key", {
      document_ref: documentRef,
      status: env.status,
      err: message,
    })
    throw new ToolError(
      `Could not tell which order document ${documentRef} belongs to: ${message}. Try again in a moment.`,
      { code: "order_key_unresolved", retryable: true },
    )
  }
  // A completed read that carries no document means invoicing knows nothing by this reference. That
  // is not an order-less document: writing `doc:<ref>` for it minted a phantom row.
  const found = env.result as { id?: unknown; shopify_order_id?: string | null } | null
  if (!found || typeof found !== "object") {
    throw new ToolError(
      `No invoicing document matches "${documentRef}". Pass the document's id or number as shown by invoicing__documents_search, or the row's order_key.`,
      { code: "document_not_found", retryable: false },
    )
  }
  const live = numericOrderId(found.shopify_order_id)
  if (live) return orderKeyForShopifyOrder(live)
  // Answered, and there is no order behind it: an order-less document is a legitimate row of its own.
  // Keyed by the document's own id, so a reference given as its number lands on the same row.
  return orderKeyForDocument(typeof found.id === "string" && found.id ? found.id : documentRef)
}

/**
 * The pre-rework validated checkbox, kept as an ALIAS onto the status enum so an agent (or a stale
 * UI bundle) that still calls it lands on the same single status field. true -> validated,
 * false -> to_prepare. Never sets or clears `on_hold`.
 */
export async function prepSetValidated(
  ctx: BoxtalToolCtx,
  input: PrepSetValidatedInput,
): Promise<PrepOrderStateRow> {
  const key =
    input.order_key ??
    (input.document_ref ? await orderKeyForDocumentRef(ctx, input.document_ref) : null)
  if (!key) {
    throw new ToolError("prep_set_validated needs an order_key or a document_ref.", {
      code: "invalid_order_key",
      retryable: false,
    })
  }
  return prepSetStatus(ctx, {
    order_key: key,
    status: input.validated ? "validated" : "to_prepare",
  })
}

// ── prep_exclude / prep_restore ──────────────────────────────────────────────

export interface PrepExcludeInput {
  order_key?: string
  /** Accepted for back-compat with the per-document keying. */
  document_ref?: string
}

async function resolveExclusionKey(ctx: BoxtalToolCtx, input: PrepExcludeInput): Promise<string> {
  if (input.order_key && parseOrderKey(input.order_key)) return input.order_key
  if (input.document_ref) return orderKeyForDocumentRef(ctx, input.document_ref)
  throw new ToolError("Pass the row's order_key (so:<order id> / doc:<document id>).", {
    code: "invalid_order_key",
    retryable: false,
  })
}

export async function prepExclude(
  ctx: BoxtalToolCtx,
  input: PrepExcludeInput,
): Promise<PrepOrderStateRow> {
  return upsertPrepOrderState(ctx, await resolveExclusionKey(ctx, input), { excluded: true })
}

export async function prepRestore(
  ctx: BoxtalToolCtx,
  input: PrepExcludeInput,
): Promise<PrepOrderStateRow> {
  return upsertPrepOrderState(ctx, await resolveExclusionKey(ctx, input), { excluded: false })
}

/**
 * The excluded set for the whole worklist, as order keys. Legacy per-document exclusions are read
 * through for anchors that never got an order-state row, so a row excluded before the rework stays
 * excluded after it.
 */
export async function excludedOrderKeys(ctx: BoxtalToolCtx): Promise<Set<string>> {
  const [states, legacy, metas] = await Promise.all([
    loadOrderStates(ctx),
    ctx.db.findMany("prep_state", { limit: 1000 }) as Promise<LegacyPrepStateRow[]>,
    ctx.db.findMany("prep_meta", { limit: 1000 }) as Promise<
      Array<{ document_ref: string; shopify_order_id?: string | null }>
    >,
  ])
  const out = new Set<string>()
  const keyByDocument = new Map<string, string>()
  for (const m of metas) {
    const oid = numericOrderId(m.shopify_order_id)
    keyByDocument.set(m.document_ref, oid ? orderKeyForShopifyOrder(oid) : orderKeyForDocument(m.document_ref))
  }
  for (const l of legacy) {
    if (!l.excluded) continue
    const key = keyByDocument.get(l.document_ref) ?? orderKeyForDocument(l.document_ref)
    // An order-state row is authoritative: it may have restored a legacy exclusion.
    if (!states.has(key)) out.add(key)
  }
  for (const [key, s] of states) if (s.excluded) out.add(key)
  return out
}
