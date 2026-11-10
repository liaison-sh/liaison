// SPDX-License-Identifier: FSL-1.1-ALv2
//
// B2B draft orders: Shopify's own B2B catalogs price the lines.
//
// A draft placed for a company location (`purchasingEntity.purchasingCompany`) gets each variant
// line's unit price from the catalogs that apply to that location, and its taxes from the
// location's tax settings. So a B2B draft never carries a price the agent made up: a plain
// `{ variantId, quantity }` line is the whole job. This module is the deterministic guard the
// draft-order normaliser runs BEFORE any approval is staged:
//
//   - a draft is B2B when `purchasingCompany` is given, when the given customer is a company
//     contact, or (update) when the existing draft's buyer is a company or a company contact;
//   - a B2B draft must name the company location (`B2B_COMPANY_REQUIRED`), and the contact must
//     hold a role at it (`B2B_CONTACT_NO_ROLE`), else Shopify refuses at execution;
//   - on a B2B draft every price the catalog would not set (a line or order `appliedDiscount`, a
//     per-unit `price`, a custom `originalUnitPriceWithCurrency`, a `priceOverride`) needs a
//     `priceException` with a reason (`B2B_PRICE_NOT_CATALOG`), and a line price is never turned
//     into a discount: an excepted price becomes the line's `priceOverride`;
//   - a `priceException` lands in the line's (or order's) custom attributes, so the approval card
//     and the resulting order both show why the price differs.

import { isRec, makeMutationError, type ShopClient } from "./shared"

export const PRICE_EXCEPTION_REASONS = [
  "demo_unit",
  "warranty_replacement",
  "gift",
  "approved_agreement",
] as const
export type PriceExceptionReason = (typeof PRICE_EXCEPTION_REASONS)[number]

/** The custom attribute key a price exception is recorded under, on the line or the order. */
export const PRICE_EXCEPTION_ATTRIBUTE = "Price exception"

export interface PriceException {
  reason: PriceExceptionReason
  note: string | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)

/**
 * Read a `priceException` ({ reason, note }, or a bare reason string). Undefined when absent; throws
 * `INVALID_PRICE_EXCEPTION` when present but its reason is not one of PRICE_EXCEPTION_REASONS.
 */
export function parsePriceException(v: unknown, where: string): PriceException | undefined {
  if (v == null) return undefined
  const raw = isRec(v) ? v.reason : v
  const reason = str(raw)?.toLowerCase()
  if (!reason || !(PRICE_EXCEPTION_REASONS as readonly string[]).includes(reason)) {
    throw makeMutationError(
      "INVALID_PRICE_EXCEPTION",
      `${where}: priceException.reason must be one of ${PRICE_EXCEPTION_REASONS.join(", ")} ` +
        `(got ${JSON.stringify(raw ?? null)}). Add a short note saying who approved it or why.`,
    )
  }
  return { reason: reason as PriceExceptionReason, note: isRec(v) ? str(v.note) : null }
}

/** The attribute value a price exception is recorded as: `<reason>` or `<reason>: <note>`. */
export function priceExceptionLabel(e: PriceException): string {
  return e.note ? `${e.reason}: ${e.note}` : e.reason
}

/** Append (or replace) the price-exception attribute on a customAttributes array. */
export function withPriceExceptionAttribute(attrs: unknown, e: PriceException): Array<Record<string, unknown>> {
  const kept = (Array.isArray(attrs) ? attrs.filter(isRec) : []).filter((a) => a.key !== PRICE_EXCEPTION_ATTRIBUTE)
  return [...kept.map((a) => ({ ...a })), { key: PRICE_EXCEPTION_ATTRIBUTE, value: priceExceptionLabel(e) }]
}

// ─────────────────────────────────────────────────────────────────────────
//  Who is buying: the B2B context of a draft
// ─────────────────────────────────────────────────────────────────────────

export interface PurchasingCompanyIds {
  companyId?: string
  companyLocationId?: string
  companyContactId?: string
}

/** A company the given customer is a contact of, with the locations the contact holds a role at. */
export interface ContactCompany {
  companyId: string
  companyName: string | null
  companyContactId: string
  locations: Array<{ id: string; name: string | null }>
}

/** The company location a verified `purchasingCompany` names (read before the draft is staged). */
export interface VerifiedCompanyBuyer {
  companyId: string
  companyName: string | null
  location: {
    id: string
    name: string | null
    taxExempt: boolean | null
    taxRegistrationId: string | null
    shippingAddress: Record<string, unknown> | null
    billingAddress: Record<string, unknown> | null
  }
  contactCustomer: {
    id: string | null
    email: string | null
    firstName: string | null
    lastName: string | null
    taxExempt: boolean | null
    defaultAddress: Record<string, unknown> | null
  } | null
}

export interface B2bContext {
  /** True when the buyer is a B2B company (or a company contact). */
  b2b: boolean
  /** A company location already on the draft (update path). */
  existingCompany: { companyName: string | null; locationId: string | null; locationName: string | null } | null
  /** The companies the customer is a contact of (for the refusal message). */
  contactCompanies: ContactCompany[]
}

/** Keep only the three string ids PurchasingCompanyInput takes. */
export function cleanPurchasingCompany(v: unknown): PurchasingCompanyIds | undefined {
  if (!isRec(v)) return undefined
  const out: PurchasingCompanyIds = {}
  const companyId = str(v.companyId)
  const companyLocationId = str(v.companyLocationId) ?? str(v.locationId)
  const companyContactId = str(v.companyContactId) ?? str(v.contactId)
  if (companyId) out.companyId = companyId
  if (companyLocationId) out.companyLocationId = companyLocationId
  if (companyContactId) out.companyContactId = companyContactId
  return out
}

const CUSTOMER_COMPANIES_QUERY = `
  query B2bCustomerCompanies($id: ID!) {
    customer(id: $id) {
      id
      companyContactProfiles {
        id
        company { id name }
        roleAssignments(first: 50) { nodes { companyLocation { id name } } }
      }
    }
  }
`

interface ContactProfileNode {
  id?: string | null
  company?: { id?: string | null; name?: string | null } | null
  roleAssignments?: { nodes?: Array<{ companyLocation?: { id?: string | null; name?: string | null } | null } | null> | null } | null
}

function contactCompaniesOf(profiles: ContactProfileNode[] | null | undefined): ContactCompany[] {
  const out: ContactCompany[] = []
  for (const p of profiles ?? []) {
    const companyId = str(p?.company?.id)
    const contactId = str(p?.id)
    if (!companyId || !contactId) continue
    const locations = (p.roleAssignments?.nodes ?? []).flatMap((n) => {
      const id = str(n?.companyLocation?.id)
      return id ? [{ id, name: str(n?.companyLocation?.name) }] : []
    })
    out.push({ companyId, companyName: str(p.company?.name), companyContactId: contactId, locations })
  }
  return out
}

/** The companies a Shopify customer is a contact of (empty for a consumer). Throws on a failed read. */
export async function readContactCompanies(client: ShopClient, customerId: string): Promise<ContactCompany[]> {
  let data: { customer?: { companyContactProfiles?: ContactProfileNode[] | null } | null }
  try {
    data = await client.query(CUSTOMER_COMPANIES_QUERY, { id: customerId })
  } catch (err) {
    throw b2bCheckFailed(err)
  }
  return contactCompaniesOf(data.customer?.companyContactProfiles)
}

const DRAFT_BUYER_QUERY = `
  query B2bDraftBuyer($id: ID!) {
    draftOrder(id: $id) {
      id
      purchasingEntity {
        __typename
        ... on PurchasingCompany { company { id name } location { id name } }
        ... on Customer { id }
      }
      customer { id }
    }
  }
`

interface DraftBuyerNode {
  purchasingEntity?: {
    __typename?: string
    company?: { id?: string | null; name?: string | null } | null
    location?: { id?: string | null; name?: string | null } | null
    id?: string | null
  } | null
  customer?: { id?: string | null } | null
}

function b2bCheckFailed(err: unknown): Error {
  return makeMutationError(
    "B2B_CHECK_FAILED",
    "Could not read whether this buyer is a B2B company in Shopify, so the draft's prices cannot be checked " +
      `(${err instanceof Error ? err.message : String(err)}). Retry in a moment.`,
    502,
  )
}

/**
 * Decide whether a draft is B2B. `purchasingCompany` given = B2B. Otherwise a given customer that
 * is a company contact is B2B. On an update (`draftId`) with no buyer in the input, the existing
 * draft's buyer decides. A read that fails throws B2B_CHECK_FAILED (the guard fails closed).
 */
export async function resolveB2bContext(
  client: ShopClient,
  args: { purchasingCompany?: PurchasingCompanyIds; customerId?: string; draftId?: string },
): Promise<B2bContext> {
  if (args.purchasingCompany) return { b2b: true, existingCompany: null, contactCompanies: [] }
  if (args.customerId) {
    const contactCompanies = await readContactCompanies(client, args.customerId)
    return { b2b: contactCompanies.length > 0, existingCompany: null, contactCompanies }
  }
  if (args.draftId) {
    let draft: DraftBuyerNode | null | undefined
    try {
      const data = await client.query<{ draftOrder?: DraftBuyerNode | null }>(DRAFT_BUYER_QUERY, { id: args.draftId })
      draft = data.draftOrder
    } catch (err) {
      throw b2bCheckFailed(err)
    }
    const pe = draft?.purchasingEntity
    if (pe && (pe.__typename === "PurchasingCompany" || pe.company)) {
      return {
        b2b: true,
        existingCompany: {
          companyName: str(pe.company?.name),
          locationId: str(pe.location?.id),
          locationName: str(pe.location?.name),
        },
        contactCompanies: [],
      }
    }
    const customerId = str(draft?.customer?.id) ?? str(pe?.id)
    if (customerId) {
      const contactCompanies = await readContactCompanies(client, customerId)
      return { b2b: contactCompanies.length > 0, existingCompany: null, contactCompanies }
    }
  }
  return { b2b: false, existingCompany: null, contactCompanies: [] }
}

/** The structured refusal for a B2B buyer placed without a company location. */
export function companyRequiredError(contactCompanies: ContactCompany[]): Error {
  const found = contactCompanies
    .map((c) => {
      const locs = c.locations.length
        ? c.locations.map((l) => `${l.name ?? "location"} (companyLocationId ${l.id})`).join("; ")
        : "no location where this contact holds a role yet: assign one in Shopify first"
      return `${c.companyName ?? "company"} (companyId ${c.companyId}, companyContactId ${c.companyContactId}): ${locs}`
    })
    .join(" | ")
  return makeMutationError(
    "B2B_COMPANY_REQUIRED",
    "This buyer is a B2B company contact, so the draft must be placed for the company location: set " +
      "purchasingEntity.purchasingCompany { companyId, companyLocationId, companyContactId } instead of customerId, " +
      "and send plain { variantId, quantity } lines so the location's catalog prices apply. " +
      (found ? `Found: ${found}.` : "Read the company with companies_search."),
  )
}

const COMPANY_ADDRESS_FIELDS = "address1 address2 city zip province zoneCode countryCode companyName recipient firstName lastName phone"

const PURCHASING_COMPANY_QUERY = `
  query B2bPurchasingCompany($contactId: ID!, $locationId: ID!) {
    companyContact(id: $contactId) {
      id
      company { id name }
      customer {
        id email firstName lastName taxExempt
        defaultAddress { name company address1 address2 zip city province countryCodeV2 }
      }
      roleAssignments(first: 100) { nodes { companyLocation { id } } }
    }
    companyLocation(id: $locationId) {
      id name
      company { id name }
      taxSettings { taxExempt taxRegistrationId }
      shippingAddress { ${COMPANY_ADDRESS_FIELDS} }
      billingAddress { ${COMPANY_ADDRESS_FIELDS} }
    }
  }
`

interface PurchasingCompanyData {
  companyContact?: {
    id?: string | null
    company?: { id?: string | null; name?: string | null } | null
    customer?: {
      id?: string | null
      email?: string | null
      firstName?: string | null
      lastName?: string | null
      taxExempt?: boolean | null
      defaultAddress?: Record<string, unknown> | null
    } | null
    roleAssignments?: { nodes?: Array<{ companyLocation?: { id?: string | null } | null } | null> | null } | null
  } | null
  companyLocation?: {
    id?: string | null
    name?: string | null
    company?: { id?: string | null; name?: string | null } | null
    taxSettings?: { taxExempt?: boolean | null; taxRegistrationId?: string | null } | null
    shippingAddress?: Record<string, unknown> | null
    billingAddress?: Record<string, unknown> | null
  } | null
}

/**
 * Check a `purchasingCompany` before staging: all three ids, the contact and the location belong to
 * the company, and the contact holds a role at the location (Shopify answers "No role assigned for
 * company location" at execution otherwise). Returns what the draft needs from the location.
 */
export async function verifyPurchasingCompany(
  client: ShopClient,
  pc: PurchasingCompanyIds,
): Promise<VerifiedCompanyBuyer> {
  const missing = (["companyId", "companyLocationId", "companyContactId"] as const).filter((k) => !pc[k])
  if (missing.length > 0) {
    throw makeMutationError(
      "B2B_COMPANY_INCOMPLETE",
      `purchasingEntity.purchasingCompany needs companyId, companyLocationId and companyContactId (missing: ${missing.join(", ")}). ` +
        "Read them with companies_search or companies_get.",
    )
  }
  let data: PurchasingCompanyData
  try {
    data = await client.query<PurchasingCompanyData>(PURCHASING_COMPANY_QUERY, {
      contactId: pc.companyContactId,
      locationId: pc.companyLocationId,
    })
  } catch (err) {
    throw b2bCheckFailed(err)
  }
  const contact = data.companyContact
  const location = data.companyLocation
  if (!location || str(location.company?.id) !== pc.companyId) {
    throw makeMutationError(
      "B2B_COMPANY_MISMATCH",
      `companyLocationId ${pc.companyLocationId} is not a location of company ${pc.companyId}. Read the company's locations with companies_get.`,
    )
  }
  if (!contact || str(contact.company?.id) !== pc.companyId) {
    throw makeMutationError(
      "B2B_COMPANY_MISMATCH",
      `companyContactId ${pc.companyContactId} is not a contact of company ${pc.companyId}. Read the company's contacts with companies_get.`,
    )
  }
  const hasRole = (contact.roleAssignments?.nodes ?? []).some((n) => str(n?.companyLocation?.id) === pc.companyLocationId)
  if (!hasRole) {
    throw makeMutationError(
      "B2B_CONTACT_NO_ROLE",
      `The company contact ${pc.companyContactId} holds no role at the location ${location.name ?? pc.companyLocationId}, ` +
        "so Shopify would refuse the draft. Pick a contact that has a role there (companies_get lists each contact's " +
        "roles per location), or assign the contact a role at that location in Shopify first.",
    )
  }
  const c = contact.customer
  return {
    companyId: pc.companyId as string,
    companyName: str(location.company?.name) ?? str(contact.company?.name),
    location: {
      id: pc.companyLocationId as string,
      name: str(location.name),
      taxExempt: typeof location.taxSettings?.taxExempt === "boolean" ? location.taxSettings.taxExempt : null,
      taxRegistrationId: str(location.taxSettings?.taxRegistrationId),
      shippingAddress: isRec(location.shippingAddress) ? location.shippingAddress : null,
      billingAddress: isRec(location.billingAddress) ? location.billingAddress : null,
    },
    contactCustomer: c
      ? {
          id: str(c.id),
          email: str(c.email),
          firstName: str(c.firstName),
          lastName: str(c.lastName),
          taxExempt: typeof c.taxExempt === "boolean" ? c.taxExempt : null,
          defaultAddress: isRec(c.defaultAddress) ? c.defaultAddress : null,
        }
      : null,
  }
}

/** A Shopify CompanyAddress as a MailingAddressInput (recipient split into first/last name). */
export function companyAddressToMailingInput(a: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!a || !str(a.address1)) return undefined
  const out: Record<string, unknown> = {}
  const recipient = str(a.recipient)
  let firstName = str(a.firstName)
  let lastName = str(a.lastName)
  if (!firstName && !lastName && recipient) {
    const parts = recipient.split(/\s+/)
    if (parts.length === 1) firstName = parts[0] ?? null
    else {
      firstName = parts.slice(0, -1).join(" ")
      lastName = parts[parts.length - 1] ?? null
    }
  }
  const set = (k: string, v: string | null): void => {
    if (v) out[k] = v
  }
  set("address1", str(a.address1))
  set("address2", str(a.address2))
  set("city", str(a.city))
  set("zip", str(a.zip))
  set("countryCode", str(a.countryCode))
  set("provinceCode", str(a.zoneCode))
  set("company", str(a.companyName))
  set("firstName", firstName)
  set("lastName", lastName)
  set("phone", str(a.phone))
  return out
}

// The verified B2B buyer of a normalised draft input, for the invoiceability facts (the contact's
// customer is the order's customer; the location's tax settings are the order's). Keyed by the
// normalised input object, so it lives exactly as long as that input.
const VERIFIED_BUYERS = new WeakMap<object, VerifiedCompanyBuyer>()

export function rememberVerifiedBuyer(input: object, buyer: VerifiedCompanyBuyer): void {
  VERIFIED_BUYERS.set(input, buyer)
}

export function verifiedBuyerOf(input: object): VerifiedCompanyBuyer | undefined {
  return VERIFIED_BUYERS.get(input)
}

// ─────────────────────────────────────────────────────────────────────────
//  Pricing rules on a B2B draft (pure)
// ─────────────────────────────────────────────────────────────────────────

/** The price fields on a raw line that set a price the company's catalog would not. */
export function nonCatalogPriceFields(line: Record<string, unknown>): string[] {
  const fields: string[] = []
  if (line.appliedDiscount != null) fields.push("appliedDiscount")
  if ((line.price ?? line.unitPrice ?? line.unit_price) != null) fields.push("price")
  if (line.originalUnitPriceWithCurrency != null || line.originalUnitPrice != null)
    fields.push("originalUnitPriceWithCurrency")
  if (line.priceOverride != null) fields.push("priceOverride")
  return fields
}

/** The refusal for B2B prices set without a priceException, naming each offending line. */
export function priceNotCatalogError(offences: string[]): Error {
  return makeMutationError(
    "B2B_PRICE_NOT_CATALOG",
    "This is a B2B draft: Shopify prices its lines from the company location's catalog, so a line or order " +
      `discount or a custom price is refused unless it carries a priceException. Refused: ${offences.join("; ")}. ` +
      "Send plain { variantId, quantity } lines (the catalog sets the price), or, for a genuine exception, set " +
      `the line's priceOverride {amount, currencyCode} with priceException { reason: ${PRICE_EXCEPTION_REASONS.join(" | ")}, note }.`,
  )
}

// ─────────────────────────────────────────────────────────────────────────
//  Catalog coverage: every catalog-priced line must have a FIXED B2B price
// ─────────────────────────────────────────────────────────────────────────
//
// A variant with no fixed price in any catalog that applies to the location is priced by Shopify
// from the price list's parent adjustment (or the retail price): not a negotiated B2B price. Such a
// line needs a priceException like any other non-catalog price. A catalog that cannot be read
// fails closed.

export interface LocationCatalog {
  id: string
  title: string | null
  priceListId: string | null
  priceListName: string | null
}

const LOCATION_CATALOGS_QUERY = `
  query B2bLocationCatalogs($id: ID!) {
    companyLocation(id: $id) {
      id
      catalogs(first: 25) { nodes { id title status priceList { id name currency } } }
    }
  }
`

function catalogUnreadable(locationLabel: string, err: unknown): Error {
  return makeMutationError(
    "B2B_CATALOG_UNREADABLE",
    `Could not read the catalogs of the company location ${locationLabel}, so this draft's B2B prices cannot be checked ` +
      `(${err instanceof Error ? err.message : String(err)}). Retry, or check that the Shopify app can read products and publications.`,
    502,
  )
}

/** The ACTIVE catalogs that apply to a company location. Throws B2B_CATALOG_UNREADABLE on a failed read. */
export async function readLocationCatalogs(
  client: ShopClient,
  locationId: string,
  locationLabel: string,
): Promise<LocationCatalog[]> {
  let data: {
    companyLocation?: {
      catalogs?: {
        nodes?: Array<{
          id?: string | null
          title?: string | null
          status?: string | null
          priceList?: { id?: string | null; name?: string | null } | null
        } | null> | null
      } | null
    } | null
  }
  try {
    data = await client.query(LOCATION_CATALOGS_QUERY, { id: locationId })
  } catch (err) {
    throw catalogUnreadable(locationLabel, err)
  }
  if (!data.companyLocation?.catalogs) throw catalogUnreadable(locationLabel, new Error("no catalogs returned"))
  return (data.companyLocation.catalogs.nodes ?? []).flatMap((n) => {
    const id = str(n?.id)
    if (!id || (n?.status && n.status !== "ACTIVE")) return []
    return [{ id, title: str(n?.title), priceListId: str(n?.priceList?.id), priceListName: str(n?.priceList?.name) }]
  })
}

/** The numeric tail of a gid (`gid://shopify/ProductVariant/123` → `123`), for a search filter. */
const gidTail = (gid: string): string | null => /\/(\d+)$/.exec(gid)?.[1] ?? null

/**
 * The variants (of `variantIds`) that have a FIXED price in at least one of the catalogs' price
 * lists. One aliased query covers every price list and variant. Throws B2B_CATALOG_UNREADABLE.
 */
export async function variantsWithFixedCatalogPrice(
  client: ShopClient,
  catalogs: LocationCatalog[],
  variantIds: string[],
  locationLabel: string,
): Promise<Set<string>> {
  const out = new Set<string>()
  const lists = catalogs.filter((c) => c.priceListId)
  const variants = [...new Set(variantIds)].flatMap((id) => {
    const tail = gidTail(id)
    return tail ? [{ id, tail }] : []
  })
  if (lists.length === 0 || variants.length === 0) return out
  const fields = lists
    .map(
      (c, i) =>
        `pl${i}: priceList(id: ${JSON.stringify(c.priceListId)}) { id ${variants
          .map(
            (v, j) =>
              `v${j}: prices(first: 1, originType: FIXED, query: ${JSON.stringify(`variant_id:${v.tail}`)}) { nodes { variant { id } } }`,
          )
          .join(" ")} }`,
    )
    .join(" ")
  let data: Record<string, Record<string, { nodes?: Array<{ variant?: { id?: string | null } | null } | null> | null } | string | null> | null>
  try {
    data = await client.query(`query B2bFixedCatalogPrices { ${fields} }`)
  } catch (err) {
    throw catalogUnreadable(locationLabel, err)
  }
  lists.forEach((c, i) => {
    const pl = data?.[`pl${i}`]
    if (!pl) throw catalogUnreadable(locationLabel, new Error(`price list ${c.priceListId} not readable`))
    variants.forEach((v, j) => {
      const conn = pl[`v${j}`]
      const nodes = conn && typeof conn === "object" ? (conn.nodes ?? []) : []
      // The query already filters on this variant: any FIXED price returned covers it.
      if (nodes.some((n) => n != null)) out.add(v.id)
    })
  })
  return out
}

/** The refusal for catalog-priced lines whose variant has no fixed B2B price in any catalog. */
export function noCatalogPriceError(
  missing: Array<{ index: number; variantId: string; label: string | null }>,
  catalogs: LocationCatalog[],
  locationLabel: string,
): Error {
  const checked = catalogs.length
    ? catalogs.map((c) => `${c.title ?? c.id}${c.priceListName ? ` (price list ${c.priceListName})` : " (no price list)"}`).join(", ")
    : `no active catalog applies to ${locationLabel}`
  const lines = missing.map((m) => `line ${m.index + 1}: no B2B price set for ${m.label ?? m.variantId} (${m.variantId}) in ${checked}`)
  return makeMutationError(
    "B2B_NO_CATALOG_PRICE",
    `${lines.join("; ")}. Set one in the catalog's price list, or give an approved exception: ` +
      `priceOverride {amount, currencyCode} with priceException { reason: ${PRICE_EXCEPTION_REASONS.join(" | ")}, note }.`,
  )
}
