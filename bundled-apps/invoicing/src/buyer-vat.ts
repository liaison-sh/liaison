// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Business-buyer guard for intra-EU documents. An EU issuer selling to a buyer in ANOTHER member
// state charges no VAT when the buyer is a business (reverse charge, the buyer's VAT number on the
// document) and the destination's VAT when it is a consumer (OSS). The only input that tells the
// two apart is `counterparty.vat_id`, and an agent that leaves it out turns a business sale into a
// consumer sale with VAT nobody owes. So the server never takes a missing VAT number on trust, and
// never takes the agent's word that the buyer is a consumer either:
//
//   - a supplied VAT number is checked against VIES (a short deadline): invalid is refused, an
//     outage is let through and said on the approval card ("not verified, VIES unavailable"), and
//     a VIES-registered name that does not match the buyer is flagged there;
//   - the org's own data is ALWAYS searched for signs the buyer is a business (earlier documents
//     for the same contact, email or address, however the address is written; the buyer's Shopify
//     orders and customer record by email, by those documents' order numbers, by name and by
//     postcode and street; the buyer's kind and legal form), with bounded, indexed, newest-first
//     queries and capped, short-deadline Shopify reads. ANY match is evidence: it refuses a
//     consumer document. A Shopify read that fails leaves the status "NOT verified": a person
//     decides, never a silent consumer document;
//   - a VAT number on record by a STRONG match (same contact, same Shopify customer, same full
//     address with a compatible name) is filled in; a weaker match (email only, street only) is
//     only offered as a candidate, never filled in silently;
//   - with no VAT number, business evidence refuses the call, naming the evidence and where to
//     find the number;
//   - `buyer_is_consumer: true` is refused outright when a VAT number is on record for the buyer,
//     and with any other business evidence it FORCES a human approval card that lists the evidence
//     (`consumer_override_evidence`), on every tool.
//
// Read-only (lookups and one VIES call), so the stage-time preflights and the executed handlers
// call the same function and can never disagree.

import { refuseTool, type ToolRefusal } from "@liaison/app-sdk"
import type { CrossAppExecuteTool } from "./cross-app"
import { isUuid, type ReadsFetch, settingsIssuerProfileList, vatValidate } from "./reads"
import { addressMatch, addressParts, normaliseAddress } from "./address-match"
import { isEuCountry } from "./tax"

/** The `documents` row fields the evidence search reads. */
interface PriorDocumentRow {
  id?: unknown
  number?: unknown
  type?: unknown
  counterparty_contact_id?: unknown
  counterparty_name?: unknown
  counterparty_email?: unknown
  counterparty_address?: unknown
  counterparty_vat_id?: unknown
  counterparty_country?: unknown
  tax_treatment?: unknown
  tax_total_minor?: unknown
  grand_total_minor?: unknown
  external_refs?: unknown
}

export interface BuyerVatCtx {
  db: {
    findMany(
      entity: string,
      opts?: { where?: Record<string, unknown>; orderBy?: Record<string, "asc" | "desc">; limit?: number },
    ): Promise<unknown[]>
  }
  executeTool?: CrossAppExecuteTool
  fetch?: ReadsFetch
}

export interface BuyerVatInput {
  issuerCountry: string | null | undefined
  /** The tax destination (tax_country, else country). */
  taxCountry: string | null | undefined
  counterparty: {
    contact_id?: string | null
    legal_name?: string | null
    email?: string | null
    address?: string | null
    vat_id?: string | null
    customer_kind?: string | null
  }
  buyerIsConsumer?: boolean | null
  /** The document being edited, left out of its own evidence. */
  excludeDocumentId?: string | null
}

/** What the approval card says about the buyer's VAT status. */
export interface BuyerVatFacts {
  /** True when the sale is intra-EU cross-border (the business/consumer question applies). */
  applies: boolean
  /** The VAT number the document carries (as supplied, or filled from an earlier document). */
  vat_id: string | null
  vat_id_source: "caller" | "prior_document" | null
  /** The earlier document the VAT number was taken from. */
  prior_document_number: string | null
  vies: "valid" | "unavailable" | null
  vies_name: string | null
  vies_address: string | null
  /** VIES registers the VAT number to a name that shares no word with the buyer's name. */
  vies_name_mismatch: boolean
  buyer_is_consumer: boolean
  /**
   * Business evidence the caller overrode with `buyer_is_consumer: true`, in plain words. Not
   * empty means the call must be decided by a person (every tool parks an approval card listing
   * it), whatever the tool's own gating would say.
   */
  consumer_override_evidence: string[]
  /** VAT numbers found on a weaker match (same email, same street), offered and never filled in. */
  vat_candidates: string[]
  /**
   * Why the business/consumer question could not be fully checked (a Shopify read failed or timed
   * out) while nothing else showed a business. Not null means the card says "business status NOT
   * verified" and a person decides (fail closed), never a silent consumer (OSS) document.
   */
  business_unverified: string | null
}

export type BuyerVatOutcome =
  | { ok: true; facts: BuyerVatFacts }
  | { ok: false; error: ToolRefusal }

const NONE: BuyerVatFacts = {
  applies: false,
  vat_id: null,
  vat_id_source: null,
  prior_document_number: null,
  vies: null,
  vies_name: null,
  vies_address: null,
  vies_name_mismatch: false,
  buyer_is_consumer: false,
  consumer_override_evidence: [],
  vat_candidates: [],
  business_unverified: null,
}

/** True when the agent declared a private consumer against business evidence. */
export function consumerDeclaredAgainstEvidence(
  facts: Partial<Pick<BuyerVatFacts, "consumer_override_evidence">> | null | undefined,
): boolean {
  return (facts?.consumer_override_evidence?.length ?? 0) > 0
}

/**
 * True when the call must be decided by a person: the agent declared a consumer against evidence,
 * or the buyer's business status could not be verified (a Shopify read failed).
 */
export function needsHumanBuyerDecision(
  facts: Partial<Pick<BuyerVatFacts, "consumer_override_evidence" | "business_unverified">> | null | undefined,
): boolean {
  return consumerDeclaredAgainstEvidence(facts) || !!facts?.business_unverified
}

/** VIES's answer within this deadline, else "NOT verified (VIES unavailable)". */
export const BUYER_VIES_TIMEOUT_MS = 3000
/** How many earlier documents each lookup reads, newest first. */
const PRIOR_BY_PARTY_LIMIT = 25
const PRIOR_BY_COUNTRY_LIMIT = 200

// Company legal forms across the EU, matched as whole words on the buyer's name.
const LEGAL_FORM_RE =
  /(^|[\s,.(])(sas|sasu|sarl|eurl|sa|sca|snc|sci|gmbh|ag|kg|ohg|ug|srl|s\.r\.l|srls|spa|s\.p\.a|sapa|bv|b\.v|nv|n\.v|vof|bvba|sprl|ltd|limited|plc|llp|oy|oyj|aps|a\/s|asa|sl|s\.l|slu|sp\.? ?z\.? ?o\.? ?o|s\.a|lda|kft|zrt|nyrt|s\.r\.o|sro|d\.o\.o|doo|uab|sia)\.?(?=$|[\s,.)])/i

/** True when a name ends or contains a company legal form ("Studio Rosso SRL", "Kanal GmbH"). */
export function hasCompanyLegalForm(name: string | null | undefined): boolean {
  if (typeof name !== "string" || name.trim() === "") return false
  return LEGAL_FORM_RE.test(name.trim())
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null
}

export { addressMatch, addressParts, normaliseAddress, sameAddress, sameFullAddress } from "./address-match"
export type { AddressParts } from "./address-match"

const NAME_NOISE = new Set(["the", "and", "und", "et", "di", "de", "del", "della", "der", "die", "das", "van", "von", "les", "la", "le"])

/** The words of a name that identify it: no legal form, no short or filler words. */
function nameWords(name: string | null | undefined): string[] {
  return normaliseAddress(name)
    .split(" ")
    .filter((w) => w.length >= 3 && !NAME_NOISE.has(w) && !hasCompanyLegalForm(w))
}

/** Two names that could be the same buyer: they share an identifying word. Unknown is not compatible. */
export function compatibleNames(a: string | null | undefined, b: string | null | undefined): boolean {
  const wa = nameWords(a)
  const wb = new Set(nameWords(b))
  return wa.length > 0 && wb.size > 0 && wa.some((w) => wb.has(w))
}

function money(v: unknown): bigint | null {
  if (typeof v === "bigint") return v
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.round(v))
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim())
  return null
}

function docLabel(row: PriorDocumentRow): string {
  const type = str(row.type)?.replace("_", " ") ?? "document"
  const number = str(row.number)
  return number ? `${type} ${number}` : `a ${type} draft`
}

/** A VAT number in one canonical form: no spaces or dots, upper case, with its country prefix. */
function canonicalVat(vat: string, country: string): string {
  const c = vat.replace(/[\s.-]/g, "").toUpperCase()
  return /^[A-Z]{2}/.test(c) ? c : `${country === "GR" ? "EL" : country}${c}`
}

interface VatOnRecord {
  vat: string
  /** Where it was found: a document number, or "Shopify order #1001". */
  from: string
  /** How the record matched the buyer, in words ("the same contact"). */
  how: string
}

interface Evidence {
  lines: string[]
  /** VAT numbers on record by a STRONG match (same contact, same Shopify customer, same full
   *  address with a compatible name), keyed canonically. These may be filled in. */
  strong: Map<string, VatOnRecord>
  /** VAT numbers on a weaker match (same email or same street only): candidates, never filled in. */
  weak: Map<string, VatOnRecord>
  /** Company names on the matching records: the buyer's likely legal entity. */
  companies: Array<{ name: string; from: string }>
  /** Shopify order numbers on the matching earlier documents ("2748"), looked up in Shopify. */
  shopifyOrders: Set<string>
  /** Shopify order numbers of the orders that matched the buyer ("2748"): their own documents are
   *  read too, so a company named on an earlier invoice of that order is known. */
  matchedOrders: Set<string>
  /** Earlier documents already read, by id. */
  seenDocs: Set<string>
  /** Why Shopify could not be checked, when it could not ("Shopify did not answer"). */
  shopifyUnverified: string | null
}

/** Earlier documents for the same buyer: same contact, same email or same address. */
async function priorDocumentEvidence(ctx: BuyerVatCtx, input: BuyerVatInput, ev: Evidence): Promise<void> {
  const cp = input.counterparty
  const country = (input.taxCountry ?? "").toUpperCase()
  const email = str(cp.email)
  const emailKey = email?.toLowerCase() ?? null
  const contactId = str(cp.contact_id)
  const rows: PriorDocumentRow[] = []
  const add = (list: unknown[]) => rows.push(...unseen(list, input, ev))
  // Indexed lookups (counterparty_contact_id, counterparty_email, counterparty_country + createdAt),
  // newest first and bounded: the guard runs on interactive tools with a few seconds of budget.
  const newest = { createdAt: "desc" } as const
  // One after the other: they share the handler's database session.
  if (contactId) {
    add(await ctx.db.findMany("documents", { where: { counterparty_contact_id: contactId }, orderBy: newest, limit: PRIOR_BY_PARTY_LIMIT }))
  }
  if (email) {
    add(await ctx.db.findMany("documents", { where: { counterparty_email: email }, orderBy: newest, limit: PRIOR_BY_PARTY_LIMIT }))
    if (emailKey && emailKey !== email) {
      add(await ctx.db.findMany("documents", { where: { counterparty_email: emailKey }, orderBy: newest, limit: PRIOR_BY_PARTY_LIMIT }))
    }
  }
  // The address match needs the destination's documents; only read them when there is an address.
  if (country && str(cp.address)) {
    add(await ctx.db.findMany("documents", { where: { counterparty_country: country }, orderBy: newest, limit: PRIOR_BY_COUNTRY_LIMIT }))
  }
  considerPriorRows(rows, input, ev, null)
}

/** The rows not read yet (and not the document being edited), marked read. */
function unseen(list: unknown[], input: BuyerVatInput, ev: Evidence): PriorDocumentRow[] {
  const out: PriorDocumentRow[] = []
  for (const r of list as PriorDocumentRow[]) {
    const id = String(r.id ?? "")
    if (id && (ev.seenDocs.has(id) || id === input.excludeDocumentId)) continue
    if (id) ev.seenDocs.add(id)
    out.push(r)
  }
  return out
}

/** The Shopify order number a document records ("2748"): its column, else its external_refs. */
function orderNumberOf(r: PriorDocumentRow & { shopify_order_number?: unknown }): string | null {
  const n = str(r.shopify_order_number) ?? str((r.external_refs as Record<string, unknown> | null)?.shopify_order_number)
  return n ? n.replace(/^#/, "") : null
}

/** A business sale: a VAT number on the document, a reverse-charge or destination treatment, or no
 *  VAT at all on a sale to the destination country. */
function businessSale(r: PriorDocumentRow, country: string): boolean {
  const tax = money(r.tax_total_minor)
  const grand = money(r.grand_total_minor)
  const treatment = str(r.tax_treatment)
  const sameDest = str(r.counterparty_country)?.toUpperCase() === country
  return (
    !!str(r.counterparty_vat_id) ||
    treatment === "eu_reverse_charge" ||
    treatment === "eu_destination" ||
    (sameDest && tax === 0n && grand !== null && grand > 0n)
  )
}

/**
 * The documents of the Shopify orders that matched the buyer (by name, address or email) and that
 * no earlier-document lookup already read: an invoice made out to the buyer's company is found
 * through its order even when the agent gave no address or email that matches it. Indexed
 * (shopify_order_number), plus the document number an imported invoice shares with its order;
 * a row counts only when it records that order.
 */
async function orderDocumentEvidence(ctx: BuyerVatCtx, input: BuyerVatInput, ev: Evidence): Promise<void> {
  const orders = [...ev.matchedOrders].filter((n) => !ev.shopifyOrders.has(n)).slice(0, MAX_PRIOR_SHOPIFY_ORDERS)
  for (const n of orders) {
    const rows: PriorDocumentRow[] = []
    for (const where of [{ shopify_order_number: n }, { shopify_order_number: `#${n}` }, { number: n }]) {
      const found = (await ctx.db.findMany("documents", { where, orderBy: { createdAt: "desc" }, limit: 5 })) as PriorDocumentRow[]
      rows.push(...unseen(found.filter((r) => orderNumberOf(r) === n), input, ev))
    }
    considerPriorRows(rows, input, ev, n)
  }
}

/**
 * Earlier documents as evidence. `viaOrder` is the Shopify order number the rows were found
 * through (the order matched the buyer); null for rows found by contact, email or address.
 */
function considerPriorRows(rows: PriorDocumentRow[], input: BuyerVatInput, ev: Evidence, viaOrder: string | null): void {
  const cp = input.counterparty
  const country = (input.taxCountry ?? "").toUpperCase()
  const emailKey = str(cp.email)?.toLowerCase() ?? null
  const contactId = str(cp.contact_id)
  for (const r of rows) {
    if (r.type === "purchase_order") continue
    const name = str(r.counterparty_name)
    const address = addressMatch(cp.address, str(r.counterparty_address))
    const byContact = contactId !== null && str(r.counterparty_contact_id) === contactId
    const byFullAddress = address === "full" && compatibleNames(cp.legal_name, name)
    const byEmail = emailKey !== null && str(r.counterparty_email)?.toLowerCase() === emailKey
    // ANY match is evidence (it refuses a consumer document); only a strong one fills in a VAT number.
    if (!byContact && !byFullAddress && !byEmail && address === null && viaOrder === null) continue
    const how = byContact
      ? "the same contact"
      : byFullAddress
        ? "the same address and name"
        : byEmail
          ? "the same email"
          : address === "full"
            ? "the same address"
            : address === "street"
              ? "the same street"
              : `the same Shopify order #${viaOrder}`
    const label = docLabel(r)
    // The buyer's company: a legal form in the name, or another name than the buyer's on a
    // business sale ("Bottega Notturna" invoiced with no VAT to the address of "Lucia Ferro").
    const company =
      name && (hasCompanyLegalForm(name) || (businessSale(r, country) && !compatibleNames(cp.legal_name, name))) ? name : null
    if (company && !ev.companies.some((c) => c.name === company)) ev.companies.push({ name: company, from: label })
    const shopifyOrder = orderNumberOf(r)
    if (shopifyOrder && ev.shopifyOrders.size < MAX_PRIOR_SHOPIFY_ORDERS) ev.shopifyOrders.add(shopifyOrder)
    const to = company ? `, to the company "${company}"` : name ? `, to "${name}"` : ""
    const vat = str(r.counterparty_vat_id)
    if (vat) {
      const key = canonicalVat(vat, country)
      const rec: VatOnRecord = { vat, from: str(r.number) ?? label, how }
      const target = byContact || byFullAddress ? ev.strong : ev.weak
      if (!target.has(key)) target.set(key, rec)
      ev.lines.push(`${label} (${how}${to}) carries the buyer VAT number ${vat}`)
      continue
    }
    const treatment = str(r.tax_treatment)
    const tax = money(r.tax_total_minor)
    const grand = money(r.grand_total_minor)
    // No VAT on a sale to the same destination country: only a business buyer gets that.
    const sameDest = str(r.counterparty_country)?.toUpperCase() === country
    const zeroTaxSale = sameDest && tax === 0n && grand !== null && grand > 0n
    const order = shopifyOrder ? `, Shopify order ${shopifyOrder}` : ""
    if (treatment === "eu_reverse_charge" || treatment === "eu_destination" || zeroTaxSale) {
      ev.lines.push(`${label} (${how}${to}${order}) was issued WITHOUT VAT (${treatment ?? "no tax"}, ${tax === 0n ? "zero VAT" : "no VAT line"}): a business sale`)
    } else if (company) {
      ev.lines.push(`${label} (${how}) was issued to the company "${company}" (legal form in its name)`)
    }
    // A document WITH VAT to a person's name is a consumer sale: no evidence either way.
  }
}

interface ShopifyOrderHit {
  id?: unknown
  title?: unknown
  attributes?: {
    email?: unknown
    tags?: unknown
    totalTax?: unknown
    totalAmount?: unknown
    taxExempt?: unknown
    customerTaxExempt?: unknown
    euDestination?: unknown
    shippingCountryCode?: unknown
    shippingAddress1?: unknown
    shippingZip?: unknown
    shippingCity?: unknown
    customer?: { id?: unknown; firstName?: unknown; lastName?: unknown; email?: unknown; taxExempt?: unknown } | null
    b2bCompany?: { name?: unknown; taxRegistrationId?: unknown } | null
  }
}

interface ShopifyCustomerHit {
  id?: unknown
  title?: unknown
  attributes?: {
    email?: unknown
    firstName?: unknown
    lastName?: unknown
    tags?: unknown
    taxExempt?: unknown
    companies?: unknown
    defaultAddress?: { address1?: unknown; city?: unknown; zip?: unknown; countryCode?: unknown } | null
  }
}

/** Each Shopify lookup's deadline: the store answers within it or the check reads "not verified". */
export const SHOPIFY_LOOKUP_TIMEOUT_MS = 2500
/** At most this many Shopify reads per check, run together, each returning at most SHOPIFY_LOOKUP_LIMIT hits. */
const MAX_SHOPIFY_LOOKUPS = 5
const SHOPIFY_LOOKUP_LIMIT = 5
const MAX_PRIOR_SHOPIFY_ORDERS = 3
const B2B_TAG_RE = /^(b2b|wholesale|business|professional|dealer|reseller|distributor|trade)$/i

/** Every identifying word of the buyer's name is in the other name ("Lucia Ferro" in "Marco Lucia Ferro"). */
export function nameCovers(buyer: string | null | undefined, other: string | null | undefined): boolean {
  const wb = nameWords(buyer)
  const wo = new Set(nameWords(other))
  if (wb.length === 0 || wo.size === 0) return false
  if (wb.length === 1 && wb[0]!.length < 5) return false
  return wb.every((w) => wo.has(w))
}

/** No Shopify to ask (not installed, not connected): no evidence from it, and nothing unverified. */
export function shopifyAbsent(codeAndMessage: string): boolean {
  return /tool_not_found|not_connected|connection_missing|install_metadata_missing|not_installed|no shopify connection|install_metadata row not found/i.test(
    codeAndMessage,
  )
}

/** Quote-free text for a Shopify search term. */
export function shopifyTerm(s: string): string {
  return s.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * The buyer's Shopify orders and customer record, looked up by email, by the order numbers on the
 * matching earlier documents, by the buyer's name and by the shipping postcode and street: a
 * customer who never gave an email is still found. A B2B tag, a tax exemption, a company, or no
 * tax charged on an EU delivery is evidence. The reads are capped (MAX_SHOPIFY_LOOKUPS, run
 * together, SHOPIFY_LOOKUP_LIMIT hits, SHOPIFY_LOOKUP_TIMEOUT_MS each); a read that fails or
 * times out marks the check `shopifyUnverified` (fail closed: a person decides).
 */
async function shopifyEvidence(ctx: BuyerVatCtx, input: BuyerVatInput, ev: Evidence): Promise<void> {
  if (!ctx.executeTool) return
  const exec = ctx.executeTool
  const cp = input.counterparty
  const email = str(cp.email)
  const name = str(cp.legal_name)
  const parts = addressParts(cp.address)
  const dest = (input.taxCountry ?? "").toUpperCase()
  const issuer = (input.issuerCountry ?? "").toUpperCase()
  const base = { limit: SHOPIFY_LOOKUP_LIMIT, timeout_ms: SHOPIFY_LOOKUP_TIMEOUT_MS }
  const lookups: Array<{ tool: "shopify:orders_search" | "shopify:customers_search"; query: string }> = []
  if (email) lookups.push({ tool: "shopify:orders_search", query: `email:"${shopifyTerm(email)}"` })
  if (ev.shopifyOrders.size > 0) {
    lookups.push({ tool: "shopify:orders_search", query: [...ev.shopifyOrders].map((n) => `name:#${shopifyTerm(n)}`).join(" OR ") })
  }
  if (name && nameWords(name).length > 0) {
    lookups.push({ tool: "shopify:orders_search", query: `"${shopifyTerm(name)}"` })
    lookups.push({ tool: "shopify:customers_search", query: `"${shopifyTerm(name)}"` })
  }
  if (parts?.postcode && parts.street.length > 0) {
    const word = [...parts.street].sort((a, b) => b.length - a.length)[0]!
    lookups.push({ tool: "shopify:orders_search", query: `${parts.postcode} ${word}` })
  }
  if (lookups.length === 0) return
  let failed: string | null = null
  let absent = 0
  const answers = await Promise.all(
    lookups.slice(0, MAX_SHOPIFY_LOOKUPS).map(async (l) => {
      try {
        const env = await exec(l.tool, { ...base, query: l.query })
        if (env?.status === "completed") {
          const results = (env.result as { results?: unknown } | null)?.results
          return { tool: l.tool, results: Array.isArray(results) ? results : [] }
        }
        const code = env?.status === "error" ? String(env.error?.code ?? "error") : String(env?.status ?? "no answer")
        const message = env?.status === "error" ? String(env.error?.message ?? "") : ""
        if (shopifyAbsent(`${code} ${message}`)) absent++
        else failed ??= code
      } catch (err) {
        const code = String((err as { code?: unknown } | null)?.code ?? "error")
        if (shopifyAbsent(`${code} ${String((err as Error | null)?.message ?? "")}`)) absent++
        else failed ??= code
      }
      return { tool: l.tool, results: [] as unknown[] }
    }),
  )
  if (absent === Math.min(lookups.length, MAX_SHOPIFY_LOOKUPS)) return
  if (failed) ev.shopifyUnverified = `Shopify could not be checked (${failed})`

  const orders = new Map<string, ShopifyOrderHit>()
  const customers = new Map<string, ShopifyCustomerHit>()
  for (const a of answers) {
    for (const hit of a.results as Array<ShopifyOrderHit & ShopifyCustomerHit>) {
      const id = String(hit?.id ?? hit?.title ?? "")
      if (!id) continue
      if (a.tool === "shopify:customers_search") customers.set(id, hit)
      else orders.set(id, hit)
    }
  }
  for (const hit of orders.values()) {
    const a = hit.attributes
    if (!a) continue
    const order = str(hit.title) ?? "an order"
    const customerName = [str(a.customer?.firstName), str(a.customer?.lastName)].filter(Boolean).join(" ")
    const ship = str(a.shippingCountryCode)?.toUpperCase() ?? null
    const shipAddress = [str(a.shippingAddress1), [str(a.shippingZip), str(a.shippingCity)].filter(Boolean).join(" ")].filter(Boolean).join(", ")
    const orderEmail = str(a.email) ?? str(a.customer?.email)
    const byEmail = !!email && orderEmail?.toLowerCase() === email.toLowerCase()
    const byNumber = ev.shopifyOrders.has(order.replace(/^#/, ""))
    const byAddress = addressMatch(cp.address, shipAddress) !== null
    const byName = nameCovers(name, customerName) && (ship === null || ship === dest)
    if (!byEmail && !byNumber && !byAddress && !byName) continue
    if (/^#?\d+$/.test(order) && ev.matchedOrders.size < MAX_PRIOR_SHOPIFY_ORDERS) ev.matchedOrders.add(order.replace(/^#/, ""))
    const how = byEmail ? `of ${email}` : byNumber ? "on the earlier document" : byAddress ? "to the same address" : `of the customer "${customerName}"`
    const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : []
    const b2bTag = tags.find((t) => B2B_TAG_RE.test(t.trim()))
    const company = str(a.b2bCompany?.name)
    const taxId = str(a.b2bCompany?.taxRegistrationId)
    if (taxId) {
      const key = canonicalVat(taxId, dest)
      const rec: VatOnRecord = { vat: taxId, from: `Shopify order ${order}`, how: byEmail ? "the same Shopify customer" : how }
      const target = byEmail ? ev.strong : ev.weak
      if (!ev.strong.has(key) && !target.has(key)) target.set(key, rec)
    }
    if (company && !ev.companies.some((c) => c.name === company)) ev.companies.push({ name: company, from: `Shopify order ${order}` })
    const signs: string[] = []
    if (b2bTag) signs.push(`tagged "${b2bTag}"`)
    if (company) signs.push(`bought by the company "${company}"${taxId ? ` (tax id ${taxId})` : ""}`)
    if (a.taxExempt === true || a.customerTaxExempt === true || a.customer?.taxExempt === true) signs.push("tax exempt")
    const tax = typeof a.totalTax === "string" ? Number(a.totalTax) : typeof a.totalTax === "number" ? a.totalTax : null
    const total = typeof a.totalAmount === "string" ? Number(a.totalAmount) : typeof a.totalAmount === "number" ? a.totalAmount : null
    if (tax === 0 && total !== null && total > 0 && a.euDestination === true && ship !== null && ship !== issuer) {
      signs.push("no VAT charged on an EU delivery")
    }
    if (signs.length > 0) ev.lines.push(`Shopify order ${order} (${how}): ${signs.join(", ")}`)
  }
  for (const hit of customers.values()) {
    const a = hit.attributes
    if (!a) continue
    const customerName = [str(a.firstName), str(a.lastName)].filter(Boolean).join(" ") || (str(hit.title) ?? "")
    const d = a.defaultAddress
    const home = d ? [str(d.address1), [str(d.zip), str(d.city)].filter(Boolean).join(" ")].filter(Boolean).join(", ") : ""
    const country = str(d?.countryCode)?.toUpperCase() ?? null
    const byAddress = addressMatch(cp.address, home) !== null
    const byName = nameCovers(name, customerName) && (country === null || country === dest)
    if (!byAddress && !byName) continue
    const tags = Array.isArray(a.tags) ? a.tags.filter((t): t is string => typeof t === "string") : []
    const b2bTag = tags.find((t) => B2B_TAG_RE.test(t.trim()))
    const companies = Array.isArray(a.companies)
      ? a.companies.map((c) => (typeof c === "string" ? c : str((c as { name?: unknown } | null)?.name))).filter((c): c is string => !!c)
      : []
    const signs: string[] = []
    if (b2bTag) signs.push(`tagged "${b2bTag}"`)
    if (a.taxExempt === true) signs.push("tax exempt")
    if (companies.length > 0) signs.push(`buys for the company "${companies[0]}"`)
    for (const c of companies) if (!ev.companies.some((x) => x.name === c)) ev.companies.push({ name: c, from: `Shopify customer "${customerName}"` })
    if (signs.length > 0) ev.lines.push(`Shopify customer "${customerName}" (${byAddress ? "the same address" : "the same name"}): ${signs.join(", ")}`)
  }
}

/** A deliberate refusal (refuseTool): the host answers it as a 4xx at warn, never a 500 fault. */
function refuse(code: string, message: string, body?: unknown): BuyerVatOutcome {
  return { ok: false, error: refuseTool(code, message, body ? { body } : {}) }
}

export interface ViesAnswer {
  status: "valid" | "invalid" | "unavailable"
  name: string | null
  address: string | null
}

/** VIES on one VAT number within BUYER_VIES_TIMEOUT_MS: valid, invalid (with VIES's answer) or unavailable. */
export async function viesCheck(ctx: Pick<BuyerVatCtx, "fetch">, vat: string, taxCountry: string): Promise<ViesAnswer> {
  const compact = vat.replace(/[\s.-]/g, "").toUpperCase()
  // The number's own prefix names its member state (Greece registers as EL); a bare number takes
  // the tax destination's.
  const prefix = /^[A-Z]{2}/.test(compact) ? compact.slice(0, 2) : taxCountry === "GR" ? "EL" : taxCountry
  const r = await vatValidate(ctx, { country_code: prefix, vat_number: compact, timeout_ms: BUYER_VIES_TIMEOUT_MS })
  if (r.error) return { status: "unavailable", name: null, address: null }
  return { status: r.isValid ? "valid" : "invalid", name: r.name, address: r.address }
}

/** The facts for a VAT number the document will carry, with what VIES said about it. */
function vatFacts(
  vat: string,
  source: "caller" | "prior_document",
  from: string | null,
  v: ViesAnswer,
  buyerName: string | null | undefined,
): BuyerVatFacts {
  return {
    ...NONE,
    applies: true,
    vat_id: vat,
    vat_id_source: source,
    prior_document_number: from,
    vies: v.status === "valid" ? "valid" : "unavailable",
    vies_name: v.name,
    vies_address: v.address,
    // VIES often answers "---" for a name it withholds: only a real name can mismatch.
    vies_name_mismatch:
      v.status === "valid" && nameWords(v.name).length > 0 && !!str(buyerName) && !compatibleNames(buyerName, v.name),
  }
}

function recordWords(r: VatOnRecord): string {
  return `${r.vat} (on ${r.from}, ${r.how})`
}

/**
 * Decide the buyer's VAT status for an intra-EU document, or refuse the call. See the file header.
 */
export async function checkBuyerVat(ctx: BuyerVatCtx, input: BuyerVatInput): Promise<BuyerVatOutcome> {
  const issuer = (input.issuerCountry ?? "").trim().toUpperCase()
  const dest = (input.taxCountry ?? "").trim().toUpperCase()
  const suppliedVat = str(input.counterparty.vat_id)
  const consumer = input.buyerIsConsumer === true
  if (!isEuCountry(issuer) || !isEuCountry(dest) || issuer === dest) {
    return { ok: true, facts: { ...NONE, vat_id: suppliedVat, vat_id_source: suppliedVat ? "caller" : null, buyer_is_consumer: consumer } }
  }
  if (suppliedVat && consumer) {
    return refuse(
      "buyer_status_contradiction",
      `counterparty.vat_id is ${suppliedVat} AND buyer_is_consumer is true. A buyer with a VAT number is a business (reverse charge, no VAT); a consumer has none. Pass one or the other.`,
    )
  }
  if (suppliedVat) {
    const v = await viesCheck(ctx, suppliedVat, dest)
    if (v.status === "invalid") {
      return refuse(
        "vat_id_invalid",
        `VIES says the VAT number ${suppliedVat} is NOT valid. Nothing was created. Check the number (an earlier document for this buyer, the buyer's website legal notice or company registry), then call again with the correct counterparty.vat_id. Check a number with invoicing__vat_validate.`,
      )
    }
    return { ok: true, facts: vatFacts(suppliedVat, "caller", null, v, input.counterparty.legal_name) }
  }

  // The evidence search runs whatever the caller says: buyer_is_consumer is a claim to check, not
  // a way around the check.
  const ev: Evidence = { lines: [], strong: new Map(), weak: new Map(), companies: [], shopifyOrders: new Set(),
    matchedOrders: new Set(),
    seenDocs: new Set(),
    shopifyUnverified: null,
  }
  const kind = str(input.counterparty.customer_kind)
  if (kind && kind !== "individual") ev.lines.push(`the counterparty is marked customer_kind "${kind}"`)
  if (hasCompanyLegalForm(input.counterparty.legal_name)) {
    ev.lines.push(`the buyer's name "${String(input.counterparty.legal_name).trim()}" is a company legal form`)
  }
  // The earlier documents first: their Shopify order numbers are looked up in Shopify.
  await priorDocumentEvidence(ctx, input, ev)
  await shopifyEvidence(ctx, input, ev)
  // The matched Shopify orders' own documents: the company an earlier invoice was made out to.
  await orderDocumentEvidence(ctx, input, ev)
  const strong = [...ev.strong.values()]
  const weak = [...ev.weak.entries()].filter(([k]) => !ev.strong.has(k)).map(([, r]) => r)

  if (consumer) {
    // A VAT number on record for this very buyer: it is a business, whatever the caller says.
    if (strong.length > 0) {
      const first = strong[0]!
      return refuse(
        "buyer_is_consumer_refused",
        `buyer_is_consumer is true, but this buyer in ${dest} has a VAT number on record: ${strong.map(recordWords).join("; ")}. A buyer with a VAT number is a business: the document must carry it (reverse charge, no VAT). Nothing was created. ` +
          `Next step: confirm the number with invoicing__vat_validate and call again with counterparty.vat_id: "${first.vat}" and without buyer_is_consumer.`,
        { vat_on_record: strong },
      )
    }
    const evidence = [...ev.lines, ...weak.map((r) => `VAT number ${recordWords(r)} may be this buyer's`)]
    return {
      ok: true,
      facts: {
        ...NONE,
        applies: true,
        buyer_is_consumer: true,
        consumer_override_evidence: evidence.slice(0, 6),
        vat_candidates: weak.map((r) => r.vat),
        business_unverified: evidence.length === 0 ? ev.shopifyUnverified : null,
      },
    }
  }

  // One VAT number on record by a strong match: fill it in, after VIES confirms it is not invalid.
  if (strong.length === 1) {
    const only = strong[0]!
    const v = await viesCheck(ctx, only.vat, dest)
    if (v.status !== "invalid") {
      return { ok: true, facts: vatFacts(only.vat, "prior_document", only.from, v, input.counterparty.legal_name) }
    }
    ev.lines.push(`the VAT number ${only.vat} on ${only.from} is NOT valid in VIES any more`)
  }
  if (ev.lines.length === 0 && weak.length === 0) {
    return { ok: true, facts: { ...NONE, applies: true, business_unverified: ev.shopifyUnverified } }
  }
  const shown = ev.lines.slice(0, 6)
  const candidates = [...strong, ...weak]
  const entity = ev.companies[0] ?? null
  const lookup = vatLookupCall(
    entity?.name ?? (hasCompanyLegalForm(input.counterparty.legal_name) ? str(input.counterparty.legal_name) : null),
    dest,
    input.counterparty.address,
  )
  return refuse(
    "buyer_vat_id_required",
    `This buyer in ${dest} looks like a BUSINESS, but counterparty.vat_id is empty, which would charge ${dest} consumer VAT (OSS) instead of the reverse charge. Nothing was created. ` +
      (shown.length > 0 ? `Evidence: ${shown.join("; ")}. ` : "") +
      (candidates.length > 0
        ? `VAT numbers on record that may be this buyer's (NOT filled in, check they are this company): ${candidates.map(recordWords).join("; ")}. `
        : "") +
      (entity
        ? `The buyer is likely the company "${entity.name}" (the name on ${entity.from})${
            compatibleNames(entity.name, input.counterparty.legal_name) ? "" : `, not "${str(input.counterparty.legal_name) ?? "the name given"}"`
          }. `
        : "") +
      `Next step: ${lookup.text}. If it finds none, find the buyer's VAT number: on the earlier documents above (invoicing__documents_get), in VIES (invoicing__vat_validate), in the company register, in the customer's website legal notice, or on the Shopify order's company or the buyer's contact record. Then call again with counterparty.vat_id and the company's name as counterparty.legal_name. ` +
      "Only if the user confirms the buyer is a private person, pass buyer_is_consumer: true; a person then approves the document with this evidence in front of them.",
    {
      evidence: shown,
      vat_candidates: candidates.map((r) => r.vat),
      likely_legal_name: entity?.name ?? null,
      next_call: { tool: "invoicing__vat_lookup", params: lookup.params },
    },
  )
}

/** First letter of each word upper case: "torino" -> "Torino". */
function titleCase(s: string): string {
  return s.replace(/(^|\s)(\p{L})/gu, (_m, sp: string, c: string) => sp + c.toUpperCase())
}

/**
 * The exact invoicing__vat_lookup call the refusal names, from what the guard already knows: the
 * likely legal entity, the tax destination and the city and postcode read off the buyer's address.
 */
export function vatLookupCall(
  legalName: string | null,
  country: string,
  address: string | null | undefined,
): { text: string; params: Record<string, string> } {
  const parts = addressParts(address)
  const city = parts?.city ? titleCase(parts.city) : null
  const params: Record<string, string> = { ...(legalName ? { legal_name: legalName } : {}), country }
  if (city) params.city = city
  if (parts?.postcode) params.postcode = parts.postcode
  const place = [`country '${country}'`, ...(city ? [`city '${city}'`] : []), ...(parts?.postcode ? [`postcode '${parts.postcode}'`] : [])]
  if (!legalName) {
    // No company on record: never a placeholder the agent fills with the person's own name.
    return {
      text:
        `no company name is on record for this buyer: ask the user for the buyer company's legal name (never use the person's name as a company name), ` +
        `then call invoicing__vat_lookup with that legal_name, ${place.join(", ")}`,
      params,
    }
  }
  return { text: `call invoicing__vat_lookup with ${[`legal_name '${legalName}'`, ...place].join(", ")}`, params }
}

/**
 * Read behind the create-and-issue approval cards (manifest `summarizerContext`): the issuer
 * profiles (as settings_issuer_profile_list returns them) plus the buyer's VAT status this call
 * resolves, so the card states the VAT number it will carry, where it came from and what VIES
 * said. Read-only; a refusal is reported in words, never thrown.
 */
export async function documentsIssuePreview(
  ctx: BuyerVatCtx & Parameters<typeof settingsIssuerProfileList>[0],
  params: {
    issuer_profile_id?: string | null
    counterparty?: unknown
    buyer_is_consumer?: boolean | null
    original_document_id?: string | null
  },
): Promise<{
  items: Record<string, unknown>[]
  buyer: BuyerVatFacts | null
  refusal: string | null
  original?: { number: string | null; issued_at: string | null; grand_total_minor: string | null } | null
}> {
  const { items } = await settingsIssuerProfileList(ctx)
  // A credit note's card names the invoice it reverses by its number and date, never its id.
  if (params.original_document_id) {
    const ref = params.original_document_id
    const [doc] = (await ctx.db.findMany("documents", {
      where: isUuid(ref) ? { id: ref } : { number: ref },
      limit: 1,
    })) as Array<Record<string, unknown>>
    return {
      items,
      buyer: null,
      refusal: null,
      original:
        doc?.type === "invoice"
          ? {
              number: str(doc.number),
              issued_at: doc.issued_at instanceof Date ? doc.issued_at.toISOString() : str(doc.issued_at),
              grand_total_minor: doc.grand_total_minor == null ? null : String(doc.grand_total_minor),
            }
          : null,
    }
  }
  const live = items.filter((r) => !r.archived_at)
  const issuer = params.issuer_profile_id
    ? live.find((r) => String(r.id) === params.issuer_profile_id)
    : live.length === 1
      ? live[0]
      : undefined
  let cp: Record<string, unknown> | null = null
  if (params.counterparty && typeof params.counterparty === "object") cp = params.counterparty as Record<string, unknown>
  else if (typeof params.counterparty === "string") {
    try {
      const parsed: unknown = JSON.parse(params.counterparty)
      if (parsed && typeof parsed === "object") cp = parsed as Record<string, unknown>
    } catch {
      cp = null
    }
  }
  if (!issuer || !cp) return { items, buyer: null, refusal: null }
  const s = (k: string) => (typeof cp?.[k] === "string" ? (cp[k] as string) : null)
  const r = await checkBuyerVat(ctx, {
    issuerCountry: typeof issuer.country === "string" ? issuer.country : null,
    taxCountry: s("tax_country") ?? s("country"),
    counterparty: {
      contact_id: s("contact_id"),
      legal_name: s("legal_name"),
      email: s("email"),
      address: s("address"),
      vat_id: s("vat_id"),
      customer_kind: s("customer_kind"),
    },
    buyerIsConsumer: params.buyer_is_consumer === true,
  })
  return r.ok ? { items, buyer: r.facts, refusal: null } : { items, buyer: null, refusal: r.error.error.message }
}
