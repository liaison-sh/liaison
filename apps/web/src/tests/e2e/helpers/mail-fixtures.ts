// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Mail for browser tests, from the seed route's mail factories
// (apps/api/test-support/seed/mail.ts): mailboxes on their own placeholder
// connections, conversations with their messages, drafts, and a message that
// arrives live through the outbox. Never a raw insert from the test.
import { randomUUID } from "node:crypto"
import { api, type WorkerEnv } from "@liaison/test-helpers"
import { seedFactory } from "./seed"

export interface MailAddress {
  name?: string
  email: string
}

export interface MailMessageSpec {
  direction: "inbound" | "outbound"
  from: MailAddress
  to: MailAddress[]
  textBody: string
  htmlBody?: string
  /** ISO; default now. */
  sentAt?: string
  isRead?: boolean
  /** The teammate who sent it from a shared mailbox. */
  sentByUserId?: string
  /** The provider's headers as synced; default none. */
  rawHeaders?: Record<string, string>
}

export interface SeededMailAccount {
  accountId: string
  connectedAccountId: string
  email: string
}

/** A mailbox at `email`: the person's own (`user`), or the org's connected by `userId` (`org`). */
export function seedMailAccount(
  env: WorkerEnv,
  orgId: string,
  opts: { userId: string; email: string; ownerType?: "user" | "org"; provider?: "gmail" | "imap" },
): Promise<SeededMailAccount> {
  return seedFactory(env, orgId, "mail.account", {
    ownerType: opts.ownerType ?? "user",
    userId: opts.userId,
    email: opts.email,
    ...(opts.provider ? { provider: opts.provider } : {}),
  })
}

/** An org-owned mail account at `email` (connected by the admin). */
export function seedOrgMailAccount(
  env: WorkerEnv,
  orgId: string,
  adminUserId: string,
  email: string,
): Promise<SeededMailAccount> {
  return seedMailAccount(env, orgId, { userId: adminUserId, email, ownerType: "org" })
}

/** A conversation on a mailbox with its messages (oldest first); `linkThreadTitle` links a new thread. */
export function seedMailConversation(
  env: WorkerEnv,
  orgId: string,
  opts: {
    accountId: string
    subject: string
    status?: "open" | "archived" | "trashed"
    labels?: string[]
    isRead?: boolean
    isStarred?: boolean
    /** Default: the subject. */
    snippet?: string
    /** The contact the conversation is with (its backlink). */
    contactId?: string
    linkThreadTitle?: string
    /** Who starts the linked thread on a shared mailbox. */
    linkThreadBy?: string
    lastMessageAt?: string
    messageCount?: number
    messages: MailMessageSpec[]
  },
): Promise<{ conversationId: string; messageIds: string[]; threadId: string | null }> {
  return seedFactory(env, orgId, "mail.conversation", opts)
}

/**
 * More messages on a conversation (its snippet, last time and count follow);
 * `announce` sends each one live, as a sync does, so an open view updates.
 */
export function appendMailMessages(
  env: WorkerEnv,
  orgId: string,
  conversationId: string,
  messages: MailMessageSpec[],
  opts: { announce?: boolean } = {},
): Promise<{ messageIds: string[] }> {
  return seedFactory(env, orgId, "mail.messages", {
    conversationId,
    messages,
    announce: opts.announce ?? false,
  })
}

/** A draft by `userId`: a reply on a conversation, or a new message. */
export async function seedMailDraft(
  env: WorkerEnv,
  orgId: string,
  opts: {
    accountId: string
    userId: string
    conversationId?: string
    replyToMessageId?: string
    to?: Array<{ email: string }>
    subject?: string
    htmlBody?: string
    textBody?: string
  },
): Promise<string> {
  const { draftId } = await seedFactory<{ draftId: string }>(env, orgId, "mail.draft", opts)
  return draftId
}

/** Widen the person's `mail:inbox` grant by these mailboxes (keeps the ones they had). */
export async function grantMailInboxes(
  env: WorkerEnv,
  orgId: string,
  userId: string,
  accountIds: string[],
): Promise<void> {
  await seedFactory(env, orgId, "people.grantDimension", {
    userId,
    dimension: "mail:inbox",
    values: accountIds,
    merge: true,
  })
}

/** Turn the org's Gmail connection type on or off, as the admin does on the Mail settings page. */
export async function setMailProviderEnabled(
  env: WorkerEnv,
  adminToken: string,
  enabled: boolean,
): Promise<void> {
  const res = await api(env.serverUrl, "/api/mail/providers/gmail", {
    method: "PATCH",
    token: adminToken,
    body: { enabled },
  })
  if (res.status !== 200) {
    throw new Error(`mail provider setting failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
}

// ── Composite fixtures ──────────────────────────────────────────────────────

export interface SharedInboxClaimSeed {
  accountId: string
  connectedAccountId: string
  conversationId: string
  subject: string
  accountEmail: string
  recipientEmail: string
}

/** A shared (org) mailbox with one unread customer message; `granteeUserIds` may read it. */
export async function seedSharedInboxClaimCase(
  env: WorkerEnv,
  adminUserId: string,
  orgId: string,
  granteeUserIds: string[],
): Promise<SharedInboxClaimSeed> {
  const accountEmail = `phase5-shared-gmail-${randomUUID().slice(0, 8)}@e2e.test`
  const recipientEmail = "phase5-recipient@e2e.test"
  const subject = `Shared Inbox Claim ${randomUUID().slice(0, 8)}`
  const account = await seedOrgMailAccount(env, orgId, adminUserId, accountEmail)
  const { conversationId } = await seedMailConversation(env, orgId, {
    accountId: account.accountId,
    subject,
    labels: ["INBOX"],
    messages: [
      {
        direction: "inbound",
        from: { name: "Phase 5 Recipient", email: recipientEmail },
        to: [{ email: accountEmail }],
        textBody: "Can someone from support reply?",
      },
    ],
  })
  for (const userId of granteeUserIds) {
    await grantMailInboxes(env, orgId, userId, [account.accountId])
  }
  return {
    accountId: account.accountId,
    connectedAccountId: account.connectedAccountId,
    conversationId,
    subject,
    accountEmail,
    recipientEmail,
  }
}

export interface MailBaselineSeed {
  account: { id: string; connectedAccountId: string; email: string }
  conversations: {
    unreadStarredHtml: { id: string; subject: string }
    readNormal: { id: string; subject: string }
    withThread: { id: string; subject: string; threadId: string }
    sentOnly: { id: string; subject: string }
    trashed: { id: string; subject: string }
    archived: { id: string; subject: string }
    withReplyDraft: { id: string; subject: string; draftId: string }
  }
  standaloneDraft: { id: string; subject: string }
}

const isoIn = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

/**
 * The person's mailbox (`admin.test@mail.test` unless named) with seven
 * conversations: unread+starred with a remote image, read, linked to a thread,
 * sent only, trashed, archived, one with a reply draft, and a new-message draft.
 */
export async function seedMailBaseline(
  env: WorkerEnv,
  userId: string,
  orgId: string,
  accountEmail?: string,
): Promise<MailBaselineSeed> {
  const email = accountEmail ?? "admin.test@mail.test"
  const account = await seedMailAccount(env, orgId, { userId, email })
  const conv = (o: Omit<Parameters<typeof seedMailConversation>[2], "accountId">) =>
    seedMailConversation(env, orgId, { accountId: account.accountId, ...o })
  const inbound = (from: MailAddress, textBody: string, sentAt: string, more = {}) => ({
    direction: "inbound" as const,
    from,
    to: [{ email }],
    textBody,
    sentAt,
    ...more,
  })

  const a = await conv({
    subject: "Q3 Budget Proposal",
    isStarred: true,
    messages: [0, 1, 2].map((i) =>
      inbound(
        { name: "Amina Cherif", email: "amina@resonantaudiolabs.example" },
        `Budget discussion message ${i + 1}`,
        isoIn(-180000 + i * 60000),
        {
          htmlBody:
            i === 2
              ? '<p>See attached chart:</p><img src="https://remote.example.com/chart.png" alt="Budget Chart" />'
              : `<p>Budget discussion message ${i + 1}</p>`,
        },
      ),
    ),
  })
  const b = await conv({
    subject: "Team Standup Notes",
    isRead: true,
    messages: [0, 1].map((i) =>
      inbound(
        { name: "Lucas Pereira", email: "lucas@resonantaudiolabs.example" },
        `Standup note ${i + 1}`,
        isoIn(-240000 + i * 60000),
        {
          isRead: true,
        },
      ),
    ),
    lastMessageAt: isoIn(-120000),
  })
  const c = await conv({
    subject: "Client Feedback",
    linkThreadTitle: "Client Feedback Discussion",
    messages: [
      inbound({ name: "Client", email: "client@example.com" }, "Feedback content", isoIn(-90000)),
    ],
  })
  const d = await conv({
    subject: "Sent Follow-up",
    isRead: true,
    labels: ["SENT"],
    messages: [
      {
        direction: "outbound",
        from: { email },
        to: [{ email: "recipient@example.com" }],
        textBody: "Following up on our discussion",
        sentAt: isoIn(-300000),
        isRead: true,
      },
    ],
  })
  const e = await conv({
    subject: "Trashed Receipt",
    status: "trashed",
    isRead: true,
    messages: [
      inbound({ email: "receipts@store.com" }, "Your receipt", isoIn(-400000), { isRead: true }),
    ],
  })
  const f = await conv({
    subject: "Archived Invoice #1234",
    status: "archived",
    isRead: true,
    messages: [
      inbound({ email: "billing@vendor.com" }, "Invoice attached", isoIn(-500000), {
        isRead: true,
      }),
    ],
  })
  const g = await conv({
    subject: "Draft Follow-up",
    isRead: true,
    messages: [
      inbound(
        { name: "Margot Dufour", email: "margot@resonantaudiolabs.example" },
        "Original message for reply",
        isoIn(-150000),
        {
          isRead: true,
        },
      ),
    ],
  })
  const replyDraftId = await seedMailDraft(env, orgId, {
    accountId: account.accountId,
    userId,
    conversationId: g.conversationId,
    replyToMessageId: g.messageIds[0],
    to: [{ email: "margot@resonantaudiolabs.example" }],
    subject: "Re: Draft Follow-up",
    htmlBody: "<p>Draft reply content</p>",
    textBody: "Draft reply content",
  })
  const standaloneDraftId = await seedMailDraft(env, orgId, {
    accountId: account.accountId,
    userId,
    to: [{ email: "new-recipient@example.com" }],
    subject: "Hello from Liaison",
    htmlBody: "<p>Hello!</p>",
    textBody: "Hello!",
  })

  return {
    account: { id: account.accountId, connectedAccountId: account.connectedAccountId, email },
    conversations: {
      unreadStarredHtml: { id: a.conversationId, subject: "Q3 Budget Proposal" },
      readNormal: { id: b.conversationId, subject: "Team Standup Notes" },
      withThread: {
        id: c.conversationId,
        subject: "Client Feedback",
        threadId: c.threadId as string,
      },
      sentOnly: { id: d.conversationId, subject: "Sent Follow-up" },
      trashed: { id: e.conversationId, subject: "Trashed Receipt" },
      archived: { id: f.conversationId, subject: "Archived Invoice #1234" },
      withReplyDraft: { id: g.conversationId, subject: "Draft Follow-up", draftId: replyDraftId },
    },
    standaloneDraft: { id: standaloneDraftId, subject: "Hello from Liaison" },
  }
}
