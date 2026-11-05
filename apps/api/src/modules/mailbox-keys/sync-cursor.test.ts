// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `GET /api/mailbox/sync-cursor`, the sealed listing (spec section 5.5 and
// section 6.3).
//
// Two consumers, two modes, and the difference between them is load bearing:
//
//   * the CLIENT SEARCH INDEX (`mode=sealed`, the default) walks a monotonic
//     change cursor over ciphertext metadata and indexes what it can open, so
//     it wants sealed rows only,
//   * the MIGRATION SWEEP (`mode=verify`) has to cover the EXACT row set the
//     server's acknowledgement digest covers, which is every personal message
//     regardless of `enc_version`, plus the plaintext still sitting beside the
//     ciphertext during the dual-read window. Filtering unsealed rows out of
//     that walk is how an unverified message ends up inside a signed
//     acknowledgement, so the two modes must not be collapsed.
//
// Owner scoping is the other property: another user's personal mailbox and a
// shared org mailbox both stay out of the listing entirely.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { errorHandler } from "~/middleware/error-handler"
import { type AppDescriptor, registerApps } from "~/modules/apps/runtime"
import { collectPersonalMessageIds } from "~/modules/mailbox-crypto/ack-verify"
import { mailboxRoutes } from "~/modules/mailbox-keys/routes"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

/** Legacy rows: sealed by the backfill, plaintext still beside the ciphertext. */
const SEALED_COUNT = 5
/** Legacy rows the backfill has not reached yet. */
const UNSEALED_COUNT = 2
/**
 * Rows sealed AT INGEST. They never had plaintext, so all four plaintext
 * columns are NULL and there is nothing for the sweep to compare against. Every
 * enrolled mailbox accumulates these from the moment it is armed, so a listing
 * that cannot describe them is a listing no live mailbox can ever be swept
 * from.
 */
const INGEST_SEALED_COUNT = 2
const VERIFY_TOTAL = SEALED_COUNT + UNSEALED_COUNT + INGEST_SEALED_COUNT

interface Seeded {
  user: minimal.Person
  accountId: string
  conversationId: string
  strangerAccountId: string
  sharedAccountId: string
  ownSealedIds: string[]
  ownUnsealedId: string
  strangerMessageId: string
  sharedMessageId: string
}

let seeded: Seeded

function appFor(user: minimal.Person): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("userId", user.id)
    c.set("orgId", user.orgId)
    c.set("scopes", ["mail:*"] as never)
    c.set("dimensionGrants", {})
    await next()
  })
  app.route("/api/mailbox", mailboxRoutes)
  app.onError(errorHandler)
  return app
}

async function json<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T
}

async function seedAccount(
  orgId: string,
  ownerType: "user" | "shared",
  ownerId: string | null,
): Promise<string> {
  const id = crypto.randomUUID()
  await withSystemDb("sync-cursor-seed-account", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, ${ownerType},
              ${ownerId}::uuid, 'gmail', ${`${id}@sync.test`}, 'active',
              ${ownerType === "user" ? "ready" : "none"})`),
  )
  return id
}

async function seedMessage(input: {
  orgId: string
  accountId: string
  conversationId: string
  ownerId: string | null
  ownerType: "user" | "shared"
  index: number
  sealed: boolean
  /** False for a row sealed at ingest: it never held plaintext. */
  plaintext?: boolean
}): Promise<string> {
  const id = crypto.randomUUID()
  const ciphertext = input.sealed ? Buffer.from(`ciphertext-${input.index}`) : null
  const hasPlaintext = input.plaintext !== false
  const subject = hasPlaintext ? `subject ${input.index}` : null
  const textBody = hasPlaintext ? `body ${input.index}` : null
  const htmlBody = hasPlaintext ? `<p>body ${input.index}</p>` : null
  const snippet = hasPlaintext ? `snippet ${input.index}` : null
  await withSystemDb("sync-cursor-seed-message", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.messages
        (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
         from_address, to_addresses, cc_addresses, labels, direction, subject, text_body,
         html_body, snippet, sent_at, created_at, updated_at,
         subject_ciphertext, text_body_ciphertext, html_body_ciphertext, snippet_ciphertext,
         content_key_wrapped, content_key_epk, enc_key_id, enc_version)
      VALUES (${id}::uuid, ${input.orgId}::uuid, ${input.conversationId}::uuid,
              ${input.accountId}::uuid, ${input.ownerType}, ${input.ownerId}::uuid,
              ${`<sync-${input.index}-${id}@sync.test>`},
              ${JSON.stringify({ email: "sender@sync.test", name: "Ada Sender" })}::jsonb,
              ${JSON.stringify([{ email: "me@sync.test" }])}::jsonb, '[]'::jsonb,
              ${JSON.stringify(["INBOX"])}::jsonb, 'inbound',
              ${subject}, ${textBody},
              ${htmlBody}, ${snippet},
              ${new Date(Date.UTC(2026, 2, 1, 0, input.index)).toISOString()}::timestamptz,
              ${new Date(Date.UTC(2026, 2, 1, 0, input.index)).toISOString()}::timestamptz,
              ${new Date(Date.UTC(2026, 2, 1, 0, input.index)).toISOString()}::timestamptz,
              ${ciphertext}, ${ciphertext}, ${ciphertext}, ${ciphertext},
              ${ciphertext}, ${ciphertext},
              ${input.sealed ? 1 : null}, ${input.sealed ? 1 : 0})`),
  )
  return id
}

beforeAll(async () => {
  await acquireTestLock()
  await acquireAppSchemaJsLock("app_mail")
  const user = await minimal.person((await createTestOrg()).id)
  await registerApps([mailAppManifest as unknown as AppDescriptor], user.orgId)
  const stranger = await minimal.person(user.orgId)

  const accountId = await seedAccount(user.orgId, "user", user.id)
  const strangerAccountId = await seedAccount(user.orgId, "user", stranger.id)
  const sharedAccountId = await seedAccount(user.orgId, "shared", null)
  const conversationId = crypto.randomUUID()

  await withSystemDb("sync-cursor-seed-conversation", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.conversations
        (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
         status, labels, is_read, is_starred, message_count, from_email)
      VALUES (${conversationId}::uuid, ${user.orgId}::uuid, ${accountId}::uuid, 'user',
              ${user.id}::uuid, ${`thread-${conversationId}`}, 'a conversation', 'a snippet',
              'open', '[]'::jsonb, false, false, 0, 'sender@sync.test')`),
  )

  const ownSealedIds: string[] = []
  for (let i = 0; i < SEALED_COUNT; i++) {
    const ownId = await seedMessage({
      orgId: user.orgId,
      accountId,
      conversationId,
      ownerId: user.id,
      ownerType: "user",
      index: i,
      sealed: true,
    })
    ownSealedIds.push(ownId)
  }
  let ownUnsealedId = ""
  for (let i = 0; i < UNSEALED_COUNT; i++) {
    ownUnsealedId = await seedMessage({
      orgId: user.orgId,
      accountId,
      conversationId,
      ownerId: user.id,
      ownerType: "user",
      index: 100 + i,
      sealed: false,
    })
  }
  for (let i = 0; i < INGEST_SEALED_COUNT; i++) {
    await seedMessage({
      orgId: user.orgId,
      accountId,
      conversationId,
      ownerId: user.id,
      ownerType: "user",
      index: 400 + i,
      sealed: true,
      plaintext: false,
    })
  }
  // Rows that must never appear: another user's personal mailbox, and a shared
  // org mailbox that is not in the encryption regime at all.
  const strangerMessageId = await seedMessage({
    orgId: user.orgId,
    accountId: strangerAccountId,
    conversationId,
    ownerId: stranger.id,
    ownerType: "user",
    index: 200,
    sealed: true,
  })
  const sharedMessageId = await seedMessage({
    orgId: user.orgId,
    accountId: sharedAccountId,
    conversationId,
    ownerId: null,
    ownerType: "shared",
    index: 300,
    sealed: true,
  })

  seeded = {
    user,
    accountId,
    conversationId,
    strangerAccountId,
    sharedAccountId,
    ownSealedIds,
    ownUnsealedId,
    strangerMessageId,
    sharedMessageId,
  }
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_mail")
  if (seeded) {
    await withSystemDb("sync-cursor-cleanup", async (tx) => {
      await tx.execute(
        drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${seeded.user.orgId}::uuid`,
      )
      await tx.execute(
        drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${seeded.user.orgId}::uuid`,
      )
      await tx.execute(
        drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${seeded.user.orgId}::uuid`,
      )
    })
  }
  await releaseTestLock()
})

async function drain(
  app: Hono<AppEnv>,
  query: string,
  limit = 3,
): Promise<{ items: any[]; pages: number }> {
  const items: any[] = []
  let cursor: string | null = null
  let pages = 0
  for (;;) {
    const url = `/api/mailbox/sync-cursor?limit=${limit}${query}${
      cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
    }`
    const res = await app.request(url)
    expect(res.status).toBe(200)
    const page = (await json(res)).data
    pages++
    items.push(...page.items)
    if (page.done) return { items, pages }
    expect(page.items.length).toBeGreaterThan(0)
    cursor = page.cursor
    if (pages > 20) throw new Error("the listing never reported completion")
  }
}

describe("GET /api/mailbox/sync-cursor", () => {
  test("the default listing carries only sealed rows, and never plaintext", async () => {
    const app = appFor(seeded.user)
    const { items, pages } = await drain(app, "")
    expect(items).toHaveLength(SEALED_COUNT + INGEST_SEALED_COUNT)
    expect(pages).toBeGreaterThan(1)
    for (const item of items) {
      expect(item.sealed.encVersion).toBe(1)
      expect(item.sealed.contentKeyWrapped).toBeTruthy()
      expect(item.envelope.accountId).toBe(seeded.accountId)
      expect(item.envelope.conversationId).toBe(seeded.conversationId)
      expect(item.envelope.sentAt).toBeTruthy()
      // Correspondents and labels are cleartext by spec section 2.1 and are
      // what the metadata half of the client index tokenizes.
      expect(item.envelope.metadata).toContain("sender@sync.test")
      expect(item.plaintext).toBeUndefined()
    }
    // The listing is the search index's only source, so a body leaking into it
    // would defeat the whole client-side design.
    const serialized = JSON.stringify(items)
    expect(serialized).not.toContain("body 0")
    expect(serialized).not.toContain("subject 0")
  })

  test("the verify listing covers the EXACT id set the acknowledgement digest covers", async () => {
    const app = appFor(seeded.user)
    const { items } = await drain(app, "&mode=verify")
    const listed = items.map((i) => i.sealed.id).sort()
    const serverIds = await withSystemDb("sync-cursor-server-ids", (tx) =>
      collectPersonalMessageIds(tx as never, seeded.user.id, seeded.user.orgId),
    )
    expect(listed).toEqual(serverIds)
    expect(listed).toHaveLength(VERIFY_TOTAL)
  })

  test("the verify listing carries the plaintext half for the byte-for-byte comparison", async () => {
    const app = appFor(seeded.user)
    const { items } = await drain(app, "&mode=verify")
    const withPlaintext = items.filter((i) => i.plaintext?.textBody)
    expect(withPlaintext.length).toBe(SEALED_COUNT + UNSEALED_COUNT)
    const first = withPlaintext[0]
    expect(first.plaintext.subject).toMatch(/^subject /)
    expect(first.plaintext.htmlBody).toMatch(/^<p>body /)
    expect(first.plaintext.snippet).toMatch(/^snippet /)
  })

  test("the verify listing states per row whether a plaintext half exists", async () => {
    // The server decides this, not the client. A row sealed at ingest has no
    // plaintext to compare against and the sweep's only job on it is to prove
    // it DECRYPTS; a legacy row still holding plaintext must be compared. A
    // client left to infer the difference from an absent field cannot tell a
    // row that never had plaintext from a listing served in the wrong mode.
    const app = appFor(seeded.user)
    const { items } = await drain(app, "&mode=verify")
    expect(items).toHaveLength(VERIFY_TOTAL)

    // Every row states the flag, and it agrees with whether the half is there.
    for (const item of items) {
      expect(typeof item.hasPlaintext).toBe("boolean")
      expect(item.plaintext == null).toBe(item.hasPlaintext === false)
    }

    const sealedAtIngest = items.filter((i) => i.hasPlaintext === false)
    expect(sealedAtIngest).toHaveLength(INGEST_SEALED_COUNT)
    for (const item of sealedAtIngest) {
      // Sealed, and therefore openable: the sweep must be able to verify it.
      expect(item.sealed.encVersion).toBe(1)
      expect(item.sealed.contentKeyWrapped).toBeTruthy()
    }
    expect(items.filter((i) => i.hasPlaintext === true)).toHaveLength(SEALED_COUNT + UNSEALED_COUNT)
  })

  test("another user's personal mailbox and a shared mailbox are invisible", async () => {
    const app = appFor(seeded.user)
    const { items } = await drain(app, "&mode=verify")
    const accountIds = new Set(items.map((i) => i.envelope.accountId))
    expect([...accountIds]).toEqual([seeded.accountId])
    expect(accountIds.has(seeded.strangerAccountId)).toBe(false)
    expect(accountIds.has(seeded.sharedAccountId)).toBe(false)
  })

  test("the cursor is monotonic: resuming from it never repeats or skips a row", async () => {
    const app = appFor(seeded.user)
    const first = await json(await app.request("/api/mailbox/sync-cursor?limit=2&mode=verify"))
    expect(first.data.items).toHaveLength(2)
    expect(first.data.done).toBe(false)
    const second = await json(
      await app.request(
        `/api/mailbox/sync-cursor?limit=2&mode=verify&cursor=${encodeURIComponent(first.data.cursor)}`,
      ),
    )
    const firstIds = first.data.items.map((i: any) => i.sealed.id)
    const secondIds = second.data.items.map((i: any) => i.sealed.id)
    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false)
    // A duplicate id would make `computeIdSetDigest` throw rather than silently
    // over-count, but the listing must not produce one in the first place.
    expect(new Set([...firstIds, ...secondIds]).size).toBe(4)
  })

  test("the listing reports the total, so a sweep can show progress", async () => {
    const app = appFor(seeded.user)
    const page = (await json(await app.request("/api/mailbox/sync-cursor?limit=2&mode=verify")))
      .data
    expect(page.total).toBe(VERIFY_TOTAL)
  })

  test("ids= returns only the named sealed rows of the caller's own mailbox", async () => {
    // A browser asked to open mail it never loaded (Run now from Home, a chat
    // turn outside Mail) reads exactly those rows, and nothing else.
    const app = appFor(seeded.user)
    const asked = [
      seeded.ownSealedIds[0],
      seeded.ownSealedIds[1],
      seeded.ownUnsealedId,
      seeded.strangerMessageId,
      seeded.sharedMessageId,
      "not-a-uuid",
    ]
    const page = (await json(await app.request(`/api/mailbox/sync-cursor?ids=${asked.join(",")}`)))
      .data
    const ids = page.items.map((i: any) => i.sealed.id).sort()
    expect(ids).toEqual([seeded.ownSealedIds[0], seeded.ownSealedIds[1]].sort())
    expect(page.done).toBe(true)
    expect(JSON.stringify(page.items)).not.toContain("body 0")
  })

  test("ids= never narrows the verify walk", async () => {
    const app = appFor(seeded.user)
    const { items } = await drain(app, `&mode=verify&ids=${seeded.ownSealedIds[0]}`)
    expect(items).toHaveLength(VERIFY_TOTAL)
  })
})
