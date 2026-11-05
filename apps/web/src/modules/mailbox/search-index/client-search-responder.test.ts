// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-WEB-4 and the web half of T-INT-8 part two (blueprint task 10.5).
//
// The property that makes client search worth building at all: the SEARCH TERM
// never leaves the browser, and neither does anything the index matched on. The
// server learns a set of ids it could already enumerate, and nothing else.
//
// The whole path is real here: real Account Key, real seals, a real index built
// by the real sync loop. Only the transport is a spy, because the transport is
// the thing under test.

import { describe, expect, it, vi } from "vitest"
import { MAILBOX_LOCKED, MailboxCryptoError } from "~/modules/mailbox/crypto-protocol"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealMessageFixture,
  TEST_USER_ID,
} from "~/modules/mailbox/mailbox-fixtures"
import {
  answerClientSearch,
  CLIENT_SEARCH_MAX_RESULTS,
} from "~/modules/mailbox/search-index/client-search-responder"
import { createFlexSearchIndexAdapter } from "~/modules/mailbox/search-index/flexsearch-adapter"
import { createMemoryIndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"
import { sessionShardSealer } from "~/modules/mailbox/search-index/index-persistence"
import { type IndexSyncItem, syncSearchIndex } from "~/modules/mailbox/search-index/index-sync"

const PASSPHRASE = "correct horse battery staple 42"
/** Occurs in exactly one body and in no envelope field anywhere. */
const NEEDLE = "pangolinsemaphore"
const TURN = "turn-nonce-1"

const ID_A = "11111111-1111-4111-8111-111111111111"
const ID_B = "22222222-2222-4222-8222-222222222222"
const ID_C = "33333333-3333-4333-8333-333333333333"

async function buildIndexedMailbox() {
  const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  await session.unlock({
    userId: TEST_USER_ID,
    method: "passphrase",
    secret: PASSPHRASE,
    wrap: enrollment.passphraseWrap,
    keyring: enrollment.keyring,
  })

  const messages = [
    {
      id: ID_A,
      accountId: "acc-1",
      subject: "Quarterly numbers",
      textBody: `the ${NEEDLE} invoice is overdue`,
    },
    { id: ID_B, accountId: "acc-1", subject: "Lunch", textBody: "see you at one" },
    { id: ID_C, accountId: "acc-2", subject: "Other mailbox", textBody: `another ${NEEDLE} note` },
  ]

  const items: IndexSyncItem[] = []
  for (const message of messages) {
    items.push({
      sealed: await sealMessageFixture(enrollment, {
        id: message.id,
        subject: message.subject,
        textBody: message.textBody,
        htmlBody: `<p>${message.textBody}</p>`,
      }),
      envelope: {
        accountId: message.accountId,
        conversationId: `conv-${message.id}`,
        sentAt: "2026-08-01T00:00:00.000Z",
        metadata: "ada@example.com inbox",
      },
    })
  }

  const adapter = createFlexSearchIndexAdapter()
  await syncSearchIndex({
    adapter,
    store: createMemoryIndexBlobStore(),
    sealer: sessionShardSealer(session),
    source: {
      async fetchPage() {
        return { cursor: "c1", done: true, total: items.length, items }
      },
    },
    open: (sealed) => session.openMessage(sealed),
  })
  return { adapter, session }
}

describe("T-WEB-4: free text search runs in the browser", () => {
  it("finds the message whose body holds the phrase, and sends no term to the server", async () => {
    const { adapter } = await buildIndexedMailbox()
    // Non-vacuity: the index really contains the seeded mail, so the negative
    // assertions below cannot pass against an index that was never built.
    expect((await adapter.search({ text: NEEDLE })).sort()).toEqual([ID_A, ID_C].sort())

    const post = vi.fn(async () => {})
    const outcome = await answerClientSearch(
      {
        adapter,
        isUnlocked: () => true,
        turnNonce: () => TURN,
        allowedAccountIds: ["acc-1", "acc-2"],
        post,
      },
      { requestId: "req-1", turnNonce: TURN, query: NEEDLE },
    )
    expect(outcome.messageIds.sort()).toEqual([ID_A, ID_C].sort())
    expect(outcome.indexComplete).toBe(true)

    expect(post).toHaveBeenCalledTimes(1)
    const [requestId, body] = post.mock.calls[0] as unknown as [string, unknown]
    expect(requestId).toBe("req-1")
    const wire = JSON.stringify({ requestId, body })
    // The term itself, and every plaintext the index matched on.
    expect(wire).not.toContain(NEEDLE)
    expect(wire).not.toContain("invoice")
    expect(wire).not.toContain("Quarterly")
    expect(wire).not.toContain("snippet")
    // Ids only, and nothing shaped like a body.
    expect(Object.keys(body as object).sort()).toEqual(["indexComplete", "indexMode", "messageIds"])
  })

  it("scopes the result to the accounts the turn is allowed to see", async () => {
    const { adapter } = await buildIndexedMailbox()
    const outcome = await answerClientSearch(
      {
        adapter,
        isUnlocked: () => true,
        turnNonce: () => TURN,
        allowedAccountIds: ["acc-1"],
        post: async () => {},
      },
      { requestId: "req-2", turnNonce: TURN, query: NEEDLE },
    )
    // The message in acc-2 matches the phrase and is still not returned.
    expect(outcome.messageIds).toEqual([ID_A])
  })

  it("refuses an out of scope account rather than widening the answer", async () => {
    const { adapter } = await buildIndexedMailbox()
    await expect(
      answerClientSearch(
        {
          adapter,
          isUnlocked: () => true,
          turnNonce: () => TURN,
          allowedAccountIds: ["acc-1"],
          post: async () => {},
        },
        {
          requestId: "req-3",
          turnNonce: TURN,
          query: NEEDLE,
          filters: { accountIds: ["acc-9"] },
        },
      ),
    ).rejects.toThrow(/out of scope/i)
  })

  it("refuses a request carrying the wrong turn nonce and posts nothing", async () => {
    const { adapter } = await buildIndexedMailbox()
    const post = vi.fn(async () => {})
    await expect(
      answerClientSearch(
        { adapter, isUnlocked: () => true, turnNonce: () => TURN, post },
        { requestId: "req-4", turnNonce: "someone-elses-turn", query: NEEDLE },
      ),
    ).rejects.toThrow(/turn/i)
    expect(post).not.toHaveBeenCalled()
  })

  it("caps the result count whatever the caller asks for", async () => {
    const { adapter } = await buildIndexedMailbox()
    const outcome = await answerClientSearch(
      {
        adapter,
        isUnlocked: () => true,
        turnNonce: () => TURN,
        post: async () => {},
      },
      { requestId: "req-5", turnNonce: TURN, query: NEEDLE, limit: 100_000 },
    )
    expect(outcome.appliedLimit).toBe(CLIENT_SEARCH_MAX_RESULTS)
  })

  it("answers MAILBOX_LOCKED without touching the index", async () => {
    const { adapter } = await buildIndexedMailbox()
    const search = vi.spyOn(adapter, "search")
    const post = vi.fn(async () => {})
    await expect(
      answerClientSearch(
        { adapter, isUnlocked: () => false, turnNonce: () => TURN, post },
        { requestId: "req-6", turnNonce: TURN, query: NEEDLE },
      ),
    ).rejects.toMatchObject({ code: MAILBOX_LOCKED })
    expect(search).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it("flags an incomplete index instead of presenting a partial answer as whole", async () => {
    const { adapter } = await buildIndexedMailbox()
    adapter.setMode("metadata-only")
    const post = vi.fn(async () => {})
    const outcome = await answerClientSearch(
      {
        adapter,
        isUnlocked: () => true,
        turnNonce: () => TURN,
        indexComplete: () => false,
        post,
      },
      { requestId: "req-7", turnNonce: TURN, query: NEEDLE },
    )
    expect(outcome.indexComplete).toBe(false)
    expect(outcome.indexMode).toBe("metadata-only")
    const [, body] = post.mock.calls[0] as unknown as [string, { indexComplete: boolean }]
    expect(body.indexComplete).toBe(false)
  })

  it("throws a MailboxCryptoError, so the caller branches on a code", async () => {
    const { adapter } = await buildIndexedMailbox()
    const error = await answerClientSearch(
      { adapter, isUnlocked: () => false, turnNonce: () => TURN, post: async () => {} },
      { requestId: "req-8", turnNonce: TURN, query: NEEDLE },
    ).catch((caught) => caught)
    expect(error).toBeInstanceOf(MailboxCryptoError)
  })
})
