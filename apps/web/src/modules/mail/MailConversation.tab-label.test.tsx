// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S10: a mail conversation tab is titled with the email's subject, whichever
// way it was opened. A Home card, a mention or a notification opens it with
// the notification's text as the label ("Nouvel e-mail de Elodie"), and the
// tab kept that text for good: the tab type had no `resolveLabel` and the
// conversation never renamed its tab. An encrypted mailbox reads
// "Conversation" while it is locked and the subject once it is unlocked.
//
// Real stores, the real mail manifest wired to the real mail exports, and the
// real attention-link opener; only the network and the account list are faked.

import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    post: vi.fn(async () => ({})),
    patch: vi.fn(async () => ({})),
    getEnvelope: vi.fn(async () => ({ data: [] })),
  },
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => mocks.api,
  useOptionalApi: () => mocks.api,
}))

vi.mock("~/modules/mail/mail-account-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/mail/mail-account-store")>()
  return {
    ...actual,
    getAccount: () => ({ id: "acc-1", ownerType: "user" }),
    allAccounts: () => [{ id: "acc-1", ownerType: "user" }],
  }
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, userFromToken: () => ({ userId: "u-1" }) }
})

import { getTabType, resetRegistry, tabDisplayLabel } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppFromManifest, resetAppIndex } from "~/framework/define-app"
import { requestResync } from "~/framework/resync"
import * as mailExports from "~/modules/mail/exports"
import { MailConversation } from "~/modules/mail/MailConversation"
import { resetMailConversationStore } from "~/modules/mail/mail-conversation-store"
import {
  resetMailMessageStore,
  subscribeMailMessageResync,
} from "~/modules/mail/mail-message-store"
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
import { openAttentionLink } from "~/modules/shell/entity-opener"
import { makeTabId, resetTabStore, tabStore } from "~/modules/shell/tab-store"

const MAIL_MANIFEST = resolvePath(__dirname, "../../../../api/src/apps/mail/app.manifest.json")
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const MESSAGE_ID = "55555555-5555-4555-8555-555555555555"
const TAB_ID = makeTabId("mail:conversation", CONVERSATION_ID)
const NOTIFICATION_TEXT = "Nouvel e-mail de Elodie"

function installMail(): void {
  const manifest = JSON.parse(readFileSync(MAIL_MANIFEST, "utf8"))
  registerAppFromManifest(manifest as never, mailExports as never)
}

function tab() {
  return tabStore.tabs.find((t) => t.id === TAB_ID)
}

/** What the tab strip and the phone header print for the tab. */
function shownLabel(): string | undefined {
  const t = tab()
  return t ? tabDisplayLabel((key) => key, t) : undefined
}

function message(overrides: Record<string, unknown>) {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    fromAddress: { email: "elodie@example.com", name: "Elodie" },
    toAddresses: [],
    ccAddresses: [],
    direction: "inbound",
    sentAt: "2026-10-06T09:00:00.000Z",
    isRead: true,
    ...overrides,
  }
}

function serve(payload: unknown): void {
  mocks.api.get.mockImplementation(async () => structuredClone(payload))
}

async function openFromHomeCard(): Promise<void> {
  // The Home card's own path: the item's metadata.link, labelled with its text.
  await openAttentionLink(
    mocks.api as never,
    "mail:conversation",
    CONVERSATION_ID,
    NOTIFICATION_TEXT,
  )
  expect(tab()?.label).toBe(NOTIFICATION_TEXT)
}

function cryptoClient() {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  return createMailboxCryptoClient({ post: (request) => handleWorkerRequest(session, request) })
}

async function unlockedClient(enrollment: TestEnrollment) {
  const client = cryptoClient()
  await client.unlock({
    userId: TEST_USER_ID,
    method: "passphrase",
    secret: "correct horse battery staple 42",
    wrap: enrollment.passphraseWrap,
    keyring: enrollment.keyring,
  })
  return client
}

describe("mail conversation tab title (S10)", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetAppIndex()
    resetBootstrap()
    resetMailMessageStore()
    resetMailConversationStore()
    setMailboxCryptoClient(null)
    bootstrapKernelApps()
    installMail()
    mocks.api.get.mockReset()
  })
  afterEach(() => {
    setMailboxCryptoClient(null)
  })

  it("opened from an attention link, the tab ends up titled with the subject", async () => {
    serve({
      conversation: { id: CONVERSATION_ID, accountId: "acc-1", subject: "Quarterly numbers" },
      messages: [
        message({ subject: "Quarterly numbers", textBody: "Hi", htmlBody: null, encVersion: 0 }),
      ],
      nextMessageCursor: null,
    })
    await openFromHomeCard()
    // Nothing loaded yet: the opener's text stands in.
    expect(shownLabel()).toBe(NOTIFICATION_TEXT)

    render(() => <MailConversation entityId={CONVERSATION_ID} />)

    await waitFor(() => expect(tab()?.label).toBe("Quarterly numbers"))
    expect(shownLabel()).toBe("Quarterly numbers")
    // The tab type resolves it too, for every surface that prints a tab.
    expect(getTabType("mail:conversation")?.resolveLabel?.(CONVERSATION_ID)).toBe(
      "Quarterly numbers",
    )
  })

  it("a locked mailbox titles it Conversation, then the subject once unlocked", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const sealed = await sealMessageFixture(enrollment, {
      id: MESSAGE_ID,
      subject: "Sealed subject",
      textBody: "Sealed body",
      htmlBody: "<p>Sealed body</p>",
    })
    serve({
      // The server holds a sealed conversation's subject as ciphertext only.
      conversation: { id: CONVERSATION_ID, accountId: "acc-1", subject: null, encVersion: 1 },
      messages: [message({ ...sealed, subject: "", textBody: "", htmlBody: "" })],
      nextMessageCursor: null,
    })
    setMailboxCryptoClient(cryptoClient()) // enrolled, not unlocked
    subscribeMailMessageResync()
    await openFromHomeCard()

    const view = render(() => <MailConversation entityId={CONVERSATION_ID} />)

    await waitFor(() => expect(view.getByTestId("mail-conversation-locked")).toBeTruthy())
    await waitFor(() => expect(tab()?.label).toBe("Conversation"))
    expect(shownLabel()).toBe("Conversation")

    // The unlock: the worker can open the mail now, and the unlock bumps the
    // resync bus, which reloads the open conversation.
    setMailboxCryptoClient(await unlockedClient(enrollment))
    requestResync("mailbox-unlock")

    await waitFor(() => expect(tab()?.label).toBe("Sealed subject"))
    expect(shownLabel()).toBe("Sealed subject")
  })
})
