// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The server-managed mail format (`enc_version = 2`): what one mailbox's data
// key seals opens again for that mailbox only, field by field, and nothing can
// be moved between fields, rows or mailboxes and still open.

import { describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { decryptBytes, encryptBytes } from "~/lib/crypto"
import {
  isManagedEncVersion,
  MAILBOX_MANAGED_ENC_VERSION,
  openManaged,
  openManagedAttachment,
  sealManaged,
  sealManagedAttachment,
} from "~/modules/mailbox-crypto/managed-seal"

const accountId = crypto.randomUUID()
const messageId = crypto.randomUUID()

function seal(dek: Buffer) {
  return sealManaged({
    accountId,
    dek,
    items: [
      { context: mailboxAad.messageSubject(messageId), plaintext: "Quarterly numbers" },
      { context: mailboxAad.messageTextBody(messageId), plaintext: "The body, with é and 漢字" },
    ],
  })
}

describe("encryptBytes / decryptBytes", () => {
  it("round-trips bytes under the same key and context, and refuses any other", () => {
    const key = randomBytes(32)
    const sealed = encryptBytes(Buffer.from("hello"), key, "ctx:a")
    // iv (12) + tag (16) + ciphertext (5): the plaintext is not in the output.
    expect(sealed.byteLength).toBe(33)
    expect(sealed.includes(Buffer.from("hello"))).toBe(false)
    expect(decryptBytes(sealed, key, "ctx:a").toString()).toBe("hello")
    expect(() => decryptBytes(sealed, key, "ctx:b")).toThrow()
    expect(() => decryptBytes(sealed, randomBytes(32), "ctx:a")).toThrow()
    const tampered = Buffer.from(sealed)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1
    expect(() => decryptBytes(tampered, key, "ctx:a")).toThrow()
  })

  it("refuses a key that is not 32 bytes", () => {
    expect(() => encryptBytes(Buffer.from("x"), randomBytes(16), "c")).toThrow(/32 bytes/)
  })
})

describe("managed mail seal and open", () => {
  it("is version 2, never the zero-access version", () => {
    expect(MAILBOX_MANAGED_ENC_VERSION).toBe(2)
    expect(isManagedEncVersion(2)).toBe(true)
    expect(isManagedEncVersion(1)).toBe(false)
    expect(isManagedEncVersion(null)).toBe(false)
  })

  it("opens every field it sealed, for the same mailbox and data key", () => {
    const dek = randomBytes(32)
    const sealed = seal(dek)
    expect(sealed.items).toHaveLength(2)
    expect(sealed.items[0]?.includes(Buffer.from("Quarterly"))).toBe(false)
    const opened = openManaged({
      accountId,
      dek,
      contentKeyWrapped: sealed.contentKeyWrapped,
      fields: [
        { context: mailboxAad.messageSubject(messageId), ciphertext: sealed.items[0] },
        { context: mailboxAad.messageTextBody(messageId), ciphertext: sealed.items[1] },
        { context: mailboxAad.messageHtmlBody(messageId), ciphertext: null },
      ],
    })
    expect(opened).toEqual(["Quarterly numbers", "The body, with é and 漢字", null])
  })

  it("refuses a field moved to another column, another row or another mailbox", () => {
    const dek = randomBytes(32)
    const sealed = seal(dek)
    const open = (over: Partial<Parameters<typeof openManaged>[0]>) =>
      openManaged({
        accountId,
        dek,
        contentKeyWrapped: sealed.contentKeyWrapped,
        fields: [{ context: mailboxAad.messageSubject(messageId), ciphertext: sealed.items[0] }],
        ...over,
      })
    // Non-vacuity: the unmodified call opens.
    expect(open({})).toEqual(["Quarterly numbers"])
    expect(() =>
      open({
        fields: [{ context: mailboxAad.messageSnippet(messageId), ciphertext: sealed.items[0] }],
      }),
    ).toThrow()
    expect(() =>
      open({
        fields: [
          { context: mailboxAad.messageSubject(crypto.randomUUID()), ciphertext: sealed.items[0] },
        ],
      }),
    ).toThrow()
    expect(() => open({ accountId: crypto.randomUUID() })).toThrow()
    expect(() => open({ dek: randomBytes(32) })).toThrow()
  })

  it("seals an attachment under its file id and opens it back", () => {
    const dek = randomBytes(32)
    const fileId = crypto.randomUUID()
    const bytes = randomBytes(70_000)
    const sealed = sealManagedAttachment({ accountId, dek, keyVersion: 3, fileId, bytes })
    expect(sealed.columns).toMatchObject({
      encVersion: 2,
      encKeyId: 3,
      chunkCount: 1,
      plaintextLength: bytes.byteLength,
    })
    const opened = openManagedAttachment({
      accountId,
      dek,
      fileId,
      contentKeyWrapped: sealed.columns.contentKeyWrapped,
      body: sealed.body,
    })
    expect(opened.equals(bytes)).toBe(true)
    expect(() =>
      openManagedAttachment({
        accountId,
        dek,
        fileId: crypto.randomUUID(),
        contentKeyWrapped: sealed.columns.contentKeyWrapped,
        body: sealed.body,
      }),
    ).toThrow()
  })
})
