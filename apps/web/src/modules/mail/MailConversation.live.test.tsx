// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An open mail conversation shows a reply as soon as it is sent, from any send
// path (the reply bar, compose, an approved agent or routine reply), without a
// reload. The server announces the stored copy with a `mail:message:create`
// event carrying ids only (never the body); the conversation re-reads itself
// under the reader's own credentials and renders the message.
//
// Real stores, the real mail manifest wired to the real mail exports and the
// real websocket dispatch; only the network and the account list are faked.

import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { render, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

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
    getAccount: () => ({ id: "acc-1", ownerType: "org" }),
    allAccounts: () => [{ id: "acc-1", ownerType: "org" }],
  }
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, userFromToken: () => ({ userId: "u-1" }) }
})

import { dispatchWsEventMessage, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppFromManifest, resetAppIndex } from "~/framework/define-app"
import * as mailExports from "~/modules/mail/exports"
import { MailConversation } from "~/modules/mail/MailConversation"
import { resetMailConversationStore } from "~/modules/mail/mail-conversation-store"
import { resetMailMessageStore } from "~/modules/mail/mail-message-store"
import { resetTabStore } from "~/modules/shell/tab-store"

const MAIL_MANIFEST = resolvePath(__dirname, "../../../../api/src/apps/mail/app.manifest.json")
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const INBOUND_ID = "11111111-1111-4111-8111-111111111111"
const REPLY_ID = "22222222-2222-4222-8222-222222222222"

function message(overrides: Record<string, unknown>) {
  return {
    conversationId: CONVERSATION_ID,
    toAddresses: [],
    ccAddresses: [],
    htmlBody: null,
    isRead: true,
    encVersion: 0,
    ...overrides,
  }
}

const inbound = message({
  id: INBOUND_ID,
  fromAddress: { email: "buyer@example.com", name: "Buyer" },
  direction: "inbound",
  subject: "Interested",
  textBody: "Can we get a quote for 40 units?",
  sentAt: "2026-10-26T09:00:00.000Z",
})
const reply = message({
  id: REPLY_ID,
  fromAddress: { email: "support@example.com" },
  direction: "outbound",
  subject: "Re: Interested",
  textBody: "Here is the quote for 40 units.",
  sentAt: "2026-10-26T09:05:00.000Z",
})

const server = { messages: [inbound] as unknown[] }

/** A message body renders in a sandboxed frame: what the frames hold. */
function shownBodies(container: HTMLElement): string {
  return [...container.querySelectorAll("iframe")]
    .map((f) => f.getAttribute("srcdoc") ?? "")
    .join("\n")
}

describe("mail conversation, live sent reply", () => {
  beforeEach(() => {
    resetTabStore()
    resetRegistry()
    resetAppIndex()
    resetBootstrap()
    resetMailMessageStore()
    resetMailConversationStore()
    bootstrapKernelApps()
    registerAppFromManifest(
      JSON.parse(readFileSync(MAIL_MANIFEST, "utf8")) as never,
      mailExports as never,
    )
    server.messages = [inbound]
    mocks.api.get.mockReset()
    mocks.api.get.mockImplementation(async () =>
      structuredClone({
        conversation: { id: CONVERSATION_ID, accountId: "acc-1", subject: "Interested" },
        messages: server.messages,
        nextMessageCursor: null,
      }),
    )
  })

  /** The approval executed `mail:reply`: the sent copy is stored, and the
   * websocket delivers its create event, ids only. */
  function deliverReplyEvent(): void {
    server.messages = [inbound, reply]
    dispatchWsEventMessage(
      {
        type: "event",
        payload: {
          app: "mail",
          entity: "message",
          action: "create",
          entityId: REPLY_ID,
          actorId: "routine-actor",
          data: {
            id: REPLY_ID,
            conversationId: CONVERSATION_ID,
            accountId: "acc-1",
            direction: "outbound",
            from: { email: "support@example.com" },
            origin: "sent",
          },
        },
      },
      { currentUserId: "u-1", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )
  }

  async function openConversation() {
    const view = render(() => <MailConversation entityId={CONVERSATION_ID} />)
    await waitFor(() =>
      expect(shownBodies(view.container)).toContain("Can we get a quote for 40 units?"),
    )
    expect(shownBodies(view.container)).not.toContain("Here is the quote for 40 units.")
    return view
  }

  it("re-reads the open conversation and shows the reply when its message event arrives", async () => {
    const view = await openConversation()
    // Long open: every load has settled.
    await new Promise((r) => setTimeout(r, 50))
    const readsBefore = mocks.api.get.mock.calls.length

    deliverReplyEvent()

    await waitFor(() =>
      expect(shownBodies(view.container)).toContain("Here is the quote for 40 units."),
    )
    expect(mocks.api.get.mock.calls.length).toBeGreaterThan(readsBefore)
    expect(String(mocks.api.get.mock.calls.at(-1)?.[0])).toContain(CONVERSATION_ID)
  })

  it("an event arriving while a load is in flight still ends with the reply shown", async () => {
    // The first paint is in, the full page was requested before the reply was
    // stored: joining that load would leave the reply an empty stub.
    const view = await openConversation()

    deliverReplyEvent()

    await waitFor(() =>
      expect(shownBodies(view.container)).toContain("Here is the quote for 40 units."),
    )
  })
})
