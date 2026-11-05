// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Task 2.2. The AAD construction of spec section 3.4:
//
//     aad = header_bytes || 0x00 || context_string
//
// The eleven context builders are the only way to obtain a context string, so
// no call site ever writes the literal and no two objects can share one.

import { describe, expect, it } from "bun:test"
import { buildAad, MAILBOX_AAD_BUILDERS, type MailboxAadContext, mailboxAad } from "./aad"
import { blobHeader } from "./blob"
import { fromUtf8, toHex, utf8 } from "./bytes"
import { openField } from "./field-open"
import { sealField } from "./field-seal"

const messageId = "b0f0f0f0-0000-4000-8000-000000000001"
const conversationId = "c0f0f0f0-0000-4000-8000-000000000002"
const fileId = "f0f0f0f0-0000-4000-8000-000000000003"
const draftId = "d0f0f0f0-0000-4000-8000-000000000004"
const userId = "11111111-1111-4111-8111-111111111111"

describe("mailbox AAD contexts", () => {
  it("names all eleven contexts of spec section 3.4", () => {
    expect(MAILBOX_AAD_BUILDERS.length).toBe(11)
    for (const name of MAILBOX_AAD_BUILDERS) {
      expect(typeof mailboxAad[name], `missing builder ${name}`).toBe("function")
    }
  })

  it("builds the exact context strings", () => {
    expect(mailboxAad.messageTextBody(messageId).context).toBe(
      `mail.message:text_body:${messageId}`,
    )
    expect(mailboxAad.messageHtmlBody(messageId).context).toBe(
      `mail.message:html_body:${messageId}`,
    )
    expect(mailboxAad.messageSubject(messageId).context).toBe(`mail.message:subject:${messageId}`)
    expect(mailboxAad.messageSnippet(messageId).context).toBe(`mail.message:snippet:${messageId}`)
    expect(mailboxAad.messageHeaders(messageId).context).toBe(`mail.message:headers:${messageId}`)
    expect(mailboxAad.conversationSubject(conversationId).context).toBe(
      `mail.conversation:subject:${conversationId}`,
    )
    expect(mailboxAad.conversationSnippet(conversationId).context).toBe(
      `mail.conversation:snippet:${conversationId}`,
    )
    expect(mailboxAad.attachment(fileId).context).toBe(`mail.attachment:${fileId}`)
    expect(mailboxAad.draftBody(draftId).context).toBe(`mail.draft:body:${draftId}`)
    expect(mailboxAad.draftSubject(draftId).context).toBe(`mail.draft:subject:${draftId}`)
    expect(mailboxAad.index(userId, "0").context).toBe(`mail.index:${userId}:0`)
  })

  it("gives every builder a distinct context and a distinct D5 field name", () => {
    const contexts = new Set<string>()
    const fieldNames = new Set<string>()
    for (const ctx of everyContext()) {
      contexts.add(ctx.context)
      fieldNames.add(ctx.fieldName)
    }
    expect(contexts.size).toBe(11)
    expect(fieldNames.size).toBe(11)
  })

  it("assembles aad as header || 0x00 || context", () => {
    const header = blobHeader(1, 7)
    const ctx = mailboxAad.messageTextBody(messageId)
    const expected = new Uint8Array([...header, 0, ...utf8(ctx.context)])
    expect(toHex(buildAad(header, ctx))).toBe(toHex(expected))
  })

  it("changes the aad when the header changes, so version and key id are covered", () => {
    const ctx = mailboxAad.messageSubject(messageId)
    const a = toHex(buildAad(blobHeader(1, 7), ctx))
    const b = toHex(buildAad(blobHeader(2, 7), ctx))
    const c = toHex(buildAad(blobHeader(1, 8), ctx))
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(b).not.toBe(c)
  })

  it("carries the entity id into the D5 derivation inputs", () => {
    expect(mailboxAad.messageTextBody(messageId).entityId).toBe(messageId)
    expect(mailboxAad.attachment(fileId).entityId).toBe(fileId)
    expect(mailboxAad.index(userId, "3").entityId).toBe(`${userId}:3`)
  })
})

function everyContext() {
  return [
    mailboxAad.messageTextBody(messageId),
    mailboxAad.messageHtmlBody(messageId),
    mailboxAad.messageSubject(messageId),
    mailboxAad.messageSnippet(messageId),
    mailboxAad.messageHeaders(messageId),
    mailboxAad.conversationSubject(conversationId),
    mailboxAad.conversationSnippet(conversationId),
    mailboxAad.attachment(fileId),
    mailboxAad.draftBody(draftId),
    mailboxAad.draftSubject(draftId),
    mailboxAad.index(userId, "0"),
  ]
}

describe("T-CRYPTO-2 aad binding", () => {
  const keyId = 7
  const messageA = "aaaaaaaa-0000-4000-8000-00000000000a"
  const messageB = "bbbbbbbb-0000-4000-8000-00000000000b"
  const key = crypto.getRandomValues(new Uint8Array(32))

  async function seal(context: MailboxAadContext) {
    return sealField({ contentKey: key, context, keyId, plaintext: utf8("the body") })
  }

  it("opens under the context it was sealed with, the non vacuity half", async () => {
    const ctx = mailboxAad.messageTextBody(messageA)
    const blob = await seal(ctx)
    expect(fromUtf8(await openField({ contentKey: key, context: ctx, blob }))).toBe("the body")
  })

  it("refuses message A's blob under message B's context and back", async () => {
    const blobA = await seal(mailboxAad.messageTextBody(messageA))
    const blobB = await seal(mailboxAad.messageTextBody(messageB))
    await expect(
      openField({ contentKey: key, context: mailboxAad.messageTextBody(messageB), blob: blobA }),
    ).rejects.toThrow()
    await expect(
      openField({ contentKey: key, context: mailboxAad.messageTextBody(messageA), blob: blobB }),
    ).rejects.toThrow()
  })

  it("refuses a draft blob under a message context and back", async () => {
    const draftCtx = mailboxAad.draftBody(messageA)
    const messageCtx = mailboxAad.messageTextBody(messageA)
    const draftBlob = await seal(draftCtx)
    const messageBlob = await seal(messageCtx)
    await expect(
      openField({ contentKey: key, context: messageCtx, blob: draftBlob }),
    ).rejects.toThrow()
    await expect(
      openField({ contentKey: key, context: draftCtx, blob: messageBlob }),
    ).rejects.toThrow()
  })

  it("refuses every other context for one sealed object", async () => {
    const sealedCtx = mailboxAad.messageSubject(messageId)
    const blob = await seal(sealedCtx)
    let refused = 0
    for (const other of everyContext()) {
      if (other.context === sealedCtx.context) continue
      await expect(
        openField({ contentKey: key, context: other, blob }),
        `opened under ${other.context}`,
      ).rejects.toThrow()
      refused++
    }
    expect(refused).toBe(10)
  })
})
