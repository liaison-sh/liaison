// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 5.1: the sealing surface a sandboxed mail handler may reach.
//
// The bridge can SEAL. It has no method that unseals, and it never will: the
// server holds no key that can read mail. The asymmetry is the security
// property, and T-SEC-1 (b16) walks the import graph to prove it structurally.
// What this file proves is the behaviour at the bridge boundary.
//
// The check that matters most is `RECIPIENT_MISMATCH`. The acting identity is
// NEVER a parameter: it comes from the captured execution context, and the
// recipient comes from the account row. A `userId` parameter would let a
// sandboxed handler, a bundle change or a compromised app seal a victim's mail
// to another org member's public key, and nothing downstream would notice.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { openField, unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import type { RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { createRpcBridge } from "./rpc-bridge"

const SCHEMA = schemaRef("app_mail")

let ORG_ID: string

beforeAll(async () => {
  await acquireTestLock()
  // One org for the whole file: bootstrapping an org is the slow part, and every
  // case below varies the USER's enrollment, not the tenant.
  ORG_ID = (await minimal.person((await createTestOrg()).id)).orgId
})
afterAll(releaseTestLock)

async function member(): Promise<{ id: string; orgId: string }> {
  const user = await minimal.person(ORG_ID)
  return { id: user.id, orgId: user.orgId }
}

async function enroll(
  orgId: string,
  userId: string,
  keyId: number,
  status = "active",
): Promise<CryptoKeyPair> {
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair
  const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
  const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
  await withSystemDb("bridge-seal-test-enroll", (db) =>
    db.execute(drizzleSql`
      INSERT INTO kernel.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${orgId}::uuid, ${userId}::uuid, ${keyId}, ${ecdhSpki}, ${signSpki},
              ${Buffer.from("attestation")}, ${status})`),
  )
  return ecdh
}

async function createAccount(
  orgId: string,
  ownerId: string | null,
  encryptionState: string,
  ownerType = "user",
): Promise<string> {
  const id = crypto.randomUUID()
  await withSystemDb("bridge-seal-test-account", (db) =>
    db.execute(drizzleSql`
      INSERT INTO ${drizzleSql.raw(`"${SCHEMA}"`)}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, ${ownerType},
              ${ownerId}::uuid, 'gmail', ${`${id}@example.test`}, 'active', ${encryptionState})`),
  )
  return id
}

async function withBridge<T>(
  orgId: string,
  userId: string,
  fn: (bridge: Record<string, any>, tx: RlsClient) => Promise<T>,
): Promise<T> {
  return withPrivilegedDb(orgId, "bridge-seal-test", async (tx) => {
    const bridge = createRpcBridge(
      "mail",
      userId,
      orgId,
      tx as unknown as RlsClient,
      mailAppManifest as never,
    )
    return fn(bridge, tx as unknown as RlsClient)
  })
}

async function sealCall(
  bridge: Record<string, any>,
  params: Record<string, unknown>,
): Promise<unknown> {
  return bridge.mailbox_seal(JSON.stringify(params)).catch((e: unknown) => e)
}

describe("mailbox_seal", () => {
  test("seals a plaintext the client half can recover byte for byte", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const keys = await enroll(org.id, user.id, 11)
    const accountId = await createAccount(org.id, user.id, "ready")
    const entityId = crypto.randomUUID()
    const plaintext = "The bridge can seal. It cannot open."

    const result = (await withBridge(org.id, user.id, (bridge) =>
      bridge.mailbox_seal(
        JSON.stringify({
          plaintextBase64: Buffer.from(plaintext).toString("base64"),
          aadContext: "messageTextBody",
          entityId,
          accountId,
        }),
      ),
    )) as string
    const out = JSON.parse(result) as {
      ciphertextBase64: string
      contentKeyWrappedBase64: string
      contentKeyEpkBase64: string
      keyId: number
      encVersion: number
    }

    // Non-vacuity: an implementation returning empty strings would satisfy every
    // error-code test below on its own.
    expect(out.ciphertextBase64.length).toBeGreaterThan(0)
    expect(out.contentKeyWrappedBase64.length).toBeGreaterThan(0)
    expect(out.contentKeyEpkBase64.length).toBeGreaterThan(0)
    expect(out.keyId).toBe(11)
    expect(out.encVersion).toBe(1)

    const contentKey = await unsealContentKey({
      privateKey: keys.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
      userId: user.id,
      keyId: 11,
      wrapped: new Uint8Array(Buffer.from(out.contentKeyWrappedBase64, "base64")),
      epkSpki: new Uint8Array(Buffer.from(out.contentKeyEpkBase64, "base64")),
    })
    const opened = await openField({
      contentKey,
      context: mailboxAad.messageTextBody(entityId),
      blob: new Uint8Array(Buffer.from(out.ciphertextBase64, "base64")),
    })
    expect(new TextDecoder().decode(opened)).toBe(plaintext)
  })

  test("refuses to seal against a mailbox owned by another user", async () => {
    const owner = await member()
    const attacker = await member()
    const org = { id: owner.orgId }
    await enroll(org.id, owner.id, 1)
    await enroll(org.id, attacker.id, 2)
    const victimAccount = await createAccount(org.id, owner.id, "ready")

    const err = (await withBridge(org.id, attacker.id, (bridge) =>
      sealCall(bridge, {
        plaintextBase64: Buffer.from("x").toString("base64"),
        aadContext: "messageTextBody",
        entityId: crypto.randomUUID(),
        accountId: victimAccount,
      }),
    )) as Error
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain("RECIPIENT_MISMATCH")
  })

  test("refuses a user who never enrolled", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const accountId = await createAccount(org.id, user.id, "ready")
    const err = (await withBridge(org.id, user.id, (bridge) =>
      sealCall(bridge, {
        plaintextBase64: Buffer.from("x").toString("base64"),
        aadContext: "messageTextBody",
        entityId: crypto.randomUUID(),
        accountId,
      }),
    )) as Error
    expect(String(err.message)).toContain("USER_NOT_ENROLLED")
  })

  test("refuses a user whose only identity rows are retired", async () => {
    const user = await member()
    const org = { id: user.orgId }
    await enroll(org.id, user.id, 4, "retired")
    const accountId = await createAccount(org.id, user.id, "ready")
    const err = (await withBridge(org.id, user.id, (bridge) =>
      sealCall(bridge, {
        plaintextBase64: Buffer.from("x").toString("base64"),
        aadContext: "messageTextBody",
        entityId: crypto.randomUUID(),
        accountId,
      }),
    )) as Error
    expect(String(err.message)).toContain("NO_ACTIVE_IDENTITY_KEY")
  })

  test("refuses when more than one identity row is active", async () => {
    const user = await member()
    const org = { id: user.orgId }
    await enroll(org.id, user.id, 1)
    await enroll(org.id, user.id, 2)
    const accountId = await createAccount(org.id, user.id, "ready")
    const err = (await withBridge(org.id, user.id, (bridge) =>
      sealCall(bridge, {
        plaintextBase64: Buffer.from("x").toString("base64"),
        aadContext: "messageTextBody",
        entityId: crypto.randomUUID(),
        accountId,
      }),
    )) as Error
    expect(String(err.message)).toContain("MULTIPLE_ACTIVE_IDENTITY_KEYS")
  })

  test("refuses a plaintext above the one megabyte cap", async () => {
    const user = await member()
    const org = { id: user.orgId }
    await enroll(org.id, user.id, 3)
    const accountId = await createAccount(org.id, user.id, "ready")
    const err = (await withBridge(org.id, user.id, (bridge) =>
      sealCall(bridge, {
        plaintextBase64: Buffer.alloc(1024 * 1024 + 1).toString("base64"),
        aadContext: "messageTextBody",
        entityId: crypto.randomUUID(),
        accountId,
      }),
    )) as Error
    expect(String(err.message)).toContain("PLAINTEXT_TOO_LARGE")
  })
})

describe("the bridge exposes no way to open mail", () => {
  test("there is no unseal, open, decrypt or requestPlaintext method", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const names = await withBridge(org.id, user.id, async (bridge) => Object.keys(bridge))
    // Non-vacuity: the sealing surface really is present on this object.
    expect(names).toContain("mailbox_seal")
    expect(names).toContain("mailbox_sealAndInsert")
    expect(names.filter((n) => /^mailbox_(unseal|open|requestPlaintext|decrypt)/.test(n))).toEqual(
      [],
    )
  })
})

describe("mailbox_sealAndInsert", () => {
  test("binds the minted row id into the AAD", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const keys = await enroll(org.id, user.id, 21)
    const accountId = await createAccount(org.id, user.id, "ready")
    const conversationId = crypto.randomUUID()

    const inserted = await withBridge(org.id, user.id, async (bridge) => {
      const conv = JSON.parse(
        await bridge.mailbox_sealAndInsert(
          JSON.stringify({
            entity: "conversations",
            accountId,
            row: {
              id: conversationId,
              accountId,
              ownerType: "user",
              ownerId: user.id,
              externalThreadId: `thread-${conversationId}`,
              status: "open",
              labels: [],
              isRead: false,
              isStarred: false,
              messageCount: 1,
            },
            plaintext: { subject: "conversation subject" },
          }),
        ),
      )
      return JSON.parse(
        await bridge.mailbox_sealAndInsert(
          JSON.stringify({
            entity: "messages",
            accountId,
            row: {
              conversationId: conv.id,
              accountId,
              externalMessageId: `<${crypto.randomUUID()}@example.test>`,
              messageReferences: [],
              fromAddress: { email: "a@b.test" },
              toAddresses: [],
              ccAddresses: [],
              bccAddresses: [],
              isRead: false,
              isStarred: false,
              labels: [],
              direction: "inbound",
              ownerType: "user",
              ownerId: user.id,
              rawHeaders: { "message-id": "<m@x>", subject: "the secret subject" },
            },
            plaintext: { subject: "the secret subject", textBody: "the secret body" },
          }),
        ),
      )
    })

    expect(typeof inserted.id).toBe("string")
    expect(inserted.enc_version).toBe(1)
    expect(inserted.subject).toBeNull()
    expect(inserted.text_body).toBeNull()
    // The non-allowlisted header was stripped from the cleartext map.
    expect(inserted.raw_headers).toEqual({ "message-id": "<m@x>" })

    const contentKey = await unsealContentKey({
      privateKey: keys.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
      userId: user.id,
      keyId: 21,
      wrapped: new Uint8Array(Buffer.from(inserted.content_key_wrapped, "base64")),
      epkSpki: new Uint8Array(Buffer.from(inserted.content_key_epk, "base64")),
    })
    const blob = new Uint8Array(Buffer.from(inserted.text_body_ciphertext, "base64"))

    const opened = await openField({
      contentKey,
      context: mailboxAad.messageTextBody(inserted.id),
      blob,
    })
    expect(new TextDecoder().decode(opened)).toBe("the secret body")

    // A different uuid in the AAD must not open the same blob.
    const wrong = await openField({
      contentKey,
      context: mailboxAad.messageTextBody(crypto.randomUUID()),
      blob,
    }).catch((e: unknown) => e)
    expect(wrong).toBeInstanceOf(Error)
  })

  test("db_insert still rejects a sandbox-supplied id", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const err = (await withBridge(org.id, user.id, (bridge) =>
      bridge
        .db_insert("conversations", JSON.stringify({ id: crypto.randomUUID(), accountId: null }))
        .catch((e: unknown) => e),
    )) as Error
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain('Unknown field "id"')
  })
})

// The bridge guard is the SECOND line of defence: the database trigger is the
// enforcement point, and this layer exists so a bundle bug fails with an error
// naming the field. `db_updateMany` writes an arbitrary `data` object over a
// `where` clause, so it has no id to resolve an account from and was the one
// write path the guard did not cover: a bulk rewrite of a guarded column
// surfaced as a bare Postgres `mailbox_plaintext_forbidden` instead.
describe("db_updateMany and Invariant P", () => {
  async function armedAccountWithConversation(): Promise<{
    orgId: string
    userId: string
    accountId: string
  }> {
    const user = await member()
    await enroll(user.orgId, user.id, 61)
    const accountId = await createAccount(user.orgId, user.id, "ready")
    await withBridge(user.orgId, user.id, (bridge) =>
      bridge.mailbox_sealAndInsert(
        JSON.stringify({
          entity: "conversations",
          accountId,
          row: {
            accountId,
            ownerType: "user",
            ownerId: user.id,
            externalThreadId: `thread-${crypto.randomUUID()}`,
            status: "open",
            labels: [],
            isRead: false,
            isStarred: false,
            messageCount: 1,
          },
          plaintext: { subject: "the real subject" },
        }),
      ),
    )
    return { orgId: user.orgId, userId: user.id, accountId }
  }

  test("a bulk write of a guarded plaintext column is refused by name", async () => {
    const { orgId, userId, accountId } = await armedAccountWithConversation()
    const err = (await withBridge(orgId, userId, (bridge) =>
      bridge
        .db_updateMany(
          "conversations",
          JSON.stringify({ where: { accountId }, data: { subject: "leaked in bulk" } }),
        )
        .catch((e: unknown) => e),
    )) as Error
    expect(err).toBeInstanceOf(Error)
    // The NAMED error this layer exists to produce, listing the field. Without
    // the guard the same write still fails, but as the trigger's bare
    // `mailbox_plaintext_forbidden` wrapped in "db_updateMany failed".
    expect(err.name).toBe("MailboxPlaintextForbiddenError")
    expect(String(err.message)).toContain("cannot write plaintext subject")
    expect(String(err.message)).toContain('on "conversations"')
  })

  test("a bulk write that touches no guarded column still succeeds", async () => {
    const { orgId, userId, accountId } = await armedAccountWithConversation()
    const result = await withBridge(orgId, userId, (bridge) =>
      bridge.db_updateMany(
        "conversations",
        JSON.stringify({ where: { accountId }, data: { isRead: true } }),
      ),
    )
    expect(JSON.parse(result as string).count).toBe(1)
  })
})

// Every production mail sync runs headless. `runtime.ts` builds the bridge
// actor for a job as `payload._userId ?? "system:<app>:<job>"`, and no mail
// sync path sets `_userId` (enqueueJob refuses to stamp it for a system
// actor), so the actor reaching these methods is the literal string
// "system:mail:sync". If that actor cannot seal, an enrolled mailbox stops
// ingesting mail permanently. The acting identity is still never a parameter:
// the recipient is resolved from the account row, host side.
describe("headless sync actor", () => {
  test("a system actor seals to the mailbox owner", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const keys = await enroll(org.id, user.id, 31)
    const accountId = await createAccount(org.id, user.id, "ready")
    const entityId = crypto.randomUUID()
    const plaintext = "delivered while the owner was offline"

    const result = (await withBridge(org.id, "system:mail:sync", (bridge) =>
      bridge.mailbox_seal(
        JSON.stringify({
          plaintextBase64: Buffer.from(plaintext).toString("base64"),
          aadContext: "messageTextBody",
          entityId,
          accountId,
        }),
      ),
    )) as string
    const out = JSON.parse(result) as {
      ciphertextBase64: string
      contentKeyWrappedBase64: string
      contentKeyEpkBase64: string
      keyId: number
    }
    expect(out.keyId).toBe(31)

    // Sealed to the OWNER, proven by opening it with the owner's private key.
    const contentKey = await unsealContentKey({
      privateKey: keys.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
      userId: user.id,
      keyId: 31,
      wrapped: new Uint8Array(Buffer.from(out.contentKeyWrappedBase64, "base64")),
      epkSpki: new Uint8Array(Buffer.from(out.contentKeyEpkBase64, "base64")),
    })
    const opened = await openField({
      contentKey,
      context: mailboxAad.messageTextBody(entityId),
      blob: new Uint8Array(Buffer.from(out.ciphertextBase64, "base64")),
    })
    expect(new TextDecoder().decode(opened)).toBe(plaintext)
  })

  test("a system actor seals and inserts an inbound message to the owner", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const keys = await enroll(org.id, user.id, 32)
    const accountId = await createAccount(org.id, user.id, "ready")
    const conversationId = crypto.randomUUID()

    const inserted = await withBridge(org.id, "system:mail:sync", async (bridge) => {
      const conv = JSON.parse(
        await bridge.mailbox_sealAndInsert(
          JSON.stringify({
            entity: "conversations",
            accountId,
            row: {
              id: conversationId,
              accountId,
              ownerType: "user",
              ownerId: user.id,
              externalThreadId: `thread-${conversationId}`,
              status: "open",
              labels: [],
              isRead: false,
              isStarred: false,
              messageCount: 1,
            },
            plaintext: { subject: "headless conversation subject" },
          }),
        ),
      )
      return JSON.parse(
        await bridge.mailbox_sealAndInsert(
          JSON.stringify({
            entity: "messages",
            accountId,
            row: {
              conversationId: conv.id,
              accountId,
              externalMessageId: `<${crypto.randomUUID()}@example.test>`,
              messageReferences: [],
              fromAddress: { email: "sender@b.test" },
              toAddresses: [],
              ccAddresses: [],
              bccAddresses: [],
              isRead: false,
              isStarred: false,
              labels: [],
              direction: "inbound",
              ownerType: "user",
              ownerId: user.id,
              rawHeaders: { "message-id": "<headless@x>" },
            },
            plaintext: { subject: "headless subject", textBody: "headless body" },
          }),
        ),
      )
    })

    expect(inserted.enc_version).toBe(1)
    expect(inserted.subject).toBeNull()
    expect(inserted.text_body).toBeNull()

    const contentKey = await unsealContentKey({
      privateKey: keys.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
      userId: user.id,
      keyId: 32,
      wrapped: new Uint8Array(Buffer.from(inserted.content_key_wrapped, "base64")),
      epkSpki: new Uint8Array(Buffer.from(inserted.content_key_epk, "base64")),
    })
    const opened = await openField({
      contentKey,
      context: mailboxAad.messageTextBody(inserted.id),
      blob: new Uint8Array(Buffer.from(inserted.text_body_ciphertext, "base64")),
    })
    expect(new TextDecoder().decode(opened)).toBe("headless body")
  })

  test("a human actor who is not the owner is still refused", async () => {
    const owner = await member()
    const attacker = await member()
    const org = { id: owner.orgId }
    await enroll(org.id, owner.id, 33)
    await enroll(org.id, attacker.id, 34)
    const victimAccount = await createAccount(org.id, owner.id, "ready")

    const err = (await withBridge(org.id, attacker.id, (bridge) =>
      sealCall(bridge, {
        plaintextBase64: Buffer.from("x").toString("base64"),
        aadContext: "messageTextBody",
        entityId: crypto.randomUUID(),
        accountId: victimAccount,
      }),
    )) as Error
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain("RECIPIENT_MISMATCH")
  })

  test("a system actor cannot seal a shared mailbox to anyone", async () => {
    const user = await member()
    const org = { id: user.orgId }
    await enroll(org.id, user.id, 35)
    const sharedAccount = await createAccount(org.id, null, "none", "shared")

    const err = (await withBridge(org.id, "system:mail:sync", (bridge) =>
      sealCall(bridge, {
        plaintextBase64: Buffer.from("x").toString("base64"),
        aadContext: "messageTextBody",
        entityId: crypto.randomUUID(),
        accountId: sharedAccount,
      }),
    )) as Error
    expect(err).toBeInstanceOf(Error)
    expect(String(err.message)).toContain("RECIPIENT_MISMATCH")
  })
})

// A mailbox connected AFTER its owner enrolled used to insert with the manifest
// default `encryption_state = 'none'`. Invariant P arms on the EXISTENCE of an
// active identity, not on that column, so the trigger was armed immediately
// while `mailAccountRequiresSealing` read `none` and let the ingest write
// plaintext: every message raised `mailbox_plaintext_forbidden`, permanently,
// with no transition out of `none` reachable at runtime.
describe("encryption_state at account creation", () => {
  async function insertAccount(
    orgId: string,
    actor: string,
    row: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    return withBridge(orgId, actor, async (bridge) =>
      JSON.parse(await bridge.db_insert("accounts", JSON.stringify(row))),
    )
  }

  test("a mailbox connected by an already enrolled owner is created ready", async () => {
    const user = await member()
    const org = { id: user.orgId }
    await enroll(org.id, user.id, 41)

    const created = await insertAccount(org.id, "system:mail:connect", {
      connectedAccountId: crypto.randomUUID(),
      ownerType: "user",
      ownerId: user.id,
      provider: "gmail",
      emailAddress: `late-${crypto.randomUUID()}@example.test`,
      syncStatus: "pre-sync",
    })
    expect(created.encryption_state).toBe("ready")

    // And it can actually ingest, which is the property the state exists for.
    const conversationId = crypto.randomUUID()
    const inserted = await withBridge(org.id, "system:mail:sync", async (bridge) => {
      const conv = JSON.parse(
        await bridge.mailbox_sealAndInsert(
          JSON.stringify({
            entity: "conversations",
            accountId: created.id,
            row: {
              id: conversationId,
              accountId: created.id,
              ownerType: "user",
              ownerId: user.id,
              externalThreadId: `thread-${conversationId}`,
              status: "open",
              labels: [],
              isRead: false,
              isStarred: false,
              messageCount: 1,
            },
            plaintext: { subject: "late connect subject" },
          }),
        ),
      )
      return JSON.parse(
        await bridge.mailbox_sealAndInsert(
          JSON.stringify({
            entity: "messages",
            accountId: created.id,
            row: {
              conversationId: conv.id,
              accountId: created.id,
              externalMessageId: `<${crypto.randomUUID()}@example.test>`,
              messageReferences: [],
              fromAddress: { email: "a@b.test" },
              toAddresses: [],
              ccAddresses: [],
              bccAddresses: [],
              isRead: false,
              isStarred: false,
              labels: [],
              direction: "inbound",
              ownerType: "user",
              ownerId: user.id,
              rawHeaders: { "message-id": "<late@x>" },
            },
            plaintext: { subject: "late subject", textBody: "late body" },
          }),
        ),
      )
    })
    expect(inserted.enc_version).toBe(1)
    expect(inserted.text_body).toBeNull()
  })

  test("a mailbox connected by an owner who has not enrolled is created pending_enrollment", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const created = await insertAccount(org.id, "system:mail:connect", {
      connectedAccountId: crypto.randomUUID(),
      ownerType: "user",
      ownerId: user.id,
      provider: "gmail",
      emailAddress: `unenrolled-${crypto.randomUUID()}@example.test`,
      syncStatus: "pre-sync",
    })
    expect(created.encryption_state).toBe("pending_enrollment")
  })

  test("a shared mailbox is untouched by the encryption state machine", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const created = await insertAccount(org.id, "system:mail:connect", {
      connectedAccountId: crypto.randomUUID(),
      ownerType: "shared",
      provider: "gmail",
      emailAddress: `shared-${crypto.randomUUID()}@example.test`,
      syncStatus: "pre-sync",
    })
    expect(created.encryption_state).toBe("none")
  })
})

describe("mailbox_enqueueClientJob", () => {
  test("queues a job for the mailbox owner when the actor is the sync system", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const accountId = await createAccount(org.id, user.id, "ready")
    const out = await withBridge(org.id, "system:mail:sync", async (bridge) =>
      JSON.parse(
        await bridge.mailbox_enqueueClientJob(
          JSON.stringify({ kind: "index_backfill", accountId, payload: { accountId } }),
        ),
      ),
    )
    expect(typeof out.jobId).toBe("string")
    const rows = await withSystemDb("bridge-seal-test-job-owner", (db) =>
      db.execute(
        drizzleSql`SELECT user_id::text AS user_id FROM kernel.mailbox_client_jobs WHERE id = ${out.jobId}::uuid`,
      ),
    )
    const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
      user_id: string
    }[]
    expect(list[0]?.user_id).toBe(user.id)
  })

  test("returns a job id for a queued client job", async () => {
    const user = await member()
    const org = { id: user.orgId }
    const accountId = await createAccount(org.id, user.id, "ready")
    const out = await withBridge(org.id, user.id, async (bridge) =>
      JSON.parse(
        await bridge.mailbox_enqueueClientJob(
          JSON.stringify({ kind: "index_backfill", payload: { accountId } }),
        ),
      ),
    )
    expect(typeof out.jobId).toBe("string")
    expect(out.jobId.length).toBeGreaterThan(0)
  })
})
