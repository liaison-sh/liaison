// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `documents_link_shopify_orders`: link issued documents that name their Shopify order by NUMBER
// only (`shopify_order_number`, e.g. made by hand or imported from an earlier tool) to the order's
// numeric id (`shopify_order_id`), the key every order-aware read uses: the buyer invoices API, the
// order's credit notes and refunds, the duplicate-invoice check of the order webhook.
//
// The order name comes from `shopify_order_number` (basis `order_number`). A document imported from
// an earlier tool (`external_refs.import_source`) with its legal original recorded and no order
// number may instead use its own all-digits number as the name "#<number>" (basis
// `number_as_order_name`); an imported number with anything but digits is reported `not_eligible`.
// On that basis a link also records the order's name in `shopify_order_number`.
//
// A link is written only when it is proven, never guessed:
//   - the document's issuer profile is mapped to a shop (`issuer_profiles.shopify_shop_id`) and the
//     connected shop the order was read from IS that shop;
//   - exactly one order in that shop carries the document's order name;
//   - the order's email equals the document's buyer email (or, when the document has none, its
//     linked contact's email), compared trimmed and lower-cased;
//   - when both the order and the document's contact carry a Shopify customer id, they are equal;
//   - no other LIVE document already carries that order id (an invoice and its credit note naming
//     the same order in the same run are linked together). A replacement invoice links next to the
//     documents it replaced: when every other carrier is cancelled or voided, a fully credited
//     invoice, or a credit note of such an invoice, the live invoice is the order's one invoice.
// Anything else is reported with its reason and left as it is.
//
// What it writes: `shopify_order_id` (and, on the number basis, `shopify_order_number`) and one
// `shopify_order_linked` lifecycle entry, nothing else.
// The column is a link, not part of the legal document: it is outside the issued-document freeze
// (documents_update's frozen fields and the legal-original locked fields), the PDF is not
// re-rendered, and the number, buyer, lines and totals are untouched.
//
// Idempotent: a linked document is no longer a candidate. A reported one stays a candidate, so a
// later run (after a fix in Shopify or on the document) retries it; `cursor` pages past it within
// one sweep. `dry_run` (the default) reads Shopify and reports, writing nothing.

type Row = Record<string, unknown>

export const SHOPIFY_ORDER_LINKED_EVENT = "shopify_order_linked"
export const LINK_DEFAULT_LIMIT = 20
export const LINK_MAX_LIMIT = 40
const SCAN_PAGE = 500
const DEAD_STATUSES = new Set(["voided", "cancelled"])

/** Legal documents only; quotes, proformas and purchase orders keep their own order handling. */
const LINKABLE_TYPES = new Set(["invoice", "credit_note"])
const NOT_LINKABLE_STATUSES = new Set(["draft", "pending_approval", "voided", "cancelled"])

export interface LinkOrdersEnvelope {
  status: "completed" | "pending_approval" | "error"
  result?: unknown
  error?: { code: string; message: string; retryable?: boolean }
}

export interface LinkOrdersCtx {
  db: {
    findMany(
      entity: string,
      opts?: {
        where?: Record<string, unknown>
        orderBy?: Record<string, "asc" | "desc">
        limit?: number
        offset?: number
      },
    ): Promise<unknown[]>
    update(entity: string, id: string, data: Record<string, unknown>): Promise<unknown>
  }
  executeTool(target: string, args: Record<string, unknown>): Promise<LinkOrdersEnvelope>
}

export interface LinkOrdersInput {
  dry_run?: boolean | null
  limit?: number | null
  cursor?: string | null
}

export type LinkOutcome =
  | "linked"
  | "would_link"
  | "issuer_has_no_shop"
  | "lookup_failed"
  | "shop_unverified"
  | "shop_mismatch"
  | "order_not_found"
  | "order_ambiguous"
  | "order_already_linked"
  | "document_email_missing"
  | "order_email_missing"
  | "email_mismatch"
  | "contact_unreadable"
  | "customer_mismatch"
  | "not_eligible"

/** How the order name was found: the document's recorded order number, or (an imported legacy
 *  document with no order number) its own all-digits number read as the order name "#<number>". */
export type LinkBasis = "order_number" | "number_as_order_name"

export interface LinkResultRow {
  document_id: string
  number: string | null
  order_name: string | null
  basis: LinkBasis
  outcome: LinkOutcome
  shopify_order_id?: string
  detail?: string
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t === "" ? null : t
}

function refsOf(v: unknown): Row {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Row
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v) as unknown
      if (p && typeof p === "object" && !Array.isArray(p)) return p as Row
    } catch {
      // not JSON
    }
  }
  return {}
}

/** Imported from an earlier tool (`external_refs.import_source`) with its legal original recorded:
 *  the only documents whose own number may stand for their Shopify order's name. */
function importedLegacy(d: Row): boolean {
  return str(d.legal_original_id) !== null && str(refsOf(d.external_refs).import_source) !== null
}

function absMinor(v: unknown): bigint {
  try {
    const n = BigInt(typeof v === "number" ? Math.round(v) : String(v ?? "0") || "0")
    return n < 0n ? -n : n
  } catch {
    return 0n
  }
}

/**
 * The documents that no longer bill an order: cancelled or voided ones, invoices their issued
 * credit notes cover in full, and the credit notes of those invoices. A replacement invoice may
 * carry the order next to them.
 */
function replacedDocuments(docs: Row[]): Set<string> {
  const byId = new Map(docs.map((d) => [String(d.id), d]))
  const credited = new Map<string, bigint>()
  for (const d of docs) {
    if (d.type !== "credit_note" || NOT_LINKABLE_STATUSES.has(String(d.status))) continue
    const orig = str(d.original_document_id) ?? str(refsOf(d.external_refs).original_document_id)
    if (orig) credited.set(orig, (credited.get(orig) ?? 0n) + absMinor(d.grand_total_minor))
  }
  const dead = new Set<string>()
  for (const d of docs) {
    const id = String(d.id)
    if (DEAD_STATUSES.has(String(d.status))) dead.add(id)
    else if (d.type === "invoice") {
      const total = absMinor(d.grand_total_minor)
      if (d.payment_status === "credited" || (total > 0n && (credited.get(id) ?? 0n) >= total))
        dead.add(id)
    }
  }
  for (const d of docs) {
    if (d.type !== "credit_note") continue
    const orig = str(d.original_document_id) ?? str(refsOf(d.external_refs).original_document_id)
    if (orig && dead.has(orig) && byId.has(orig)) dead.add(String(d.id))
  }
  return dead
}

const lowerEmail = (v: unknown): string | null => str(v)?.toLowerCase() ?? null
const lowerDomain = (v: unknown): string | null => str(v)?.toLowerCase() ?? null

/** Numeric id of a Shopify gid (or of a bare numeric id). */
function numericId(v: unknown, kind: "Order" | "Customer"): string | null {
  const s = str(v)
  if (!s) return null
  const m = new RegExp(`^(?:gid://shopify/${kind}/)?(\\d+)$`).exec(s)
  return m ? (m[1] as string) : null
}

function clampLimit(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : LINK_DEFAULT_LIMIT
  return Math.min(Math.max(n, 1), LINK_MAX_LIMIT)
}

/** The names a document's order number can be written as in Shopify ("1001" is "#1001"). */
function wantedNames(orderNumber: string): string[] {
  const n = orderNumber.trim()
  if (n.startsWith("#")) return [n.toLowerCase()]
  return [`#${n}`.toLowerCase(), n.toLowerCase()]
}

function searchQuery(orderNumber: string): string {
  const n = orderNumber.trim().replace(/["\\]/g, " ").replace(/\s+/g, " ")
  if (/^#?\d+$/.test(n)) return `name:#${n.replace(/^#/, "")}`
  return `name:"${n}"`
}

interface OrderLookup {
  ok: boolean
  code?: string
  shopDomain: string | null
  hits: Array<{ id: string | null; name: string; email: string | null; customerId: string | null }>
}

function parseLookup(env: LinkOrdersEnvelope): OrderLookup {
  if (env?.status !== "completed") {
    return {
      ok: false,
      code: env?.status === "error" ? String(env.error?.code ?? "error") : String(env?.status),
      shopDomain: null,
      hits: [],
    }
  }
  const result = (env.result ?? {}) as { results?: unknown; shopDomain?: unknown }
  const raw = Array.isArray(result.results) ? (result.results as Row[]) : []
  return {
    ok: true,
    shopDomain: lowerDomain(result.shopDomain),
    hits: raw.map((h) => {
      const a = (h.attributes ?? {}) as Row
      const customer = (a.customer ?? null) as Row | null
      return {
        id: numericId(h.id, "Order"),
        name: String(h.title ?? h.name ?? ""),
        email: lowerEmail(a.email) ?? lowerEmail(customer?.email),
        customerId: numericId(customer?.id, "Customer"),
      }
    }),
  }
}

async function allRows(ctx: LinkOrdersCtx, entity: string): Promise<Row[]> {
  const out: Row[] = []
  let offset = 0
  for (;;) {
    const page = (await ctx.db.findMany(entity, {
      orderBy: { id: "asc" },
      limit: SCAN_PAGE,
      offset,
    })) as Row[]
    if (page.length === 0) break
    out.push(...page)
    offset += page.length
    if (page.length < SCAN_PAGE) break
  }
  return out
}

export async function linkShopifyOrders(
  ctx: LinkOrdersCtx,
  input: LinkOrdersInput = {},
): Promise<Row> {
  const dryRun = input?.dry_run !== false
  const limit = clampLimit(input?.limit)
  const cursor = str(input?.cursor)

  const shopOf = new Map<string, string | null>()
  for (const p of await allRows(ctx, "issuer_profiles")) {
    shopOf.set(String(p.id), lowerDomain(p.shopify_shop_id))
  }

  const docs = await allRows(ctx, "documents")
  const replaced = replacedDocuments(docs)
  // Which documents already carry each order id.
  const carriers = new Map<string, Set<string>>()
  for (const d of docs) {
    const orderId = str(d.shopify_order_id)
    if (!orderId) continue
    const set = carriers.get(orderId) ?? new Set<string>()
    set.add(String(d.id))
    carriers.set(orderId, set)
  }
  const candidates = docs
    .filter(
      (d) =>
        LINKABLE_TYPES.has(String(d.type)) &&
        !NOT_LINKABLE_STATUSES.has(String(d.status)) &&
        str(d.number) !== null &&
        str(d.shopify_order_id) === null &&
        (str(d.shopify_order_number) !== null || importedLegacy(d)),
    )
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0))
    .filter((d) => !cursor || String(d.id) > cursor)
  const batch = candidates.slice(0, limit)

  const lookups = new Map<string, OrderLookup>()
  const contacts = new Map<
    string,
    { ok: boolean; email: string | null; shopifyId: string | null }
  >()
  const linkedHere = new Set<string>()
  const results: LinkResultRow[] = []

  const readContact = async (contactId: string) => {
    const cached = contacts.get(contactId)
    if (cached) return cached
    let entry = { ok: false, email: null as string | null, shopifyId: null as string | null }
    try {
      const env = await ctx.executeTool("kernel:contacts_read", { contactId })
      if (env?.status === "completed") {
        const c = ((env.result ?? {}) as { contact?: Row }).contact ?? {}
        const ext = (c.externalIds ?? {}) as Row
        entry = {
          ok: true,
          email: lowerEmail(c.email),
          shopifyId: numericId(ext.shopify, "Customer"),
        }
      }
    } catch {
      // unreadable: reported below
    }
    contacts.set(contactId, entry)
    return entry
  }

  for (const d of batch) {
    const id = String(d.id)
    const recorded = str(d.shopify_order_number)
    const number = str(d.number) as string
    const basis: LinkBasis = recorded ? "order_number" : "number_as_order_name"
    // Only a plain all-digits number reads as an order name; "1001-2" or "Repair 12" never do.
    const orderNumber = recorded ?? (/^\d+$/.test(number) ? `#${number}` : null)
    const base = { document_id: id, number, order_name: orderNumber, basis }
    const report = (outcome: LinkOutcome, extra: Partial<LinkResultRow> = {}) =>
      results.push({ ...base, outcome, ...extra })
    if (!orderNumber) {
      report("not_eligible")
      continue
    }

    const shop = shopOf.get(String(d.issuer_profile_id)) ?? null
    if (!shop) {
      report("issuer_has_no_shop")
      continue
    }

    const key = `${shop}\n${orderNumber.toLowerCase()}`
    let lookup = lookups.get(key)
    if (!lookup) {
      try {
        lookup = parseLookup(
          await ctx.executeTool("shopify:orders_search", {
            query: searchQuery(orderNumber),
            limit: 10,
          }),
        )
      } catch (err) {
        lookup = {
          ok: false,
          code: String((err as { code?: unknown } | null)?.code ?? "error"),
          shopDomain: null,
          hits: [],
        }
      }
      // One read per order name and run; a failed one is retried by the next run (the document
      // stays a candidate).
      lookups.set(key, lookup)
    }
    if (!lookup.ok) {
      report("lookup_failed", { detail: lookup.code })
      continue
    }
    if (!lookup.shopDomain) {
      report("shop_unverified")
      continue
    }
    if (lookup.shopDomain !== shop) {
      report("shop_mismatch", { detail: lookup.shopDomain })
      continue
    }
    const names = wantedNames(orderNumber)
    const exact = lookup.hits.filter((h) => h.id && names.includes(h.name.trim().toLowerCase()))
    if (exact.length === 0) {
      report("order_not_found")
      continue
    }
    if (new Set(exact.map((h) => h.id)).size > 1) {
      report("order_ambiguous")
      continue
    }
    const order = exact[0] as (typeof exact)[number]
    const orderId = order.id as string

    const others = [...(carriers.get(orderId) ?? [])].filter((x) => !linkedHere.has(x))
    // A live replacement invoice links next to the documents it replaced (see the header).
    const replacement =
      d.type === "invoice" && !replaced.has(id) && others.every((x) => replaced.has(x))
    if (others.length > 0 && !replacement) {
      report("order_already_linked", { shopify_order_id: orderId })
      continue
    }

    const contactId = str(d.counterparty_contact_id)
    const contact = contactId ? await readContact(contactId) : null
    if (contactId && !contact?.ok) {
      report("contact_unreadable")
      continue
    }
    const docEmail = lowerEmail(d.counterparty_email) ?? contact?.email ?? null
    if (!docEmail) {
      report("document_email_missing")
      continue
    }
    if (!order.email) {
      report("order_email_missing")
      continue
    }
    if (order.email !== docEmail) {
      report("email_mismatch")
      continue
    }
    if (contact?.shopifyId && order.customerId && contact.shopifyId !== order.customerId) {
      report("customer_mismatch")
      continue
    }

    if (!dryRun) {
      const log = Array.isArray(d.lifecycle_log) ? (d.lifecycle_log as Row[]) : []
      await ctx.db.update("documents", id, {
        shopify_order_id: orderId,
        // The number basis also records the order's name, which the document lacked.
        ...(recorded ? {} : { shopify_order_number: order.name }),
        lifecycle_log: [
          ...log,
          {
            event: SHOPIFY_ORDER_LINKED_EVENT,
            ts: new Date().toISOString(),
            shopify_order_id: orderId,
            order_name: order.name,
            matched_on: "email",
            basis,
          },
        ],
      })
    }
    linkedHere.add(id)
    const set = carriers.get(orderId) ?? new Set<string>()
    set.add(id)
    carriers.set(orderId, set)
    report(dryRun ? "would_link" : "linked", { shopify_order_id: orderId })
  }

  const done = results.filter((r) => r.outcome === "linked" || r.outcome === "would_link").length
  const remaining = candidates.length - batch.length
  const last = batch[batch.length - 1]
  return {
    status: "ok",
    dry_run: dryRun,
    limit,
    linked: dryRun ? 0 : done,
    would_link: dryRun ? done : 0,
    reported: results.length - done,
    results,
    remaining,
    next_cursor: remaining > 0 && last ? String(last.id) : null,
    message:
      `${dryRun ? "Dry run, nothing written: " : ""}${done} document(s) ` +
      `${dryRun ? "would be linked" : "linked"} to their Shopify order, ` +
      `${results.length - done} reported with a reason and left unchanged` +
      (remaining > 0 ? `; ${remaining} more after this batch (pass next_cursor).` : "."),
  }
}
