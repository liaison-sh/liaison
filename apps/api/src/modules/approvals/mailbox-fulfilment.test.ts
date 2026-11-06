// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint Task 9.8 and 9.9, the approval half.
//
// The property under test is the one the whole design turns on: the plaintext a
// gated mail send needs to execute is supplied AT EXECUTE TIME and is never
// written anywhere. This module is the pure function that merges it, so the
// tests here pin the merge, the caps and the refusals; the threading tests live
// with decide.

import { describe, expect, it } from "bun:test"
import {
  applyMailboxFulfilment,
  MAILBOX_FULFILMENT_MAX_ATTACHMENT_BYTES,
  MAILBOX_FULFILMENT_MAX_ATTACHMENTS,
  MAILBOX_FULFILMENT_MAX_QUOTED_MESSAGES,
  MAILBOX_FULFILMENT_MAX_TEXT_BYTES,
  MailboxFulfilmentError,
  parseMailboxFulfilment,
  SEALED_PAYLOAD_KEYS,
} from "~/modules/approvals/mailbox-fulfilment"

const SEALED_PAYLOAD = {
  conversationId: "11111111-1111-1111-1111-111111111111",
  to: ["someone@example.com"],
  mailboxSealed: true,
  bodyCiphertext: "AQID",
  subjectCiphertext: "AQID",
  contentKeyWrapped: "AQID",
  contentKeyEpk: "AQID",
  encKeyId: 1,
  encVersion: 1,
  subjectHash: "abc",
  byteLength: 12,
  recipientCount: 1,
}

describe("applyMailboxFulfilment", () => {
  it("returns the payload untouched when there is no fulfilment (non-vacuity)", () => {
    const payload = { conversationId: "x", textBody: "hello" }
    const out = applyMailboxFulfilment({ toolName: "mail:reply", payload })
    expect(out).toEqual(payload)
  })

  it("refuses a mail send whose payload a mailbox purge emptied", () => {
    for (const toolName of ["mail:reply", "mail:forward", "mail:compose", "mail:composeForApp"]) {
      let err: unknown
      try {
        applyMailboxFulfilment({ toolName, payload: {} })
      } catch (e) {
        err = e
      }
      expect(err).toBeInstanceOf(MailboxFulfilmentError)
      expect((err as MailboxFulfilmentError).code).toBe("draft_removed")
    }
    // Another tool's empty payload is none of this module's business.
    expect(applyMailboxFulfilment({ toolName: "tickets:reply", payload: {} })).toEqual({})
  })

  it("refuses a SEALED payload that arrives with no fulfilment at all", () => {
    // The header of this module names this exact scenario as the thing it
    // exists to prevent: "a gated send that reaches its handler with an empty
    // body". Returning the sealed payload untouched handed the handler
    // `bodyCiphertext`, `contentKeyWrapped` and friends and no `textBody`, so
    // `assertKnownParams` rejected the manifest-undeclared keys and the send
    // died as an opaque handler error AFTER the approval row had been claimed
    // and moved. Approving from a device with no key, from a locked mailbox, or
    // as an eligible non-owner all land here.
    let err: unknown
    try {
      applyMailboxFulfilment({ toolName: "mail:reply", payload: SEALED_PAYLOAD })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(MailboxFulfilmentError)
    expect((err as MailboxFulfilmentError).code).toBe("fulfilment_required")
    // The message has to tell the approver what to do, not just that it failed.
    expect(String((err as Error).message)).toMatch(/unlock/i)
  })

  it("replaces the sealed ciphertext keys with the client-supplied draft", () => {
    const out = applyMailboxFulfilment({
      toolName: "mail:reply",
      payload: SEALED_PAYLOAD,
      fulfilment: { draft: { textBody: "THE REAL BODY", subject: "Re: Invoice 42" } },
    })
    expect(out.textBody).toBe("THE REAL BODY")
    expect(out.subject).toBe("Re: Invoice 42")
    expect(out.conversationId).toBe(SEALED_PAYLOAD.conversationId)
    for (const key of SEALED_PAYLOAD_KEYS) {
      expect(out[key]).toBeUndefined()
    }
  })

  it("carries a quote and attachments under the names the handler reads", () => {
    const out = applyMailboxFulfilment({
      toolName: "mail:forward",
      payload: SEALED_PAYLOAD,
      fulfilment: {
        draft: { note: "see below" },
        quote: { "msg-1": { quotedBody: "ORIGINAL", resolvedSubject: "Invoice 42" } },
        attachments: { "file-1": "AQIDBA==" },
      },
    })
    expect(out.note).toBe("see below")
    expect((out.__mailboxQuote as any)["msg-1"].quotedBody).toBe("ORIGINAL")
    expect((out.__mailboxAttachments as any)["file-1"]).toBe("AQIDBA==")
  })

  it("refuses a fulfilment aimed at a tool that is not a mail send", () => {
    expect(() =>
      applyMailboxFulfilment({
        toolName: "tickets:reply",
        payload: { ticketId: "t" },
        fulfilment: { draft: { textBody: "x" } },
      }),
    ).toThrow(MailboxFulfilmentError)
  })

  it("refuses a fulfilment for a payload that was never sealed", () => {
    // Otherwise anyone who can approve could overwrite the body of an ordinary
    // shared-mailbox draft with content nobody reviewed.
    expect(() =>
      applyMailboxFulfilment({
        toolName: "mail:reply",
        payload: { conversationId: "x", textBody: "reviewed text" },
        fulfilment: { draft: { textBody: "swapped text" } },
      }),
    ).toThrow(MailboxFulfilmentError)
  })

  it("refuses an oversized body, an oversized quote set and oversized attachments", () => {
    const big = "a".repeat(MAILBOX_FULFILMENT_MAX_TEXT_BYTES + 1)
    expect(() =>
      applyMailboxFulfilment({
        toolName: "mail:compose",
        payload: SEALED_PAYLOAD,
        fulfilment: { draft: { textBody: big } },
      }),
    ).toThrow(MailboxFulfilmentError)

    const quote: Record<string, { quotedBody: string }> = {}
    for (let i = 0; i <= MAILBOX_FULFILMENT_MAX_QUOTED_MESSAGES; i++) {
      quote[`m-${i}`] = { quotedBody: "x" }
    }
    expect(() =>
      applyMailboxFulfilment({
        toolName: "mail:forward",
        payload: SEALED_PAYLOAD,
        fulfilment: { quote },
      }),
    ).toThrow(MailboxFulfilmentError)

    const attachments: Record<string, string> = {}
    for (let i = 0; i <= MAILBOX_FULFILMENT_MAX_ATTACHMENTS; i++) {
      attachments[`f-${i}`] = "AQID"
    }
    expect(() =>
      applyMailboxFulfilment({
        toolName: "mail:forward",
        payload: SEALED_PAYLOAD,
        fulfilment: { attachments },
      }),
    ).toThrow(MailboxFulfilmentError)

    // One attachment over the whole-request byte ceiling.
    const oversized = "A".repeat(Math.ceil((MAILBOX_FULFILMENT_MAX_ATTACHMENT_BYTES + 8) / 3) * 4)
    expect(() =>
      applyMailboxFulfilment({
        toolName: "mail:forward",
        payload: SEALED_PAYLOAD,
        fulfilment: { attachments: { "f-1": oversized } },
      }),
    ).toThrow(MailboxFulfilmentError)
  })

  it("never lets a fulfilment introduce a key of its own choosing", () => {
    const out = applyMailboxFulfilment({
      toolName: "mail:compose",
      payload: SEALED_PAYLOAD,
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
      fulfilment: { draft: { textBody: "ok" }, evil: "yes" } as any,
    })
    expect((out as Record<string, unknown>).evil).toBeUndefined()
  })
})

describe("parseMailboxFulfilment", () => {
  it("accepts the documented shape and rejects everything else", () => {
    expect(
      parseMailboxFulfilment({
        draft: { textBody: "b" },
        quote: { "m-1": { quotedBody: "q", resolvedSubject: "s" } },
        attachments: { "f-1": "AQID" },
      }),
    ).toBeTruthy()
    expect(() => parseMailboxFulfilment({ draft: { textBody: 7 } })).toThrow(MailboxFulfilmentError)
    expect(() => parseMailboxFulfilment({ attachments: { "f-1": 7 } })).toThrow(
      MailboxFulfilmentError,
    )
    expect(parseMailboxFulfilment(undefined)).toBeUndefined()
  })
})
