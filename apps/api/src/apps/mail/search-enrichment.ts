// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Unified search for mail: the conversation document, and one FRAGMENT
// document per message.
//
// WHY FRAGMENTS
// -------------
// The conversation document used to carry the text of its newest 50 messages.
// Every synced message emits a conversation update, so each new message rebuilt
// the whole document: three privileged transactions, up to 50 bodies read and
// converted from HTML, up to 30 KB re-sent to Meili, for one new message. A
// 10k-message mailbox sync made 10k such rebuilds.
//
// Now every document is built from exactly the rows that changed:
//
//   conversation   subject, sender, linked contact. O(1): the conversation row
//                  and one contact row.
//   message        (a fragment of its conversation) the message's own
//                  participants and text. Built once, when the message is
//                  created, from that one row.
//
// Search reports a fragment hit AS its conversation (service.ts, "Fragments"):
// the fragment carries `parent_type`/`parent_id`, the conversation's
// `dedupe_key` (so `distinct` shows one result per conversation) and the
// conversation's exact permission fields, copied from the CONVERSATION row with
// the conversation registration, so the engine admits a fragment for exactly
// the searchers it admits the conversation for. Mail's permission field is the
// conversation owner, set once when the conversation is created; a future
// permission field that can change on a live conversation must re-record the
// conversation's fragments when it does.
//
// INVARIANT K
// -----------
// An encrypted personal mailbox contributes NO content to the index: no
// conversation body, and no fragment at all (a fragment is only content). The
// suppression predicate is the shared one (content-suppression.ts), cached per
// account. A mailbox sealed later has its fragments deleted by the purge and
// the reset, which already delete `documentId(org, "mail", "message", id)` for
// every message of the mailbox.

import { htmlToText } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { DurableEventContext } from "~/infra/events/durable-consumers"
import { registerDurableEventConsumer } from "~/infra/events/durable-consumers"
import { searchLogger as log } from "~/lib/logger"
import {
  isContentSuppressedForRow,
  isMailAccountSuppressed,
} from "~/modules/mailbox-crypto/content-suppression"
import { applyPermissionFields, toUnixSeconds } from "~/modules/search/doc-builder"
import { documentId } from "~/modules/search/document-id"
import type { EnrichmentHelpers } from "~/modules/search/enrichment"
import { registerSearchEnrichment } from "~/modules/search/enrichment"
import { type IndexSourceSink, registerIndexSource } from "~/modules/search/index-sources"
import {
  type LiveIndexItem,
  type LiveIndexResolution,
  rawDeleteItem,
  recordLiveIndex,
  registerLiveIndexResolver,
} from "~/modules/search/live-index-queue"
import {
  collectSearchableRegistrations,
  type SearchableEntityRegistration,
} from "~/modules/search/searchable-entities"

function mailRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("app_mail")}.${name}`)
}

function kernelRel(name: string): ReturnType<typeof drizzleSql.raw> {
  return drizzleSql.raw(`${schemaRef("kernel")}.${name}`)
}

/** Per message: Meili's per-attribute position limit makes more unsearchable anyway. */
const BODY_BYTE_BUDGET = 30_000

const MAIL_APP = "mail"
const CONVERSATION = "conversation"
const FRAGMENT = "message"
const FRAGMENT_RESOLVER = "mail-message"

function truncateToByteBudget(text: string, budget: number): string {
  if (Buffer.byteLength(text, "utf8") <= budget) return text
  let candidate = text.slice(0, budget)
  while (candidate.length > 0 && Buffer.byteLength(candidate, "utf8") > budget) {
    candidate = candidate.slice(0, -1)
  }
  return candidate
}

interface AddressJson {
  name?: string | null
  email?: string | null
}

/** Flatten a from/to/cc address JSON value ({name,email} or an array of them)
 * into "Name email" strings, skipping empties. */
function addressBits(value: unknown, out: Set<string>): void {
  const list = Array.isArray(value) ? value : value ? [value] : []
  for (const a of list as AddressJson[]) {
    if (!a || typeof a !== "object") continue
    const bits = [a.name, a.email].filter((v): v is string => typeof v === "string" && v.length > 0)
    if (bits.length > 0) out.add(bits.join(" "))
  }
}

function conversationDocId(orgId: string, conversationId: string): string {
  return documentId(orgId, MAIL_APP, CONVERSATION, conversationId)
}

function fragmentDocId(orgId: string, messageId: string): string {
  return documentId(orgId, MAIL_APP, FRAGMENT, messageId)
}

/* -------------------------------------------------------------------------- */
/* The conversation document                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The conversation's extra searchable text: its linked contact's identity.
 * The messages' participants and text are in the fragments.
 */
async function buildConversationEnrichmentBody(
  row: Record<string, unknown>,
  helpers: EnrichmentHelpers,
): Promise<string | null> {
  // Invariant K: an encrypted personal mailbox contributes nothing, not even
  // the contact line (it names a correspondent of a sealed mailbox). The doc
  // builder already answered the question; a caller that did not asks here.
  const suppressed =
    helpers.contentSuppressed ??
    (await helpers.withPrivilegedRead("mail:search-enrichment:suppression", (tx) =>
      isContentSuppressedForRow(tx, helpers.orgId, MAIL_APP, CONVERSATION, row),
    ))
  if (suppressed) return null

  const contactId = row.contact_id as string | null | undefined
  if (!contactId) return null
  const contactRow = await helpers.withPrivilegedRead("mail:search-enrichment:contact", (tx) =>
    tx.execute(drizzleSql`
      SELECT name, email FROM ${kernelRel("contacts")}
      WHERE id = ${contactId} AND org_id = ${helpers.orgId}
      LIMIT 1
    `),
  )
  const contact = extractRows<{ name: string | null; email: string | null }>(contactRow)[0]
  if (!contact) return null
  const bits = [contact.name, contact.email].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  )
  return bits.length > 0 ? bits.join(" ") : null
}

/* -------------------------------------------------------------------------- */
/* Fragments                                                                  */
/* -------------------------------------------------------------------------- */

function conversationRegistration(orgId: string): SearchableEntityRegistration | null {
  return (
    collectSearchableRegistrations(orgId).entities.find(
      (e) => e.app === MAIL_APP && e.entityType === CONVERSATION,
    ) ?? null
  )
}

const FRAGMENT_COLUMNS = drizzleSql`m.id, m.conversation_id, m.account_id, m.subject, m.snippet,
  m.text_body, m.html_body, m.from_address, m.to_addresses, m.cc_addresses, m.sent_at`

/**
 * The fragment document of one message, or null when it has nothing to carry.
 * `conversation` is the parent row: its permission fields are the fragment's.
 */
function fragmentDocument(
  orgId: string,
  reg: SearchableEntityRegistration,
  message: Record<string, unknown>,
  conversation: Record<string, unknown>,
): Record<string, unknown> | null {
  const participants = new Set<string>()
  addressBits(message.from_address, participants)
  addressBits(message.to_addresses, participants)
  addressBits(message.cc_addresses, participants)
  const text =
    typeof message.text_body === "string" && message.text_body.trim()
      ? message.text_body
      : typeof message.html_body === "string" && message.html_body.trim()
        ? htmlToText(message.html_body)
        : typeof message.snippet === "string"
          ? message.snippet
          : null
  const parts = [[...participants].join("\n"), text].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  )
  if (parts.length === 0) return null
  const messageId = String(message.id)
  const conversationId = String(conversation.id)
  const doc: Record<string, unknown> = {
    id: fragmentDocId(orgId, messageId),
    org_id: orgId,
    app: MAIL_APP,
    entity_type: FRAGMENT,
    entity_id: messageId,
    parent_type: CONVERSATION,
    parent_id: conversationId,
    dedupe_key: conversationDocId(orgId, conversationId),
    read_scope: reg.readScope,
    is_mentionable: false,
    title: message.subject ?? conversation.subject ?? null,
    body: truncateToByteBudget(parts.join("\n"), BODY_BYTE_BUDGET),
  }
  const at = toUnixSeconds(message.sent_at)
  if (at !== null) doc.created_at = at
  applyPermissionFields(doc, reg, conversation)
  return doc
}

/**
 * The fragments a set of message requests writes: one read of the messages,
 * one of their conversations, a cached suppression answer per account.
 */
async function planFragments(
  orgId: string,
  requests: Array<{ action: "upsert" | "delete"; messageId: string }>,
): Promise<{ docs: Record<string, unknown>[]; deleteIds: string[] }> {
  const out = { docs: [] as Record<string, unknown>[], deleteIds: [] as string[] }
  const reg = conversationRegistration(orgId)
  const upserts = requests.filter((r) => r.action === "upsert").map((r) => r.messageId)
  const rows =
    reg && upserts.length > 0
      ? await withPrivilegedDb(orgId, "mail:search-fragments", async (tx) => {
          const ids = JSON.stringify([...new Set(upserts)])
          const messages = extractRows<Record<string, unknown>>(
            await tx.execute(drizzleSql`
              SELECT ${FRAGMENT_COLUMNS} FROM ${mailRel("messages")} m
              WHERE m.org_id = ${orgId}
                AND m.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${ids}::jsonb))`),
          )
          const convIds = JSON.stringify([
            ...new Set(messages.map((m) => String(m.conversation_id))),
          ])
          const conversations = extractRows<Record<string, unknown>>(
            await tx.execute(drizzleSql`
              SELECT * FROM ${mailRel("conversations")} c
              WHERE c.org_id = ${orgId}
                AND c.id IN (SELECT value::uuid FROM jsonb_array_elements_text(${convIds}::jsonb))`),
          )
          const suppressed = new Map<string, boolean>()
          for (const m of messages) {
            const account = String(m.account_id ?? "")
            if (!suppressed.has(account)) {
              suppressed.set(account, await isMailAccountSuppressed(tx, orgId, account || null))
            }
          }
          return { messages, conversations, suppressed }
        })
      : null
  const messageById = new Map((rows?.messages ?? []).map((m) => [String(m.id), m]))
  const conversationById = new Map((rows?.conversations ?? []).map((c) => [String(c.id), c]))
  for (const req of requests) {
    const message = req.action === "upsert" ? messageById.get(req.messageId) : undefined
    const conversation = message ? conversationById.get(String(message.conversation_id)) : undefined
    const sealed = message ? rows?.suppressed.get(String(message.account_id ?? "")) !== false : true
    const doc =
      reg && message && conversation && !sealed
        ? fragmentDocument(orgId, reg, message, conversation)
        : null
    if (doc) out.docs.push(doc)
    else out.deleteIds.push(fragmentDocId(orgId, req.messageId))
  }
  return out
}

function fragmentItem(
  orgId: string,
  action: "upsert" | "delete",
  messageId: string,
): LiveIndexItem {
  return {
    t: FRAGMENT_RESOLVER,
    key: fragmentDocId(orgId, messageId),
    payload: { action, orgId, messageId },
  }
}

/** The live-index removal of one message's fragment (the message row is gone). */
export function mailFragmentRemovalItem(orgId: string, messageId: string): LiveIndexItem {
  return fragmentItem(orgId, "delete", messageId)
}

function meiliEscape(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

/** The fragments of one conversation, by filter (their ids are gone with the rows). */
function conversationFragmentsFilter(orgId: string, conversationId: string): string {
  return `org_id = "${meiliEscape(orgId)}" AND app = "${MAIL_APP}" AND parent_type = "${CONVERSATION}" AND dedupe_key = "${meiliEscape(conversationDocId(orgId, conversationId))}"`
}

registerLiveIndexResolver(FRAGMENT_RESOLVER, async (items) => {
  const out: LiveIndexResolution = { docs: [], deleteIds: [], failed: [] }
  const byOrg = new Map<string, LiveIndexItem[]>()
  for (const item of items) {
    const list = byOrg.get(item.payload.orgId) ?? []
    list.push(item)
    byOrg.set(item.payload.orgId, list)
  }
  for (const [orgId, list] of byOrg) {
    try {
      const plan = await planFragments(
        orgId,
        list.map((i) => ({
          action: i.payload.action,
          messageId: String((i.payload as { messageId?: unknown }).messageId),
        })),
      )
      out.docs.push(...plan.docs)
      out.deleteIds.push(...plan.deleteIds)
    } catch (err) {
      log.warn({ err, orgId, count: list.length }, "Could not build mail search fragments")
      out.failed.push(...list)
    }
  }
  return out
})

/**
 * The event side: a mail message created or updated records its fragment, a
 * deleted one its removal, and a deleted conversation removes its fragments by
 * filter. Throws on a Redis failure, like the entity indexer's consumer, so
 * the outbox replays the event rather than lose the change.
 */
async function mailFragmentDurableHandler(ctx: DurableEventContext): Promise<void> {
  const { event } = ctx
  if (event.ephemeral || event.app !== MAIL_APP) return
  const data = (event.data ?? {}) as Record<string, unknown>
  const id = (data.id as string | undefined) ?? event.entityId
  if (!id) return
  if (event.entity === FRAGMENT) {
    const action =
      event.action === "create" || event.action === "update"
        ? "upsert"
        : event.action === "delete"
          ? "delete"
          : null
    if (action) await recordLiveIndex([fragmentItem(event.orgId, action, id)])
    return
  }
  if (event.entity === CONVERSATION && event.action === "delete") {
    await recordLiveIndex([
      rawDeleteItem(event.orgId, `${conversationDocId(event.orgId, id)}:fragments`, {
        filter: conversationFragmentsFilter(event.orgId, id),
      }),
    ])
  }
}

/** The rebuild's fragment source: one org's mail messages, keyset-paged. */
async function streamFragmentsForRebuild(orgId: string, sink: IndexSourceSink): Promise<void> {
  if (!conversationRegistration(orgId)) return
  let after: string | null = null
  for (;;) {
    const cursor: string | null = after
    const ids: string[] = await withPrivilegedDb(
      orgId,
      "mail:search-fragments:stream",
      async (tx) =>
        extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
          SELECT m.id::text AS id FROM ${mailRel("messages")} m
          WHERE m.org_id = ${orgId} ${cursor ? drizzleSql`AND m.id > ${cursor}::uuid` : drizzleSql``}
          ORDER BY m.id ASC LIMIT 500`),
        ).map((r) => r.id),
    )
    if (ids.length === 0) return
    after = ids[ids.length - 1] ?? null
    const plan = await planFragments(
      orgId,
      ids.map((messageId) => ({ action: "upsert" as const, messageId })),
    )
    await sink(plan.docs)
    if (ids.length < 500) return
  }
}

let registered = false

/**
 * Register the mail search enrichment hook and the fragment rebuild source.
 * Idempotent; invoked once at process boot from `infra/boot-phase10.ts` (and by
 * the reindex CLI) before anything builds a mail document.
 */
export function registerMailSearchEnrichment(): void {
  if (registered) return
  registered = true
  registerSearchEnrichment(MAIL_APP, CONVERSATION, async (row, helpers) => ({
    bodyExtra: await buildConversationEnrichmentBody(row, helpers),
    // The group its fragments join (service.ts collapses it with `distinct`).
    dedupeKey: typeof row.id === "string" ? conversationDocId(helpers.orgId, row.id) : null,
  }))
  registerIndexSource("mail-fragments", streamFragmentsForRebuild)
}

let consumerRegistered = false

/** The event consumer for fragments. Run in the event-consuming process. */
export function registerMailFragmentConsumer(): void {
  if (consumerRegistered) return
  consumerRegistered = true
  registerDurableEventConsumer("search-mail-fragments", mailFragmentDurableHandler)
}

/** Direct fragment writes for tests and backfills: what one flush would write. */
export async function planMailFragments(
  orgId: string,
  requests: Array<{ action: "upsert" | "delete"; messageId: string }>,
) {
  return await planFragments(orgId, requests)
}

/**
 * Test access to this module's private state, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const MailSearchEnrichmentTestAccess = {
  /** Test-only: allow re-registration after `SearchEnrichmentTestAccess.reset()`. */
  resetRegistration(): void {
    registered = false
  },
  handler: mailFragmentDurableHandler,
}
