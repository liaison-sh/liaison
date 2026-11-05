// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The mailbox agent runtime runs app-wide, from the shell, with no Mail tab.
//
// It used to be mounted only inside the mail inbox, so a window with no Mail
// tab open had no runtime at all: a routine's Run now on Home refused with
// "Your private mailbox is not ready in this window yet" for an unlocked
// mailbox, and a chat turn from any other surface carried no turn nonce, so the
// server could never ask this browser for a private-mailbox read. These drive
// the real Shell on Home and check both, plus that a second host (the mail
// surface mounting one too) neither installs a second runtime nor tears down
// the live one when it goes away.
import type { AttentionItem } from "@liaison/shared"
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111"

const h = vi.hoisted(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    length: 0,
    key: () => null,
  } as any
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  const state = {
    fetched: [] as string[],
    plaintextPosts: [] as Array<{ url: string; body: any }>,
    openMessage: async (sealed: { id: string }) => ({
      id: sealed.id,
      subject: "Order 1042",
      textBody: "Where is my order?",
    }),
  }
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    state.fetched.push(url)
    const ok = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    if (url.includes("/mailbox/sync-cursor") && url.includes("ids=")) {
      return ok({
        cursor: "",
        done: true,
        total: 1,
        items: [
          {
            sealed: {
              id: MESSAGE_ID,
              encVersion: 1,
              encKeyId: 1,
              contentKeyWrapped: "AA==",
              contentKeyEpk: "AA==",
              subjectCiphertext: "AA==",
              textBodyCiphertext: "AA==",
            },
            envelope: { accountId: "a", conversationId: "c", sentAt: null, metadata: "" },
          },
        ],
      })
    }
    if (url.includes("/agent/mailbox-plaintext/")) {
      state.plaintextPosts.push({ url, body: JSON.parse(String(init?.body ?? "{}")) })
      return ok({ ok: true })
    }
    return ok([])
  }) as typeof fetch
  return state
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: () => true,
    accessToken: () => "test-token",
    userFromToken: () => ({
      userId: "u1",
      orgId: "o1",
      name: "Tester",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  }
})

vi.mock("~/modules/mailbox/mailbox-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/mailbox/mailbox-store")>()
  const client = {
    isUnlocked: () => true,
    openMessage: (sealed: { id: string }) => h.openMessage(sealed),
    openAttachment: async () => {
      throw new Error("not in this test")
    },
  }
  return {
    ...actual,
    mailboxStore: {
      status: "unlocked",
      keyring: {
        identityId: "i",
        keyId: 1,
        identities: [{ keyId: 1, status: "active" }],
        wraps: [],
      },
      lastErrorCode: null,
      idleTimeoutMs: 0,
      deviceMissingKeyring: false,
    },
    isMailboxUnlocked: () => true,
    mailboxCryptoClient: () => client,
    loadMailboxKeyring: async () => ({}),
  }
})
vi.mock("~/modules/mailbox/agent-mail-access", () => ({
  agentMailAccessEnabled: () => true,
  syncAgentMailAccessFromServer: async () => {},
}))
// The client search index is not what these tests are about.
vi.mock("~/modules/mailbox/search-index/search-index-host", () => ({
  MAILBOX_SEALED_LISTING_PATH: "/mailbox/sync-cursor",
  liveSearchIndexAdapter: () => null,
  startMailboxSearchIndex: async () => {},
  stopMailboxSearchIndex: () => {},
}))
vi.mock("~/modules/threads/message-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/threads/message-store")>()
  return {
    ...actual,
    sendMessage: vi.fn(async () => {}),
    holdTurnScopeUntilAgentTurnEnds: () => () => {},
  }
})

import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import RoutineMailboxWaitRow, {
  type RoutineMailboxWait,
  routineMailboxWaitOf,
} from "~/modules/agent/RoutineMailboxWaitRow"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { MailboxAgentHost } from "~/modules/mailbox/MailboxAgentHost"
import { beginMailboxAgentTurn, mailboxAgentRuntime } from "~/modules/mailbox/mailbox-agent-runtime"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetDockStore } from "~/modules/shell/dock-store"
import { Shell } from "~/modules/shell/Shell"
import { openTab } from "~/modules/shell/tab-store"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"
import { sendMessage } from "~/modules/threads/message-store"
import { sendThreadMessage } from "~/modules/threads/thread-send"

function renderShellOnHome() {
  resetRegistry()
  bootstrapKernelApps()
  openTab({ type: "home", entityId: "home", label: "Home" })
  return render(() => (
    <Router>
      <Route path="*" component={Shell} />
    </Router>
  ))
}

function waitItem(): AttentionItem {
  return {
    id: "kernel:agent_notification:w-1",
    app: "kernel",
    entity: "agent_notification",
    entityId: "routine-mailbox-wait:run-1",
    kind: "routine_mailbox_wait",
    summary: 'Routine "Morning mail" is waiting for your private mailbox',
    urgency: 60,
    occurredAt: "2026-10-31T08:00:00Z",
    action: { type: "open_entity", tabType: "thread", entityId: "t-1" },
    metadata: {
      routineMailboxWait: {
        routineId: "r-1",
        routineName: "Morning mail",
        runId: "run-1",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        trigger: { app: "mail", entity: "message", action: "create" },
      },
    },
  } as AttentionItem
}

beforeEach(() => {
  h.fetched = []
  h.plaintextPosts = []
})

afterEach(() => {
  resetBootstrap()
  resetRegistry()
  resetDockStore()
  resetToastStore()
})

describe("the mailbox agent runtime outside the Mail tab", () => {
  it("the shell installs it on Home, with no Mail tab open", () => {
    const view = renderShellOnHome()
    expect(screen.queryByTestId("mail-inbox")).toBeNull()
    expect(mailboxAgentRuntime()).not.toBeNull()
    view.unmount()
    expect(mailboxAgentRuntime()).toBeNull()
  })

  it("Run now on Home starts the run and answers its handoff from mail this window never loaded", async () => {
    const view = renderShellOnHome()
    const post = vi.fn(async (path: string, _body: unknown) =>
      path.endsWith("/run")
        ? {
            runId: "run-1",
            queued: false,
            handoff: {
              requestId: "req-1",
              messageIds: [MESSAGE_ID],
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          }
        : {},
    )
    const api = { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() } as never
    const item = waitItem()
    render(() => (
      <I18nProvider initialLocale="en">
        <ApiContext.Provider value={api}>
          <ul>
            <RoutineMailboxWaitRow
              item={item}
              wait={routineMailboxWaitOf(item) as RoutineMailboxWait}
            />
          </ul>
        </ApiContext.Provider>
      </I18nProvider>
    ))
    fireEvent.click(screen.getByTestId("routine-mailbox-wait-run"))
    await waitFor(() => expect(h.plaintextPosts).toHaveLength(1))
    // The run was started with this window's turn nonce.
    const [runPath, runBody] = post.mock.calls[0] as [string, { turnNonce: string }]
    expect(runPath).toBe("/agent/routines/r-1/mailbox-waits/run-1/run")
    expect(typeof runBody.turnNonce).toBe("string")
    // The handoff mail was read by id (ciphertext), opened here and posted back.
    expect(h.fetched.some((url) => url.includes(`ids=${MESSAGE_ID}`))).toBe(true)
    expect(h.plaintextPosts[0]?.url).toContain("/agent/mailbox-plaintext/req-1")
    expect(JSON.stringify(h.plaintextPosts[0]?.body)).toContain("Where is my order?")
    // It started: the row left the list and the toast says it runs.
    await waitFor(() => expect(screen.queryByTestId("routine-mailbox-wait-row")).toBeNull())
    expect(toasts().some((toast) => toast.message.startsWith("Morning mail is running"))).toBe(true)
    expect(toasts().some((toast) => /not ready/i.test(toast.message))).toBe(false)
    view.unmount()
  })

  it("a chat turn sent from a non-Mail surface carries a turn nonce", async () => {
    const view = renderShellOnHome()
    await sendThreadMessage(
      { post: vi.fn() } as never,
      "thread-1",
      "what did the customer ask?",
      { id: "u1", name: "Tester" },
      {},
      new Set(),
    )
    const opts = vi.mocked(sendMessage).mock.calls.at(-1)?.[4] as { turnNonce?: string }
    expect(typeof opts?.turnNonce).toBe("string")
    view.unmount()
  })

  it("a second host (the mail surface mounting one too) installs nothing and tears nothing down", () => {
    const view = renderShellOnHome()
    const live = mailboxAgentRuntime()
    expect(live).not.toBeNull()
    const second = render(() => <MailboxAgentHost />)
    expect(mailboxAgentRuntime()).toBe(live)
    second.unmount()
    // Still the shell's runtime, still answering turns.
    expect(mailboxAgentRuntime()).toBe(live)
    expect(beginMailboxAgentTurn()).not.toBeNull()
    view.unmount()
  })
})
