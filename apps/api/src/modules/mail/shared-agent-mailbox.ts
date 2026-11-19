// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A person's own mailbox is read by that person and their personal agent, never by a SHARED agent
 * (kind `role` or `system`): a shared agent works for everyone in a room, and an admin who widens
 * its access widens it for the whole organization.
 *
 * The wall itself is row level security: a shared agent's turn marks every transaction
 * (`app.current_agent_shared`, db/rls.ts) and the mail tables' personal-agent-only policies hide
 * every user-owned mailbox from it, so a list or a search simply leaves them out. This module words
 * the refusal a call AIMED at the person's own mailbox gets instead of a bare "not found", names the
 * personal agent that can do it, and refuses a scope request for mail access from a shared agent.
 */
import { and, sql as drizzleSql, eq, isNull } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { agents } from "~/db/schema/kernel/agents"
import { schemaRef } from "~/db/schema-ref"
import { quoteIdent } from "~/lib/sql-utils"
import { UUID_RE } from "~/lib/uuid"
import { isSharedAgentFrame } from "~/modules/agent/runtime/run-context"

/** The error code of every refusal below. */
export const PERSONAL_MAILBOX_SHARED_AGENT_CODE = "personal_mailbox_shared_agent"

const mailSchema = () => drizzleSql.raw(quoteIdent(schemaRef("app_mail")))

/** The handle of this person's own personal agent, or null when they have none. */
export async function personalAgentHandleOf(orgId: string, userId: string): Promise<string | null> {
  const [row] = await withPrivilegedDb(orgId, "personal-agent-handle", (tx) =>
    tx
      .select({ handle: agents.handle })
      .from(agents)
      .where(
        and(
          eq(agents.orgId, orgId),
          eq(agents.ownerUserId, userId),
          eq(agents.kind, "personal"),
          isNull(agents.archivedAt),
        ),
      )
      .orderBy(agents.createdAt, agents.id)
      .limit(1),
  )
  return row?.handle ?? null
}

/** What the agent is told to say: it cannot open the mailbox, the person's own agent can. */
export function personalMailboxRefusalMessage(handle: string | null): string {
  // Handles are stored with their `@` (personal-agent.ts); tolerate one without.
  const at = handle ? (handle.startsWith("@") ? handle : `@${handle}`) : null
  const who = at ? `their personal agent ${at}` : "their own personal agent"
  return (
    "Personal mailboxes can only be read by their owner's personal agent. Tell the user plainly " +
    `that you cannot open their mailbox and that only ${who} can: they should ask ${at ?? "it"} ` +
    "to read, search or reply to their email. Do not file a scope request for it: no grant " +
    'changes this. A shared organization mailbox (one whose ownerType is "org") is different: ' +
    "an admin gives this agent access to it in this agent's settings."
  )
}

export interface PersonalMailboxRefusal {
  code: typeof PERSONAL_MAILBOX_SHARED_AGENT_CODE
  message: string
  retryable: false
  status: 403
  details: { personalAgentHandle: string | null }
}

export async function personalMailboxRefusal(
  orgId: string,
  userId: string,
): Promise<PersonalMailboxRefusal> {
  const handle = await personalAgentHandleOf(orgId, userId)
  return {
    code: PERSONAL_MAILBOX_SHARED_AGENT_CODE,
    message: personalMailboxRefusalMessage(handle),
    retryable: false,
    status: 403,
    details: { personalAgentHandle: handle },
  }
}

/** Is any scope here a mail capability (`mail:*`, `mail:conversations:read`, ...)? */
export function requestsMailScope(scopes: readonly string[]): boolean {
  return scopes.some((s) => s === "mail" || s.startsWith("mail:"))
}

function uuidsOf(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value]
  return list.filter((v): v is string => typeof v === "string" && UUID_RE.test(v))
}

/** The ids a mail tool call aims at, by the parameter names the mail tools use. */
export function mailTargetIds(params: unknown): {
  accountIds: string[]
  conversationIds: string[]
  messageIds: string[]
} {
  const p = (params ?? {}) as Record<string, unknown>
  return {
    accountIds: uuidsOf(p.accountId),
    conversationIds: [...uuidsOf(p.conversationId), ...uuidsOf(p.conversationIds)],
    messageIds: uuidsOf(p.messageId),
  }
}

/**
 * Does any of these ids belong to a mailbox `userId` owns personally? Read privileged: under the
 * shared agent's own context those rows do not exist at all.
 */
export async function aimsAtOwnPersonalMailbox(
  orgId: string,
  userId: string,
  ids: { accountIds: string[]; conversationIds: string[]; messageIds: string[] },
): Promise<boolean> {
  if (ids.accountIds.length + ids.conversationIds.length + ids.messageIds.length === 0) return false
  const schema = mailSchema()
  const arr = (xs: string[]) =>
    drizzleSql`ARRAY[${drizzleSql.join(
      xs.length > 0 ? xs.map((x) => drizzleSql`${x}::uuid`) : [drizzleSql`NULL::uuid`],
      drizzleSql`, `,
    )}]::uuid[]`
  const rows = await withPrivilegedDb(orgId, "shared-agent-mailbox-target", (tx) =>
    tx.execute(drizzleSql`
      SELECT 1
        FROM ${schema}.accounts a
       WHERE a.org_id = ${orgId}::uuid
         AND a.owner_type = 'user'
         AND a.owner_id = ${userId}::uuid
         AND (
           a.id = ANY(${arr(ids.accountIds)})
           OR a.id IN (SELECT c.account_id FROM ${schema}.conversations c
                        WHERE c.org_id = ${orgId}::uuid AND c.id = ANY(${arr(ids.conversationIds)}))
           OR a.id IN (SELECT m.account_id FROM ${schema}.messages m
                        WHERE m.org_id = ${orgId}::uuid AND m.id = ANY(${arr(ids.messageIds)}))
         )
       LIMIT 1`),
  )
  return extractRows(rows).length > 0
}

/**
 * The refusal a mail tool call gets when a SHARED agent aims it at the caller's own personal
 * mailbox, or null to let it run (row level security still hides every personal mailbox from it).
 */
export async function sharedAgentMailToolRefusal(a: {
  orgId: string
  userId: string | null
  params: unknown
}): Promise<PersonalMailboxRefusal | null> {
  if (!a.userId || !isSharedAgentFrame()) return null
  if (!(await aimsAtOwnPersonalMailbox(a.orgId, a.userId, mailTargetIds(a.params)))) return null
  return personalMailboxRefusal(a.orgId, a.userId)
}

/** The same for a mail attachment (a `kernel.files` row hung on a mail message or conversation). */
export async function sharedAgentAttachmentRefusal(a: {
  orgId: string
  userId: string | null
  fileId: string
}): Promise<PersonalMailboxRefusal | null> {
  if (!a.userId || !isSharedAgentFrame() || !UUID_RE.test(a.fileId)) return null
  const rows = await withPrivilegedDb(a.orgId, "shared-agent-mailbox-file", (tx) =>
    tx.execute(drizzleSql`
      SELECT entity_type AS "entityType", entity_id::text AS "entityId"
        FROM ${drizzleSql.raw(quoteIdent(schemaRef("kernel")))}.files
       WHERE id = ${a.fileId}::uuid AND org_id = ${a.orgId}::uuid AND app = 'mail'
       LIMIT 1`),
  )
  const file = extractRows<{ entityType: string; entityId: string | null }>(rows)[0]
  if (!file?.entityId) return null
  const ids = {
    accountIds: [] as string[],
    conversationIds: [] as string[],
    messageIds: [] as string[],
  }
  if (file.entityType === "message" || file.entityType === "messages")
    ids.messageIds.push(file.entityId)
  else if (file.entityType === "conversation" || file.entityType === "conversations")
    ids.conversationIds.push(file.entityId)
  else if (file.entityType === "outbound_staging") ids.accountIds.push(file.entityId)
  else return null
  if (!(await aimsAtOwnPersonalMailbox(a.orgId, a.userId, ids))) return null
  return personalMailboxRefusal(a.orgId, a.userId)
}
