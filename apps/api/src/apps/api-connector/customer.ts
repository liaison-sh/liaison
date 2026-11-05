// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Customer resolver behind the customer card and the agent's auto-context.
 *
 * Across every connection whose adapter fills `customer.lookup`: look the
 * participant up by email, then by phone, then by the company domain (each
 * when the lookup declares that param); for each match (at most
 * MAX_MATCHES_PER_CONNECTION) call the connection's `customer.summary`,
 * `customer.orders`, `customer.invoices` and `deal.list` operations when the
 * adapter has them, in parallel, with the match's `id` as `customerId`.
 *
 * Every match says how it was found (`matchedBy`). Only a plain addr-spec is
 * looked up. The domain fallback is skipped for a consumer mail domain
 * (consumer-domains.ts) and for the org's own mailbox and inbox domains: such
 * a domain names no company. `emailOnly` (the agent's context) asks by email
 * alone, so a domain match never reaches the agent as "the sender".
 *
 * Every call is one page, bounded per call and overall, and each connection
 * gets CUSTOMER_REQUEST_BUDGET upstream requests per resolution, shared by the
 * lookup (its chain included) and every role call of every match: the lookup
 * goes first, and a role call that finds the budget spent is left out of the
 * match (no list, no error). The budget is per connection, not shared across
 * connections, so each connection's cached answer never depends on another's
 * usage. A connection that
 * fails reports its error code and never hides the others. Each connection's
 * answer is cached in Redis for 60 s, keyed by org, connection, adapter hash,
 * credential version and the lookup key.
 *
 * Database use is a few short transactions, one after the other, and none
 * while a request is out: the adapter rows and every connection's credentials
 * are loaded once for the whole resolution (one transaction each), the calls
 * share them, and their audit rows are written together after the last call.
 * However many calls a card makes, it holds at most one privileged slot at a
 * time.
 */

import { createHash } from "node:crypto"
import type {
  Adapter,
  CustomerConnectionError,
  CustomerMatch,
  CustomerMatchKey,
  CustomerResolution,
  CustomerSummaryValue,
  Operation,
  ProjectedObject,
  ProjectedValue,
  RoleName,
} from "@liaison/api-connector-core"
import { isStrictEmail } from "@liaison/api-connector-core/contract"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { redis } from "~/lib/redis"
import { quoteIdent } from "~/lib/sql-utils"
import type { AuditEntry } from "~/modules/audit/service"
import { cacheKeyFor, rememberCacheKey } from "./cache"
import { isConsumerMailDomain } from "./consumer-domains"
import { type ConnectorCallActor, runConnectorOperation, writeConnectorAudits } from "./service"
import {
  type AdapterRow,
  type ConnectionCredentials,
  listAdapterRows,
  resolveConnectionsCredentials,
} from "./store"
import { ApiConnectorError, adapterHash, RequestBudget, RequestBudgetError } from "./transport"

export const CUSTOMER_CACHE_TTL_S = 60
export const CUSTOMER_OVERALL_BUDGET_MS = 10_000
export const CUSTOMER_PER_CALL_TIMEOUT_MS = 8_000
/** Upstream requests one connection may receive for one resolution (pages and chain steps included). */
export const CUSTOMER_REQUEST_BUDGET = 20
const MAX_MATCHES_PER_CONNECTION = 3
const MAX_LIST_ITEMS = 20
const MAX_SUMMARY_VALUE = 500

export type { CustomerConnectionError, CustomerMatch, CustomerResolution }

export interface ResolveCustomerInput {
  actor: ConnectorCallActor
  email?: string
  /** A phone number (digits, an optional leading +; spaces, dots, dashes and brackets ignored). */
  phone?: string
  domain?: string
  /** Look up by email only: no phone, no domain fallback (the agent's customer context). */
  emailOnly?: boolean
  /** Overall budget for every call this resolution makes. */
  budgetMs?: number
  /** Per-call timeout (below the overall budget). */
  perCallTimeoutMs?: number
  /** Ask only the first connection (by slug) that fills customer.lookup. */
  firstConnectionOnly?: boolean
  /**
   * The org's adapter rows, when the caller already listed them (the agent's
   * customer context does, to skip every other query for an org without a
   * lookup connection); listed here otherwise.
   */
  adapterRows?: readonly AdapterRow[]
  /** Upstream requests per connection for this resolution (default CUSTOMER_REQUEST_BUDGET). */
  requestBudget?: number
  signal?: AbortSignal
}

function roleOp(adapter: Adapter, role: RoleName): Operation | undefined {
  return adapter.operations.find((o) => o.role === role)
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/**
 * Flatten projected fields into dotted paths for the card, each scalar keeping
 * its type (a number stays a number, so the card formats it for the reader's
 * locale); a list of scalars is joined into one string.
 */
function flatten(
  obj: ProjectedObject,
  prefix = "",
  out: Record<string, CustomerSummaryValue> = {},
): Record<string, CustomerSummaryValue> {
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key
    addValue(path, value, out)
  }
  return out
}

function addValue(
  path: string,
  value: ProjectedValue,
  out: Record<string, CustomerSummaryValue>,
): void {
  if (value === null) return
  if (Array.isArray(value)) {
    const scalars = value.filter(
      (v): v is string | number | boolean => typeof v !== "object" || v === null,
    )
    if (scalars.length === value.length) {
      out[path] = scalars.join(", ").slice(0, MAX_SUMMARY_VALUE)
      return
    }
    value.forEach((v, i) => {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v, `${path}.${i}`, out)
    })
    return
  }
  if (typeof value === "object") {
    flatten(value, path, out)
    return
  }
  out[path] = typeof value === "string" ? value.slice(0, MAX_SUMMARY_VALUE) : value
}

const CURRENCY_FIELDS = ["currency", "currency_code", "currencyCode"]

/** The match with its record's own top-level currency code (ISO 4217 shape, upper-cased), if any. */
function withCurrency(match: CustomerMatch): CustomerMatch {
  for (const key of CURRENCY_FIELDS) {
    const value = match.summary[key]
    if (typeof value === "string" && /^[A-Za-z]{3}$/.test(value)) {
      return { ...match, currency: value.toUpperCase() }
    }
  }
  return match
}

export interface CustomerKey {
  email?: string
  phone?: string
  domain?: string
}

/** The lookups to try, in order (email, phone, domain), each only when the op declares it. */
function lookupAttempts(op: Operation, key: CustomerKey): [CustomerMatchKey, string][] {
  const declared = op.params.properties
  const order: CustomerMatchKey[] = ["email", "phone", "domain"]
  return order.flatMap((k): [CustomerMatchKey, string][] => {
    const value = key[k]
    return value && Object.hasOwn(declared, k) ? [[k, value]] : []
  })
}

async function resolveOnConnection(
  input: ResolveCustomerInput,
  row: AdapterRow,
  credentials: ConnectionCredentials | undefined,
  key: CustomerKey,
  signal: AbortSignal,
  auditSink: AuditEntry[],
): Promise<CustomerMatch[]> {
  const { identifier, adapter } = row
  const lookup = roleOp(adapter, "customer.lookup")
  if (!lookup) return []
  if (!credentials)
    throw new ApiConnectorError(
      "not_configured",
      `The connection "${identifier}" has no credentials yet.`,
    )

  const cacheKey = cacheKeyFor(
    "customer",
    input.actor.orgId,
    identifier,
    adapterHash(adapter),
    credentials.version,
    sha(JSON.stringify([key.email ?? "", key.phone ?? "", key.domain ?? ""])),
  )
  const cached = await redis.get(cacheKey).catch(() => null)
  if (cached) return JSON.parse(cached) as CustomerMatch[]

  const budget = new RequestBudget(input.requestBudget ?? CUSTOMER_REQUEST_BUDGET)
  const call = (operation: Operation, params: Record<string, unknown>) =>
    runConnectorOperation({
      connection: { row, credentials },
      auditSink,
      requestBudget: budget,
      actor: input.actor,
      identifier,
      operation: operation.name,
      params,
      mode: "read",
      maxPages: 1,
      budgetMs: input.perCallTimeoutMs ?? CUSTOMER_PER_CALL_TIMEOUT_MS,
      requestTimeoutMs: input.perCallTimeoutMs ?? CUSTOMER_PER_CALL_TIMEOUT_MS,
      signal,
    })

  let found: ProjectedObject[] = []
  let matchedBy: CustomerMatchKey = "email"
  for (const [by, value] of lookupAttempts(lookup, key)) {
    found = (await call(lookup, { [by]: value })).items
    matchedBy = by
    if (found.length > 0) break
  }

  const summaryOp = roleOp(adapter, "customer.summary")
  const lists: [
    keyof Pick<CustomerMatch, "orders" | "invoices" | "deals">,
    Operation | undefined,
  ][] = [
    ["orders", roleOp(adapter, "customer.orders")],
    ["invoices", roleOp(adapter, "customer.invoices")],
    ["deals", roleOp(adapter, "deal.list")],
  ]
  const matches = await Promise.all(
    found.slice(0, MAX_MATCHES_PER_CONNECTION).map(async (item): Promise<CustomerMatch> => {
      const customerId = item.id
      const idParam =
        typeof customerId === "string" || typeof customerId === "number" ? String(customerId) : null
      const match: CustomerMatch = {
        connection: identifier,
        connectionName: adapter.name,
        matchedBy,
        summary: flatten(item),
      }
      if (idParam === null) return withCurrency(match)
      const [summary, ...listResults] = await Promise.all([
        summaryOp
          ? call(summaryOp, { customerId: idParam })
              .then((r) => r.items[0] ?? null)
              .catch(skipWhenOverBudget)
          : Promise.resolve(null),
        ...lists.map(([, op]) =>
          op
            ? call(op, { customerId: idParam })
                .then((r) => r.items.slice(0, MAX_LIST_ITEMS))
                .catch(skipWhenOverBudget)
            : Promise.resolve(null),
        ),
      ])
      if (summary) match.summary = { ...match.summary, ...flatten(summary) }
      lists.forEach(([name], i) => {
        const items = listResults[i]
        if (items) match[name] = items
      })
      return withCurrency(match)
    }),
  )

  await redis
    .set(cacheKey, JSON.stringify(matches), "EX", CUSTOMER_CACHE_TTL_S)
    .then(() => rememberCacheKey(input.actor.orgId, identifier, cacheKey, CUSTOMER_CACHE_TTL_S))
    .catch(() => undefined)
  return matches
}

/** A role call the resolution's request budget could not cover is left out, not an error. */
function skipWhenOverBudget(err: unknown): null {
  if (err instanceof RequestBudgetError) return null
  throw err
}

const PHONE_RE = /^\+?[0-9]{6,15}$/
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

function table(schema: string, name: string) {
  return drizzleSql.raw(`${quoteIdent(schemaRef(schema))}.${quoteIdent(name)}`)
}

/** The domains of the org's own mailboxes and ticket inboxes (lowercased). */
export async function ownMailDomains(orgId: string): Promise<Set<string>> {
  const out = new Set<string>()
  const read = async (query: ReturnType<typeof drizzleSql>) => {
    try {
      const rows = await withPrivilegedDb(orgId, "api-connector-own-domains", async (tx) =>
        extractRows<{ email: string | null }>(await tx.execute(query)),
      )
      for (const r of rows) {
        const domain = r.email?.trim().toLowerCase().split("@")[1]
        if (domain) out.add(domain)
      }
    } catch {
      // An app that is not installed has no addresses to exclude.
    }
  }
  await read(
    drizzleSql`SELECT email_address AS email FROM ${table("app_mail", "accounts")} WHERE org_id = ${orgId}::uuid`,
  )
  await read(drizzleSql`
    SELECT a AS email FROM ${table("app_tickets", "inboxes")} i,
      LATERAL (VALUES (i.email_address), (i.reply_from_email), (i.reply_to_email)) v(a)
    WHERE i.org_id = ${orgId}::uuid AND a IS NOT NULL`)
  return out
}

/**
 * Normalise the lookup key: a lowercased plain addr-spec (anything else is
 * dropped), a phone of digits with an optional +, and the domain (given, or
 * the email's) unless it names no company: a consumer mail domain or one of
 * `ownDomains`.
 */
export function customerKey(
  input: { email?: string; phone?: string; domain?: string; emailOnly?: boolean },
  ownDomains: ReadonlySet<string> = new Set(),
): CustomerKey {
  const rawEmail = input.email?.trim().toLowerCase()
  const email = rawEmail && isStrictEmail(rawEmail) ? rawEmail : undefined
  if (input.emailOnly) return email ? { email } : {}
  const rawPhone = input.phone?.replace(/[\s().-]/g, "")
  const phone = rawPhone && PHONE_RE.test(rawPhone) ? rawPhone : undefined
  const rawDomain = (input.domain?.trim().toLowerCase() || email?.split("@")[1])?.replace(
    /^www\./,
    "",
  )
  const domain =
    rawDomain &&
    DOMAIN_RE.test(rawDomain) &&
    !isConsumerMailDomain(rawDomain) &&
    !ownDomains.has(rawDomain)
      ? rawDomain
      : undefined
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}), ...(domain ? { domain } : {}) }
}

/** Some connection of the org fills `customer.lookup` (tickets and mail then show the customer card). */
export async function customerLookupConfigured(orgId: string): Promise<boolean> {
  return (await listAdapterRows(orgId)).some((r) => roleOp(r.adapter, "customer.lookup"))
}

export async function resolveCustomer(input: ResolveCustomerInput): Promise<CustomerResolution> {
  const lookupRows = (input.adapterRows ?? (await listAdapterRows(input.actor.orgId))).filter((r) =>
    roleOp(r.adapter, "customer.lookup"),
  )
  const rows = input.firstConnectionOnly ? lookupRows.slice(0, 1) : lookupRows
  const connections = rows.map((r) => ({ identifier: r.identifier, name: r.adapter.name }))
  const ownDomains =
    rows.length > 0 && !input.emailOnly
      ? await ownMailDomains(input.actor.orgId)
      : new Set<string>()
  const key = customerKey(input, ownDomains)
  if (rows.length === 0 || (!key.email && !key.phone && !key.domain)) {
    return { matches: [], configured: rows.length > 0, connections, errors: [] }
  }
  const overall = AbortSignal.timeout(input.budgetMs ?? CUSTOMER_OVERALL_BUDGET_MS)
  const signal = input.signal ? AbortSignal.any([overall, input.signal]) : overall
  const credentials = await resolveConnectionsCredentials(
    input.actor.orgId,
    rows.map((r) => r.identifier),
  )
  const auditSink: AuditEntry[] = []
  const settled = await Promise.allSettled(
    rows.map((r) =>
      resolveOnConnection(input, r, credentials.get(r.identifier), key, signal, auditSink),
    ),
  )
  await writeConnectorAudits(input.actor.orgId, auditSink)
  const matches: CustomerMatch[] = []
  const errors: CustomerConnectionError[] = []
  settled.forEach((s, i) => {
    const row = rows[i]
    if (!row) return
    if (s.status === "fulfilled") matches.push(...s.value)
    else {
      errors.push({
        connection: row.identifier,
        connectionName: row.adapter.name,
        code: s.reason instanceof ApiConnectorError ? s.reason.code : "internal",
      })
    }
  })
  return { matches, configured: true, connections, errors }
}
