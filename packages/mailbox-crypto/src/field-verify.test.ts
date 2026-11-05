// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { mailboxAad } from "./aad"
import { sealField } from "./field-seal"
import { sealedFieldMatches, sealedStreamMatches } from "./field-verify"
import { deriveFieldSubkey } from "./kdf"
import { generateContentKey } from "./seal"
import { encryptAttachmentStream } from "./stream-seal"

const text = (value: string) => new TextEncoder().encode(value)

async function sealed(plaintext: string) {
  const contentKey = generateContentKey()
  const context = mailboxAad.messageTextBody("m-1")
  const blob = await sealField({ contentKey, context, keyId: 1, plaintext: text(plaintext) })
  const fieldKey = await deriveFieldSubkey({
    contentKey,
    fieldName: context.fieldName,
    entityId: context.entityId,
  })
  return { contentKey, context, blob, fieldKey }
}

describe("sealedFieldMatches", () => {
  it("accepts the field's own plaintext under its own subkey", async () => {
    const s = await sealed("﻿the real body")
    expect(await sealedFieldMatches({ ...s, plaintext: text("﻿the real body") })).toBe(true)
  })

  it("refuses other plaintext, even with the right subkey", async () => {
    const s = await sealed("the real body")
    expect(await sealedFieldMatches({ ...s, plaintext: text("the real bodY") })).toBe(false)
    expect(await sealedFieldMatches({ ...s, plaintext: text("the real body ") })).toBe(false)
  })

  it("refuses a made-up key, another field's key and another binding", async () => {
    const s = await sealed("the real body")
    const plaintext = text("the real body")
    const madeUp = crypto.getRandomValues(new Uint8Array(32))
    expect(await sealedFieldMatches({ ...s, fieldKey: madeUp, plaintext })).toBe(false)
    const subjectKey = await deriveFieldSubkey({
      contentKey: s.contentKey,
      fieldName: mailboxAad.messageSubject("m-1").fieldName,
      entityId: "m-1",
    })
    expect(await sealedFieldMatches({ ...s, fieldKey: subjectKey, plaintext })).toBe(false)
    expect(
      await sealedFieldMatches({ ...s, context: mailboxAad.messageTextBody("m-2"), plaintext }),
    ).toBe(false)
  })

  it("is false, never a throw, on malformed input", async () => {
    const s = await sealed("x")
    const plaintext = text("x")
    expect(await sealedFieldMatches({ ...s, fieldKey: new Uint8Array(16), plaintext })).toBe(false)
    expect(await sealedFieldMatches({ ...s, blob: new Uint8Array(5), plaintext })).toBe(false)
  })
})

describe("sealedStreamMatches", () => {
  const fileId = "f-1"
  const bytes = new Uint8Array(150).map((_, i) => (i * 13) % 256)

  async function stream(plaintext: Uint8Array) {
    const contentKey = generateContentKey()
    const sealed = await encryptAttachmentStream({
      contentKey,
      fileId,
      keyId: 1,
      plaintextLength: plaintext.length,
      source: plaintext as Uint8Array<ArrayBuffer>,
      chunkSize: 64,
    })
    const parts: Uint8Array[] = []
    for await (const c of sealed.chunks) parts.push(c)
    const stored = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) {
      stored.set(p, o)
      o += p.length
    }
    const context = mailboxAad.attachment(fileId)
    const streamKey = await deriveFieldSubkey({
      contentKey,
      fieldName: context.fieldName,
      entityId: context.entityId,
    })
    return { header: sealed.header, stored, streamKey, fileId }
  }

  it("accepts the attachment's own bytes under its own subkey", async () => {
    const s = await stream(bytes)
    expect(await sealedStreamMatches({ ...s, plaintext: bytes })).toBe(true)
  })

  it("accepts an empty attachment", async () => {
    const s = await stream(new Uint8Array(0))
    expect(await sealedStreamMatches({ ...s, plaintext: new Uint8Array(0) })).toBe(true)
  })

  it("refuses other bytes of the same length, even with the right subkey", async () => {
    const s = await stream(bytes)
    const other = bytes.slice()
    other[140] = (other[140] as number) ^ 1
    expect(await sealedStreamMatches({ ...s, plaintext: other })).toBe(false)
  })

  it("refuses the right bytes under another subkey, another file id or a short length", async () => {
    const s = await stream(bytes)
    const wrongKey = crypto.getRandomValues(new Uint8Array(32))
    expect(await sealedStreamMatches({ ...s, streamKey: wrongKey, plaintext: bytes })).toBe(false)
    expect(await sealedStreamMatches({ ...s, fileId: "f-2", plaintext: bytes })).toBe(false)
    expect(await sealedStreamMatches({ ...s, plaintext: bytes.subarray(0, 100) })).toBe(false)
    expect(
      await sealedStreamMatches({ ...s, streamKey: new Uint8Array(16), plaintext: bytes }),
    ).toBe(false)
  })
})
