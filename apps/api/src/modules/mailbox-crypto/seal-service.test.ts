// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seal-only server module, against real rows in the test database.
//
// Two properties matter here beyond "it produces bytes":
//   * The recipient is resolved from persisted state, never from a caller
//     argument, and TWO active identity rows is a hard refusal. A second active
//     row is the shape an operator key-injection attack takes: seal to the key
//     I planted, and the user never notices because their own key still works.
//   * A user with no identity is refused rather than silently sealed to
//     nothing, so a sealing caller can never write plaintext as a fallback.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import {
  MailboxSealError,
  resolveActiveIdentity,
  sealForUser,
} from "~/modules/mailbox-crypto/seal-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const ATTESTATION = Buffer.from("keyring-attestation-bytes")

async function generateIdentity(): Promise<{ ecdhSpki: Buffer; signSpki: Buffer }> {
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair
  return {
    ecdhSpki: Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey)),
    signSpki: Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey)),
  }
}

async function enroll(user: minimal.Person, keyId: number, status = "active"): Promise<void> {
  const { ecdhSpki, signSpki } = await generateIdentity()
  await withSystemDb("seal-service-test-enroll", (db) =>
    db.execute(drizzleSql`
      INSERT INTO kernel.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${user.orgId}::uuid, ${user.id}::uuid, ${keyId}, ${ecdhSpki}, ${signSpki}, ${ATTESTATION}, ${status})`),
  )
}

describe("seal-service", () => {
  test("seals every item under one content key bound to the resolved identity", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    await enroll(user, 3)

    const sealed = await sealForUser(user.id, user.orgId, [
      { context: { kind: "messageTextBody", entityId: "msg-1" }, plaintext: "hello" },
      { context: { kind: "messageSubject", entityId: "msg-1" }, plaintext: "a subject" },
    ])

    expect(sealed.keyId).toBe(3)
    expect(sealed.encVersion).toBe(1)
    expect(sealed.contentKeyWrapped.byteLength).toBeGreaterThan(0)
    expect(sealed.contentKeyEpk.byteLength).toBeGreaterThan(0)
    expect(sealed.items).toHaveLength(2)
    for (const item of sealed.items) {
      expect(item.ciphertext.byteLength).toBeGreaterThan(0)
      // version byte, then key id byte: the header is inside the AAD, so a
      // flipped byte fails to open rather than opening as something else.
      expect(item.ciphertext[0]).toBe(1)
      expect(item.ciphertext[1]).toBe(3)
    }
    // Distinct fields under one content key must not share a blob.
    const first = Buffer.from(sealed.items[0]!.ciphertext).toString("base64")
    const second = Buffer.from(sealed.items[1]!.ciphertext).toString("base64")
    expect(first).not.toBe(second)
  })

  test("refuses a user with no identity", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const err = await sealForUser(user.id, user.orgId, [
      { context: { kind: "messageTextBody", entityId: "m" }, plaintext: "x" },
    ]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailboxSealError)
    expect((err as MailboxSealError).code).toBe("NO_ACTIVE_IDENTITY_KEY")
  })

  test("refuses when more than one identity row is active", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    await enroll(user, 1)
    // Non-vacuity: one active row resolves cleanly first, so the refusal below
    // is caused by the second row and not by an unrelated failure.
    const one = await resolveActiveIdentity(user.id, user.orgId)
    expect(one.keyId).toBe(1)

    await enroll(user, 2)
    const err = await resolveActiveIdentity(user.id, user.orgId).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailboxSealError)
    expect((err as MailboxSealError).code).toBe("MULTIPLE_ACTIVE_IDENTITY_KEYS")
  })

  test("ignores retired rows when resolving the active identity", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    await enroll(user, 7, "retired")
    await enroll(user, 8)
    const identity = await resolveActiveIdentity(user.id, user.orgId)
    expect(identity.keyId).toBe(8)
  })

  test("refuses a plaintext above the byte cap", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    await enroll(user, 4)
    const oversize = new Uint8Array(1024 * 1024 + 1)
    const err = await sealForUser(user.id, user.orgId, [
      { context: { kind: "messageTextBody", entityId: "m" }, plaintext: oversize },
    ]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailboxSealError)
    expect((err as MailboxSealError).code).toBe("PLAINTEXT_TOO_LARGE")
  })
})
