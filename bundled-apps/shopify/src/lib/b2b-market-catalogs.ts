// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The B2B catalogs a company location gets through a MARKET.
//
// A catalog reaches a company location two ways: assigned to the location directly
// (`companyLocation.catalogs`, a Shopify Plus feature), or through a B2B market whose
// `conditions.companyLocationsCondition` includes the location (every plan with B2B). Only the
// second exists outside Plus, so reading the direct catalogs alone misses every B2B price there.
//
// A market counts only when it is ACTIVE and its company-locations condition applies to ALL
// company locations or lists this one. A region or retail market (no company-locations condition)
// never counts, even when its price list has a fixed price for the variant: that is not a B2B price.
//
// Every list is read in full or the read fails: a truncated list could hide the catalog that
// applies, so the caller fails closed (B2B_CATALOG_UNREADABLE) rather than guess.

interface QueryClient {
  query<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T>
}

export interface MarketCatalogRef {
  id: string
  title: string | null
  status: string | null
  priceList: { id: string; name: string | null; currency: string | null } | null
  marketId: string
  marketName: string | null
}

const MARKETS_PAGE = 50
const MAX_MARKET_PAGES = 10
const LOCATIONS_PAGE = 250
const MAX_LOCATION_PAGES = 20

const MARKETS_QUERY = `
  query B2bMarketsList($after: String) {
    markets(first: ${MARKETS_PAGE}, after: $after) {
      nodes { id name status conditions { companyLocationsCondition { applicationLevel } } }
      pageInfo { hasNextPage endCursor }
    }
  }
`

const MARKET_CATALOGS_QUERY = `
  query B2bMarketCatalogs($id: ID!, $after: String) {
    market(id: $id) {
      id name status
      conditions {
        companyLocationsCondition {
          applicationLevel
          companyLocations(first: ${LOCATIONS_PAGE}, after: $after) { nodes { id } pageInfo { hasNextPage endCursor } }
        }
      }
      catalogs(first: 25) { nodes { id title status priceList { id name currency } } pageInfo { hasNextPage } }
    }
  }
`

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => v != null && typeof v === "object" && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null)
const nodesOf = (conn: unknown): Rec[] =>
  isRec(conn) && Array.isArray(conn.nodes) ? (conn.nodes.filter(isRec) as Rec[]) : []
const pageOf = (conn: unknown): { hasNextPage: boolean; endCursor: string | null } => {
  const p = isRec(conn) && isRec(conn.pageInfo) ? conn.pageInfo : {}
  return { hasNextPage: p.hasNextPage === true, endCursor: str(p.endCursor) }
}

/** The ACTIVE markets that carry a company-locations condition. Throws on a failed or truncated read. */
async function readB2bMarkets(
  client: QueryClient,
): Promise<Array<{ id: string; appliesToAll: boolean }>> {
  const out: Array<{ id: string; appliesToAll: boolean }> = []
  let after: string | null = null
  for (let page = 0; page < MAX_MARKET_PAGES; page++) {
    const data: { markets?: unknown } = await client.query(MARKETS_QUERY, { after })
    if (!isRec(data?.markets)) throw new Error("markets not returned")
    for (const m of nodesOf(data.markets)) {
      const id = str(m.id)
      const cond = isRec(m.conditions) ? m.conditions.companyLocationsCondition : null
      if (!id || m.status !== "ACTIVE" || !isRec(cond)) continue
      out.push({ id, appliesToAll: cond.applicationLevel === "ALL" })
    }
    const p = pageOf(data.markets)
    if (!p.hasNextPage) return out
    if (!p.endCursor) throw new Error("markets list truncated (no cursor)")
    after = p.endCursor
  }
  throw new Error(`more than ${MARKETS_PAGE * MAX_MARKET_PAGES} markets: the list was truncated`)
}

/** One B2B market's catalogs and the company locations its condition lists. Throws on a truncated read. */
async function readMarket(
  client: QueryClient,
  marketId: string,
  appliesToAll: boolean,
): Promise<{ name: string | null; catalogs: Rec[]; locationIds: Set<string> }> {
  const locationIds = new Set<string>()
  let after: string | null = null
  let name: string | null = null
  let catalogs: Rec[] = []
  for (let page = 0; page < MAX_LOCATION_PAGES; page++) {
    const data: { market?: unknown } = await client.query(MARKET_CATALOGS_QUERY, {
      id: marketId,
      after,
    })
    const m = data?.market
    if (!isRec(m)) throw new Error(`market ${marketId} not readable`)
    name = str(m.name)
    if (!isRec(m.catalogs)) throw new Error(`catalogs of market ${name ?? marketId} not returned`)
    if (pageOf(m.catalogs).hasNextPage)
      throw new Error(`market ${name ?? marketId} has more than 25 catalogs`)
    catalogs = nodesOf(m.catalogs)
    if (appliesToAll) return { name, catalogs, locationIds }
    const cond = isRec(m.conditions) ? m.conditions.companyLocationsCondition : null
    const locs = isRec(cond) ? cond.companyLocations : null
    if (!isRec(locs))
      throw new Error(`company locations of market ${name ?? marketId} not returned`)
    for (const l of nodesOf(locs)) {
      const id = str(l.id)
      if (id) locationIds.add(id)
    }
    const p = pageOf(locs)
    if (!p.hasNextPage) return { name, catalogs, locationIds }
    if (!p.endCursor)
      throw new Error(`company locations of market ${name ?? marketId} truncated (no cursor)`)
    after = p.endCursor
  }
  throw new Error(
    `market ${name ?? marketId} lists more than ${LOCATIONS_PAGE * MAX_LOCATION_PAGES} company locations`,
  )
}

/**
 * For each of `locationIds`, the catalogs it gets through ACTIVE B2B markets (any catalog status;
 * the caller decides which statuses count). Throws on a failed or truncated read.
 */
export async function readB2bMarketCatalogs(
  client: QueryClient,
  locationIds: string[],
): Promise<Map<string, MarketCatalogRef[]>> {
  const out = new Map<string, MarketCatalogRef[]>(locationIds.map((id) => [id, []]))
  if (locationIds.length === 0) return out
  const markets = await readB2bMarkets(client)
  for (const market of markets) {
    const {
      name,
      catalogs,
      locationIds: listed,
    } = await readMarket(client, market.id, market.appliesToAll)
    const refs = catalogs.flatMap((c): MarketCatalogRef[] => {
      const id = str(c.id)
      if (!id) return []
      const pl = isRec(c.priceList) ? c.priceList : null
      const plId = str(pl?.id)
      return [
        {
          id,
          title: str(c.title),
          status: str(c.status),
          priceList:
            pl && plId ? { id: plId, name: str(pl.name), currency: str(pl.currency) } : null,
          marketId: market.id,
          marketName: name,
        },
      ]
    })
    for (const loc of locationIds) {
      if (market.appliesToAll || listed.has(loc)) out.get(loc)?.push(...refs)
    }
  }
  return out
}
