// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-2 T14. The phone mail screen's title, account line and segmented filter,
// pinned away from any rendering.
import { describe, expect, it } from "vitest"
import type { MailAccount } from "~/modules/mail/mail-account-store"
import type { ViewType } from "~/modules/mail/mail-conversation-store"
import {
  forwardBody,
  forwardSubject,
  mailAccountLine,
  mailFolderLabelKey,
  matchesMailPhoneFilter,
  unreadCount,
} from "~/modules/mail/mail-phone-view"

function account(over: Partial<MailAccount> & Pick<MailAccount, "id">): MailAccount {
  return {
    connectedAccountId: null,
    provider: "gmail",
    emailAddress: `${over.id}@example.com`,
    displayName: null,
    ownerType: "user",
    ownerId: null,
    syncStatus: "idle",
    lastSyncAt: null,
    lastSyncError: null,
    unreadCount: 0,
    allowedImageSenderDomains: [],
    messagesSynced: 0,
    ...over,
  } as MailAccount
}

describe("mailFolderLabelKey", () => {
  it("names the folder the view is on", () => {
    const seen = (
      [
        "inbox",
        "inbox:personal",
        "inbox:acc-1",
        "assigned-to-me",
        "starred",
        "sent",
        "drafts",
        "trash",
      ] as ViewType[]
    ).map((v) => [v, mailFolderLabelKey(v)] as const)
    expect(Object.fromEntries(seen)).toEqual({
      inbox: "kernel.mailFolderInbox",
      "inbox:personal": "kernel.mailFolderInbox",
      "inbox:acc-1": "kernel.mailFolderInbox",
      "assigned-to-me": "kernel.mailFolderAssigned",
      starred: "kernel.mailFolderStarred",
      sent: "kernel.mailFolderSent",
      drafts: "kernel.mailFolderDrafts",
      trash: "kernel.mailFolderTrash",
    })
  })
})

describe("mailAccountLine", () => {
  const personal = account({ id: "p1", emailAddress: "me@example.com", ownerType: "user" })
  const shared = account({ id: "s1", emailAddress: "support@acme.test", ownerType: "org" })

  it("names the shared account a per account folder belongs to", () => {
    expect(mailAccountLine("inbox:s1" as ViewType, [personal, shared])).toEqual({
      kind: "address",
      address: "support@acme.test",
    })
  })

  it("names the only account when there is one", () => {
    expect(mailAccountLine("inbox", [personal])).toEqual({
      kind: "address",
      address: "me@example.com",
    })
  })

  it("counts rather than naming the first of several", () => {
    expect(mailAccountLine("inbox", [personal, shared])).toEqual({ kind: "all", count: 2 })
  })

  it("scopes the personal group to the user's own accounts", () => {
    expect(mailAccountLine("inbox:personal" as ViewType, [personal, shared])).toEqual({
      kind: "address",
      address: "me@example.com",
    })
  })

  it("says nothing when no account is connected", () => {
    expect(mailAccountLine("inbox", [])).toEqual({ kind: "none" })
  })
})

describe("matchesMailPhoneFilter", () => {
  const rows = [
    { isRead: false, isStarred: false },
    { isRead: true, isStarred: true },
    { isRead: true, isStarred: false },
  ]

  it("narrows to unread, to starred, and to nothing on All", () => {
    expect(rows.filter((r) => matchesMailPhoneFilter(r, "unread"))).toHaveLength(1)
    expect(rows.filter((r) => matchesMailPhoneFilter(r, "starred"))).toHaveLength(1)
    expect(rows.filter((r) => matchesMailPhoneFilter(r, "all"))).toHaveLength(3)
  })

  it("counts the unread seat", () => {
    expect(unreadCount(rows)).toBe(1)
  })
})

describe("forward draft", () => {
  it("prefixes the subject once", () => {
    expect(forwardSubject("Client Feedback")).toBe("Fwd: Client Feedback")
    expect(forwardSubject("Fwd: Client Feedback")).toBe("Fwd: Client Feedback")
    expect(forwardSubject("")).toBe("Fwd:")
  })

  it("quotes who wrote and what they said", () => {
    const body = forwardBody({
      fromName: "Alice",
      fromEmail: "alice@example.com",
      sentAt: "2026-01-02T03:04:05.000Z",
      textBody: "The pedal stopped responding.",
    })
    expect(body).toContain("Alice")
    expect(body).toContain("2026-01-02T03:04:05.000Z")
    expect(body).toContain("The pedal stopped responding.")
  })

  it("falls back to the html body with its markup removed", () => {
    expect(forwardBody({ fromEmail: "b@x.test", htmlBody: "<p>Hello <b>there</b></p>" })).toContain(
      "Hello there",
    )
  })
})
