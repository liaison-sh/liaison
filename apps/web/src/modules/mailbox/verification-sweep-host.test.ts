// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The wiring of the sweep: the listing it reads, and the session it signs with.
//
// This file exists because the recurring defect in this feature has been a
// module that works in its own test and is called by nothing. The assertions
// here are about the CALLS: the right route, in verify mode, and a refusal to
// start at all with no unlocked session.

import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  client: null as null | {
    openMessage: ReturnType<typeof vi.fn>
    signAck: ReturnType<typeof vi.fn>
  },
}))

vi.mock("~/modules/mailbox/mailbox-store", () => ({
  mailboxCryptoClient: () => mocks.client,
  isMailboxUnlocked: () => mocks.client !== null,
}))

import {
  createVerifyListingSource,
  MAILBOX_VERIFY_LISTING_PATH,
  startMailboxVerificationSweep,
} from "~/modules/mailbox/verification-sweep-host"

const ACCOUNT_ID = "55555555-5555-4555-8555-555555555555"

function sealedItem(id: string) {
  return {
    sealed: {
      id,
      encVersion: 1,
      encKeyId: 1,
      contentKeyWrapped: "AA==",
      contentKeyEpk: "AA==",
      subjectCiphertext: "AA==",
      textBodyCiphertext: "AA==",
      htmlBodyCiphertext: null,
      snippetCiphertext: null,
    },
    envelope: {
      accountId: ACCOUNT_ID,
      conversationId: "c-1",
      sentAt: "2026-03-01T00:00:00.000Z",
      metadata: "sender@sync.test",
    },
    plaintext: { subject: `s ${id}`, textBody: `b ${id}`, htmlBody: null, snippet: null },
  }
}

describe("verification sweep host", () => {
  beforeEach(() => {
    mocks.client = {
      openMessage: vi.fn(async (sealed: { id: string }) => ({
        id: sealed.id,
        subject: `s ${sealed.id}`,
        textBody: `b ${sealed.id}`,
        htmlBody: null,
        snippet: null,
      })),
      signAck: vi.fn(async () => ({ keyId: 1, signature: "c2ln" })),
    }
  })

  it("reads the sealed listing in verify mode, which is the only mode that covers every row", async () => {
    const paths: string[] = []
    const api = {
      get: async (path: string) => {
        paths.push(path)
        return { cursor: "m-1", done: true, total: 1, items: [sealedItem("m-1")] } as never
      },
      post: async () => ({}) as never,
      delete: async () => ({}) as never,
    }
    const source = createVerifyListingSource(api)
    const page = await source.fetchPage(null, 25)

    expect(paths[0]).toContain(MAILBOX_VERIFY_LISTING_PATH)
    expect(paths[0]).toContain("mode=verify")
    expect(paths[0]).toContain("limit=25")
    expect(page.items).toHaveLength(1)
    expect(page.items[0]?.plaintext?.textBody).toBe("b m-1")
    expect(page.total).toBe(1)

    await source.fetchPage("m-1", 25)
    expect(paths[1]).toContain("cursor=m-1")
  })

  it("refuses to start without an unlocked mailbox rather than signing nothing", async () => {
    mocks.client = null
    await expect(
      startMailboxVerificationSweep({
        api: {
          get: async () => ({}) as never,
          post: async () => ({}) as never,
          delete: async () => ({}) as never,
        },
        accountId: ACCOUNT_ID,
      }),
    ).rejects.toThrow(/unlock/i)
  })

  it("signs through the worker session, never in the page", async () => {
    const posts: string[] = []
    const api = {
      get: async () =>
        ({
          cursor: "m-1",
          done: true,
          total: 1,
          items: [sealedItem("m-1")],
        }) as never,
      post: async (path: string) => {
        posts.push(path)
        if (path === "/mailbox/verify-nonce") {
          return {
            nonce: "n",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            backfillCursor: "",
            messageCount: 1,
          } as never
        }
        return { verified: true } as never
      },
      delete: async () => ({}) as never,
    }
    const result = await startMailboxVerificationSweep({ api, accountId: ACCOUNT_ID })
    expect(result.completed).toBe(true)
    expect(mocks.client?.signAck).toHaveBeenCalledTimes(1)
    expect(posts).toContain("/mailbox/verify-decrypt")
  })
})
