// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A contact's related mail (its "Activity" backlinks) on an end to end
// encrypted mailbox. The rows come from the same `/mail/conversations` list
// projection the Mail inbox reads, so their subject and snippet are ciphertext
// only. They must open through the SAME worker path the inbox uses: unlocked,
// the decrypted subject shows; locked, the row says so; unlocking later opens
// them in place. Real crypto throughout, as in the inbox's own test.

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  contactDetailStore,
  loadBacklinks,
  resetContactDetailStore,
  subscribeContactDetailResync,
} from "~/modules/contacts/contact-detail-store"
import { createMailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealConversationFixture,
  TEST_USER_ID,
  type TestEnrollment,
} from "~/modules/mailbox/mailbox-fixtures"
import {
  mailboxStore,
  resetMailboxStore,
  setMailboxCryptoClient,
  unlockMailbox,
} from "~/modules/mailbox/mailbox-store"

const PASSWORD = "correct horse battery staple 42"
const CONTACT_ID = "11111111-1111-4111-8111-111111111111"
const SEALED_ID = "66666666-6666-4666-8666-666666666666"
const PLAIN_ID = "77777777-7777-4777-8777-777777777777"

function inProcessClient() {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  return createMailboxCryptoClient({ post: (request) => handleWorkerRequest(session, request) })
}

async function backlinkPage(enrollment: TestEnrollment) {
  const sealed = await sealConversationFixture(enrollment, {
    id: SEALED_ID,
    subject: "Contract renewal",
    snippet: "Signed copy attached",
  })
  const base = {
    accountId: "acct-1",
    status: "open",
    isRead: true,
    lastMessageAt: "2026-09-01T00:00:00.000Z",
    messageCount: 1,
    contactId: CONTACT_ID,
  }
  return [
    { ...base, ...sealed, subject: null, snippet: null },
    { ...base, id: PLAIN_ID, subject: "Plain hello", snippet: "Hi", encVersion: 0 },
  ]
}

function api(enrollment: TestEnrollment, page: unknown[]) {
  return {
    getEnvelope: vi
      .fn()
      .mockImplementation(async () => ({ data: structuredClone(page), meta: {} })),
    get: vi.fn().mockImplementation(async (path: string) => {
      if (path === "/mailbox-keys/me") {
        return {
          identityId: "identity-1",
          keyId: enrollment.entry.keyId,
          identities: [
            {
              id: "identity-1",
              keyId: enrollment.entry.keyId,
              status: "active",
              ecdhPublicKey: enrollment.keyring[0].ecdhSpki,
              signPublicKey: enrollment.keyring[0].signSpki,
              wrappedEcdhPrivate: enrollment.keyring[0].wrappedEcdhPrivate,
              wrappedSignPrivate: enrollment.keyring[0].wrappedSignPrivate,
              ecdhWrapIv: enrollment.keyring[0].ecdhWrapIv,
              signWrapIv: enrollment.keyring[0].signWrapIv,
              attestation: "",
              createdAt: "2026-08-01T00:00:00.000Z",
              retiredAt: null,
            },
          ],
          wraps: [],
        }
      }
      if (path.endsWith("/wrap-passphrase/blob")) {
        return {
          wrappedAccountKey: enrollment.passphraseWrap.wrappedAccountKey,
          kdfParams: enrollment.passphraseWrap.kdfParams,
        }
      }
      throw new Error(`unexpected path ${path}`)
    }),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
}

const row = (id: string) => contactDetailStore.backlinks[CONTACT_ID]?.byId[id]

async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe("contact related mail, sealed rows", () => {
  beforeEach(() => {
    resetContactDetailStore()
    resetMailboxStore()
    localStorage.clear()
  })

  it("an unlocked mailbox shows the decrypted subject and snippet", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    const client = inProcessClient()
    await client.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: PASSWORD,
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    setMailboxCryptoClient(client)
    await loadBacklinks(api(enrollment, await backlinkPage(enrollment)), CONTACT_ID)
    await settle(() => row(SEALED_ID)?.encState === "opened")

    expect(row(SEALED_ID)?.subject).toBe("Contract renewal")
    expect(row(SEALED_ID)?.snippet).toBe("Signed copy attached")
    expect(row(PLAIN_ID)?.subject).toBe("Plain hello")
    expect(row(PLAIN_ID)?.sealed).toBe(false)
  })

  it("a locked mailbox marks the sealed row locked, and unlocking opens it in place", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    subscribeContactDetailResync()
    setMailboxCryptoClient(inProcessClient())
    const mailApi = api(enrollment, await backlinkPage(enrollment))
    await loadBacklinks(mailApi, CONTACT_ID)
    await settle(() => row(SEALED_ID)?.encState === "locked")
    expect(row(SEALED_ID)?.sealed).toBe(true)
    expect(row(SEALED_ID)?.encState).toBe("locked")

    const ok = await unlockMailbox(mailApi, {
      userId: TEST_USER_ID,
      wrap: {
        id: "wrap-passphrase",
        type: "passphrase",
        label: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        lastUsedAt: null,
      },
      secret: PASSWORD,
    })
    expect(ok).toBe(true)
    expect(mailboxStore.status).toBe("unlocked")
    await settle(() => row(SEALED_ID)?.encState === "opened")
    expect(row(SEALED_ID)?.subject).toBe("Contract renewal")
  })
})
