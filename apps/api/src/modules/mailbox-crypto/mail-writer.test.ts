// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The chokepoint every mail writer goes through.
//
// The property under test is not "it produces bytes", it is that the columns
// it hands back are a COMPLETE replacement for the plaintext ones: every
// plaintext field the caller supplied comes back as a ciphertext column, the
// key material comes with it, and a caller that forgets one is not silently
// given a half-sealed row.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { openField } from "@liaison/mailbox-crypto/src/client"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { MailboxSealError } from "~/modules/mailbox-crypto/identity-resolver"
import {
  fitMailFieldToSealCap,
  MAILBOX_SEALED_FIELDS,
  sealMailFields,
} from "~/modules/mailbox-crypto/mail-writer"
import { MAX_PLAINTEXT_BYTES } from "~/modules/mailbox-crypto/seal-service"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

async function enroll(user: minimal.Person, keyId: number): Promise<CryptoKeyPair> {
  const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as unknown as CryptoKeyPair
  const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair
  const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
  const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
  await withSystemDb("mail-writer-test-enroll", (db) =>
    db.execute(drizzleSql`
      INSERT INTO kernel.user_mailbox_identities
        (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
      VALUES (${user.orgId}::uuid, ${user.id}::uuid, ${keyId}, ${ecdhSpki}, ${signSpki},
              ${Buffer.from("attestation")}, 'active')`),
  )
  return ecdh
}

describe("sealMailFields", () => {
  test("returns one ciphertext column per supplied plaintext field plus the key material", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    await enroll(user, 5)
    const messageId = crypto.randomUUID()

    const sealed = await sealMailFields({
      userId: user.id,
      orgId: user.orgId,
      entity: "messages",
      entityId: messageId,
      values: { subject: "Quarterly numbers", textBody: "body text", snippet: "body te" },
      headers: { "message-id": "<a@b>", subject: "Quarterly numbers", "x-spam": "no" },
    })

    // Non-vacuity: an implementation returning {} would pass every "no
    // plaintext" assertion elsewhere in this phase.
    expect(sealed.keyId).toBe(5)
    expect(sealed.columns.encVersion).toBe(1)
    expect(sealed.columns.encKeyId).toBe(5)
    for (const col of [
      "subjectCiphertext",
      "textBodyCiphertext",
      "snippetCiphertext",
      "rawHeadersCiphertext",
      "contentKeyWrapped",
      "contentKeyEpk",
    ]) {
      expect(Buffer.isBuffer(sealed.columns[col]), `${col} must be sealed bytes`).toBe(true)
      expect((sealed.columns[col] as Buffer).byteLength).toBeGreaterThan(0)
    }
    // htmlBody was not supplied, so no column is invented for it.
    expect(sealed.columns.htmlBodyCiphertext).toBeUndefined()
    // The allowlisted header stays cleartext, the rest went into the blob.
    expect(sealed.retainedHeaders).toEqual({ "message-id": "<a@b>" })
  })

  test("an empty or absent value seals nothing for that field", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    await enroll(user, 6)
    const sealed = await sealMailFields({
      userId: user.id,
      orgId: user.orgId,
      entity: "messages",
      entityId: crypto.randomUUID(),
      values: { subject: "s", textBody: "", htmlBody: null },
    })
    expect(sealed.columns.subjectCiphertext).toBeDefined()
    expect(sealed.columns.textBodyCiphertext).toBeUndefined()
    expect(sealed.columns.htmlBodyCiphertext).toBeUndefined()
  })

  test("refuses a user with no active identity rather than returning nothing to seal with", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const err = await sealMailFields({
      userId: user.id,
      orgId: user.orgId,
      entity: "messages",
      entityId: crypto.randomUUID(),
      values: { subject: "s" },
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MailboxSealError)
    expect((err as MailboxSealError).code).toBe("NO_ACTIVE_IDENTITY_KEY")
  })

  test("every declared plaintext field maps to a distinct ciphertext column and AAD binding", () => {
    // The property is that no ciphertext can be moved from one field to another
    // and still open. A distinct AAD KIND is one way to get that; a shared kind
    // with a distinct entity-id suffix is the other, and the drafts html
    // alternative uses the second (`draftBody` at `<id>:html`), matching the
    // convention the approval payload already established. So the set that has
    // to be distinct is the kind AND suffix together, per entity.
    const bindings = new Set<string>()
    const columns = new Set<string>()
    let count = 0
    for (const [entity, fields] of Object.entries(MAILBOX_SEALED_FIELDS)) {
      for (const [, def] of Object.entries(fields)) {
        columns.add(`${entity}.${def.column}`)
        bindings.add(`${def.aad}${def.aadSuffix ?? ""}`)
        count++
        expect(typeof mailboxAad[def.aad]).toBe("function")
      }
    }
    expect(count).toBe(10)
    expect(bindings.size).toBe(10)
    expect(columns.size).toBe(10)
  })
})

describe("the sealed columns open on the client half", () => {
  test("the body recovered under the entity id in the AAD is byte identical", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const keys = await enroll(user, 9)
    const messageId = crypto.randomUUID()
    const body = "Nobody on the server can read this line."

    const sealed = await sealMailFields({
      userId: user.id,
      orgId: user.orgId,
      entity: "messages",
      entityId: messageId,
      values: { textBody: body },
    })

    const { unsealContentKey } = await import("@liaison/mailbox-crypto/src/client")
    const contentKey = await unsealContentKey({
      privateKey: keys.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
      userId: user.id,
      keyId: 9,
      wrapped: new Uint8Array(sealed.columns.contentKeyWrapped as Buffer),
      epkSpki: new Uint8Array(sealed.columns.contentKeyEpk as Buffer),
    })
    const opened = await openField({
      contentKey,
      context: mailboxAad.messageTextBody(messageId),
      blob: new Uint8Array(sealed.columns.textBodyCiphertext as Buffer),
    })
    expect(new TextDecoder().decode(opened)).toBe(body)

    // The entity id is bound: a different id must not open the same blob.
    const wrong = await openField({
      contentKey,
      context: mailboxAad.messageTextBody(crypto.randomUUID()),
      blob: new Uint8Array(sealed.columns.textBodyCiphertext as Buffer),
    }).catch((e: unknown) => e)
    expect(wrong).toBeInstanceOf(Error)
  })
})

describe("a message over the seal cap", () => {
  test("is cut on a whole character with a note that keeps its full size", () => {
    expect(fitMailFieldToSealCap("textBody", "short", 1000)).toBe("short")
    // "é" is two bytes: a cut landing inside it must not leave half a character.
    const fitted = fitMailFieldToSealCap("textBody", "é".repeat(400), 400)
    expect(Buffer.byteLength(fitted, "utf8")).toBeLessThanOrEqual(400)
    expect(fitted).not.toContain("\uFFFD")
    expect(fitted).toContain("Message truncated: it is 800 bytes")
    const html = fitMailFieldToSealCap("htmlBody", `<p>${"x".repeat(2000)}</p>`, 600)
    expect(html).toContain('data-liaison-truncated="2007"')
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(600)
  })

  test("seals instead of failing, so one oversized message never stops the mailbox's sync", async () => {
    const user = await minimal.person((await createTestOrg()).id)
    const keys = await enroll(user, 13)
    const messageId = crypto.randomUUID()
    // The live case: about 1.5 MB of html, over the 1 MiB cap.
    const huge = `<div>${"ü".repeat(750_000)}</div>`
    const sealed = await sealMailFields({
      userId: user.id,
      orgId: user.orgId,
      entity: "messages",
      entityId: messageId,
      values: { subject: "Big newsletter", htmlBody: huge, textBody: "ü".repeat(600_000) },
    })
    const { unsealContentKey } = await import("@liaison/mailbox-crypto/src/client")
    const contentKey = await unsealContentKey({
      privateKey: keys.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
      userId: user.id,
      keyId: 13,
      wrapped: new Uint8Array(sealed.columns.contentKeyWrapped as Buffer),
      epkSpki: new Uint8Array(sealed.columns.contentKeyEpk as Buffer),
    })
    const html = new TextDecoder().decode(
      await openField({
        contentKey,
        context: mailboxAad.messageHtmlBody(messageId),
        blob: new Uint8Array(sealed.columns.htmlBodyCiphertext as Buffer),
      }),
    )
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES)
    expect(html.startsWith("<div>üü")).toBe(true)
    expect(html).toContain(`data-liaison-truncated="${Buffer.byteLength(huge, "utf8")}"`)
    const text = new TextDecoder().decode(
      await openField({
        contentKey,
        context: mailboxAad.messageTextBody(messageId),
        blob: new Uint8Array(sealed.columns.textBodyCiphertext as Buffer),
      }),
    )
    expect(text).toContain("Message truncated: it is 1200000 bytes")
  })
})
