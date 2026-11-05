// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `POST /api/mail/conversations/search`: the inbox search box over the whole
// view, not only the pages the list has loaded. A conversation far past the
// first page is found by text and by a message id the browser matched, rows
// come back in the list's own projection, and neither an account outside the
// request nor another user's personal mailbox ever answers.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { MailSearchTestAccess } from "~/apps/mail/search"
import { seedContext } from "~/seed/context"
import { insertUnarmedMail, type MailConversationSpec } from "~/seed/factories/mail/conversations"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const PHRASE = "quokka"

let token: string
let ownAccountId: string
let sharedAccountId: string
let otherUserAccountId: string
let oldConversationId: string
let oldMessageId: string
let sharedConversationId: string
let otherUserConversationId: string

function conversation(
  key: string,
  box: string,
  subject: string,
  hoursAgo: number,
  fromName = "Filler Sender",
): MailConversationSpec {
  return {
    key,
    box,
    subject,
    status: "open",
    labels: ["INBOX"],
    isRead: false,
    isStarred: false,
    messages: [
      {
        direction: "inbound",
        fromName,
        fromEmail: "sender@example.com",
        toName: "Mailbox",
        toEmail: "mailbox@example.com",
        hoursAgo,
        body: "preview",
      },
    ],
  }
}

async function searchRequest(body: Record<string, unknown>): Promise<Response> {
  return app.request("/api/mail/conversations/search", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function searchIds(body: Record<string, unknown>): Promise<string[]> {
  const res = await searchRequest(body)
  expect(res.status).toBe(200)
  const json = (await res.json()) as { data: Array<{ id: string }> }
  return json.data.map((row) => row.id)
}

beforeAll(async () => {
  await acquireTestLock()
  const orgId = (await createTestOrg()).id
  // The org admin holds the admin wildcard grant: every shared mailbox is in
  // reach, so the only thing keeping another user's personal mailbox out is
  // its own privacy rule.
  const admin = await minimal.orgAdmin(orgId)
  const other = await minimal.person(orgId, { role: "member" })
  token = await minimal.token(admin.id)

  // Free text through the SQL branch only: the rows here are never indexed, so
  // the test must not depend on what a shared search index happens to hold.
  MailSearchTestAccess.setMatchResolver(async () => [])

  const ctx = seedContext({ orgId, now: new Date() })
  // Thirty newer conversations fill the first page, so the target is beyond it.
  const fillers = Array.from({ length: 30 }, (_, i) =>
    conversation(`filler-${i}`, "own", `Filler ${i}`, (i + 1) / 60),
  )
  await insertUnarmedMail(ctx, {
    domain: "search.test",
    mailboxes: [
      { box: "own", ownerUserId: admin.id, email: "own@search.test", displayName: "Own" },
      { box: "shared", ownerUserId: null, email: "shared@search.test", displayName: "Shared" },
      { box: "other", ownerUserId: other.id, email: "other@search.test", displayName: "Other" },
    ],
    conversations: [
      ...fillers,
      conversation("old", "own", `Re: ${PHRASE} invoice`, 48, "Old Sender"),
      conversation("shared", "shared", `${PHRASE} shared`, 0.1),
      conversation("other", "other", `${PHRASE} private`, 0.1),
    ],
  })
  ownAccountId = ctx.id("mail-account", "own")
  sharedAccountId = ctx.id("mail-account", "shared")
  otherUserAccountId = ctx.id("mail-account", "other")
  oldConversationId = ctx.id("mail-conversation", "old")
  oldMessageId = ctx.id("mail-message", "old:0")
  sharedConversationId = ctx.id("mail-conversation", "shared")
  otherUserConversationId = ctx.id("mail-conversation", "other")
})

afterAll(async () => {
  MailSearchTestAccess.setMatchResolver(null)
  await releaseTestLock()
})

describe("POST /api/mail/conversations/search", () => {
  it("finds a conversation beyond the first page by text, in the list projection", async () => {
    // Non-vacuity: the first page of the list does not carry it.
    const list = await app.request(
      `/api/mail/conversations?status=open&accountId=${ownAccountId}&limit=25`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const listed = ((await list.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id)
    expect(listed).toHaveLength(25)
    expect(listed).not.toContain(oldConversationId)

    const res = await searchRequest({ query: PHRASE, accountIds: [ownAccountId], status: "open" })
    expect(res.status).toBe(200)
    const rows = ((await res.json()) as { data: Array<Record<string, unknown>> }).data
    expect(rows.map((r) => r.id)).toEqual([oldConversationId])
    expect(rows[0]).toMatchObject({
      accountId: ownAccountId,
      subject: `Re: ${PHRASE} invoice`,
      senderName: "Old Sender",
      subjectCiphertext: null,
    })
  })

  it("finds the conversation holding a message id the browser matched", async () => {
    expect(await searchIds({ messageIds: [oldMessageId], accountIds: [ownAccountId] })).toEqual([
      oldConversationId,
    ])
  })

  it("never answers from an account the request did not name", async () => {
    const ids = await searchIds({ query: PHRASE, accountIds: [ownAccountId] })
    expect(ids).not.toContain(sharedConversationId)
    // Named, the shared mailbox does answer: the negative above is not vacuous.
    expect(await searchIds({ query: PHRASE, accountIds: [sharedAccountId] })).toEqual([
      sharedConversationId,
    ])
  })

  it("never answers from another user's personal mailbox, even when named", async () => {
    const ids = await searchIds({
      query: PHRASE,
      accountIds: [ownAccountId, sharedAccountId, otherUserAccountId],
    })
    expect(ids).toContain(oldConversationId)
    expect(ids).not.toContain(otherUserConversationId)
  })

  it("refuses a request carrying both text and message ids, or neither", async () => {
    expect(
      (
        await searchRequest({
          query: PHRASE,
          messageIds: [oldMessageId],
          accountIds: [ownAccountId],
        })
      ).status,
    ).toBe(400)
    expect((await searchRequest({ accountIds: [ownAccountId] })).status).toBe(400)
  })
})
