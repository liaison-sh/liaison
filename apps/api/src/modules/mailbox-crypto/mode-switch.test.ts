// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Switching on server-managed mail encryption, against the database: which mode
// a new mailbox gets (the person's pick inside the org switch, else the
// deployment default), the boot step that moves never-enrolled waiting
// mailboxes to `managed`, and the two owner-only switches between modes.
//
// The test environment pins MAILBOX_ENCRYPTION_DEFAULT=private (.env.test), the
// zero-access behaviour every other suite is written against; each case that
// needs the transparent default says so through a pick or the org switch.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { deriveFieldSubkey } from "@liaison/mailbox-crypto/src/kdf"
import { sql as drizzleSql } from "drizzle-orm"
import { EXPORT_EXCLUDED_TABLES } from "~/cli/export-full"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { env } from "~/lib/env"
import { sealMailApprovalPayload } from "~/modules/mailbox-crypto/approval-payload"
import {
  EncryptionModeTestAccess,
  effectiveMailboxEncryptionMode,
  mailboxEncryptionSettings,
  resolveDeploymentEncryptionDefault,
} from "~/modules/mailbox-crypto/encryption-mode"
import { sealMailFields } from "~/modules/mailbox-crypto/mail-writer"
import {
  openManagedApprovalPayload,
  revealManagedApprovalSummaries,
} from "~/modules/mailbox-crypto/managed-approval"
import { ensureMailboxServerKey } from "~/modules/mailbox-crypto/managed-keys"
import { openManagedMailRows } from "~/modules/mailbox-crypto/managed-open"
import {
  applyTransparentBatch,
  beginMakeMailboxTransparent,
  finishMakeMailboxTransparent,
  listTransparentPending,
  makeMailboxPrivate,
} from "~/modules/mailbox-crypto/mode-switch"
import { assertMailboxSchemaState } from "~/modules/mailbox-crypto/post-sync-assertions"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const K = drizzleSql.raw("kernel")

const created: { orgs: Set<string> } = { orgs: new Set() }

async function enroll(user: minimal.Person, keyId: number) {
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair
  const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
  const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
  await withSystemDb("mode-switch-test-enroll", (db) =>
    db.execute(drizzleSql`
      INSERT INTO ${K}.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${user.orgId}::uuid, ${user.id}::uuid, ${keyId}, ${ecdhSpki}, ${signSpki},
              ${Buffer.from("attestation")}, 'active')`),
  )
  return { user, keyId, ecdh, ecdhSpki: new Uint8Array(ecdhSpki) }
}

/**
 * What the owner's unlocked browser hands back with a row it opened: the D5
 * subkey of each sealed field, the proof that its plaintext is the row's.
 */
async function fieldKeys(
  owner: Awaited<ReturnType<typeof enroll>>,
  stored: Record<string, unknown>,
  contexts: Record<string, ReturnType<typeof mailboxAad.messageSubject>>,
): Promise<Record<string, string>> {
  const contentKey = await unsealContentKey({
    privateKey: owner.ecdh.privateKey,
    recipientEcdhSpki: owner.ecdhSpki,
    userId: owner.user.id,
    keyId: owner.keyId,
    wrapped: new Uint8Array(stored.content_key_wrapped as Uint8Array),
    epkSpki: new Uint8Array(stored.content_key_epk as Uint8Array),
  })
  const keys: Record<string, string> = {}
  for (const [field, context] of Object.entries(contexts)) {
    const subkey = await deriveFieldSubkey({
      contentKey,
      fieldName: context.fieldName,
      entityId: context.entityId,
    })
    keys[field] = Buffer.from(subkey).toString("base64")
  }
  return keys
}

/** Starting the move is confirmed by the route's step-up; here, a stand-in. */
const stepUpConfirmed = async () => {}

async function account(user: minimal.Person, state: string): Promise<string> {
  const id = crypto.randomUUID()
  created.orgs.add(user.orgId)
  await withSystemDb("mode-switch-test-account", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${id}::uuid, ${user.orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
              ${user.id}::uuid, 'gmail', ${`${id}@mode.test`}, 'active', ${state})`),
  )
  return id
}

async function message(user: minimal.Person, accountId: string, state: string, subject: string) {
  const id = crypto.randomUUID()
  const sealed = await sealMailFields({
    userId: user.id,
    orgId: user.orgId,
    entity: "messages",
    entityId: id,
    values: { subject, textBody: `${subject} body`, snippet: subject },
    account: { id: accountId, encryptionState: state },
  })
  const c = sealed.columns
  await withSystemDb("mode-switch-test-message", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.messages
        (id, org_id, account_id, conversation_id, external_message_id, owner_type, owner_id,
         direction, sent_at, labels, is_read, is_starred, raw_headers,
         subject_ciphertext, text_body_ciphertext, snippet_ciphertext,
         content_key_wrapped, content_key_epk, enc_key_id, enc_version)
      VALUES (${id}::uuid, ${user.orgId}::uuid, ${accountId}::uuid, ${crypto.randomUUID()}::uuid,
              ${`ext-${id}`}, 'user', ${user.id}::uuid, 'inbound', now(), '[]'::jsonb, false,
              false, '{}'::jsonb, ${c.subjectCiphertext as Buffer}, ${c.textBodyCiphertext as Buffer},
              ${c.snippetCiphertext as Buffer}, ${c.contentKeyWrapped as Buffer},
              ${(c.contentKeyEpk as Buffer | undefined) ?? null}, ${c.encKeyId as number},
              ${c.encVersion as number})`),
  )
  return id
}

async function conversation(
  user: minimal.Person,
  accountId: string,
  state: string,
  subject: string,
) {
  const id = crypto.randomUUID()
  await withSystemDb("mode-switch-test-conversation", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.conversations
        (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
         is_read, is_starred, message_count)
      VALUES (${id}::uuid, ${user.orgId}::uuid, ${accountId}::uuid, 'user', ${user.id}::uuid,
              ${`t-${id}`}, 'open', '[]'::jsonb, false, false, 1)`),
  )
  const sealed = await sealMailFields({
    userId: user.id,
    orgId: user.orgId,
    entity: "conversations",
    entityId: id,
    values: { subject, snippet: subject },
    account: { id: accountId, encryptionState: state },
  })
  const c = sealed.columns
  await withSystemDb("mode-switch-test-conversation-seal", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${MAIL}.conversations
         SET subject_ciphertext = ${c.subjectCiphertext as Buffer},
             snippet_ciphertext = ${c.snippetCiphertext as Buffer},
             content_key_wrapped = ${c.contentKeyWrapped as Buffer},
             content_key_epk = ${(c.contentKeyEpk as Buffer | undefined) ?? null},
             enc_key_id = ${c.encKeyId as number}, enc_version = ${c.encVersion as number}
       WHERE id = ${id}::uuid`),
  )
  return id
}

function b64(value: unknown): string {
  return Buffer.from(value as Uint8Array).toString("base64")
}

async function row(table: string, id: string) {
  return withSystemDb("mode-switch-test-read", async (tx) =>
    extractRows<Record<string, unknown> & { id: string }>(
      await tx.execute(
        drizzleSql`SELECT * FROM ${MAIL}.${drizzleSql.raw(`"${table}"`)} WHERE id = ${id}::uuid`,
      ),
    ),
  )
}

async function setPreference(user: minimal.Person, mode: string) {
  await withSystemDb("mode-switch-test-pref", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${K}.users SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{mail}',
        ${JSON.stringify({ encryptionPreference: mode })}::jsonb, true)
       WHERE id = ${user.id}::uuid`),
  )
}

async function setAllowPrivate(orgId: string, allow: boolean) {
  await withSystemDb("mode-switch-test-policy", (tx) =>
    tx.execute(drizzleSql`
      UPDATE ${K}.organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{mail}',
        ${JSON.stringify({ allowPrivateMailboxes: allow })}::jsonb, true)
       WHERE id = ${orgId}::uuid`),
  )
}

beforeAll(acquireTestLock)
afterAll(async () => {
  await withSystemDb("mode-switch-test-cleanup", async (tx) => {
    for (const orgId of created.orgs) {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.mailbox_server_keys WHERE org_id = ${orgId}::uuid`,
      )
    }
  })
  await releaseTestLock()
})

describe("which mode a new mailbox gets", () => {
  it("takes MAILBOX_ENCRYPTION_DEFAULT when set", async () => {
    await withSystemDb("mode-test", async (tx) => {
      expect(await resolveDeploymentEncryptionDefault(tx, "managed")).toEqual({
        mode: "managed",
        reason: "env",
      })
      expect(await resolveDeploymentEncryptionDefault(tx, "private")).toEqual({
        mode: "private",
        reason: "env",
      })
    })
  })

  it("auto is decided once, counting every enrollment whatever its preference, and stays put", async () => {
    const clearStored = () =>
      withSystemDb("mode-test-clear", (tx) =>
        tx.execute(
          drizzleSql`DELETE FROM ${K}.instance_settings WHERE key = 'mail.encryption_default'`,
        ),
      )
    const resolve = async () => {
      EncryptionModeTestAccess.reset()
      return withSystemDb("mode-test", (tx) => resolveDeploymentEncryptionDefault(tx, null))
    }
    try {
      await clearStored()
      // An enrolled person who also recorded a preference (the old rule skipped
      // them, so one preference click could flip the deployment to managed).
      const legacy = await minimal.person((await createTestOrg()).id)
      await enroll(legacy, 3)
      await setPreference(legacy, "managed")
      expect(await resolve()).toEqual({
        mode: "private",
        reason: "auto:legacy_private_enrollments",
      })
      // Stored: every later resolution, on any process, reads the same answer.
      expect(await resolve()).toEqual({ mode: "private", reason: "auto:stored" })
      await setPreference(legacy, "private")
      expect((await resolve()).mode).toBe("private")

      // A decision once taken is never re-decided, in either direction: an
      // enrollment after a transparent decision does not flip it either.
      await clearStored()
      await withSystemDb("mode-test-store", (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO ${K}.instance_settings (key, value)
          VALUES ('mail.encryption_default', '{"mode":"managed"}'::jsonb)`),
      )
      expect(await resolve()).toEqual({ mode: "managed", reason: "auto:stored" })
    } finally {
      await clearStored()
      EncryptionModeTestAccess.reset()
    }
  })

  it("is the person's pick inside the org switch", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    await withSystemDb("mode-test", async (tx) => {
      // No pick: the deployment default (private in tests).
      expect(await effectiveMailboxEncryptionMode(tx, user.orgId, user.id)).toBe("private")
    })
    await setPreference(user, "managed")
    await withSystemDb("mode-test", async (tx) => {
      expect(await effectiveMailboxEncryptionMode(tx, user.orgId, user.id)).toBe("managed")
    })
    await setPreference(user, "private")
    await setAllowPrivate(user.orgId, false)
    await withSystemDb("mode-test", async (tx) => {
      // The org does not allow private mailboxes: transparent, whatever the pick.
      const settings = await mailboxEncryptionSettings(tx, user.orgId, user.id)
      expect(settings.effective).toBe("managed")
      expect(settings.allowPrivate).toBe(false)
      expect(settings.canMakeTransparent).toBe(true)
    })
  })
})

describe("MAILBOX_ENCRYPTION_ALLOW_MANAGED=false locks private", () => {
  it("makes everything private: the default, the pick, the org switch and Make transparent", async () => {
    const instance = env as { MAILBOX_ENCRYPTION_ALLOW_MANAGED: boolean }
    const user = await minimal.person((await createTestOrg()).id)
    await setPreference(user, "managed")
    await setAllowPrivate(user.orgId, false)
    instance.MAILBOX_ENCRYPTION_ALLOW_MANAGED = false
    try {
      await withSystemDb("mode-test", async (tx) => {
        expect(await resolveDeploymentEncryptionDefault(tx, "managed")).toEqual({
          mode: "private",
          reason: "env:locked_private",
        })
        const settings = await mailboxEncryptionSettings(tx, user.orgId, user.id)
        expect(settings.effective).toBe("private")
        expect(settings.allowManaged).toBe(false)
        expect(settings.canMakeTransparent).toBe(false)
      })
      const id = await account(user, "ready")
      await expect(
        beginMakeMailboxTransparent({
          orgId: user.orgId,
          userId: user.id,
          accountId: id,
          confirmStepUp: stepUpConfirmed,
        }),
      ).rejects.toThrow("TRANSPARENT_NOT_OFFERED")
    } finally {
      instance.MAILBOX_ENCRYPTION_ALLOW_MANAGED = true
    }
  })
})

describe("the boot step", () => {
  it("moves a waiting mailbox of a never-enrolled transparent owner to managed, and nothing else", async () => {
    const transparent = await minimal.person((await createTestOrg()).id)
    await setPreference(transparent, "managed")
    // One org: a new test org can retire an earlier one's users.
    const privateOwner = await minimal.person(transparent.orgId)
    const enrolled = await minimal.person(transparent.orgId)
    await setPreference(enrolled, "managed")
    await enroll(enrolled, 7)
    const moves = await account(transparent, "pending_enrollment")
    const stays = await account(privateOwner, "pending_enrollment")
    const enrolledStays = await account(enrolled, "pending_enrollment")
    const ready = await account(enrolled, "ready")

    const result = await withSystemDb("mode-test-boot", (tx) =>
      assertMailboxSchemaState(tx, schemaRef("app_mail")),
    )
    expect(result.accountsMovedToManaged).toBeGreaterThanOrEqual(1)
    expect((await row("accounts", moves))[0]?.encryption_state).toBe("managed")
    // Private by default (tests pin private): unchanged, exactly as today.
    expect((await row("accounts", stays))[0]?.encryption_state).toBe("pending_enrollment")
    // An owner who ever enrolled is never moved, whatever their pick.
    expect((await row("accounts", enrolledStays))[0]?.encryption_state).toBe("pending_enrollment")
    expect((await row("accounts", ready))[0]?.encryption_state).toBe("ready")
  })
})

describe("switching a mailbox between modes", () => {
  it("make private: needs a mailbox password, then re-seals every row to the owner and destroys the key", async () => {
    const owner = await minimal.person((await createTestOrg()).id)
    const acct = await account(owner, "managed")
    const msg = await message(owner, acct, "managed", "PRIVATESWITCH")
    expect(Number((await row("messages", msg))[0]?.enc_version)).toBe(2)

    await expect(
      makeMailboxPrivate({ orgId: owner.orgId, userId: owner.id, accountId: acct }),
    ).rejects.toThrow(/NOT_ENROLLED/)

    await enroll(owner, 9)
    const result = await makeMailboxPrivate({
      orgId: owner.orgId,
      userId: owner.id,
      accountId: acct,
    })
    expect(result.messages).toBe(1)
    const [after] = await row("messages", msg)
    expect(Number(after?.enc_version)).toBe(1)
    expect(Number(after?.enc_key_id)).toBe(9)
    expect(after?.content_key_epk).not.toBeNull()
    expect((await row("accounts", acct))[0]?.encryption_state).toBe("ready")
    const keys = await withSystemDb("mode-test-keys", async (tx) =>
      extractRows(
        await tx.execute(
          drizzleSql`SELECT 1 FROM ${K}.mailbox_server_keys WHERE account_id = ${acct}::uuid`,
        ),
      ),
    )
    expect(keys).toHaveLength(0)
    // Recorded as the owner's own pick.
    const pref = await withSystemDb("mode-test-pref-read", async (tx) =>
      extractRows<{ v: string }>(
        await tx.execute(
          drizzleSql`SELECT settings -> 'mail' ->> 'encryptionPreference' AS v FROM ${K}.users WHERE id = ${owner.id}::uuid`,
        ),
      ),
    )
    expect(pref[0]?.v).toBe("private")
    expect((await row("accounts", acct))[0]?.encryption_conversion).toBeNull()
    // No key is ever minted again for it: a late writer that still read
    // "managed" fails its seal instead of writing a server-readable row.
    await expect(
      sealMailFields({
        userId: owner.id,
        orgId: owner.orgId,
        entity: "messages",
        entityId: crypto.randomUUID(),
        values: { subject: "LATE" },
        account: { id: acct, encryptionState: "managed" },
      }),
    ).rejects.toThrow(/MAILBOX_SERVER_KEY_REFUSED/)
  })

  it("make private resumes an interrupted run and converts what arrived meanwhile", async () => {
    const owner = await minimal.person((await createTestOrg()).id)
    await enroll(owner, 12)
    const acct = await account(owner, "managed")
    const first = await message(owner, acct, "managed", "RESUMEONE")
    const conv = await conversation(owner, acct, "managed", "RESUMECONV")
    // A run that stopped after it began: still transparent, conversion recorded.
    await withSystemDb("mode-test-interrupt", (tx) =>
      tx.execute(drizzleSql`
        UPDATE ${MAIL}.accounts SET encryption_conversion = 'to_private' WHERE id = ${acct}::uuid`),
    )
    // Mail kept arriving, sealed in the mode the mailbox is still in.
    const second = await message(owner, acct, "managed", "RESUMETWO")
    const result = await makeMailboxPrivate({
      orgId: owner.orgId,
      userId: owner.id,
      accountId: acct,
    })
    expect(result.done).toBe(true)
    expect(result.messages).toBe(2)
    expect(result.conversations).toBe(1)
    for (const id of [first, second]) {
      expect(Number((await row("messages", id))[0]?.enc_version)).toBe(1)
    }
    expect(Number((await row("conversations", conv))[0]?.enc_version)).toBe(1)
    const [after] = await row("accounts", acct)
    expect(after?.encryption_state).toBe("ready")
    expect(after?.encryption_conversion).toBeNull()
    // Running it again is a no-op.
    expect(
      (await makeMailboxPrivate({ orgId: owner.orgId, userId: owner.id, accountId: acct })).done,
    ).toBe(true)
  })

  it("make private is the owner's alone", async () => {
    const owner = await minimal.person((await createTestOrg()).id)
    const other = await minimal.person(owner.orgId, { role: "admin" })
    const acct = await account(owner, "managed")
    await expect(
      makeMailboxPrivate({ orgId: owner.orgId, userId: other.id, accountId: acct }),
    ).rejects.toThrow(/MAILBOX_NOT_OWNER/)
  })

  it("make transparent: not offered on a private-default deployment, then a resumable conversion of every private-sealed row", async () => {
    const owner = await minimal.person((await createTestOrg()).id)
    const keyring = await enroll(owner, 11)
    const acct = await account(owner, "ready")
    const msg = await message(owner, acct, "ready", "TRANSPARENTSWITCH")
    const conv = await conversation(owner, acct, "ready", "TRANSPARENTCONV")
    expect(Number((await row("messages", msg))[0]?.enc_version)).toBe(1)
    const ids = { orgId: owner.orgId, userId: owner.id, accountId: acct }

    let stepUps = 0
    const begin = () =>
      beginMakeMailboxTransparent({
        ...ids,
        confirmStepUp: async () => {
          stepUps += 1
        },
      })
    await expect(begin()).rejects.toThrow(/TRANSPARENT_NOT_OFFERED/)
    expect(stepUps).toBe(0)

    await setAllowPrivate(owner.orgId, false)
    // A refused step-up starts nothing.
    await expect(
      beginMakeMailboxTransparent({
        ...ids,
        confirmStepUp: async () => {
          throw new Error("step-up refused")
        },
      }),
    ).rejects.toThrow("step-up refused")
    expect((await row("accounts", acct))[0]?.encryption_conversion).toBeNull()
    await begin()
    expect(stepUps).toBe(1)
    // Still private while it converts: the browser keeps opening v1 rows, and
    // writers keep sealing to the owner until the end.
    let [acc] = await row("accounts", acct)
    expect(acc?.encryption_state).toBe("ready")
    expect(acc?.encryption_conversion).toBe("to_managed")
    // Resuming is the same call, and asks for no second step-up.
    await begin()
    expect(stepUps).toBe(1)

    const pending = await listTransparentPending({ ...ids, entity: "messages" })
    expect(pending.items.map((i) => i.id)).toEqual([msg])
    expect(typeof pending.items[0]?.contentKeyWrapped).toBe("string")
    const convPending = await listTransparentPending({ ...ids, entity: "conversations" })
    expect(convPending.items.map((i) => i.id)).toEqual([conv])

    // Not finished while anything private-sealed is left.
    expect(await finishMakeMailboxTransparent(ids)).toMatchObject({ done: false, remaining: 2 })

    const msgKey = b64((await row("messages", msg))[0]?.content_key_wrapped)
    const foreign = crypto.randomUUID()
    const batch = await applyTransparentBatch({
      ...ids,
      batch: {
        messages: [
          // A copy the browser opened before the row changed is refused.
          {
            id: msg,
            contentKeyWrapped: Buffer.from("stale").toString("base64"),
            subject: "STALE",
          },
          { id: foreign, contentKeyWrapped: msgKey, subject: "not mine" },
        ],
      },
    })
    expect(batch).toEqual({ resealed: 0, skipped: [msg, foreign] })
    const convRow = (await row("conversations", conv))[0] as Record<string, unknown>
    const convKey = b64(convRow.content_key_wrapped)
    const msgRow = (await row("messages", msg))[0] as Record<string, unknown>
    const msgFieldKeys = await fieldKeys(keyring, msgRow, {
      subject: mailboxAad.messageSubject(msg),
      textBody: mailboxAad.messageTextBody(msg),
      snippet: mailboxAad.messageSnippet(msg),
    })
    // Plaintext the row does not hold is refused, even with the row's own keys.
    expect(
      await applyTransparentBatch({
        ...ids,
        batch: {
          messages: [
            {
              id: msg,
              contentKeyWrapped: msgKey,
              subject: "TRANSPARENTSWITCH",
              textBody: "something else",
              snippet: "TRANSPARENTSWITCH",
              fieldKeys: msgFieldKeys,
            },
          ],
        },
      }),
    ).toEqual({ resealed: 0, skipped: [msg] })
    const good = await applyTransparentBatch({
      ...ids,
      batch: {
        messages: [
          {
            id: msg,
            contentKeyWrapped: msgKey,
            subject: "TRANSPARENTSWITCH",
            textBody: "TRANSPARENTSWITCH body",
            snippet: "TRANSPARENTSWITCH",
            fieldKeys: msgFieldKeys,
          },
        ],
        conversations: [
          {
            id: conv,
            contentKeyWrapped: convKey,
            subject: "TRANSPARENTCONV",
            snippet: "TRANSPARENTCONV",
            fieldKeys: await fieldKeys(keyring, convRow, {
              subject: mailboxAad.conversationSubject(conv),
              snippet: mailboxAad.conversationSnippet(conv),
            }),
          },
        ],
      },
    })
    expect(good).toEqual({ resealed: 2, skipped: [] })
    const rows = await row("messages", msg)
    expect(Number(rows[0]?.enc_version)).toBe(2)
    // The owner reads it on the web while the mailbox is still converting.
    const opened = await openManagedMailRows({
      orgId: owner.orgId,
      accountId: acct,
      entity: "messages",
      rows,
      actor: { userId: owner.id },
      purpose: { kind: "web_view" },
    })
    expect(opened.get(msg)?.textBody).toBe("TRANSPARENTSWITCH body")

    expect(await finishMakeMailboxTransparent(ids)).toMatchObject({ done: true, remaining: 0 })
    ;[acc] = await row("accounts", acct)
    expect(acc?.encryption_state).toBe("managed")
    expect(acc?.encryption_conversion).toBeNull()
  })
})

describe("the data keys follow the mailbox", () => {
  it("deleting a mailbox row destroys its keys, whatever deleted it", async () => {
    await withSystemDb("mode-test-boot", (tx) =>
      assertMailboxSchemaState(tx, schemaRef("app_mail")),
    )
    const owner = await minimal.person((await createTestOrg()).id)
    const acct = await account(owner, "managed")
    await withSystemDb("mode-test-key", (tx) => ensureMailboxServerKey(tx, owner.orgId, acct))
    await withSystemDb("mode-test-delete", (tx) =>
      tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE id = ${acct}::uuid`),
    )
    const keys = await withSystemDb("mode-test-keys-after", async (tx) =>
      extractRows(
        await tx.execute(
          drizzleSql`SELECT 1 FROM ${K}.mailbox_server_keys WHERE account_id = ${acct}::uuid`,
        ),
      ),
    )
    expect(keys).toHaveLength(0)
  })

  it("a full export keeps the key table: a restore needs it", () => {
    expect(EXPORT_EXCLUDED_TABLES as readonly string[]).not.toContain("kernel.mailbox_server_keys")
  })
})

describe("gated sends from a transparent mailbox", () => {
  it("seals the draft in the approval row, opens it for the owner only", async () => {
    const owner = await minimal.person((await createTestOrg()).id)
    const admin = await minimal.person(owner.orgId, { role: "admin" })
    const acct = await account(owner, "managed")
    const conversationId = crypto.randomUUID()
    await withSystemDb("mode-test-conv", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.conversations
          (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
           is_read, is_starred, message_count)
        VALUES (${conversationId}::uuid, ${owner.orgId}::uuid, ${acct}::uuid, 'user',
                ${owner.id}::uuid, ${`t-${conversationId}`}, 'open', '[]'::jsonb, false, false, 1)`),
    )
    const approvalRequestId = crypto.randomUUID()
    const sealed = await sealMailApprovalPayload({
      orgId: owner.orgId,
      appName: "mail",
      toolShortName: "reply",
      approvalRequestId,
      toolParams: {
        conversationId,
        subject: "APPROVALMANAGEDSUBJECT",
        textBody: "APPROVALMANAGEDBODY",
        quotedOriginal: "APPROVALMANAGEDQUOTE",
      },
    })
    const text = JSON.stringify(sealed)
    expect(text).not.toContain("APPROVALMANAGEDSUBJECT")
    expect(text).not.toContain("APPROVALMANAGEDBODY")
    expect(text).not.toContain("APPROVALMANAGEDQUOTE")
    expect(sealed.encVersion).toBe(2)
    expect(sealed.mailboxSealed).toBe(true)

    const opened = await openManagedApprovalPayload({
      payload: sealed,
      orgId: owner.orgId,
      deciderId: owner.id,
      approvalRequestId,
    })
    expect(opened.textBody).toBe("APPROVALMANAGEDBODY")
    expect(opened.subject).toBe("APPROVALMANAGEDSUBJECT")
    expect(opened.mailboxSealed).toBeUndefined()
    await expect(
      openManagedApprovalPayload({
        payload: sealed,
        orgId: owner.orgId,
        deciderId: admin.id,
        approvalRequestId,
      }),
    ).rejects.toThrow(/MAILBOX_MANAGED_ACCESS_DENIED/)

    const [forAdmin] = await revealManagedApprovalSummaries(
      [{ id: approvalRequestId, currentPayload: sealed }],
      owner.orgId,
      admin.id,
    )
    expect(JSON.stringify(forAdmin)).not.toContain("APPROVALMANAGEDBODY")
    const [forOwner] = await revealManagedApprovalSummaries(
      [{ id: approvalRequestId, currentPayload: sealed }],
      owner.orgId,
      owner.id,
    )
    const shown = (forOwner?.currentPayload ?? {}) as { textBody?: string }
    expect(shown.textBody).toBe("APPROVALMANAGEDBODY")
    await withSystemDb("mode-test-conv-cleanup", (tx) =>
      tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE id = ${conversationId}::uuid`),
    )
  })
})
