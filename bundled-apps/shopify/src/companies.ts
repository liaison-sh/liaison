// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify B2B companies (read_companies): `companies_search` and `companies_get`.
//
// A B2B draft order is placed for a company LOCATION, by a company CONTACT who holds a role at that
// location; the catalogs that apply to the location price its lines. These reads hand the agent
// exactly the ids `draft_orders_create` needs (`purchasingEntity.purchasingCompany { companyId,
// companyLocationId, companyContactId }`), each location's addresses and tax settings, each
// contact's roles per location, and the location's catalogs when the app can read them.

import type { AppContext } from "@liaison/app-sdk"
import { getShopifyClient } from "./lib/get-client"

const ADDRESS_FIELDS = "address1 address2 city zip province zoneCode countryCode companyName recipient phone"

const CATALOGS_SELECTION = "catalogs(first: 10) { nodes { id title status priceList { id name currency } } }"

const companySelection = (withCatalogs: boolean): string => `
  id name externalId note
  mainContact { id }
  locations(first: 25) {
    nodes {
      id name
      taxSettings { taxExempt taxRegistrationId }
      shippingAddress { ${ADDRESS_FIELDS} }
      billingAddress { ${ADDRESS_FIELDS} }
      ${withCatalogs ? CATALOGS_SELECTION : ""}
    }
  }
  contacts(first: 50) {
    nodes {
      id title isMainContact
      customer { id email firstName lastName }
      roleAssignments(first: 25) { nodes { role { name } companyLocation { id name } } }
    }
  }
`

const searchQuery = (withCatalogs: boolean): string => `
  query CompaniesSearch($query: String, $first: Int!, $after: String) {
    companies(first: $first, after: $after, query: $query) {
      nodes { ${companySelection(withCatalogs)} }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const getQuery = (withCatalogs: boolean): string => `
  query CompanyGet($id: ID!) {
    company(id: $id) { ${companySelection(withCatalogs)} }
  }
`

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => v != null && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null)
const nodesOf = (conn: unknown): Rec[] =>
  isRec(conn) && Array.isArray(conn.nodes) ? (conn.nodes.filter(isRec) as Rec[]) : []

export interface CompanyCatalog {
  id: string
  title: string | null
  status: string | null
  priceList: { id: string; name: string | null; currency: string | null } | null
}

export interface CompanyLocationOut {
  id: string
  name: string | null
  taxExempt: boolean | null
  taxRegistrationId: string | null
  shippingAddress: Rec | null
  billingAddress: Rec | null
  /** The catalogs that apply to this location; null when the app cannot read catalogs. */
  catalogs: CompanyCatalog[] | null
}

export interface CompanyContactOut {
  id: string
  title: string | null
  isMainContact: boolean
  customer: { id: string | null; email: string | null; firstName: string | null; lastName: string | null } | null
  /** Where this contact may order: one entry per location it holds a role at. */
  roles: Array<{ locationId: string; locationName: string | null; role: string | null }>
}

export interface CompanyOut {
  id: string
  name: string | null
  externalId: string | null
  note: string | null
  mainContactId: string | null
  locations: CompanyLocationOut[]
  contacts: CompanyContactOut[]
}

function address(v: unknown): Rec | null {
  if (!isRec(v)) return null
  const out: Rec = {}
  for (const k of ADDRESS_FIELDS.split(" ")) if (v[k] != null) out[k] = v[k]
  return Object.keys(out).length > 0 ? out : null
}

function normalizeCompany(node: Rec, withCatalogs: boolean): CompanyOut {
  const locations = nodesOf(node.locations).map((l): CompanyLocationOut => {
    const tax = isRec(l.taxSettings) ? l.taxSettings : {}
    return {
      id: String(l.id),
      name: str(l.name),
      taxExempt: typeof tax.taxExempt === "boolean" ? tax.taxExempt : null,
      taxRegistrationId: str(tax.taxRegistrationId),
      shippingAddress: address(l.shippingAddress),
      billingAddress: address(l.billingAddress),
      catalogs: withCatalogs
        ? nodesOf(l.catalogs).map((c) => {
            const pl = isRec(c.priceList) ? c.priceList : null
            return {
              id: String(c.id),
              title: str(c.title),
              status: str(c.status),
              priceList: pl ? { id: String(pl.id), name: str(pl.name), currency: str(pl.currency) } : null,
            }
          })
        : null,
    }
  })
  const contacts = nodesOf(node.contacts).map((c): CompanyContactOut => {
    const cust = isRec(c.customer) ? c.customer : null
    return {
      id: String(c.id),
      title: str(c.title),
      isMainContact: c.isMainContact === true,
      customer: cust
        ? { id: str(cust.id), email: str(cust.email), firstName: str(cust.firstName), lastName: str(cust.lastName) }
        : null,
      roles: nodesOf(c.roleAssignments).flatMap((r) => {
        const loc = isRec(r.companyLocation) ? r.companyLocation : null
        const locationId = str(loc?.id)
        if (!locationId) return []
        return [{ locationId, locationName: str(loc?.name), role: isRec(r.role) ? str(r.role.name) : null }]
      }),
    }
  })
  return {
    id: String(node.id),
    name: str(node.name),
    externalId: str(node.externalId),
    note: str(node.note),
    mainContactId: isRec(node.mainContact) ? str(node.mainContact.id) : null,
    locations,
    contacts,
  }
}

interface CompanyReadError extends Error {
  code: string
}
function readError(code: string, message: string): CompanyReadError {
  const e = new Error(message) as CompanyReadError
  e.code = code
  return e
}

/** Run a company query with catalogs; when catalogs cannot be read, run it again without them. */
async function withCatalogFallback<T>(
  run: (withCatalogs: boolean) => Promise<T>,
): Promise<{ data: T; catalogsReadable: boolean }> {
  try {
    return { data: await run(true), catalogsReadable: true }
  } catch {
    return { data: await run(false), catalogsReadable: false }
  }
}

/**
 * Shopify's company search string. `name` searches the company name (one word: a prefix match); `query` is
 * passed as is (a bare term is Shopify's default text search, `key:value` filters such as
 * `external_id:` work too).
 */
export function companiesQueryString(params: Rec): string | null {
  const q = str(params.query)?.trim()
  if (q) return q
  const name = str(params.name)?.trim().replace(/["\\]/g, "")
  if (!name) return null
  // One word: a prefix match. Several words: the quoted phrase.
  return /\s/.test(name) ? `name:"${name}"` : `name:${name}*`
}

export async function companies_search(
  params: Rec,
  ctx: AppContext,
): Promise<{ results: CompanyOut[]; nextCursor: string | null; catalogsReadable: boolean }> {
  const n = Number(params.limit)
  const first = Number.isFinite(n) && n > 0 ? Math.min(25, Math.floor(n)) : 10
  const client = await getShopifyClient(ctx)
  const vars = { query: companiesQueryString(params), first, after: str(params.cursor) }
  const { data, catalogsReadable } = await withCatalogFallback((withCatalogs) =>
    client.query<{ companies?: { nodes?: Rec[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } }>(
      searchQuery(withCatalogs),
      vars,
    ),
  )
  const page = data.companies
  return {
    results: (page?.nodes ?? []).filter(isRec).map((c) => normalizeCompany(c, catalogsReadable)),
    nextCursor: page?.pageInfo?.hasNextPage ? (page.pageInfo.endCursor ?? null) : null,
    catalogsReadable,
  }
}

export async function companies_get(
  params: Rec,
  ctx: AppContext,
): Promise<CompanyOut & { catalogsReadable: boolean }> {
  const id = str(params.id)
  if (!id) throw readError("BAD_PARAM", "id is required (a gid://shopify/Company/… id from companies_search)")
  const client = await getShopifyClient(ctx)
  const { data, catalogsReadable } = await withCatalogFallback((withCatalogs) =>
    client.query<{ company?: Rec | null }>(getQuery(withCatalogs), { id }),
  )
  if (!data.company) throw readError("NOT_FOUND", `company ${id} not found`)
  return { ...normalizeCompany(data.company, catalogsReadable), catalogsReadable }
}
