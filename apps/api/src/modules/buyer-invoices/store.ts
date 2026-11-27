// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The data of the buyer invoices API: server keys, download links, and the documents of the
// sales a buyer matches. Every read of invoicing data is scoped to the key's org AND issuer
// profile in SQL; which sales a buyer sees is decided by `saleMatches` (match.ts) on the
// candidates read here, never by SQL alone.
//
// Keys and links are kernel tables on the privileged pool only (migration 0357): a request names
// no org, so its key is looked up first, by its 8-character prefix, then compared by hash in
// constant time.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { base32Token } from "~/lib/random-token"
import { type BuyerIdentity, saleMatches } from "./match"

const K = () => sql.raw(schemaRef("kernel"))

export const KEY_PREFIX = "linv_"
/** `linv_` + 32 base32 characters (160 random bits). */
export const KEY_RE = /^linv_[A-Z2-7]{32}$/
export const MAX_ACTIVE_KEYS = 2
export const LINK_TTL_MS = 5 * 60 * 1000

export function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex")
}

export interface BuyerKey {
  id: string
  orgId: string
  issuerProfileId: string
}

export interface BuyerKeyRow {
  id: string
  issuer_profile_id: string
  label: string
  key_prefix: string
  created_by: string
  created_at: string
  revoked_at: string | null
  last_used_at: string | null
}

// ── keys ────────────────────────────────────────────────────────────────

export class KeyLimitError extends Error {
  constructor() {
    super(`An issuer profile has at most ${MAX_ACTIVE_KEYS} active keys: revoke one first.`)
    this.name = "KeyLimitError"
  }
}

/** A new key for one issuer profile. The plaintext is returned once and never stored. */
export async function createBuyerKey(params: {
  orgId: string
  issuerProfileId: string
  label: string
  createdBy: string
}): Promise<{ id: string; key: string; prefix: string }> {
  const key = `${KEY_PREFIX}${base32Token(20)}`
  const prefix = key.slice(0, 8)
  const id = await withPrivilegedDb(params.orgId, "buyer-invoices-key-create", async (tx) => {
    // One profile's keys are created one at a time, so the limit cannot be passed by two at once.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`buyer-invoice-keys:${params.orgId}:${params.issuerProfileId}`}))`,
    )
    const [count] = extractRows<{ n: number }>(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM ${K()}.buyer_invoice_keys
         WHERE org_id = ${params.orgId}::uuid AND issuer_profile_id = ${params.issuerProfileId}::uuid
           AND revoked_at IS NULL`),
    )
    if ((count?.n ?? 0) >= MAX_ACTIVE_KEYS) throw new KeyLimitError()
    const [row] = extractRows<{ id: string }>(
      await tx.execute(sql`
        INSERT INTO ${K()}.buyer_invoice_keys
          (org_id, issuer_profile_id, label, key_prefix, key_hash, created_by)
        VALUES (${params.orgId}::uuid, ${params.issuerProfileId}::uuid, ${params.label},
                ${prefix}, ${sha256Hex(key)}, ${params.createdBy}::uuid)
        RETURNING id`),
    )
    return String(row?.id)
  })
  return { id, key, prefix }
}

export async function listBuyerKeys(
  orgId: string,
  issuerProfileId: string,
): Promise<BuyerKeyRow[]> {
  return withPrivilegedDb(orgId, "buyer-invoices-key-list", async (tx) =>
    extractRows<BuyerKeyRow>(
      await tx.execute(sql`
        SELECT id, issuer_profile_id, label, key_prefix, created_by, created_at, revoked_at,
               last_used_at
          FROM ${K()}.buyer_invoice_keys
         WHERE org_id = ${orgId}::uuid AND issuer_profile_id = ${issuerProfileId}::uuid
         ORDER BY created_at DESC`),
    ),
  )
}

/** Revoke a key of this org; its live links die with it. False when there was nothing to revoke. */
export async function revokeBuyerKey(
  orgId: string,
  keyId: string,
  revokedBy: string,
): Promise<{ issuerProfileId: string } | null> {
  return withPrivilegedDb(orgId, "buyer-invoices-key-revoke", async (tx) => {
    const [row] = extractRows<{ issuer_profile_id: string }>(
      await tx.execute(sql`
        UPDATE ${K()}.buyer_invoice_keys SET revoked_at = now(), revoked_by = ${revokedBy}::uuid
         WHERE org_id = ${orgId}::uuid AND id = ${keyId}::uuid AND revoked_at IS NULL
         RETURNING issuer_profile_id`),
    )
    if (!row) return null
    await tx.execute(sql`
      DELETE FROM ${K()}.buyer_invoice_links WHERE org_id = ${orgId}::uuid AND key_id = ${keyId}::uuid`)
    return { issuerProfileId: row.issuer_profile_id }
  })
}

/** The active key a bearer value names, or null (malformed, unknown or revoked: one answer). */
export async function authenticateBuyerKey(plaintext: string): Promise<BuyerKey | null> {
  if (!KEY_RE.test(plaintext)) return null
  const want = Buffer.from(sha256Hex(plaintext), "hex")
  const rows = await withSystemDb("buyer-invoices-key-lookup", async (db) =>
    extractRows<{ id: string; org_id: string; issuer_profile_id: string; key_hash: string }>(
      await db.execute(sql`
        SELECT id, org_id, issuer_profile_id, key_hash FROM ${K()}.buyer_invoice_keys
         WHERE key_prefix = ${plaintext.slice(0, 8)} AND revoked_at IS NULL`),
    ),
  )
  let found: BuyerKey | null = null
  for (const r of rows) {
    const have = Buffer.from(r.key_hash, "hex")
    // Every candidate is compared, in constant time, whatever an earlier one gave.
    if (have.length === want.length && timingSafeEqual(have, want) && !found) {
      found = { id: r.id, orgId: r.org_id, issuerProfileId: r.issuer_profile_id }
    }
  }
  return found
}

export async function touchBuyerKey(key: BuyerKey): Promise<void> {
  await withPrivilegedDb(key.orgId, "buyer-invoices-key-touch", (tx) =>
    tx.execute(sql`
      UPDATE ${K()}.buyer_invoice_keys SET last_used_at = now()
       WHERE id = ${key.id}::uuid AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`),
  )
}

/** The issuer profile exists in this org (a key is only ever created for one that does). */
export async function issuerProfileExists(
  orgId: string,
  issuerProfileId: string,
): Promise<boolean> {
  return withPrivilegedDb(orgId, "buyer-invoices-issuer-check", async (tx) => {
    const [row] = extractRows<{ ok: boolean }>(
      await tx.execute(sql`
        SELECT EXISTS (SELECT 1 FROM app_invoicing.issuer_profiles
                        WHERE org_id = ${orgId}::uuid AND id = ${issuerProfileId}::uuid) AS ok`),
    )
    return row?.ok === true
  })
}

// ── sales and documents ─────────────────────────────────────────────────

interface Candidate {
  /** `sale:<uuid>` for a recorded sale, `shopify:<order id>` for an invoice issued before. */
  key: string
  sale_id: string | null
  legacy_order_id: string | null
  stream: string
  ref: string
  name: string | null
  sold_on: string | null
  total_minor: string | null
  currency: string | null
  state: string
  email: string | null
  shopify_customer_id: string | null
  hub_user_id: string | null
}

export interface BuyerDocumentEntry {
  id: string | null
  kind: "invoice" | "credit_note"
  number: string | null
  issuedAt: string | null
  saleDate: string | null
  totalMinor: number | null
  currency: string | null
  status: "issued" | "paid" | "partially_credited" | "credited" | "refunded" | "pending"
  parentInvoiceId: string | null
  state: "issued" | "pending"
  source: { stream: string; ref: string; name: string | null }
}

function day(v: unknown): string | null {
  const s = v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null
  const m = s ? /^(\d{4}-\d{2}-\d{2})/.exec(s) : null
  return m ? (m[1] as string) : null
}

function minorNumber(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isSafeInteger(n) ? Math.abs(n) : null
}

/**
 * The sales of one issuer profile that could match `who`: recorded sales sharing any value, and
 * the Shopify invoices issued before sales were recorded (their identity: the document's email
 * and the contact's Shopify customer id). `saleMatches` then decides each one.
 */
async function matchingSales(key: BuyerKey, who: BuyerIdentity): Promise<Candidate[]> {
  const email = who.email ?? ""
  const shopify = who.shopifyCustomerId ?? ""
  const hub = who.hubUserId ?? ""
  const rows = await withPrivilegedDb(key.orgId, "buyer-invoices-sales", async (tx) =>
    extractRows<Candidate>(
      await tx.execute(sql`
        SELECT 'sale:' || s.id AS key, s.id::text AS sale_id, NULL::text AS legacy_order_id,
               s.stream, s.source_ref AS ref, s.source_name AS name, s.sold_on::text AS sold_on,
               s.total_minor::text AS total_minor, s.currency, s.state,
               s.buyer_email AS email, s.shopify_customer_id, s.hub_user_id
          FROM app_invoicing.sales s
         WHERE s.org_id = ${key.orgId}::uuid
           AND s.issuer_profile_id = ${key.issuerProfileId}::uuid
           AND s.state <> 'void'
           AND ((${email} <> '' AND s.buyer_email = ${email})
             OR (${shopify} <> '' AND s.shopify_customer_id = ${shopify})
             OR (${hub} <> '' AND s.hub_user_id = ${hub}))
        UNION ALL
        -- An earlier Shopify order: ONE identity over ALL its invoices, never only the ones that
        -- matched the request (a reissue with no customer id must not unlock a sibling that has
        -- one). Its emails and Shopify ids are aggregated; more than one of a kind is a conflict.
        SELECT 'shopify:' || o.shopify_order_id, NULL::text, o.shopify_order_id,
               'shopify', o.shopify_order_id, o.name, o.issued::text,
               NULL::text, NULL::text, 'issued',
               CASE WHEN cardinality(o.emails) = 1 THEN o.emails[1] END,
               CASE WHEN cardinality(o.shopify_ids) = 1 THEN o.shopify_ids[1]
                    WHEN cardinality(o.shopify_ids) > 1 THEN '<conflict>' END,
               NULL::text
          FROM (
            SELECT d.shopify_order_id, min(d.shopify_order_number) AS name,
                   min(d.issued_at) AS issued,
                   COALESCE(array_agg(DISTINCT lower(btrim(d.counterparty_email)))
                     FILTER (WHERE COALESCE(btrim(d.counterparty_email), '') <> ''), '{}') AS emails,
                   COALESCE(array_agg(DISTINCT regexp_replace(c.external_ids ->> 'shopify',
                                                              '^gid://shopify/Customer/', ''))
                     FILTER (WHERE COALESCE(c.external_ids ->> 'shopify', '') <> ''), '{}')
                     AS shopify_ids
              FROM app_invoicing.documents d
              LEFT JOIN ${K()}.contacts c
                ON c.id = d.counterparty_contact_id AND c.org_id = d.org_id
             WHERE d.org_id = ${key.orgId}::uuid
               AND d.issuer_profile_id = ${key.issuerProfileId}::uuid
               AND d.type = 'invoice'
               AND d.sale_id IS NULL
               AND d.shopify_order_id IS NOT NULL
               AND d.number IS NOT NULL
               AND d.shopify_order_id IN (
                 SELECT m.shopify_order_id FROM app_invoicing.documents m
                   LEFT JOIN ${K()}.contacts mc
                     ON mc.id = m.counterparty_contact_id AND mc.org_id = m.org_id
                  WHERE m.org_id = ${key.orgId}::uuid
                    AND m.issuer_profile_id = ${key.issuerProfileId}::uuid
                    AND m.type = 'invoice' AND m.sale_id IS NULL
                    AND m.shopify_order_id IS NOT NULL
                    AND ((${email} <> '' AND lower(btrim(m.counterparty_email)) = ${email})
                      OR (${shopify} <> '' AND regexp_replace(COALESCE(mc.external_ids ->> 'shopify', ''),
                                              '^gid://shopify/Customer/', '') = ${shopify})))
             GROUP BY d.shopify_order_id
          ) o
         ORDER BY 1`),
    ),
  )
  return rows.filter((r) =>
    saleMatches(who, {
      email: r.email,
      shopifyCustomerId: r.shopify_customer_id,
      hubUserId: r.hub_user_id,
    }),
  )
}

interface DocRow {
  id: string
  type: "invoice" | "credit_note"
  number: string
  status: string
  payment_status: string | null
  issued_at: unknown
  grand_total_minor: string
  currency: string
  original_document_id: string | null
  sale_key: string
  credited_minor: string | null
}

/** The issued invoices and credit notes of the sales given, of this key's issuer profile only. */
async function documentsOf(key: BuyerKey, sales: Candidate[]): Promise<DocRow[]> {
  const saleIds = sales.flatMap((s) => (s.sale_id ? [s.sale_id] : []))
  const orderIds = sales.flatMap((s) => (s.legacy_order_id ? [s.legacy_order_id] : []))
  if (!saleIds.length && !orderIds.length) return []
  const saleArr = `{${saleIds.join(",")}}`
  const orderArr = `{${orderIds.map((o) => `"${o.replace(/["\\]/g, "")}"`).join(",")}}`
  return withPrivilegedDb(key.orgId, "buyer-invoices-documents", async (tx) =>
    extractRows<DocRow>(
      await tx.execute(sql`
        WITH inv AS (
          SELECT d.*, CASE WHEN d.sale_id IS NOT NULL THEN 'sale:' || d.sale_id
                           ELSE 'shopify:' || d.shopify_order_id END AS sale_key
            FROM app_invoicing.documents d
           WHERE d.org_id = ${key.orgId}::uuid
             AND d.issuer_profile_id = ${key.issuerProfileId}::uuid
             AND d.type = 'invoice'
             AND d.number IS NOT NULL
             AND d.status NOT IN ('draft', 'pending_approval')
             AND (d.sale_id = ANY(${saleArr}::uuid[])
               OR (d.sale_id IS NULL AND d.shopify_order_id = ANY(${orderArr}::text[])))
        ), cn AS (
          SELECT c.*, inv.sale_key
            FROM app_invoicing.documents c
            JOIN inv ON inv.id = c.original_document_id
           WHERE c.org_id = ${key.orgId}::uuid
             AND c.issuer_profile_id = ${key.issuerProfileId}::uuid
             AND c.type = 'credit_note'
             AND c.number IS NOT NULL
             AND c.status NOT IN ('draft', 'pending_approval')
             AND c.internal_cancellation IS NOT TRUE
        )
        SELECT inv.id, inv.type, inv.number, inv.status, inv.payment_status, inv.issued_at,
               inv.grand_total_minor::text, inv.currency, inv.original_document_id, inv.sale_key,
               (SELECT sum(abs(cn.grand_total_minor))::text FROM cn
                 WHERE cn.original_document_id = inv.id) AS credited_minor
          FROM inv
        UNION ALL
        SELECT cn.id, cn.type, cn.number, cn.status, cn.payment_status, cn.issued_at,
               cn.grand_total_minor::text, cn.currency, cn.original_document_id, cn.sale_key,
               NULL::text
          FROM cn`),
    ),
  )
}

function invoiceStatus(d: DocRow): BuyerDocumentEntry["status"] {
  const total = minorNumber(d.grand_total_minor) ?? 0
  const credited = minorNumber(d.credited_minor) ?? 0
  if (credited > 0 && credited >= total) return "credited"
  if (credited > 0) return "partially_credited"
  return d.payment_status === "paid" || d.status === "paid" ? "paid" : "issued"
}

function creditNoteStatus(d: DocRow): BuyerDocumentEntry["status"] {
  return d.status === "refunded" || d.payment_status === "refunded" || d.payment_status === "paid"
    ? "refunded"
    : "issued"
}

/** The entries a buyer sees: issued documents of its matching sales, then pending sales. Newest
 *  sale date first, then issue date; ties by number, so pages are stable. */
export async function listBuyerDocuments(
  key: BuyerKey,
  who: BuyerIdentity,
): Promise<BuyerDocumentEntry[]> {
  const sales = await matchingSales(key, who)
  const docs = await documentsOf(key, sales)
  const byKey = new Map(sales.map((s) => [s.key, s]))
  const out: BuyerDocumentEntry[] = []
  const withDocs = new Set<string>()
  for (const d of docs) {
    const sale = byKey.get(d.sale_key)
    if (!sale) continue
    withDocs.add(sale.key)
    out.push({
      id: d.id,
      kind: d.type,
      number: d.number,
      issuedAt: day(d.issued_at),
      saleDate: day(sale.sold_on) ?? day(d.issued_at),
      totalMinor: minorNumber(d.grand_total_minor),
      currency: d.currency ? d.currency.toUpperCase() : null,
      status: d.type === "invoice" ? invoiceStatus(d) : creditNoteStatus(d),
      parentInvoiceId: d.type === "credit_note" ? d.original_document_id : null,
      state: "issued",
      source: { stream: sale.stream, ref: sale.ref, name: sale.name },
    })
  }
  for (const s of sales) {
    if (withDocs.has(s.key) || s.state !== "pending") continue
    // A sale that will never be invoiced (zero total) is not shown.
    if (s.total_minor !== null && minorNumber(s.total_minor) === 0) continue
    out.push({
      id: null,
      kind: "invoice",
      number: null,
      issuedAt: null,
      saleDate: day(s.sold_on),
      totalMinor: minorNumber(s.total_minor),
      currency: s.currency ? s.currency.toUpperCase() : null,
      status: "pending",
      parentInvoiceId: null,
      state: "pending",
      source: { stream: s.stream, ref: s.ref, name: s.name },
    })
  }
  out.sort(
    (a, b) =>
      (b.saleDate ?? "").localeCompare(a.saleDate ?? "") ||
      (b.issuedAt ?? "").localeCompare(a.issuedAt ?? "") ||
      (a.number ?? "~").localeCompare(b.number ?? "~") ||
      a.source.ref.localeCompare(b.source.ref),
  )
  return out
}

// ── links ───────────────────────────────────────────────────────────────

/** A 5-minute link to one issued document the buyer matches, or null (one answer for absent,
 *  another profile's, or not this buyer's). */
export async function mintBuyerLink(
  key: BuyerKey,
  who: BuyerIdentity,
  documentId: string,
  now = Date.now(),
): Promise<{ token: string; expiresAt: Date } | null> {
  const entries = await listBuyerDocuments(key, who)
  if (!entries.some((e) => e.id === documentId && e.state === "issued")) return null
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(now + LINK_TTL_MS)
  await withPrivilegedDb(key.orgId, "buyer-invoices-link-mint", async (tx) => {
    // Expired links of this key go as new ones are made; nothing reads them after expiry anyway.
    await tx.execute(sql`
      DELETE FROM ${K()}.buyer_invoice_links
       WHERE key_id = ${key.id}::uuid AND expires_at < now() - interval '1 day'`)
    await tx.execute(sql`
      INSERT INTO ${K()}.buyer_invoice_links (token_hash, org_id, key_id, document_id, expires_at)
      VALUES (${sha256Hex(token)}, ${key.orgId}::uuid, ${key.id}::uuid, ${documentId}::uuid,
              ${expiresAt.toISOString()}::timestamptz)`)
  })
  return { token, expiresAt }
}

export type LinkLookup =
  | { status: "ok"; orgId: string; keyId: string; documentId: string; issuerProfileId: string }
  | { status: "expired" }
  | { status: "unknown" }

/** A link token: live (its key still active), expired, or unknown. */
export async function lookupBuyerLink(token: string, now = Date.now()): Promise<LinkLookup> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return { status: "unknown" }
  const [row] = await withSystemDb("buyer-invoices-link-lookup", async (db) =>
    extractRows<{
      org_id: string
      key_id: string
      document_id: string
      expires_at: unknown
      issuer_profile_id: string
      revoked_at: unknown
    }>(
      await db.execute(sql`
        SELECT l.org_id, l.key_id, l.document_id, l.expires_at, k.issuer_profile_id, k.revoked_at
          FROM ${K()}.buyer_invoice_links l
          JOIN ${K()}.buyer_invoice_keys k ON k.id = l.key_id AND k.org_id = l.org_id
         WHERE l.token_hash = ${sha256Hex(token)}`),
    ),
  )
  if (!row || row.revoked_at) return { status: "unknown" }
  const expires = new Date(
    String(row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at),
  )
  if (!(expires.getTime() > now)) return { status: "expired" }
  return {
    status: "ok",
    orgId: row.org_id,
    keyId: row.key_id,
    documentId: row.document_id,
    issuerProfileId: row.issuer_profile_id,
  }
}

/** The file a link serves: the document's legal original (the render fixed at issue), else its
 *  current PDF for a document issued before legal originals existed. Null when the document left
 *  the issuer profile or has no PDF. */
export async function buyerDocumentFile(link: {
  orgId: string
  documentId: string
  issuerProfileId: string
}): Promise<{ number: string; fileId: string } | null> {
  const [row] = await withPrivilegedDb(link.orgId, "buyer-invoices-file", async (tx) =>
    extractRows<{ number: string; file_id: string | null }>(
      await tx.execute(sql`
        SELECT d.number,
               COALESCE(
                 (SELECT lo.file_id FROM app_invoicing.legal_originals lo
                   WHERE lo.org_id = d.org_id AND lo.id = d.legal_original_id
                     AND lo.file_id IS NOT NULL AND lo.sha256 IS NOT NULL),
                 d.pdf_file_id) AS file_id
          FROM app_invoicing.documents d
         WHERE d.org_id = ${link.orgId}::uuid AND d.id = ${link.documentId}::uuid
           AND d.issuer_profile_id = ${link.issuerProfileId}::uuid
           AND d.type IN ('invoice', 'credit_note') AND d.number IS NOT NULL`),
    ),
  )
  if (!row?.file_id) return null
  return { number: row.number, fileId: row.file_id }
}
