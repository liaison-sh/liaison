// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 2.4. `field-seal.ts` and `field-open.ts` are imported separately here,
// on purpose: they are two modules so the server's seal service cannot drag the
// body-decryption primitive into its import graph (Appendix C A5). If this file
// ever collapses to one import, the split has been undone.
//
// T-CRYPTO-1 round trip, T-CRYPTO-10 IV uniqueness, T-CRYPTO-11 header binding.

import { describe, expect, it } from "bun:test"
import { mailboxAad } from "./aad"
import { decodeBlob, MAILBOX_ENC_VERSION } from "./blob"
import { type Bytes, fromUtf8, toHex, utf8 } from "./bytes"
import { openField } from "./field-open"
import { sealField } from "./field-seal"

const messageId = "b0f0f0f0-0000-4000-8000-000000000001"
const conversationId = "c0f0f0f0-0000-4000-8000-000000000002"
const draftId = "d0f0f0f0-0000-4000-8000-000000000004"
const keyId = 7

function contentKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(32))
}

const FIELDS = [
  { name: "message text body", ctx: mailboxAad.messageTextBody(messageId), text: "Hello there." },
  {
    name: "message html body",
    ctx: mailboxAad.messageHtmlBody(messageId),
    text: "<p>Hello there.</p>",
  },
  { name: "message subject", ctx: mailboxAad.messageSubject(messageId), text: "Invoice 42" },
  { name: "message snippet", ctx: mailboxAad.messageSnippet(messageId), text: "Hello there." },
  {
    name: "message headers",
    ctx: mailboxAad.messageHeaders(messageId),
    text: '{"received":"by mx"}',
  },
  {
    name: "conversation subject",
    ctx: mailboxAad.conversationSubject(conversationId),
    text: "Invoice 42",
  },
  {
    name: "conversation snippet",
    ctx: mailboxAad.conversationSnippet(conversationId),
    text: "Hello there.",
  },
  { name: "draft body", ctx: mailboxAad.draftBody(draftId), text: "Draft body text" },
  { name: "draft subject", ctx: mailboxAad.draftSubject(draftId), text: "Draft subject" },
]

describe("T-CRYPTO-1 field seal and open round trip", () => {
  for (const field of FIELDS) {
    it(`round trips the ${field.name}`, async () => {
      const key = contentKey()
      const blob = await sealField({
        contentKey: key,
        context: field.ctx,
        keyId,
        plaintext: utf8(field.text),
      })
      expect(blob.length).toBeGreaterThan(30)
      const opened = await openField({ contentKey: key, context: field.ctx, blob })
      expect(fromUtf8(opened)).toBe(field.text)
    })
  }

  it("round trips an empty plaintext", async () => {
    const key = contentKey()
    const ctx = mailboxAad.messageTextBody(messageId)
    const blob = await sealField({ contentKey: key, context: ctx, keyId, plaintext: utf8("") })
    expect((await openField({ contentKey: key, context: ctx, blob })).length).toBe(0)
  })

  it("stamps the version and key id it was given", async () => {
    const key = contentKey()
    const blob = await sealField({
      contentKey: key,
      context: mailboxAad.messageSubject(messageId),
      keyId: 255,
      plaintext: utf8("x"),
    })
    const decoded = decodeBlob(blob)
    expect(decoded.version).toBe(MAILBOX_ENC_VERSION)
    expect(decoded.keyId).toBe(255)
  })

  it("refuses to open under a different content key", async () => {
    const ctx = mailboxAad.messageTextBody(messageId)
    const blob = await sealField({
      contentKey: contentKey(),
      context: ctx,
      keyId,
      plaintext: utf8("secret"),
    })
    await expect(openField({ contentKey: contentKey(), context: ctx, blob })).rejects.toThrow()
  })
})

describe("T-CRYPTO-10 iv uniqueness", () => {
  it("draws a fresh iv for every field of one message and every re encryption", async () => {
    const key = contentKey()
    const contexts = [
      mailboxAad.messageTextBody(messageId),
      mailboxAad.messageHtmlBody(messageId),
      mailboxAad.messageSubject(messageId),
      mailboxAad.messageSnippet(messageId),
      mailboxAad.messageHeaders(messageId),
      mailboxAad.conversationSubject(conversationId),
    ]
    const ivs: string[] = []
    for (const ctx of contexts) {
      const blob = await sealField({ contentKey: key, context: ctx, keyId, plaintext: utf8("x") })
      ivs.push(toHex(decodeBlob(blob).iv))
    }
    for (let i = 0; i < 2; i++) {
      const blob = await sealField({
        contentKey: key,
        context: contexts[0],
        keyId,
        plaintext: utf8("x"),
      })
      ivs.push(toHex(decodeBlob(blob).iv))
    }
    expect(ivs.length).toBe(8)
    expect(new Set(ivs).size).toBe(8)
  })

  it("produces different ciphertext for the same plaintext under the same key", async () => {
    const key = contentKey()
    const ctx = mailboxAad.messageSnippet(messageId)
    const a = await sealField({ contentKey: key, context: ctx, keyId, plaintext: utf8("same") })
    const b = await sealField({ contentKey: key, context: ctx, keyId, plaintext: utf8("same") })
    expect(toHex(a)).not.toBe(toHex(b))
  })

  it("gives the snippet and the text body different subkeys", async () => {
    // The snippet is a prefix of the body by construction, so a shared key plus
    // a repeated nonce would disclose the body. Different subkeys is the first
    // of the two defences; the fresh iv above is the second.
    const key = contentKey()
    const plaintext = utf8("Hello there.")
    const body = await sealField({
      contentKey: key,
      context: mailboxAad.messageTextBody(messageId),
      keyId,
      plaintext,
    })
    const snippet = await sealField({
      contentKey: key,
      context: mailboxAad.messageSnippet(messageId),
      keyId,
      plaintext,
    })
    // Same iv forced onto both would still not share a keystream, but the
    // observable property here is simply that neither opens under the other's
    // context, which the subkey and the AAD both enforce.
    await expect(
      openField({ contentKey: key, context: mailboxAad.messageSnippet(messageId), blob: body }),
    ).rejects.toThrow()
    await expect(
      openField({ contentKey: key, context: mailboxAad.messageTextBody(messageId), blob: snippet }),
    ).rejects.toThrow()
  })
})

describe("T-CRYPTO-11 the header is inside the aad", () => {
  it("rejects a flipped version byte", async () => {
    const key = contentKey()
    const ctx = mailboxAad.messageTextBody(messageId)
    const blob = await sealField({ contentKey: key, context: ctx, keyId, plaintext: utf8("body") })
    expect(await openField({ contentKey: key, context: ctx, blob })).toBeDefined()
    const tampered = Uint8Array.from(blob)
    tampered[0] = 2
    await expect(openField({ contentKey: key, context: ctx, blob: tampered })).rejects.toThrow()
  })

  it("rejects a flipped key id byte", async () => {
    const key = contentKey()
    const ctx = mailboxAad.messageTextBody(messageId)
    const blob = await sealField({ contentKey: key, context: ctx, keyId, plaintext: utf8("body") })
    const tampered = Uint8Array.from(blob)
    tampered[1] = keyId + 1
    await expect(openField({ contentKey: key, context: ctx, blob: tampered })).rejects.toThrow()
  })

  it("rejects a flipped ciphertext byte", async () => {
    const key = contentKey()
    const ctx = mailboxAad.messageTextBody(messageId)
    const blob = await sealField({ contentKey: key, context: ctx, keyId, plaintext: utf8("body") })
    const tampered = Uint8Array.from(blob)
    tampered[tampered.length - 1] ^= 0x01
    await expect(openField({ contentKey: key, context: ctx, blob: tampered })).rejects.toThrow()
  })

  it("rejects a truncated blob", async () => {
    const key = contentKey()
    const ctx = mailboxAad.messageTextBody(messageId)
    const blob = await sealField({ contentKey: key, context: ctx, keyId, plaintext: utf8("body") })
    await expect(
      openField({ contentKey: key, context: ctx, blob: blob.subarray(0, 10) }),
    ).rejects.toThrow()
  })
})
