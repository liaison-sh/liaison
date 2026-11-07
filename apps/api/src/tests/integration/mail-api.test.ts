// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { app } from "~/app"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { ticketsAppManifest } from "~/apps/tickets/manifest-descriptor"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { env } from "~/lib/env"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"

let orgId: string
let userId: string
let token: string
let accountId: string
let conversationId: string

beforeAll(async () => {
  const suffix = randomUUID()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
    INSERT INTO kernel.organizations (id, name, slug)
    VALUES (gen_random_uuid(), 'API Test Org', ${`mail-api-test-org-${suffix}`}) RETURNING id
  `),
  )
  orgId = org.id
  const [user] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
    INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
    VALUES (gen_random_uuid(), ${orgId}, ${`apitest-${suffix}@test.com`}, 'API Tester', 'active', 'hash', 1, 1) RETURNING id
  `),
  )
  userId = user.id

  token = await signAccessToken(
    {
      userId,
      orgId,
      name: "API Tester",
      roles: ["admin"],
      scopes: ["*"],
      dimensionGrants: {},
      authVersion: 1,
      permissionVersion: 1,
    },
    env.JWT_SECRET,
  )

  // The real apps own these schemas. Hand-rolling `app_mail` and
  // `app_tickets` with CREATE TABLE IF NOT EXISTS owned nothing: once any
  // earlier file had registered the app the statements were silent no-ops and
  // this file then ran against whatever shape was there, keeping its RLS,
  // trigger and constraint coverage only by accident.
  await acquireAppSchemaJsLock("app_mail")
  await acquireAppSchemaJsLock("app_tickets")
  await registerApps(
    [
      {
        ...(mailAppManifest as any),
        dependencies: { ...(mailAppManifest as any).dependencies, tools: [] },
      },
      ticketsAppManifest as any,
    ] as unknown as AppDescriptor[],
    orgId,
  )

  const [connected] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
    INSERT INTO kernel.connected_accounts (
      id, org_id, app_name, connection_name, owner_type, owner_id,
      provider_type, identifier, status, created_by, access_token_encrypted
    ) VALUES (
      gen_random_uuid(), ${orgId}, 'mail', 'gmail', 'user', ${userId},
      'oauth2', 'apitest@gmail.com', 'active', ${userId}, 'encrypted-token'
    ) RETURNING id
  `),
  )
  const [acc] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
    INSERT INTO app_mail.accounts (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address, sync_status)
    VALUES (gen_random_uuid(), ${orgId}, ${connected.id}, 'user', ${userId}, 'gmail', 'apitest@gmail.com', 'active')
    RETURNING id
  `),
  )
  accountId = acc.id
  const [conv] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
    INSERT INTO app_mail.conversations (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet, status, labels, is_read, is_starred, last_message_at, message_count)
    VALUES (gen_random_uuid(), ${orgId}, ${accountId}, 'user', ${userId}, 'api-thread', 'API Test', 'Hello API', 'open', '["INBOX"]'::jsonb, false, false, now(), 1)
    RETURNING id
  `),
  )
  conversationId = conv.id
  await db.execute(drizzleSql`
    INSERT INTO app_mail.messages (id, org_id, conversation_id, account_id, external_message_id, external_provider_id, in_reply_to, message_references, from_address, to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, snippet, is_read, is_starred, labels, direction, sent_at, synced_at, raw_headers, owner_type, owner_id)
    VALUES (gen_random_uuid(), ${orgId}, ${conversationId}, ${accountId}, '<api-msg-1>', 'api-1', null, '[]'::jsonb, '{"email":"sender@test.com"}'::jsonb, '[{"email":"apitest@gmail.com"}]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'API Test', 'Hello API', null, 'Hello API', false, false, '["INBOX"]'::jsonb, 'inbound', now(), now(), '{}'::jsonb, 'user', ${userId})
  `)
})

afterAll(async () => {
  await releaseAppSchemaJsLock("app_tickets")
  await releaseAppSchemaJsLock("app_mail")
})

describe("mail api", () => {
  it("GET /api/mail/conversations returns conversation list", async () => {
    const res = await app.request("/api/mail/conversations", {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it("GET /api/mail/conversations/:id returns detail", async () => {
    const res = await app.request(`/api/mail/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })

  it("GET /api/mail/accounts/:id/sync-status returns sync status", async () => {
    const res = await app.request(`/api/mail/accounts/${accountId}/sync-status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})

// ── Task 5.4 and 5.5: every remaining writer seals, or refuses ───────────────
//
// The rule these cases pin: a writer that CANNOT seal fails the operation with
// a named error and writes NOTHING. It never writes plaintext, and it never
// writes a partial row. That is what makes the trigger's arming decision safe:
// the trigger stays armed while a mailbox is `blocked` or `paused`, and the
// application layer agrees with it instead of writing around it.

import {
  afterAll as afterAllW,
  beforeAll as beforeAllW,
  describe as describeW,
  expect as expectW,
  it as itW,
} from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { openField, unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import type { RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import * as writerMailService from "~/modules/mail/service"
import { applyMailSealToRow, MailboxWriteError } from "~/modules/mailbox-crypto/mail-writer"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const W_SCHEMA = schemaRef("app_mail")
const W_KEY_ID = 55

describeW("mail writers under encryption", () => {
  let wOrgId: string
  let wUserId: string
  let wKeys: CryptoKeyPair

  beforeAllW(async () => {
    const user = await minimal.person((await createTestOrg()).id)
    wOrgId = user.orgId
    wUserId = user.id
    const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as unknown as CryptoKeyPair
    const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair
    wKeys = ecdh
    const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
    const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
    await withSystemDb("writers-enroll", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.user_mailbox_identities
          (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
        VALUES (${wOrgId}::uuid, ${wUserId}::uuid, ${W_KEY_ID}, ${ecdhSpki}, ${signSpki},
                ${Buffer.from("attestation")}, 'active')`),
    )
  }, 60_000)

  afterAllW(async () => {})

  async function wAccount(state: string): Promise<string> {
    const id = randomUUID()
    await withSystemDb("writers-account", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${W_SCHEMA}"`)}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${id}::uuid, ${wOrgId}::uuid, ${randomUUID()}::uuid, 'user', ${wUserId}::uuid,
                'gmail', ${`${id}@writers.test`}, 'active', ${state})`),
    )
    return id
  }

  async function wDraft(accountId: string): Promise<string> {
    return withPrivilegedDb(wOrgId, "writers-draft", async (tx) => {
      const draft = await writerMailService.createDraft(tx as unknown as RlsClient, {
        orgId: wOrgId,
        userId: wUserId,
        accountId,
      })
      return draft.id as string
    })
  }

  async function draftRow(id: string): Promise<any> {
    const [row] = await withSystemDb("writers-draft-row", async (tx) =>
      extractRows<any>(
        await tx.execute(
          drizzleSql`SELECT * FROM ${drizzleSql.raw(`"${W_SCHEMA}"`)}.drafts WHERE id = ${id}::uuid`,
        ),
      ),
    )
    return row
  }

  itW(
    "a draft on a ready mailbox stores ciphertext and no plaintext",
    async () => {
      const accountId = await wAccount("ready")
      const draftId = await wDraft(accountId)
      const body = "A draft nobody but me can read."

      // The browser does this. Here the seal runs server side against the same
      // AAD the browser would build, which is what the client half will open.
      const { sealMailFields } = await import("~/modules/mailbox-crypto/mail-writer")
      const sealed = await sealMailFields({
        userId: wUserId,
        orgId: wOrgId,
        entity: "drafts",
        entityId: draftId,
        values: { body, subject: "draft subject" },
      })

      const updated = await withPrivilegedDb(wOrgId, "writers-update-draft", (tx) =>
        writerMailService.updateDraft(tx as unknown as RlsClient, {
          orgId: wOrgId,
          userId: wUserId,
          draftId,
          changes: {
            bodyCiphertext: (sealed.columns.bodyCiphertext as Buffer).toString("base64"),
            subjectCiphertext: (sealed.columns.subjectCiphertext as Buffer).toString("base64"),
            contentKeyWrapped: (sealed.columns.contentKeyWrapped as Buffer).toString("base64"),
            contentKeyEpk: (sealed.columns.contentKeyEpk as Buffer).toString("base64"),
            encKeyId: sealed.columns.encKeyId as number,
          },
        }),
      )
      expectW(updated).not.toBeNull()

      // Non-vacuity first: the row really carries ciphertext.
      const row = await draftRow(draftId)
      expectW(row.body_ciphertext?.length ?? 0).toBeGreaterThan(0)
      expectW(row.enc_version).toBe(1)
      expectW(row.subject).toBeNull()
      expectW(row.html_body).toBeNull()
      expectW(row.text_body).toBeNull()

      const contentKey = await unsealContentKey({
        privateKey: wKeys.privateKey,
        recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", wKeys.publicKey)),
        userId: wUserId,
        keyId: W_KEY_ID,
        wrapped: new Uint8Array(row.content_key_wrapped),
        epkSpki: new Uint8Array(row.content_key_epk),
      })
      const opened = await openField({
        contentKey,
        context: mailboxAad.draftBody(draftId),
        blob: new Uint8Array(row.body_ciphertext),
      })
      expectW(new TextDecoder().decode(opened)).toBe(body)
    },
    60_000,
  )

  itW(
    "a plaintext draft update on a ready mailbox is refused and changes nothing",
    async () => {
      const accountId = await wAccount("ready")
      const draftId = await wDraft(accountId)
      const before = await draftRow(draftId)

      const err = await withPrivilegedDb(wOrgId, "writers-plaintext-draft", (tx) =>
        writerMailService
          .updateDraft(tx as unknown as RlsClient, {
            orgId: wOrgId,
            userId: wUserId,
            draftId,
            changes: { textBody: "plaintext that must never land", subject: "leak" },
          })
          .catch((e: unknown) => e),
      )
      expectW(String((err as Error).message)).toContain("MAILBOX_PLAINTEXT_DRAFT_REFUSED")

      const after = await draftRow(draftId)
      expectW(after.text_body).toBe(before.text_body)
      expectW(after.subject).toBe(before.subject)
      expectW(String(after.updated_at)).toBe(String(before.updated_at))
    },
    60_000,
  )

  itW(
    "an empty plaintext field is absence, not content, and is accepted",
    async () => {
      const accountId = await wAccount("ready")
      const draftId = await wDraft(accountId)
      const updated = await withPrivilegedDb(wOrgId, "writers-empty-draft", (tx) =>
        writerMailService.updateDraft(tx as unknown as RlsClient, {
          orgId: wOrgId,
          userId: wUserId,
          draftId,
          changes: { subject: "", textBody: "", htmlBody: "" },
        }),
      )
      expectW(updated).not.toBeNull()
      const row = await draftRow(draftId)
      expectW(row.subject).toBeNull()
    },
    60_000,
  )

  itW(
    "a draft on a mailbox outside the regime still takes plaintext byte for byte",
    async () => {
      // The regression guard, and it needs an UNENROLLED owner. Arming is the
      // owner's active identity, not the account's `encryption_state`, so an
      // enrolled user's `none` account is armed too: there is no such thing as
      // "outside the regime" for a user who holds a key.
      const plainUser = await minimal.person(wOrgId)
      const accountId = randomUUID()
      await withSystemDb("writers-plain-account", (tx) =>
        tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${W_SCHEMA}"`)}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${accountId}::uuid, ${wOrgId}::uuid, ${randomUUID()}::uuid, 'user',
                ${plainUser.id}::uuid, 'gmail', ${`${accountId}@writers.test`}, 'active', 'none')`),
      )
      const draftId = await withPrivilegedDb(wOrgId, "writers-plain-draft-create", async (tx) => {
        const draft = await writerMailService.createDraft(tx as unknown as RlsClient, {
          orgId: wOrgId,
          userId: plainUser.id,
          accountId,
        })
        return draft.id as string
      })
      await withPrivilegedDb(wOrgId, "writers-plain-draft", (tx) =>
        writerMailService.updateDraft(tx as unknown as RlsClient, {
          orgId: wOrgId,
          userId: plainUser.id,
          draftId,
          changes: { textBody: "ordinary draft", subject: "ordinary subject" },
        }),
      )
      const row = await draftRow(draftId)
      expectW(row.text_body).toBe("ordinary draft")
      expectW(row.subject).toBe("ordinary subject")
    },
    60_000,
  )

  for (const state of ["blocked", "paused"]) {
    itW(
      `a draft update on a ${state} mailbox is refused and writes nothing`,
      async () => {
        const readyAccount = await wAccount("ready")
        const draftId = await wDraft(readyAccount)
        await withSystemDb("writers-move-state", (tx) =>
          tx.execute(
            drizzleSql`UPDATE ${drizzleSql.raw(`"${W_SCHEMA}"`)}.accounts SET encryption_state = ${state} WHERE id = ${readyAccount}::uuid`,
          ),
        )
        const err = await withPrivilegedDb(wOrgId, "writers-blocked-draft", (tx) =>
          writerMailService
            .updateDraft(tx as unknown as RlsClient, {
              orgId: wOrgId,
              userId: wUserId,
              draftId,
              changes: { textBody: "should not land" },
            })
            .catch((e: unknown) => e),
        )
        expectW(String((err as Error).message)).toContain("MAILBOX_ENCRYPTION_NOT_READY")
        const row = await draftRow(draftId)
        expectW(row.text_body).toBeNull()
      },
      60_000,
    )

    itW(
      `sendCompose on a ${state} mailbox refuses before any provider call`,
      async () => {
        const accountId = await wAccount(state)
        const err = await withPrivilegedDb(wOrgId, "writers-blocked-compose", (tx) =>
          writerMailService
            .sendCompose(tx as unknown as RlsClient, {
              orgId: wOrgId,
              userId: wUserId,
              accountId,
              to: ["someone@example.test"],
              subject: "s",
              htmlBody: "<p>b</p>",
              textBody: "b",
            })
            .catch((e: unknown) => e),
        )
        expectW(err).toBeInstanceOf(MailboxWriteError)
        expectW((err as MailboxWriteError).code).toBe("MAILBOX_ENCRYPTION_NOT_READY")
        const rows = await withSystemDb("writers-no-rows", async (tx) =>
          extractRows<any>(
            await tx.execute(
              drizzleSql`SELECT id FROM ${drizzleSql.raw(`"${W_SCHEMA}"`)}.messages WHERE account_id = ${accountId}::uuid`,
            ),
          ),
        )
        expectW(rows.length).toBe(0)
      },
      60_000,
    )
  }

  itW(
    "applyMailSealToRow leaves no plaintext on a Sent row and binds the row id",
    async () => {
      // The exact mechanism the send paths use: INSERT with the guarded plaintext
      // columns NULL, then seal against the id the INSERT returned, in the same
      // transaction. Reached here directly because a real send needs a live
      // provider, and the persist half is the half this phase owns.
      const accountId = await wAccount("ready")
      const conversationId = randomUUID()
      const messageId = randomUUID()
      await withSystemDb("writers-sent-fixture", async (tx) => {
        await tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${W_SCHEMA}"`)}.conversations
          (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
           is_read, is_starred, message_count)
        VALUES (${conversationId}::uuid, ${wOrgId}::uuid, ${accountId}::uuid, 'user', ${wUserId}::uuid,
                ${`w-${conversationId}`}, 'open', '["SENT"]'::jsonb, true, false, 1)`)
        await tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${W_SCHEMA}"`)}.messages
          (id, org_id, conversation_id, account_id, external_message_id, message_references,
           from_address, to_addresses, cc_addresses, bcc_addresses, is_read, is_starred, labels,
           direction, raw_headers, owner_type, owner_id)
        VALUES (${messageId}::uuid, ${wOrgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
                ${`<w-${messageId}@x>`}, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
                '[]'::jsonb, true, false, '["SENT"]'::jsonb, 'outbound', '{}'::jsonb, 'user',
                ${wUserId}::uuid)`)
      })

      await withPrivilegedDb(wOrgId, "writers-seal-sent", async (tx) => {
        const { pointConversationAtMessage } = await import("~/modules/mailbox-crypto/mail-writer")
        await applyMailSealToRow(tx, {
          schemaName: W_SCHEMA,
          orgId: wOrgId,
          userId: wUserId,
          entity: "messages",
          rowId: messageId,
          values: { subject: "Sent subject", textBody: "Sent body", snippet: "Sent body" },
          headers: {},
        })
        await pointConversationAtMessage(tx, W_SCHEMA, wOrgId, conversationId, messageId)
      })

      const [row] = await withSystemDb("writers-sent-read", async (tx) =>
        extractRows<any>(
          await tx.execute(
            drizzleSql`SELECT * FROM ${drizzleSql.raw(`"${W_SCHEMA}"`)}.messages WHERE id = ${messageId}::uuid`,
          ),
        ),
      )
      expectW(row.subject).toBeNull()
      expectW(row.text_body).toBeNull()
      expectW(row.enc_version).toBe(1)
      expectW(row.text_body_ciphertext?.length ?? 0).toBeGreaterThan(0)

      const contentKey = await unsealContentKey({
        privateKey: wKeys.privateKey,
        recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", wKeys.publicKey)),
        userId: wUserId,
        keyId: W_KEY_ID,
        wrapped: new Uint8Array(row.content_key_wrapped),
        epkSpki: new Uint8Array(row.content_key_epk),
      })
      expectW(
        new TextDecoder().decode(
          await openField({
            contentKey,
            context: mailboxAad.messageTextBody(messageId),
            blob: new Uint8Array(row.text_body_ciphertext),
          }),
        ),
      ).toBe("Sent body")

      const [conv] = await withSystemDb("writers-sent-conv", async (tx) =>
        extractRows<any>(
          await tx.execute(
            drizzleSql`SELECT * FROM ${drizzleSql.raw(`"${W_SCHEMA}"`)}.conversations WHERE id = ${conversationId}::uuid`,
          ),
        ),
      )
      expectW(conv.snippet).toBeNull()
      expectW(conv.snippet_source_message_id).toBe(messageId)
      expectW(Buffer.from(conv.snippet_ciphertext).toString("base64")).toBe(
        Buffer.from(row.snippet_ciphertext).toString("base64"),
      )
    },
    60_000,
  )

  itW(
    "the conversation read projection carries the envelope the browser needs to open the mail",
    async () => {
      // Journey (a): mail arrives while the owner is offline, then the owner
      // reads it in the browser. `GET /api/mail/conversations/:id` is the ONLY
      // endpoint the reader gets messages from, so a projection that emits the
      // plaintext columns and none of the ciphertext leaves the user looking at
      // a message whose subject and body are NULL, with nothing to decrypt.
      const accountId = await wAccount("ready")
      const conversationId = randomUUID()
      const messageId = randomUUID()
      await withSystemDb("writers-read-fixture", async (tx) => {
        await tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${W_SCHEMA}"`)}.conversations
          (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
           is_read, is_starred, message_count)
        VALUES (${conversationId}::uuid, ${wOrgId}::uuid, ${accountId}::uuid, 'user', ${wUserId}::uuid,
                ${`wr-${conversationId}`}, 'open', '[]'::jsonb, false, false, 1)`)
        await tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${W_SCHEMA}"`)}.messages
          (id, org_id, conversation_id, account_id, external_message_id, message_references,
           from_address, to_addresses, cc_addresses, bcc_addresses, is_read, is_starred, labels,
           direction, raw_headers, owner_type, owner_id, sent_at)
        VALUES (${messageId}::uuid, ${wOrgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
                ${`<wr-${messageId}@x>`}, '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
                '[]'::jsonb, false, false, '[]'::jsonb, 'inbound', '{}'::jsonb, 'user',
                ${wUserId}::uuid, now())`)
      })
      await withPrivilegedDb(wOrgId, "writers-read-seal", async (tx) => {
        const { pointConversationAtMessage } = await import("~/modules/mailbox-crypto/mail-writer")
        await applyMailSealToRow(tx, {
          schemaName: W_SCHEMA,
          orgId: wOrgId,
          userId: wUserId,
          entity: "messages",
          rowId: messageId,
          values: {
            subject: "Read-path subject",
            textBody: "Read-path body, which only the owner may see.",
            snippet: "Read-path body",
          },
          headers: {},
        })
        await pointConversationAtMessage(tx, W_SCHEMA, wOrgId, conversationId, messageId)
      })

      // The read runs as the owner's request does, on an RLS transaction.
      const payload = (await withRlsContext(
        {
          actorType: "user",
          userId: wUserId,
          orgId: wOrgId,
          scopes: ["mail:*"],
          dimensionGrants: { "*": ["*"] },
        },
        (tx) =>
          writerMailService.getConversation(tx, {
            orgId: wOrgId,
            userId: wUserId,
            conversationId,
          }),
      )) as {
        messages: Array<Record<string, any>>
        conversation: Record<string, any>
      } | null

      expectW(payload).not.toBeNull()
      const projected = (payload as { messages: Array<Record<string, any>> }).messages.find(
        (m) => m.id === messageId,
      ) as Record<string, any>
      expectW(projected, "the sealed message must be in the projection").toBeDefined()

      // The plaintext half is NULL, which is the point, so the sealed half has
      // to be there or the reader has nothing at all.
      expectW(projected.subject).toBeNull()
      expectW(projected.textBody).toBeNull()
      expectW(projected.encVersion).toBe(1)
      expectW(projected.encKeyId).toBe(W_KEY_ID)
      for (const key of [
        "subjectCiphertext",
        "textBodyCiphertext",
        "snippetCiphertext",
        "contentKeyWrapped",
        "contentKeyEpk",
      ]) {
        expectW(
          typeof projected[key] === "string" && projected[key].length > 0,
          `${key} must be a non-empty base64 string on the wire`,
        ).toBe(true)
      }

      // The client half opens what the projection handed it, byte for byte.
      const contentKey = await unsealContentKey({
        privateKey: wKeys.privateKey,
        recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", wKeys.publicKey)),
        userId: wUserId,
        keyId: W_KEY_ID,
        wrapped: new Uint8Array(Buffer.from(projected.contentKeyWrapped, "base64")),
        epkSpki: new Uint8Array(Buffer.from(projected.contentKeyEpk, "base64")),
      })
      expectW(
        new TextDecoder().decode(
          await openField({
            contentKey,
            context: mailboxAad.messageTextBody(messageId),
            blob: new Uint8Array(Buffer.from(projected.textBodyCiphertext, "base64")),
          }),
        ),
      ).toBe("Read-path body, which only the owner may see.")

      // The conversation header carries its own envelope too: the list and the
      // thread title come from here, not from the messages.
      const conversation = (payload as { conversation: Record<string, any> }).conversation
      expectW(conversation.encVersion).toBe(1)
      expectW(typeof conversation.snippetCiphertext === "string").toBe(true)
      expectW(typeof conversation.contentKeyWrapped === "string").toBe(true)
      // The header's ciphertext is a copy of this message's, so it opens under
      // the MESSAGE's AAD: without the source id the browser cannot open it.
      expectW(conversation.snippetSourceMessageId).toBe(messageId)
    },
    60_000,
  )
})
