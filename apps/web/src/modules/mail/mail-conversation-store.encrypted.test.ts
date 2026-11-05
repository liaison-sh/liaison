// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The conversation LIST of an end to end encrypted mailbox. The server sends a
// sealed row's subject and snippet as ciphertext only, so the list must:
//   * mark such a row sealed (a locked row is not an empty subject),
//   * open it in the worker when the mailbox is unlocked,
//   * re-open it in place when the mailbox is unlocked later, with no reload.
// Real crypto throughout: a real enrollment, a real seal, the real worker
// protocol and the real unlock path in the mailbox store.

import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  conversationStore,
  handleConversationEvent,
  loadConversations,
  resetMailConversationStore,
  subscribeMailResync,
} from "~/modules/mail/mail-conversation-store"
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
const SEALED_ID = "66666666-6666-4666-8666-666666666666"
const PLAIN_ID = "77777777-7777-4777-8777-777777777777"
const POINTER_ID = "88888888-8888-4888-8888-888888888888"
const SOURCE_MESSAGE_ID = "99999999-9999-4999-8999-999999999999"

function inProcessClient() {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  return createMailboxCryptoClient({ post: (request) => handleWorkerRequest(session, request) })
}

/** One page of `/mail/conversations` exactly as the API projects it. */
async function listPage(enrollment: TestEnrollment) {
  const sealed = await sealConversationFixture(enrollment, {
    id: SEALED_ID,
    subject: "Quarterly figures",
    snippet: "Numbers attached",
  })
  // The shape ingest leaves: the row copies its latest message's ciphertext,
  // bound to that MESSAGE id, and names it in `snippetSourceMessageId`.
  const pointer = await sealConversationFixture(enrollment, {
    id: POINTER_ID,
    subject: "Ingested subject",
    snippet: "Ingested preview",
    pointedAtMessageId: SOURCE_MESSAGE_ID,
  })
  const base = {
    accountId: "acct-1",
    status: "open",
    isRead: true,
    isStarred: false,
    labels: [],
    lastMessageAt: "2026-09-01T00:00:00.000Z",
    messageCount: 1,
    assignedTo: null,
    contactId: null,
    internalThreadId: null,
    senderName: "Alice",
    senderEmail: "alice@example.com",
    escalatedTicketId: null,
    escalatedTicketHandle: null,
    escalatedTicketStatus: null,
  }
  return [
    // A sealed row: the plaintext columns are NULL on the server.
    { ...base, ...sealed, subject: null, snippet: null },
    { ...base, ...pointer, subject: null, snippet: null },
    { ...base, id: PLAIN_ID, subject: "Legacy plaintext", snippet: "Hello", encVersion: 0 },
  ]
}

function api(enrollment: TestEnrollment, page: unknown[]) {
  return {
    // `vi.fn().mockImplementation`: the store's API methods are generic over
    // their response type, which a typed `async () => ...` cannot satisfy.
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
    delete: vi.fn(),
  }
}

async function settle(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5))
}

describe("mail conversation list, sealed rows", () => {
  beforeEach(() => {
    resetMailConversationStore()
    resetMailboxStore()
    localStorage.clear()
  })

  it("a sealed row loaded while locked is marked sealed and locked, not an empty subject", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    setMailboxCryptoClient(inProcessClient())
    await loadConversations(api(enrollment, await listPage(enrollment)))
    await settle(() => conversationStore.byId[SEALED_ID]?.encState === "locked")

    const sealed = conversationStore.byId[SEALED_ID]
    expect(sealed?.sealed).toBe(true)
    expect(sealed?.encState).toBe("locked")
    expect(sealed?.subject).toBe("")
    // The plaintext row is untouched and not called sealed.
    expect(conversationStore.byId[PLAIN_ID]?.sealed).toBe(false)
    expect(conversationStore.byId[PLAIN_ID]?.subject).toBe("Legacy plaintext")
  })

  it("an unlocked mailbox opens the sealed subject and snippet in the list", async () => {
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
    await loadConversations(api(enrollment, await listPage(enrollment)))
    await settle(() => conversationStore.byId[SEALED_ID]?.encState === "opened")

    expect(conversationStore.byId[SEALED_ID]?.subject).toBe("Quarterly figures")
    expect(conversationStore.byId[SEALED_ID]?.snippet).toBe("Numbers attached")
    await settle(() => conversationStore.byId[POINTER_ID]?.encState === "opened")
    expect(conversationStore.byId[POINTER_ID]?.subject).toBe("Ingested subject")
    expect(conversationStore.byId[POINTER_ID]?.snippet).toBe("Ingested preview")
  })

  it("unlocking after the list loaded re-opens the sealed rows in place, no reload", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    subscribeMailResync()
    setMailboxCryptoClient(inProcessClient())
    const mailApi = api(enrollment, await listPage(enrollment))
    await loadConversations(mailApi)
    await settle(() => conversationStore.byId[SEALED_ID]?.encState === "locked")
    expect(conversationStore.byId[SEALED_ID]?.subject).toBe("")

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
    await settle(() => conversationStore.byId[SEALED_ID]?.encState === "opened")

    expect(conversationStore.byId[SEALED_ID]?.subject).toBe("Quarterly figures")
    expect(conversationStore.byId[SEALED_ID]?.snippet).toBe("Numbers attached")
    await settle(() => conversationStore.byId[POINTER_ID]?.encState === "opened")
    expect(conversationStore.byId[POINTER_ID]?.subject).toBe("Ingested subject")
    expect(conversationStore.byId[POINTER_ID]?.snippet).toBe("Ingested preview")
  })
})

// Sync delivers new mail as realtime events. A sealed mailbox's event carries
// only `{ id, accountId }`, so the live path must fetch the row through the list
// projection and open it exactly as a reload would: plaintext when unlocked,
// `locked` (and never plaintext) when locked.
describe("mail conversation list, sealed rows arriving live during sync", () => {
  const LIVE_ID = "55555555-5555-4555-8555-555555555555"

  beforeEach(() => {
    resetMailConversationStore()
    resetMailboxStore()
    localStorage.clear()
  })

  async function liveRow(enrollment: TestEnrollment, subject: string, snippet: string) {
    const sealed = await sealConversationFixture(enrollment, { id: LIVE_ID, subject, snippet })
    return {
      ...sealed,
      accountId: "acct-1",
      status: "open",
      isRead: false,
      isStarred: false,
      labels: [],
      lastMessageAt: "2026-09-02T00:00:00.000Z",
      messageCount: 1,
      senderName: "Bob",
      senderEmail: "bob@example.com",
      subject: null,
      snippet: null,
    }
  }

  /** The list starts empty; `?ids=` answers with whatever `server.rows` holds now. */
  function liveApi(enrollment: TestEnrollment, server: { rows: Array<{ id: string }> }) {
    const base = api(enrollment, [])
    base.getEnvelope = vi.fn().mockImplementation(async (path: string) => {
      const ids = new URLSearchParams(path.split("?")[1] ?? "").get("ids")
      if (!ids) return { data: [], meta: {} }
      const wanted = ids.split(",")
      return { data: structuredClone(server.rows.filter((r) => wanted.includes(r.id))), meta: {} }
    })
    return base
  }

  async function unlockedClient(enrollment: TestEnrollment) {
    const client = inProcessClient()
    await client.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: PASSWORD,
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    return client
  }

  it("unlocked: a synced sealed conversation shows its subject and snippet live, no refresh", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    setMailboxCryptoClient(await unlockedClient(enrollment))
    const server = { rows: [await liveRow(enrollment, "Synced subject", "Synced preview")] }
    const mailApi = liveApi(enrollment, server)
    await loadConversations(mailApi)
    expect(conversationStore.ids).toEqual([])

    // Exactly what ingest emits for a sealed mailbox.
    handleConversationEvent("create", { id: LIVE_ID, accountId: "acct-1" })
    await settle(() => conversationStore.byId[LIVE_ID]?.encState === "opened")

    expect(conversationStore.ids).toContain(LIVE_ID)
    expect(conversationStore.byId[LIVE_ID]?.sealed).toBe(true)
    expect(conversationStore.byId[LIVE_ID]?.subject).toBe("Synced subject")
    expect(conversationStore.byId[LIVE_ID]?.snippet).toBe("Synced preview")
    expect(conversationStore.byId[LIVE_ID]?.senderName).toBe("Bob")
  })

  it("locked: a synced sealed conversation is marked locked and never shows plaintext", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    setMailboxCryptoClient(inProcessClient())
    const server = { rows: [await liveRow(enrollment, "Synced subject", "Synced preview")] }
    await loadConversations(liveApi(enrollment, server))

    handleConversationEvent("create", { id: LIVE_ID, accountId: "acct-1" })
    await settle(() => conversationStore.byId[LIVE_ID]?.encState === "locked")

    const row = conversationStore.byId[LIVE_ID]
    expect(row?.sealed).toBe(true)
    expect(row?.encState).toBe("locked")
    expect(row?.subject).toBe("")
    expect(row?.snippet).toBe("")
  })

  it("unlocked: a new synced message re-opens the sealed row's new snippet live", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    setMailboxCryptoClient(await unlockedClient(enrollment))
    const server = { rows: [await liveRow(enrollment, "Synced subject", "First preview")] }
    await loadConversations(liveApi(enrollment, server))
    handleConversationEvent("create", { id: LIVE_ID, accountId: "acct-1" })
    await settle(() => conversationStore.byId[LIVE_ID]?.snippet === "First preview")
    expect(conversationStore.byId[LIVE_ID]?.snippet).toBe("First preview")

    server.rows = [await liveRow(enrollment, "Synced subject", "Second preview")]
    handleConversationEvent("update", { id: LIVE_ID, accountId: "acct-1", messageCount: 2 })
    await settle(() => conversationStore.byId[LIVE_ID]?.snippet === "Second preview")

    expect(conversationStore.byId[LIVE_ID]?.snippet).toBe("Second preview")
    expect(conversationStore.byId[LIVE_ID]?.encState).toBe("opened")
  })
})
