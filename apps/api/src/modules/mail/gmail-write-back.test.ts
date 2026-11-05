// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, mock } from "bun:test"
import { enqueueGmailWriteBack, gmailWriteBackFields } from "~/modules/mail/gmail-write-back"

describe("gmailWriteBackFields", () => {
  it("keeps the values that have a Gmail counterpart", () => {
    expect(gmailWriteBackFields({ status: "archived" })).toEqual({ status: "archived" })
    expect(gmailWriteBackFields({ isRead: false, isStarred: true })).toEqual({
      isRead: false,
      isStarred: true,
    })
  })

  it("has nothing to write for an assignment alone", () => {
    expect(gmailWriteBackFields({})).toBeNull()
    expect(
      gmailWriteBackFields({ assignedTo: "u-1" } as unknown as Record<string, never>),
    ).toBeNull()
  })
})

describe("enqueueGmailWriteBack", () => {
  it("hands the mail app's job the conversations and the values the user set", async () => {
    const enqueue = mock(async () => "job-1")
    const ok = await enqueueGmailWriteBack(
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        changes: { status: "archived", isRead: true },
      },
      enqueue,
    )
    expect(ok).toBe(true)
    expect(enqueue).toHaveBeenCalledWith("mail", "gmail-write-back", {
      orgId: "org-1",
      accountId: "acc-1",
      conversationIds: ["conv-1"],
      fields: { status: "archived", isRead: true },
    })
  })

  it("enqueues nothing for a change Gmail has no counterpart for", async () => {
    const enqueue = mock(async () => "job-1")
    const ok = await enqueueGmailWriteBack(
      { orgId: "org-1", accountId: "acc-1", conversationIds: ["conv-1"], changes: {} },
      enqueue,
    )
    expect(ok).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })

  it("never fails the user's request when the queue refuses the job", async () => {
    const enqueue = mock(async () => {
      throw new Error("queue backpressure")
    })
    const ok = await enqueueGmailWriteBack(
      {
        orgId: "org-1",
        accountId: "acc-1",
        conversationIds: ["conv-1"],
        changes: { isStarred: true },
      },
      enqueue,
    )
    expect(ok).toBe(false)
  })
})
