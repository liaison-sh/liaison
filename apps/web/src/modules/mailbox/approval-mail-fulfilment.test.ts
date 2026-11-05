// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint Task 9.8 and 9.9, the browser half.

import { describe, expect, it } from "vitest"
import {
  buildMailboxFulfilment,
  isSealedMailApproval,
  MailApprovalFulfilmentError,
  mailAttachmentDisclosure,
  outboundAttachmentFileIds,
} from "~/modules/mailbox/approval-mail-fulfilment"

const APPROVAL_ID = "22222222-2222-4222-8222-222222222222"

const SEALED_APPROVAL = {
  id: APPROVAL_ID,
  toolName: "mail:reply",
  payload: {
    conversationId: "11111111-1111-4111-8111-111111111111",
    to: ["someone@example.com"],
    mailboxSealed: true,
    encVersion: 1,
    encKeyId: 7,
    contentKeyWrapped: "AQID",
    contentKeyEpk: "AQID",
    bodyCiphertext: "AQID",
    subjectCiphertext: "AQID",
  },
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    isUnlocked: () => true,
    openApprovalDraft: async () => ({
      approvalRequestId: APPROVAL_ID,
      subject: "Re: Invoice 42",
      textBody: "THE DECRYPTED DRAFT",
      htmlBody: null,
      note: null,
    }),
    openMessages: async (ids: string[]) =>
      ids.map((id) => ({
        id,
        subject: "Invoice 42",
        textBody: "THE ORIGINAL",
        htmlBody: null,
        snippet: null,
      })),
    ...overrides,
  } as any
}

describe("isSealedMailApproval", () => {
  it("is true only for a gated mail send whose payload is sealed", () => {
    expect(isSealedMailApproval(SEALED_APPROVAL)).toBe(true)
    expect(isSealedMailApproval({ ...SEALED_APPROVAL, payload: { mailboxSealed: false } })).toBe(
      false,
    )
    expect(isSealedMailApproval({ ...SEALED_APPROVAL, toolName: "tickets:reply" })).toBe(false)
  })
})

describe("buildMailboxFulfilment", () => {
  it("returns the decrypted draft under the names the API expects", async () => {
    const out = await buildMailboxFulfilment(deps(), SEALED_APPROVAL)
    expect(out.draft?.textBody).toBe("THE DECRYPTED DRAFT")
    expect(out.draft?.subject).toBe("Re: Invoice 42")
    expect(out.quote).toBeUndefined()
  })

  it("carries the quoted original for the messages the send quotes", async () => {
    const out = await buildMailboxFulfilment(deps(), {
      ...SEALED_APPROVAL,
      toolName: "mail:forward",
      quotedMessageIds: ["msg-1"],
    })
    expect(out.quote?.["msg-1"]?.quotedBody).toBe("THE ORIGINAL")
    expect(out.quote?.["msg-1"]?.resolvedSubject).toBe("Invoice 42")
  })

  it("refuses when the mailbox is locked, rather than approving a blank send", async () => {
    await expect(
      buildMailboxFulfilment(deps({ isUnlocked: () => false }), SEALED_APPROVAL),
    ).rejects.toBeInstanceOf(MailApprovalFulfilmentError)
  })

  it("refuses when the draft decrypts to nothing", async () => {
    const empty = deps({
      openApprovalDraft: async () => ({
        approvalRequestId: APPROVAL_ID,
        subject: "Re: Invoice 42",
        textBody: null,
        htmlBody: null,
        note: null,
      }),
    })
    await expect(buildMailboxFulfilment(empty, SEALED_APPROVAL)).rejects.toBeInstanceOf(
      MailApprovalFulfilmentError,
    )
  })

  it("refuses when a quoted original will not decrypt", async () => {
    const partial = deps({ openMessages: async () => [] })
    await expect(
      buildMailboxFulfilment(partial, {
        ...SEALED_APPROVAL,
        toolName: "mail:forward",
        quotedMessageIds: ["msg-1"],
      }),
    ).rejects.toBeInstanceOf(MailApprovalFulfilmentError)
  })

  it("carries attachment bytes when an opener is available", async () => {
    const withFiles = deps({
      openAttachments: async (ids: string[]) =>
        ids.map((fileId) => ({ fileId, bytesBase64: "QUJD" })),
    })
    const out = await buildMailboxFulfilment(withFiles, {
      ...SEALED_APPROVAL,
      sealedAttachmentFileIds: ["file-1"],
    })
    expect(out.attachments?.["file-1"]).toBe("QUJD")
  })

  it("refuses when sealed attachments are named and nothing can open them", async () => {
    // Sending the ciphertext, or quietly dropping the attachment, are both
    // worse than refusing: one delivers an unreadable file, the other loses it.
    await expect(
      buildMailboxFulfilment(deps(), {
        ...SEALED_APPROVAL,
        sealedAttachmentFileIds: ["file-1"],
      }),
    ).rejects.toBeInstanceOf(MailApprovalFulfilmentError)
  })

  // Task 9.9. The card has to know WHICH files this send re-attaches before it
  // can open them, and the user has to be told what approving will do, in the
  // same breath. Both come off the payload the approver is looking at.
  it("names the files a sealed send re-attaches, and nothing else", () => {
    expect(
      outboundAttachmentFileIds({ ...SEALED_APPROVAL.payload, attachments: ["file-1", "file-2"] }),
    ).toEqual(["file-1", "file-2"])
    // A payload with no attachments asks for nothing, so an ordinary sealed
    // send never pays for a metadata round trip.
    expect(outboundAttachmentFileIds(SEALED_APPROVAL.payload)).toEqual([])
    // Junk is dropped rather than passed to the opener as a file id.
    expect(outboundAttachmentFileIds({ attachments: ["file-1", 7, null, ""] })).toEqual(["file-1"])
    expect(outboundAttachmentFileIds({ attachments: "file-1" })).toEqual([])
  })

  it("states in plain words what approving is about to release", () => {
    const one = mailAttachmentDisclosure(1) ?? ""
    expect(one).toContain("1")
    expect(one.toLowerCase()).toContain("attachment")
    expect(mailAttachmentDisclosure(3)).toContain("3")
    // No dash punctuation in anything a person reads.
    expect(one).not.toMatch(/--|—|–/)
    expect(mailAttachmentDisclosure(0)).toBe(null)
  })

  it("refuses an approval that is not a sealed mail send", async () => {
    await expect(
      buildMailboxFulfilment(deps(), { ...SEALED_APPROVAL, toolName: "tickets:reply" }),
    ).rejects.toBeInstanceOf(MailApprovalFulfilmentError)
  })
})
