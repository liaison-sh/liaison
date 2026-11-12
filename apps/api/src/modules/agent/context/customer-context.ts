// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Customer auto-context: when the user is looking at a ticket or a mail
 * conversation, the agent gets the matched customer's `customer.summary` from
 * the org's API connections, as untrusted external content. The connections
 * are those of the apps whose API connection declares `customerContext`
 * (connections/api/declarations.ts): no app is named here.
 *
 * - Only when the turn's EFFECTIVE scopes (agent ∩ user) hold that app's
 *   read scope: a role agent without it, or a user without it, gets nothing.
 * - The participant's email is read under the actor's RLS (a ticket's
 *   participant by the tickets rule the card uses, `loadTicketParticipantEmail`;
 *   a conversation's first inbound sender that is not one of the org's
 *   mailboxes): an entity the actor cannot see yields nothing. Only a plain
 *   addr-spec is used at all, and it is named inside the untrusted fence.
 * - Email matches only: no phone, no domain fallback, so a company-domain
 *   record (the card may show it, labelled) never reaches the agent as the
 *   sender.
 * - At most one connection (the first configured with customer.lookup),
 *   listed first so an org without one pays no other query; one page per
 *   call; a hard 1.5 s budget over the whole lookup (the resolver's 60 s cache
 *   answers repeat views at once); a miss, a timeout or an error leaves the
 *   block out.
 * - Injecting it is a read of connector data: the turn records the read scope
 *   (scope taint) and is marked tainted, exactly as a `connector_read` call.
 * - Around the fence, in our own words (never the upstream's), the block says
 *   which system the record came from, that it is the system of record for
 *   the customer's orders, invoices or deals (only the roles the adapter
 *   fills), and which connector_read operation answers each, plus its write
 *   operations: an org that also runs a shop, an invoicing app and Liaison's
 *   own contacts otherwise answers from those and calls a write to its own
 *   contacts a CRM write. The context assembler loads the connector tools for
 *   such a turn and passes them in, and a tool is named only when it is
 *   loaded, so every operation named here is callable from step one.
 */
import { type Adapter, promptSafeName, type RoleName } from "@liaison/api-connector-core"
import { isStrictEmail } from "@liaison/api-connector-core/contract"
import { firstExternalInboundSender } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { loadTicketParticipantEmail } from "~/apps/tickets/participants"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { wrapExternalContent } from "~/lib/external-content"
import { rootLogger } from "~/lib/logger"
import { quoteIdent } from "~/lib/sql-utils"
import type { TurnScopeAccumulator } from "~/modules/agent/scopes/turn-scope-accumulator"
import { resolveCustomer } from "~/modules/apps/connections/api/customer"
import {
  type ApiConnDecl,
  type ApiCustomerContextDecl,
  customerContextConnections,
} from "~/modules/apps/connections/api/declarations"
import { type AdapterRow, listAdapterRows } from "~/modules/apps/connections/api/store"
import { hasScope } from "~/modules/permissions/permissions"

const log = rootLogger.child({ module: "customer-context" })

/** The app whose connection a block came from, with its customer contract. */
export type CustomerContextSource = ApiConnDecl & { customer: ApiCustomerContextDecl }

/** The app's tools a turn with a customer block loads (tool names, not SDK names). */
export function customerContextTools(source: CustomerContextSource): ReadonlySet<string> {
  return new Set([source.customer.listTool, source.customer.readTool, source.customer.writeTool])
}

/** A loaded customer block: its text and the connection it came from. */
export interface CustomerContextBlock {
  text: string
  source: CustomerContextSource
}

/** The roles a customer question reaches past the summary: role, noun, what each answers. */
const FOLLOW_UP_ROLES: readonly [RoleName, string, string][] = [
  ["customer.orders", "orders", "their orders"],
  ["customer.invoices", "invoices", "their invoices (amounts, due dates, paid or overdue)"],
  ["deal.list", "deals", "their deals"],
]
export const CUSTOMER_CONTEXT_BUDGET_MS = 1_500
export const CUSTOMER_CONTEXT_MAX_BYTES = 2 * 1024

function table(schema: string, name: string) {
  return drizzleSql.raw(`${quoteIdent(schemaRef(schema))}.${quoteIdent(name)}`)
}

/** The surfaces the block is offered on. */
const SURFACES = new Set(["tickets:ticket", "mail:conversation"])

/** The org's own mailbox addresses (org-scoped; used only to exclude them). */
async function orgMailboxAddresses(orgId: string): Promise<string[]> {
  const rows = await withPrivilegedDb(orgId, "customer-context-own-mailboxes", async (tx) =>
    extractRows<{ email: string | null }>(
      await tx.execute(
        drizzleSql`SELECT email_address AS email FROM ${table("app_mail", "accounts")} WHERE org_id = ${orgId}::uuid`,
      ),
    ),
  )
  return rows.flatMap((r) => (r.email ? [r.email] : []))
}

/**
 * The external participant, by the rule the web card uses: a ticket's
 * participant (`loadTicketParticipantEmail`, which also answers `tickets:get`
 * participantEmail), or the conversation's first inbound sender that is not
 * one of the org's mailboxes (`firstExternalInboundSender`). Read under the
 * actor's RLS. A plain addr-spec only.
 */
export async function participantEmail(
  currentView: { tabType: string; entityId: string },
  actor: UserContext,
): Promise<string | null> {
  if (currentView.tabType === "tickets:ticket") {
    return withRlsContext(actor, (tx) =>
      loadTicketParticipantEmail(tx, actor.orgId, currentView.entityId),
    )
  }
  const messages = await withRlsContext(actor, async (tx) =>
    extractRows<{ direction: string; email: string | null; sent_at: string | Date | null }>(
      await tx.execute(
        drizzleSql`SELECT direction, from_address ->> 'email' AS email, sent_at
          FROM ${table("app_mail", "messages")}
          WHERE conversation_id = ${currentView.entityId}::uuid
          ORDER BY sent_at ASC NULLS LAST, created_at ASC
          LIMIT 200`,
      ),
    ),
  )
  if (messages.length === 0) return null
  return firstExternalInboundSender(
    messages.map((m) => ({ direction: m.direction, fromEmail: m.email, sentAt: m.sent_at })),
    await orgMailboxAddresses(actor.orgId),
    isStrictEmail,
  )
}

function clipUtf8(text: string, maxBytes: number): string {
  const enc = new TextEncoder()
  if (enc.encode(text).byteLength <= maxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (enc.encode(text.slice(0, mid)).byteLength <= maxBytes - 3) lo = mid
    else hi = mid - 1
  }
  return `${text.slice(0, lo)}…`
}

/** The follow-up roles the adapter fills, each with its read operation. */
function filledRoles(adapter: Adapter): { what: string; noun: string; op: string }[] {
  return FOLLOW_UP_ROLES.flatMap(([role, noun, what]) => {
    const op = adapter.operations.find((o) => o.kind === "read" && o.role === role)
    return op ? [{ what, noun, op: op.name }] : []
  })
}

function joinNouns(nouns: string[]): string {
  if (nouns.length <= 1) return nouns.join("")
  return `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`
}

/**
 * Where the record came from, and what it is the system of record for: only
 * the roles the adapter fills (the same source as the guide's reads), and no
 * system-of-record claim at all when it fills none of them.
 */
function header(system: string, connection: string, adapter: Adapter): string {
  const source = `Customer record from ${system} (connection "${connection}").`
  const nouns = filledRoles(adapter).map((r) => r.noun)
  if (nouns.length === 0) return source
  return `${source} ${system} is the system of record for this customer's ${joinNouns(nouns)}: answer about them from it, before any other app (a shop, an invoicing app or Liaison's own contacts hold other records, and can disagree with it).`
}

/**
 * How to go past the summary, in our words: the read operation for each role
 * the adapter fills, and its write operations when the turn may write. A tool
 * is named only when the turn loads it (`callableTools`). Every name here is
 * the admin's adapter configuration, never upstream data; the customer's id
 * is pointed at inside the fence rather than repeated outside.
 */
function connectionGuide(
  source: CustomerContextSource,
  system: string,
  connection: string,
  adapter: Adapter,
  effectiveScopes: readonly string[],
  callableTools: ReadonlySet<string>,
): string[] {
  const out: string[] = []
  const readTool = `${source.app}__${source.customer.readTool}`
  const writeTool = `${source.app}__${source.customer.writeTool}`
  const reads = filledRoles(adapter).map((r) => `- ${r.what}: operation "${r.op}"`)
  if (reads.length > 0 && callableTools.has(readTool)) {
    out.push(
      `The record above is a summary only. For more, call ${readTool} with connection "${connection}", the operation below and params {"customerId": the record's id above}:`,
      ...reads,
    )
  }
  const writes = adapter.operations
    .filter((o) => o.kind === "write")
    .map((o) => `"${o.name}" (params: ${Object.keys(o.params.properties).join(", ") || "none"})`)
  if (
    writes.length > 0 &&
    callableTools.has(writeTool) &&
    hasScope(source.decl.writeScope, [...effectiveScopes])
  ) {
    out.push(
      `To change something in ${system} (for example "add a note in the CRM"), call ${writeTool} with connection "${connection}" (write operations: ${writes.join(", ")}); a person approves it before it runs. A write to another app, such as Liaison's own contacts, is not a write to ${system}: never describe it as one.`,
    )
  }
  return out
}

export interface CustomerContextInput {
  currentView: { tabType: string; entityId: string } | undefined
  orgId: string
  actor: UserContext
  /** The turn's effective scopes (agent ∩ user). */
  effectiveScopes: readonly string[]
  /**
   * The source app's customer tools the turn loads when a block is added (SDK
   * names), asked only once there is a record. Empty when the caller loads
   * none (the REST composition preview): the block then names no tool.
   */
  callableTools: (source: CustomerContextSource) => ReadonlySet<string>
  budgetMs?: number
}

/** The first connection (by app, then slug) the turn may read that fills `customer.lookup`. */
async function lookupConnection(
  input: CustomerContextInput,
): Promise<{ source: CustomerContextSource; row: AdapterRow } | null> {
  for (const source of customerContextConnections(input.orgId)) {
    if (!hasScope(source.decl.readScope, [...input.effectiveScopes])) continue
    const [row] = (await listAdapterRows(source)).filter((r) =>
      r.adapter.operations.some((o) => o.role === "customer.lookup"),
    )
    if (row) return { source, row }
  }
  return null
}

async function buildBlock(
  input: CustomerContextInput,
  view: { tabType: string; entityId: string },
  budgetMs: number,
  signal: AbortSignal,
): Promise<CustomerContextBlock | null> {
  // The connection first: an org without one pays no participant query.
  const found = await lookupConnection(input)
  if (!found || signal.aborted) return null
  const { source, row } = found
  const email = await participantEmail(view, input.actor)
  if (!email || !isStrictEmail(email) || signal.aborted) return null
  const resolution = await resolveCustomer({
    actor: { orgId: input.orgId, userId: input.actor.userId, actorType: "agent" },
    conn: source,
    email,
    emailOnly: true,
    budgetMs,
    perCallTimeoutMs: budgetMs,
    firstConnectionOnly: true,
    adapterRows: [row],
    signal,
  })
  const match = resolution.matches.find((m) => m.matchedBy === "email")
  if (!match || signal.aborted) return null
  const lines = Object.entries(match.summary).map(([k, v]) => `${k}: ${v}`)
  // The sender's address came from outside too: it is named inside the fence.
  const body = clipUtf8(
    [`Looked up by the sender's email: ${email}`, ...lines].join("\n"),
    CUSTOMER_CONTEXT_MAX_BYTES,
  )
  // The display name is the admin's, schema-checked; normalized again here.
  const system = promptSafeName(row.adapter.name)
  const text = [
    header(system, row.identifier, row.adapter),
    wrapExternalContent(body),
    ...connectionGuide(
      source,
      system,
      row.identifier,
      row.adapter,
      input.effectiveScopes,
      input.callableTools(source),
    ),
  ].join("\n")
  return { text, source }
}

/**
 * The fenced customer block for this view, or null. Never throws, and never
 * outlasts its budget: the whole lookup (connection, participant, resolver)
 * races it.
 */
export async function loadCustomerContextBlock(
  input: CustomerContextInput,
): Promise<CustomerContextBlock | null> {
  const view = input.currentView
  if (!view || !SURFACES.has(view.tabType)) return null
  const budgetMs = input.budgetMs ?? CUSTOMER_CONTEXT_BUDGET_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("customer context budget exceeded"))
      resolve(null)
    }, budgetMs)
  })
  const work = buildBlock(input, view, budgetMs, controller.signal).catch((err: unknown) => {
    log.warn({ err, tabType: view.tabType }, "customer context unavailable")
    return null
  })
  try {
    return await Promise.race([work, expired])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Append the customer block (loaded by `loadCustomerContextBlock`) to the
 * turn's tail and taint the turn the way a connector read does. Returns true
 * when a block was added.
 */
export async function applyCustomerContext(input: {
  block: CustomerContextBlock | null
  tailLines: string[]
  turnScopeAccumulator?: TurnScopeAccumulator
  /** Marks the thread tainted (persisted); called once when a block is added. */
  markTainted: () => Promise<void>
}): Promise<boolean> {
  if (!input.block) return false
  input.tailLines.push(input.block.text)
  input.turnScopeAccumulator?.recordInjected([input.block.source.decl.readScope])
  await input.markTainted().catch((err) => log.warn({ err }, "could not mark the thread tainted"))
  return true
}
