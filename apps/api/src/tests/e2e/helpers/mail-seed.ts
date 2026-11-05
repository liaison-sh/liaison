// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mail conversations, messages, contacts and app config for api end-to-end
// scenarios, made in the server under test by the seed route's factories
// (`mail.conversation`, `mail.messages`, `people.contact`, `apps.configKey`;
// test-support/seed/). The scenario runs in another process, so no row is
// written from here; only the read queries stay.
import type { WorkerEnv } from "@liaison/test-helpers"
import { seedFactory } from "./seed-factory"

type Address = { name?: string; email: string }

interface SeedConversationParams {
  accountId: string
  orgId: string
  /** The mailbox's owner: the conversation takes it from its mailbox. */
  ownerType?: string
  ownerId?: string | null
  subject: string
  /** open | archived | trashed (checked by the factory). */
  status?: string
  isRead?: boolean
  isStarred?: boolean
  contactId?: string | null
  assignedTo?: string | null
  labels?: string[]
  messageCount?: number
  lastMessageAt?: string
}

interface SeedMessageParams {
  conversationId: string
  orgId: string
  accountId?: string
  ownerType?: string
  ownerId?: string | null
  fromAddress: Address
  toAddresses: Address[]
  /** The conversation's subject is the message's. */
  subject?: string
  textBody: string
  htmlBody?: string
  direction: "inbound" | "outbound"
  sentAt: string
  isRead?: boolean
}

type ConversationMessage = Omit<SeedMessageParams, "conversationId" | "orgId">

function messageArgs(m: ConversationMessage) {
  return {
    direction: m.direction,
    from: m.fromAddress,
    to: m.toAddresses,
    textBody: m.textBody,
    ...(m.htmlBody !== undefined ? { htmlBody: m.htmlBody } : {}),
    sentAt: m.sentAt,
    ...(m.isRead !== undefined ? { isRead: m.isRead } : {}),
  }
}

async function conversation(
  env: WorkerEnv,
  params: SeedConversationParams,
  messages: ConversationMessage[],
): Promise<{ conversationId: string; messageIds: string[] }> {
  return seedFactory(env, params.orgId, "mail.conversation", {
    accountId: params.accountId,
    subject: params.subject,
    ...(params.status ? { status: params.status } : {}),
    ...(params.isRead !== undefined ? { isRead: params.isRead } : {}),
    ...(params.isStarred !== undefined ? { isStarred: params.isStarred } : {}),
    ...(params.labels ? { labels: params.labels } : {}),
    contactId: params.contactId ?? null,
    assignedTo: params.assignedTo ?? null,
    ...(params.lastMessageAt ? { lastMessageAt: params.lastMessageAt } : {}),
    ...(params.messageCount !== undefined ? { messageCount: params.messageCount } : {}),
    messages: messages.map(messageArgs),
  })
}

/** A conversation on a mailbox, with no messages (the scenario adds them with `seedMessage`). */
export async function seedConversation(
  env: WorkerEnv,
  params: SeedConversationParams,
): Promise<{ id: string }> {
  const { conversationId } = await conversation(env, { messageCount: 0, ...params }, [])
  return { id: conversationId }
}

/** One message on a conversation, leaving the conversation's own columns as they are. */
export async function seedMessage(
  env: WorkerEnv,
  params: SeedMessageParams,
): Promise<{ id: string }> {
  const { messageIds } = await seedFactory<{ messageIds: string[] }>(
    env,
    params.orgId,
    "mail.messages",
    {
      conversationId: params.conversationId,
      messages: [messageArgs(params)],
      updateConversation: false,
    },
  )
  const id = messageIds[0]
  if (!id) throw new Error("seedMessage: no message written")
  return { id }
}

/** A conversation with its messages, oldest first; its last time is its newest message's. */
export async function seedConversationWithMessages(
  env: WorkerEnv,
  conv: SeedConversationParams,
  messages: ConversationMessage[],
): Promise<{ conversationId: string; messageIds: string[] }> {
  const lastMsg = messages[messages.length - 1]
  return conversation(
    env,
    {
      ...conv,
      messageCount: messages.length,
      lastMessageAt: lastMsg?.sentAt ?? conv.lastMessageAt,
    },
    messages,
  )
}

/** A contact of the org through the contacts service (`people.contact`). */
export async function seedContact(
  env: WorkerEnv,
  orgId: string,
  params: { name: string; email: string; company?: string; createdBy: string },
): Promise<{ id: string }> {
  return seedFactory<{ id: string }>(env, orgId, "people.contact", {
    email: params.email.toLowerCase(),
    name: params.name,
    ...(params.company ? { company: params.company } : {}),
    createdBy: params.createdBy,
  })
}

/** Top-level keys of an app's org config, each through the config writer (`apps.configKey`). */
export async function setAppConfig(
  env: WorkerEnv,
  orgId: string,
  appName: string,
  config: Record<string, unknown>,
): Promise<void> {
  for (const [key, value] of Object.entries(config)) {
    await seedFactory(env, orgId, "apps.configKey", { appName, key, value })
  }
}

function mailSchema(env: WorkerEnv) {
  return env.schemaPrefix ? `"${env.schemaPrefix}app_mail"` : "app_mail"
}

export async function queryConversations(env: WorkerEnv, where: string): Promise<any[]> {
  const ms = mailSchema(env)
  return env.db.sql.unsafe(`SELECT * FROM ${ms}.conversations WHERE ${where}`)
}

export async function queryMessages(env: WorkerEnv, where: string): Promise<any[]> {
  const ms = mailSchema(env)
  return env.db.sql.unsafe(`SELECT * FROM ${ms}.messages WHERE ${where}`)
}
