// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client job queue, as it runs in a tab.
//
// The host used to be mounted with no turn runner at all, which by the
// drainer's own contract means "list the queue and claim nothing": every
// server-enqueued job sat pending until it expired and then surfaced to the
// user as failed work. This drives the queue the way the tab does and asserts
// the job actually reaches `done`.

import { render } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { dispatchWsEventMessage } from "~/framework/app-registry"
import { MailboxJobsHost } from "~/modules/mailbox/MailboxJobsHost"
import type { MailboxAgentRuntime } from "~/modules/mailbox/mailbox-agent-runtime"
import { installMailboxAgentRuntime } from "~/modules/mailbox/mailbox-agent-runtime"

const JOB_ID = "job-1"
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111"

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  sealIndexShard: vi.fn(),
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/mailbox/mailbox-store", () => ({
  isMailboxUnlocked: () => true,
  mailboxCryptoClient: () => ({ sealIndexShard: mocks.sealIndexShard }),
  openSealedMessage: async (sealed: { id: string }) => ({
    id: sealed.id,
    subject: "Invoice",
    textBody: "body",
    htmlBody: null,
    snippet: null,
  }),
}))

function pendingJob() {
  return {
    id: JOB_ID,
    kind: "summarise",
    status: "pending",
    accountId: null,
    payload: { conversationId: "conv-1", messageIds: [MESSAGE_ID] },
    attempts: 0,
    claimedBySession: null,
    claimedAt: null,
    leaseExpiresAt: null,
    expiresAt: null,
    completedAt: null,
    createdAt: new Date().toISOString(),
    hasResult: false,
  }
}

describe("MailboxJobsHost", () => {
  let uninstall: (() => void) | null = null

  beforeEach(() => {
    mocks.api.get.mockReset()
    mocks.api.post.mockReset()
    mocks.sealIndexShard.mockReset()
    mocks.sealIndexShard.mockResolvedValue("sealed-result")
    uninstall?.()
    uninstall = null

    mocks.api.get.mockImplementation(async (path: string) => {
      if (path === "/mailbox/client-jobs") return [pendingJob()]
      if (path.startsWith("/mail/conversations/")) {
        return { messages: [{ id: MESSAGE_ID, encVersion: 1, encKeyId: 1 }] }
      }
      throw new Error(`unexpected path ${path}`)
    })
    mocks.api.post.mockImplementation(async (path: string) => {
      if (path.endsWith("/claim")) {
        return {
          ...pendingJob(),
          status: "claimed",
          leaseExpiresAt: new Date(Date.now() + 600_000).toISOString(),
        }
      }
      return {}
    })
  })

  it("runs a pending job through a real turn and posts it done", async () => {
    const turns: Array<{ prompt: string; turnNonce: string }> = []
    uninstall = installMailboxAgentRuntime({
      runJobTurn: async (request: { prompt: string; turnNonce: string }) => {
        turns.push({ prompt: request.prompt, turnNonce: request.turnNonce })
        return { text: "a summary" }
      },
      // biome-ignore lint/suspicious/noExplicitAny: only the runner half is used here
    } as any as MailboxAgentRuntime)

    render(() => <MailboxJobsHost />)

    await vi.waitFor(() => {
      const done = mocks.api.post.mock.calls.find(
        ([path, body]) => path === `/mailbox/client-jobs/${JOB_ID}` && body?.status === "done",
      )
      expect(done).toBeTruthy()
      // The result is sealed to the user's own key before it is posted.
      expect((done as [string, { resultCiphertext: string }])[1].resultCiphertext).toBe(
        "sealed-result",
      )
    })
    // Non-vacuity: the job really went through a turn, and the prompt carried
    // envelope material only.
    expect(turns).toHaveLength(1)
    expect(turns[0].prompt).not.toContain("body")
  })

  it("wakes on the ephemeral pending event the server broadcasts", async () => {
    render(() => <MailboxJobsHost />)
    await vi.waitFor(() => expect(mocks.api.get).toHaveBeenCalled())
    // Let the drain the mount started settle: a wake landing on top of one in
    // flight joins it rather than listing twice, which is the drainer working.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const before = mocks.api.get.mock.calls.filter(
      ([path]) => path === "/mailbox/client-jobs",
    ).length

    dispatchWsEventMessage(
      {
        type: "event",
        payload: {
          app: "kernel",
          entity: "mailbox_jobs",
          action: "pending",
          data: {},
        },
        // biome-ignore lint/suspicious/noExplicitAny: the dispatcher takes the raw frame
      } as any,
      { currentUserId: "someone", activeTabId: null, isDocumentVisible: true, isOwnAction: false },
    )

    await vi.waitFor(() => {
      const after = mocks.api.get.mock.calls.filter(
        ([path]) => path === "/mailbox/client-jobs",
      ).length
      expect(after).toBeGreaterThan(before)
    })
  })

  it("claims nothing when no mailbox session can run a turn", async () => {
    render(() => <MailboxJobsHost />)
    await vi.waitFor(() => expect(mocks.api.get).toHaveBeenCalled())
    expect(mocks.api.post.mock.calls.filter(([path]) => path.endsWith("/claim"))).toHaveLength(0)
  })
})
