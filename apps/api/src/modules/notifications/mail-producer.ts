// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * New-email notifications (S15, S16), kernel side.
 *
 * Consumes the mail app's `message:create` event and writes one `new_email`
 * attention item for the owner of a personal Gmail mailbox. The mail app stays
 * sandboxed and unaware of notifications: it only stamps the event with the
 * sync path that stored the message (`origin`) and the envelope facts decided
 * on here (labels, isRead, Gmail `internalDate`).
 *
 * No flood, by construction:
 *   - only `origin = incremental` produces (Gmail history, the live path,
 *     including while a backfill is still running). The initial import, the
 *     historyExpired re-sync (which re-enters the initial import), IMAP and
 *     sent mail never do;
 *   - a message Gmail received more than 15 minutes ago produces nothing
 *     (`internalDate`, not the sender-written Date header);
 *   - several new emails within 2 minutes for one user coalesce into one item
 *     whose `metadata.revision` goes up on each email, so every update
 *     re-alerts and replaces the previous banner (`newEmailAlertKeys`).
 *
 * Never the subject or the body (sealed, D2): the summary names the sender
 * only, and the event this reads carries no content.
 *
 * Rows go through the translator's insert path (`defaultInsertAttentionRow`),
 * so routing added at that path applies here as well. In-app and email
 * decisions come from the router: a per-app rule switching mail off writes
 * nothing, and the grid's email cell decides the digest state.
 *
 * Send-as aliases: the mail app stores none, so "from myself" is the account
 * address only.
 */
import { resolveLocale, type ShippedLocale } from "@liaison/shared"
import { and, eq, sql } from "drizzle-orm"
import type { PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { organizations, userPreferences, users } from "~/db/schema/kernel"
import { schemaRef } from "~/db/schema-ref"
import type { DurableEventContext } from "~/infra/events/durable-consumers"
import { registerDurableEventConsumer } from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import { rootLogger } from "~/lib/logger"
import {
  type AttentionRowInsert,
  defaultInsertAttentionRow,
  type InsertedAttentionRow,
} from "~/modules/attention/translator"
import { serverT } from "~/modules/i18n/server-i18n"
import { type AttentionLiveItem, dispatchAttentionLive, emailEnqueue } from "./dispatch"
import { type ResolveChannelsOptions, type RouterDecision, resolveChannels } from "./router"

const log = rootLogger.child({ module: "mail-new-email-producer" })
const K = () => sql.raw(schemaRef("kernel"))
const M = () => sql.raw(schemaRef("app_mail"))

export const NEW_EMAIL_KIND = "new_email"
/** A message Gmail received longer ago than this raises nothing. */
export const NEW_EMAIL_MAX_AGE_MS = 15 * 60_000
/** New emails for one user within this window update one item. */
export const NEW_EMAIL_COALESCE_MS = 2 * 60_000
const NEW_EMAIL_URGENCY = 40
const SKIPPED_CATEGORIES = [
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
]
const MAX_TRACKED_MESSAGES = 100
const MAX_TRACKED_SENDERS = 50
const MAX_SENDER_LABEL = 60

export interface NewEmailEventData {
  origin?: unknown
  direction?: unknown
  labels?: unknown
  isRead?: unknown
  internalDate?: unknown
  from?: unknown
  conversationId?: unknown
}

export interface MailAccountFacts {
  owner_type?: string | null
  owner_id?: string | null
  provider?: string | null
  email_address?: string | null
  encryption_state?: string | null
  disconnected_at?: string | null
}

export type NewEmailSkipReason =
  | "origin"
  | "no_account"
  | "provider"
  | "not_personal"
  | "disconnected"
  | "mailbox_not_ready"
  | "outbound"
  | "not_inbox"
  | "category"
  | "read"
  | "self"
  | "stale"

function senderOf(from: unknown): { email: string; name: string | null } | null {
  if (!from || typeof from !== "object") return null
  const f = from as { email?: unknown; name?: unknown }
  const email = typeof f.email === "string" ? f.email.trim().toLowerCase() : ""
  if (!email) return null
  const name = typeof f.name === "string" ? f.name : null
  return { email, name }
}

/** Why this message raises no item, or null when it does. Pure. */
export function newEmailSkipReason(
  data: NewEmailEventData,
  account: MailAccountFacts | null,
  nowMs: number,
): NewEmailSkipReason | null {
  if (data.origin !== "incremental") return "origin"
  if (!account) return "no_account"
  if (account.provider !== "gmail") return "provider"
  if (account.owner_type !== "user" || !account.owner_id) return "not_personal"
  if (account.disconnected_at) return "disconnected"
  const state = account.encryption_state
  if (state === "pending_enrollment" || state === "blocked" || state === "paused") {
    return "mailbox_not_ready"
  }
  if (data.direction !== "inbound") return "outbound"
  const labels = Array.isArray(data.labels) ? data.labels.map(String) : []
  if (!labels.includes("INBOX")) return "not_inbox"
  if (labels.some((l) => SKIPPED_CATEGORIES.includes(l))) return "category"
  if (data.isRead !== false) return "read"
  const sender = senderOf(data.from)
  const own = (account.email_address ?? "").trim().toLowerCase()
  if (!sender || sender.email === own) return "self"
  const received = typeof data.internalDate === "number" ? data.internalDate : Number.NaN
  if (!Number.isFinite(received) || Math.abs(nowMs - received) > NEW_EMAIL_MAX_AGE_MS) {
    return "stale"
  }
  return null
}

/** Who, short: the display name, else the address. No control characters. */
function senderLabel(sender: { email: string; name: string | null }): string {
  const name = (sender.name ?? "")
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  const label = name || sender.email
  return label.length > MAX_SENDER_LABEL ? `${label.slice(0, MAX_SENDER_LABEL - 1)}…` : label
}

interface TrackedSender {
  email: string
  label: string
}

/** "New email from A", or "3 new emails from A, B and 1 other". */
export function newEmailSummary(
  locale: ShippedLocale,
  count: number,
  senders: TrackedSender[],
): string {
  const k = (key: string) => `mail.newEmailNotification.${key}`
  const [first, second] = senders
  if (count <= 1 || senders.length === 0) {
    return serverT(locale, k("one"), { sender: first?.label ?? "" })
  }
  if (senders.length === 1)
    return serverT(locale, k("manyOneSender"), { count, sender: first.label })
  if (senders.length === 2) {
    return serverT(locale, k("manyTwoSenders"), { count, first: first.label, second: second.label })
  }
  const others = senders.length - 2
  return others === 1
    ? serverT(locale, k("manyOneOther"), { count, first: first.label, second: second.label })
    : serverT(locale, k("manyOthers"), { count, first: first.label, second: second.label, others })
}

/**
 * The alert identity of one revision of an item: a later revision replaces the
 * previous banner (APNs `apns-collapse-id` = item id) and is a new desktop
 * notification (`attention:<id>:<revision>`, same OS tag).
 */
export function newEmailAlertKeys(itemId: string, revision: number) {
  return { collapseId: itemId, notifyId: `attention:${itemId}:${revision}`, tag: itemId }
}

interface OpenItem {
  entity_id: string
  metadata: Record<string, unknown> | null
}

export interface MailProducerDeps {
  now?: () => number
  loadAccount?: (orgId: string, accountId: string) => Promise<MailAccountFacts | null>
  loadLocale?: (orgId: string, userId: string) => Promise<ShippedLocale>
  // biome-ignore lint/suspicious/noConfusingVoidType: a double that returns nothing keys the alert on the entity id
  insertRow?: (row: AttentionRowInsert) => Promise<void | InsertedAttentionRow>
  routerOptions?: ResolveChannelsOptions
  /** Push + desktop for each revision. Default `dispatchAttentionLive`. */
  dispatchLive?: (decision: RouterDecision, item: AttentionLiveItem) => Promise<void>
}

async function defaultLoadAccount(orgId: string, accountId: string) {
  return withPrivilegedDb(orgId, "mail-producer:account", async (tx: PrivilegedDb) => {
    // to_jsonb: `encryption_state` is created by the mail app's schema sync, so
    // read the row whole rather than name a column that may not exist yet.
    const rows = (await tx.execute(
      sql`SELECT to_jsonb(a) AS row FROM ${M()}.accounts a
            WHERE a.id = ${accountId} AND a.org_id = ${orgId} LIMIT 1`,
    )) as unknown as Array<{ row: MailAccountFacts }>
    return rows[0]?.row ?? null
  })
}

async function defaultLoadLocale(orgId: string, userId: string): Promise<ShippedLocale> {
  const [row] = await withPrivilegedDb(orgId, "mail-producer:locale", (tx) =>
    tx
      .select({ language: userPreferences.language, orgDefault: organizations.defaultLocale })
      .from(users)
      .innerJoin(organizations, eq(organizations.id, users.orgId))
      .leftJoin(userPreferences, eq(userPreferences.userId, users.id))
      .where(and(eq(users.id, userId), eq(users.orgId, orgId)))
      .limit(1),
  )
  return resolveLocale(row?.language ?? null, row?.orgDefault ?? null)
}

/** Already counted in an item (a replay of the same outbox event)? */
async function alreadyCounted(orgId: string, userId: string, messageId: string) {
  return withPrivilegedDb(orgId, "mail-producer:replay", async (tx: PrivilegedDb) => {
    const rows = (await tx.execute(
      sql`SELECT 1 FROM ${K()}.attention_events
            WHERE user_id = ${userId} AND org_id = ${orgId} AND app = 'mail'
              AND kind = ${NEW_EMAIL_KIND}
              AND created_at > now() - interval '1 day'
              AND metadata->'messageIds' @> ${JSON.stringify([messageId])}::jsonb
            LIMIT 1`,
    )) as unknown as unknown[]
    return rows.length > 0
  })
}

/** The unread item opened in the last 2 minutes, if any. */
async function openItem(orgId: string, userId: string): Promise<OpenItem | null> {
  return withPrivilegedDb(orgId, "mail-producer:open-item", async (tx: PrivilegedDb) => {
    const rows = (await tx.execute(
      sql`SELECT entity_id, metadata FROM ${K()}.attention_events
            WHERE user_id = ${userId} AND org_id = ${orgId} AND app = 'mail'
              AND kind = ${NEW_EMAIL_KIND} AND read_at IS NULL AND email_only = false
              AND created_at >= now() - make_interval(secs => ${NEW_EMAIL_COALESCE_MS / 1000})
            ORDER BY created_at DESC LIMIT 1`,
    )) as unknown as OpenItem[]
    return rows[0] ?? null
  })
}

function listOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** Handle one event. Never throws: a notification is not worth an outbox retry loop. */
export async function processNewEmailEvent(
  event: AppEvent,
  deps: MailProducerDeps = {},
): Promise<void> {
  if (event.app !== "mail" || event.entity !== "message" || event.action !== "create") return
  const data = (event.data ?? {}) as NewEmailEventData & { id?: unknown; accountId?: unknown }
  // Cheap exits first: the initial import emits hundreds of these.
  if (data.origin !== "incremental") return
  const messageId = typeof data.id === "string" ? data.id : event.entityId
  const accountId = typeof data.accountId === "string" ? data.accountId : null
  if (!messageId || !accountId) return

  try {
    const nowMs = (deps.now ?? Date.now)()
    const account = await (deps.loadAccount ?? defaultLoadAccount)(event.orgId, accountId)
    const skip = newEmailSkipReason(data, account, nowMs)
    if (skip) {
      log.debug({ accountId, messageId, skip }, "no new_email item")
      return
    }
    const userId = account?.owner_id as string
    const orgId = event.orgId

    const decision = await resolveChannels(
      { userId, orgId },
      { kind: NEW_EMAIL_KIND, app: "mail", entityType: NEW_EMAIL_KIND, isUrgent: false },
      { now: new Date(nowMs), ...deps.routerOptions },
    )
    if (!decision.channels.in_app.deliver) return

    if (await alreadyCounted(orgId, userId, messageId)) return
    const open = await openItem(orgId, userId)
    const meta = open?.metadata ?? {}

    const sender = senderOf(data.from) as { email: string; name: string | null }
    const senders = listOf<TrackedSender>(meta.senders)
    if (!senders.some((s) => s.email === sender.email) && senders.length < MAX_TRACKED_SENDERS) {
      senders.push({ email: sender.email, label: senderLabel(sender) })
    }
    const messageIds = [...listOf<string>(meta.messageIds), messageId].slice(-MAX_TRACKED_MESSAGES)
    const count = (typeof meta.count === "number" ? meta.count : 0) + 1
    const revision = (typeof meta.revision === "number" ? meta.revision : 0) + 1
    const conversationId = typeof data.conversationId === "string" ? data.conversationId : null

    const locale = await (deps.loadLocale ?? defaultLoadLocale)(orgId, userId)
    const email = emailEnqueue(decision, new Date(nowMs))
    const occurredAt = new Date(data.internalDate as number)
    const entityId = open?.entity_id ?? messageId
    const summary = newEmailSummary(locale, count, senders)
    const stored = await (deps.insertRow ?? defaultInsertAttentionRow)({
      orgId,
      userId,
      app: "mail",
      // One item per burst: the first message of the burst keys it, and the
      // upsert on the unread dedupe key turns the next ones into updates.
      entityType: NEW_EMAIL_KIND,
      entityId,
      kind: NEW_EMAIL_KIND,
      urgency: NEW_EMAIL_URGENCY,
      summary,
      actorId: null,
      actorType: "system",
      metadata: {
        // New email set to off (rule 7): unread in the inbox, but quiet.
        ...(decision.channels.in_app.quiet ? { quiet: true } : {}),
        revision,
        count,
        senders,
        messageIds,
        accountId,
        // The action opens the latest conversation (the feed reads `link`).
        ...(conversationId
          ? { conversationId, link: { tabType: "mail:conversation", entityId: conversationId } }
          : {}),
      },
      occurredAt,
      isUrgent: false,
      digestState: email.digestState,
      digestEligibleAt: email.digestEligibleAt,
    })
    // Every revision goes live, the coalescing update included: the push
    // replaces the previous banner (collapse id = the item), the desktop gets a
    // new notification per revision (notifyId carries the revision).
    const keys = newEmailAlertKeys(stored ? stored.id : entityId, revision)
    await (deps.dispatchLive ?? ((d, i) => dispatchAttentionLive(d, i)))(decision, {
      notifyId: keys.notifyId,
      collapseId: keys.collapseId,
      summary,
      app: "mail",
      entityType: NEW_EMAIL_KIND,
      entityId,
    })
  } catch (err) {
    log.warn({ err, accountId, messageId }, "new_email item could not be written")
  }
}

let registered = false
export function registerMailProducerConsumer(): void {
  if (registered) return
  registered = true
  registerDurableEventConsumer("mail-new-email", (ctx: DurableEventContext) =>
    processNewEmailEvent(ctx.event),
  )
}
