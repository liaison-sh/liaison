// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The read path for sealed mail: ciphertext in, worker unseal, plaintext into
// the same string fields the renderers already read, so nothing downstream
// changes. Dual read is asserted directly: a half-migrated conversation, one
// legacy plaintext row and one sealed row, must render both.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { getMessages, loadMessages, resetMailMessageStore } from "~/modules/mail/mail-message-store"
import { createMailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealMessageFixture,
  TEST_USER_ID,
  type TestEnrollment,
} from "~/modules/mailbox/mailbox-fixtures"
import { setMailboxCryptoClient } from "~/modules/mailbox/mailbox-store"

const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const PLAINTEXT_ID = "44444444-4444-4444-8444-444444444444"
const SEALED_ID = "55555555-5555-4555-8555-555555555555"

async function unlockedClient(enrollment: TestEnrollment) {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  const client = createMailboxCryptoClient({
    post: (request) => handleWorkerRequest(session, request),
  })
  await client.unlock({
    userId: TEST_USER_ID,
    method: "passphrase",
    secret: "correct horse battery staple 42",
    wrap: enrollment.passphraseWrap,
    keyring: enrollment.keyring,
  })
  return client
}

function lockedClient() {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  return createMailboxCryptoClient({ post: (request) => handleWorkerRequest(session, request) })
}

async function halfMigratedPayload(enrollment: TestEnrollment) {
  const sealed = await sealMessageFixture(enrollment, {
    id: SEALED_ID,
    subject: "Sealed subject",
    textBody: "Sealed body text",
    htmlBody: "<p>Sealed body text</p>",
  })
  return {
    conversation: { id: CONVERSATION_ID, accountId: "acct-1", subject: "Thread" },
    messages: [
      {
        id: PLAINTEXT_ID,
        conversationId: CONVERSATION_ID,
        fromAddress: { email: "a@example.com" },
        toAddresses: [],
        ccAddresses: [],
        subject: "Legacy subject",
        htmlBody: "<p>Legacy body</p>",
        textBody: "Legacy body",
        direction: "inbound",
        sentAt: "2026-08-01T00:00:00.000Z",
        isRead: true,
        encVersion: 0,
      },
      {
        // The sealed columns come first so the plaintext string fields below,
        // which the server sends empty for a sealed row, are what the store
        // sees before the worker fills them in. `sealed.id` IS `SEALED_ID`:
        // the AAD binds the row id, so the fixture and the row cannot disagree.
        ...sealed,
        conversationId: CONVERSATION_ID,
        fromAddress: { email: "b@example.com" },
        toAddresses: [],
        ccAddresses: [],
        subject: "",
        htmlBody: "",
        textBody: "",
        direction: "inbound",
        sentAt: "2026-08-02T00:00:00.000Z",
        isRead: true,
      },
    ],
    nextMessageCursor: null,
  }
}

/**
 * The store's `MailApi.get` is generic over its response type, so a plain
 * `async () => payload` cannot satisfy it. A `vi.fn()` double is the pattern
 * `mail-message-store.test.ts` already uses. Cloned per call because the store
 * takes ownership of what it is handed.
 */
function apiReturning(payload: unknown) {
  return { get: vi.fn().mockImplementation(async () => structuredClone(payload)) }
}

describe("mail message store, sealed rows", () => {
  beforeEach(() => {
    resetMailMessageStore()
    setMailboxCryptoClient(null)
  })

  it("T-INT-2 web half: a half-migrated conversation renders every message", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    setMailboxCryptoClient(await unlockedClient(enrollment))

    await loadMessages(apiReturning(await halfMigratedPayload(enrollment)), CONVERSATION_ID)
    const messages = getMessages(CONVERSATION_ID)
    // Non-vacuity: the fixture really did carry two messages, one of each kind.
    expect(messages).toHaveLength(2)

    const legacy = messages.find((m) => m.id === PLAINTEXT_ID)
    expect(legacy?.textBody).toBe("Legacy body")
    expect(legacy?.encState).toBe("plaintext")

    const sealed = messages.find((m) => m.id === SEALED_ID)
    expect(sealed?.subject).toBe("Sealed subject")
    expect(sealed?.textBody).toBe("Sealed body text")
    expect(sealed?.htmlBody).toBe("<p>Sealed body text</p>")
    expect(sealed?.encState).toBe("opened")
  })

  it("marks a sealed row locked, without throwing, when the mailbox is locked", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    setMailboxCryptoClient(lockedClient())

    await loadMessages(apiReturning(await halfMigratedPayload(enrollment)), CONVERSATION_ID)
    const messages = getMessages(CONVERSATION_ID)
    expect(messages).toHaveLength(2)

    const sealed = messages.find((m) => m.id === SEALED_ID)
    expect(sealed?.encState).toBe("locked")
    expect(sealed?.textBody).toBe("")
    expect(sealed?.htmlBody).toBe("")
    // The legacy row is untouched by the lock: dual read means the readable
    // half of a half-migrated mailbox stays readable.
    expect(messages.find((m) => m.id === PLAINTEXT_ID)?.textBody).toBe("Legacy body")
  })

  it("rewrites cid: references in a decrypted body so inline images render", async () => {
    // The server rewrites `cid:` to `/api/files/:id/inline` only when it can
    // read `html_body`, and for a sealed row it never can. Doing it here after
    // the decrypt is the only place left: otherwise every embedded image in an
    // encrypted message renders broken.
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    setMailboxCryptoClient(await unlockedClient(enrollment))

    const sealed = await sealMessageFixture(enrollment, {
      id: SEALED_ID,
      subject: "With a picture",
      textBody: "see the picture",
      htmlBody: '<p>see<img src="cid:logo@acme"></p>',
    })
    const payload = {
      conversation: { id: CONVERSATION_ID, accountId: "acct-1", subject: "Thread" },
      messages: [
        {
          ...sealed,
          conversationId: CONVERSATION_ID,
          fromAddress: { email: "b@example.com" },
          toAddresses: [],
          ccAddresses: [],
          subject: "",
          htmlBody: "",
          textBody: "",
          direction: "inbound",
          sentAt: "2026-08-02T00:00:00.000Z",
          isRead: true,
          attachments: [
            {
              id: "file-logo",
              filename: "logo.png",
              mimeType: "image/png",
              sizeBytes: 10,
              disposition: "inline",
              contentId: "logo@acme",
            },
          ],
        },
      ],
      nextMessageCursor: null,
    }

    await loadMessages(apiReturning(payload), CONVERSATION_ID)
    const message = getMessages(CONVERSATION_ID).find((m) => m.id === SEALED_ID)
    expect(message?.htmlBody).toContain("/api/files/file-logo/inline")
    expect(message?.htmlBody).not.toContain("cid:logo@acme")
  })

  it("never leaves ciphertext in a field a renderer treats as text", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    setMailboxCryptoClient(lockedClient())
    const payload = await halfMigratedPayload(enrollment)
    await loadMessages(apiReturning(payload), CONVERSATION_ID)
    const sealed = getMessages(CONVERSATION_ID).find((m) => m.id === SEALED_ID)
    const ciphertext = (payload.messages[1] as { textBodyCiphertext: string }).textBodyCiphertext
    expect(ciphertext.length).toBeGreaterThan(0)
    expect(sealed?.textBody).not.toContain(ciphertext)
    expect(sealed?.subject).not.toContain(ciphertext)
  })
})
