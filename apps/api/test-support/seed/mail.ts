// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mailboxes, conversations, messages and drafts for browser tests, stored as
// PLAINTEXT on UNARMED mailboxes: the same category and the same reasons as
// the seed engine's mail factory (seed/factories/mail/conversations.ts). A
// mailbox arms only once its owner enrols a key in a browser, so a seeded one
// is unarmed and its plaintext columns are the trigger's own supported branch.
// `app_mail` has no host-callable write service (its writer runs inside the
// sandbox behind the sync handlers), so the rows go in the way those handlers
// write them, privileged, schema-prefixed for the run's lane.
//
// What a mailbox stands on is real: its connection is a connected account
// (`ensureMockConnection`, placeholder tokens), a conversation linked to a
// thread links one the person started through the thread service, and a
// message that arrives "live" announces itself through the outbox
// (`tx.queueEvent`), the way the sync handler's write does.
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { createThread } from "~/modules/threads/thread"
import type { SeedContext } from "~/seed/context"
import { actorFor, asUser, rowsOf } from "~/seed/factories/people/actors"
import { ensureMockConnection } from "./mock-connections"

const M = (name: string) => sql.raw(`${schemaRef("app_mail")}.${name}`)

export interface MailAccountInput {
  ownerType: "user" | "org"
  /** The owner (`user`), or the person who connected the org's mailbox (`org`). */
  userId: string
  email: string
  provider: "gmail" | "imap"
}

export interface SeededMailAccount {
  accountId: string
  connectedAccountId: string
  email: string
}

/** A mailbox at `email` on its own connection; the existing one of that address when there is one. */
export async function ensureMailAccount(
  ctx: SeedContext,
  input: MailAccountInput,
): Promise<SeededMailAccount> {
  const { orgId } = ctx
  const connection = await ensureMockConnection(orgId, {
    appName: "mail",
    connectionName: "gmail",
    ownerType: input.ownerType,
    userId: input.userId,
    identifier: input.email,
    displayName: input.email,
    kind: { type: "oauth2" },
  })
  const ownerId = input.ownerType === "user" ? input.userId : null
  return withPrivilegedDb(orgId, "seed-route:mail-account", async (tx) => {
    const [existing] = rowsOf<{ id: string; connected_account_id: string }>(
      await tx.execute(
        sql`SELECT id, connected_account_id FROM ${M("accounts")}
            WHERE org_id = ${orgId}::uuid AND email_address = ${input.email} LIMIT 1`,
      ),
    )
    if (existing) {
      return {
        accountId: existing.id,
        connectedAccountId: existing.connected_account_id,
        email: input.email,
      }
    }
    const accountId = randomUUID()
    await tx.execute(
      sql`INSERT INTO ${M("accounts")}
            (id, org_id, connected_account_id, owner_type, owner_id, provider,
             email_address, display_name, sync_status)
          VALUES (${accountId}::uuid, ${orgId}::uuid, ${connection.id}::uuid,
                  ${input.ownerType}, ${ownerId}::uuid, ${input.provider},
                  ${input.email}, ${input.email}, 'active')`,
    )
    return { accountId, connectedAccountId: connection.id, email: input.email }
  })
}

export interface MailMessageInput {
  direction: "inbound" | "outbound"
  from: { name?: string; email: string }
  to: Array<{ name?: string; email: string }>
  textBody: string
  htmlBody?: string | null
  /** When it was sent (ISO); default now. */
  sentAt?: string
  isRead?: boolean
  /** The teammate who sent it from a shared mailbox. */
  sentByUserId?: string | null
  /** The provider's headers as synced (a JSON object); default none. */
  rawHeaders?: Record<string, string>
}

interface MailboxRow {
  owner_type: "user" | "org"
  owner_id: string | null
}

async function mailbox(ctx: SeedContext, accountId: string): Promise<MailboxRow> {
  const [row] = await withPrivilegedDb(ctx.orgId, "seed-route:mail-mailbox", async (tx) =>
    rowsOf<MailboxRow>(
      await tx.execute(
        sql`SELECT owner_type, owner_id FROM ${M("accounts")}
            WHERE id = ${accountId}::uuid AND org_id = ${ctx.orgId}::uuid`,
      ),
    ),
  )
  if (!row) throw new Error(`mail seed: no mailbox ${accountId} in org ${ctx.orgId}`)
  return row
}

async function insertMessages(
  tx: Parameters<Parameters<typeof withPrivilegedDb>[2]>[0],
  ctx: SeedContext,
  box: MailboxRow & { accountId: string },
  conversationId: string,
  subject: string,
  messages: readonly MailMessageInput[],
): Promise<Array<{ id: string; sentAt: string; m: MailMessageInput }>> {
  const out: Array<{ id: string; sentAt: string; m: MailMessageInput }> = []
  for (const m of messages) {
    const id = randomUUID()
    const sentAt = m.sentAt ?? new Date().toISOString()
    await tx.execute(
      sql`INSERT INTO ${M("messages")}
            (id, org_id, conversation_id, account_id, external_message_id, external_provider_id,
             from_address, to_addresses, cc_addresses, bcc_addresses,
             subject, text_body, html_body, snippet, is_read, is_starred, labels, direction,
             sent_at, synced_at, raw_headers, owner_type, owner_id, in_reply_to,
             message_references, sent_by_user_id)
          VALUES (${id}::uuid, ${ctx.orgId}::uuid, ${conversationId}::uuid, ${box.accountId}::uuid,
                  ${`<${randomUUID()}@e2e.web>`}, ${randomUUID()},
                  ${JSON.stringify(m.from)}::jsonb, ${JSON.stringify(m.to)}::jsonb,
                  '[]'::jsonb, '[]'::jsonb,
                  ${subject}, ${m.textBody}, ${m.htmlBody ?? `<p>${m.textBody}</p>`},
                  ${m.textBody.slice(0, 200)}, ${m.isRead ?? false}, false, '[]'::jsonb,
                  ${m.direction}, ${sentAt}, now(), ${JSON.stringify(m.rawHeaders ?? {})}::jsonb,
                  ${box.owner_type},
                  ${box.owner_id}::uuid, NULL, '[]'::jsonb, ${m.sentByUserId ?? null}::uuid)`,
    )
    out.push({ id, sentAt, m })
  }
  return out
}

export interface MailConversationInput {
  accountId: string
  subject: string
  status: "open" | "archived" | "trashed"
  labels: string[]
  isRead: boolean
  isStarred: boolean
  /** Default: the subject. */
  snippet?: string
  /** The contact the conversation is with (its backlink). */
  contactId?: string | null
  /** The teammate it is assigned to. */
  assignedTo?: string | null
  /** Link a new thread with this title, started by the mailbox's person (or the org's admin). */
  linkThreadTitle?: string
  /** Default: the newest message's time. */
  lastMessageAt?: string
  /** Default: the number of messages given. */
  messageCount?: number
  messages: MailMessageInput[]
}

/** A conversation with its messages, oldest first; ids of the conversation, its messages and any linked thread. */
export async function seedMailConversation(
  ctx: SeedContext,
  input: MailConversationInput & { linkThreadBy?: string },
): Promise<{ conversationId: string; messageIds: string[]; threadId: string | null }> {
  const box = { ...(await mailbox(ctx, input.accountId)), accountId: input.accountId }
  let threadId: string | null = null
  if (input.linkThreadTitle) {
    const starter = box.owner_id ?? input.linkThreadBy
    if (!starter)
      throw new Error("mail seed: a linked thread on a shared mailbox names who starts it")
    const actor = await actorFor(ctx, starter)
    const created = await asUser(actor, (tx) =>
      createThread(
        tx as never,
        {
          orgId: ctx.orgId,
          userId: starter,
          participantIds: [starter],
          title: input.linkThreadTitle,
          forceCreate: true,
        } as never,
      ),
    )
    threadId = (created as { id: string }).id
  }
  const conversationId = randomUUID()
  const newest = input.messages
    .map((m) => m.sentAt ?? new Date().toISOString())
    .sort()
    .at(-1)
  const lastMessageAt = input.lastMessageAt ?? newest ?? new Date().toISOString()
  const ids = await withPrivilegedDb(ctx.orgId, "seed-route:mail-conversation", async (tx) => {
    await tx.execute(
      sql`INSERT INTO ${M("conversations")}
            (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
             status, labels, is_read, is_starred, internal_thread_id, last_message_at, message_count,
             contact_id, assigned_to)
          VALUES (${conversationId}::uuid, ${ctx.orgId}::uuid, ${input.accountId}::uuid,
                  ${box.owner_type}, ${box.owner_id}::uuid, ${randomUUID()}, ${input.subject},
                  ${(input.snippet ?? input.subject).slice(0, 200)}, ${input.status},
                  ${JSON.stringify(input.labels)}::jsonb, ${input.isRead}, ${input.isStarred},
                  ${threadId}::uuid, ${lastMessageAt},
                  ${input.messageCount ?? input.messages.length}, ${input.contactId ?? null}::uuid,
                  ${input.assignedTo ?? null}::uuid)`,
    )
    return insertMessages(tx, ctx, box, conversationId, input.subject, input.messages)
  })
  return { conversationId, messageIds: ids.map((r) => r.id), threadId }
}

/**
 * More messages on a conversation; with `updateConversation` its snippet, last
 * time and count follow. `announce`: each new message and the conversation's change go out
 * through the outbox, as a sync writes them, so an open mail view updates live.
 */
export async function appendMailMessages(
  ctx: SeedContext,
  input: {
    conversationId: string
    messages: MailMessageInput[]
    /** Bring the conversation's snippet, last time and count along. */
    updateConversation: boolean
    announce: boolean
  },
): Promise<{ messageIds: string[] }> {
  const { orgId } = ctx
  const [conv] = await withPrivilegedDb(orgId, "seed-route:mail-conv-read", async (tx) =>
    rowsOf<{ account_id: string; subject: string }>(
      await tx.execute(
        sql`SELECT account_id, subject FROM ${M("conversations")}
            WHERE id = ${input.conversationId}::uuid AND org_id = ${orgId}::uuid`,
      ),
    ),
  )
  if (!conv) throw new Error(`mail seed: no conversation ${input.conversationId}`)
  const box = { ...(await mailbox(ctx, conv.account_id)), accountId: conv.account_id }
  const written = await withPrivilegedDb(orgId, "seed-route:mail-append", async (tx) => {
    const rows = await insertMessages(
      tx,
      ctx,
      box,
      input.conversationId,
      conv.subject,
      input.messages,
    )
    const newest = rows[rows.length - 1]
    if (!newest || !input.updateConversation) return rows
    const snippet = newest.m.textBody.slice(0, 200)
    await tx.execute(
      sql`UPDATE ${M("conversations")}
          SET snippet = ${snippet}, last_message_at = ${newest.sentAt},
              message_count = message_count + ${rows.length}, updated_at = now()
          WHERE id = ${input.conversationId}::uuid`,
    )
    if (input.announce) {
      const actorId = box.owner_id ?? newest.m.sentByUserId ?? null
      for (const r of rows) {
        await tx.queueEvent({
          app: "mail",
          entity: "message",
          action: "create",
          entityId: r.id,
          orgId,
          actorId,
          actorType: "system",
          timestamp: r.sentAt,
          data: {
            id: r.id,
            conversationId: input.conversationId,
            accountId: conv.account_id,
            fromAddress: r.m.from,
            toAddresses: r.m.to,
            ccAddresses: [],
            bccAddresses: [],
            subject: conv.subject,
            textBody: r.m.textBody,
            htmlBody: r.m.htmlBody ?? `<p>${r.m.textBody}</p>`,
            snippet: r.m.textBody.slice(0, 200),
            direction: r.m.direction,
            sentAt: r.sentAt,
            isRead: r.m.isRead ?? false,
            isStarred: false,
          },
        } as never)
      }
      await tx.queueEvent({
        app: "mail",
        entity: "conversation",
        action: "update",
        entityId: input.conversationId,
        orgId,
        actorId,
        actorType: "system",
        timestamp: newest.sentAt,
        data: { id: input.conversationId, snippet, lastMessageAt: newest.sentAt },
      } as never)
    }
    return rows
  })
  return { messageIds: written.map((r) => r.id) }
}

/** A draft by `userId` on a mailbox: a reply on a conversation, or a new message. */
export async function seedMailDraft(
  ctx: SeedContext,
  input: {
    accountId: string
    userId: string
    conversationId?: string | null
    replyToMessageId?: string | null
    to: Array<{ email: string }>
    subject: string
    htmlBody: string
    textBody: string
  },
): Promise<{ draftId: string }> {
  const draftId = randomUUID()
  await withPrivilegedDb(ctx.orgId, "seed-route:mail-draft", (tx) =>
    tx.execute(
      sql`INSERT INTO ${M("drafts")}
            (id, org_id, account_id, conversation_id, reply_to_message_id,
             "to", cc, bcc, subject, html_body, text_body, created_by)
          VALUES (${draftId}::uuid, ${ctx.orgId}::uuid, ${input.accountId}::uuid,
                  ${input.conversationId ?? null}::uuid, ${input.replyToMessageId ?? null}::uuid,
                  ${JSON.stringify(input.to)}::jsonb, '[]'::jsonb, '[]'::jsonb,
                  ${input.subject}, ${input.htmlBody}, ${input.textBody}, ${input.userId}::uuid)`,
    ),
  )
  return { draftId }
}
