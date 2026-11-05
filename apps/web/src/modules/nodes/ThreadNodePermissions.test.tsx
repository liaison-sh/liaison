// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A node chat's permission prompt shows in the conversation it belongs to,
// above the composer, not only on Home: the notification opens the chat, and a
// chat that showed nothing left the agent waiting on a card the person never saw.
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ThreadNodePermissions, threadNodePrompts } from "~/modules/nodes/ThreadNodePermissions"
import { ApiContext } from "~/modules/shell/ApiContext"
import { attentionStore } from "~/modules/shell/attention-store"

vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn(async () => {}),
  openAttentionLink: vi.fn(async () => {}),
  markAttentionRead: vi.fn(),
}))

const LATER = new Date(Date.now() + 9 * 60_000).toISOString()

function prompt(
  id: string,
  threadId: string,
  occurredAt: string,
  expiresAt = LATER,
): AttentionItem {
  return {
    id: `kernel:agent_notification:${id}`,
    app: "kernel",
    entity: "agent_notification",
    entityId: id,
    kind: "agent_notification",
    summary: "Data on Mac asks to use Bash",
    urgency: 80,
    occurredAt,
    action: { type: "open_entity", tabType: "thread", entityId: threadId },
    metadata: {
      link: { tabType: "thread", entityId: threadId },
      nodePermission: {
        promptId: `prompt-${id}`,
        jobId: "job-1",
        nodeName: "Mac",
        agentName: "Data",
        toolName: "Bash",
        summary: `step ${id}`,
        expiresAt,
      },
    },
  } as AttentionItem
}

afterEach(() => attentionStore._setForTest({ items: [] }))

describe("threadNodePrompts", () => {
  it("keeps this conversation's undecided, unexpired prompts, oldest first", () => {
    const now = Date.now()
    const items = [
      prompt("b", "t-1", "2026-10-27T09:02:00Z"),
      prompt("other", "t-2", "2026-10-27T09:00:00Z"),
      prompt("a", "t-1", "2026-10-27T09:01:00Z"),
      prompt("gone", "t-1", "2026-10-27T08:00:00Z", new Date(now - 1000).toISOString()),
      {
        ...prompt("plain", "t-1", "2026-10-27T09:03:00Z"),
        metadata: { link: { tabType: "thread", entityId: "t-1" } },
      },
    ]
    expect(threadNodePrompts(items, "t-1", now).map((e) => e.prompt.promptId)).toEqual([
      "prompt-a",
      "prompt-b",
    ])
  })
})

describe("ThreadNodePermissions", () => {
  it("draws the Allow / Deny card in the chat and decides it from there", async () => {
    attentionStore._setForTest({ items: [prompt("a", "t-1", "2026-10-27T09:01:00Z")] })
    const post = vi.fn(async () => ({ data: { status: "allowed" } }))
    const api = { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() } as never
    render(() => (
      <I18nProvider initialLocale="en">
        <ApiContext.Provider value={api}>
          <ThreadNodePermissions threadId="t-1" />
        </ApiContext.Provider>
      </I18nProvider>
    ))
    expect(screen.getByTestId("thread-node-permissions")).toBeInTheDocument()
    expect(screen.getByText("step a")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("node-permission-allow"))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/nodes/permission-requests/prompt-a/decision", {
        allow: true,
      }),
    )
  })

  it("keeps a short line saying what was allowed in place of the decided card", async () => {
    attentionStore._setForTest({ items: [prompt("a", "t-1", "2026-10-27T09:01:00Z")] })
    const post = vi.fn(async () => ({ data: { status: "allowed" } }))
    const api = { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() } as never
    render(() => (
      <I18nProvider initialLocale="en">
        <ApiContext.Provider value={api}>
          <ThreadNodePermissions threadId="t-1" />
        </ApiContext.Provider>
      </I18nProvider>
    ))
    fireEvent.click(screen.getByTestId("node-permission-deny"))
    const line = await screen.findByTestId("node-permission-decided")
    expect(line.textContent).toBe("You denied: Bash step a")
    expect(line.dataset.decision).toBe("denied")
    expect(screen.queryByTestId("node-permission-card")).toBeNull()
    // The attention row is read and leaves the feed: the line stays.
    attentionStore._setForTest({ items: [] })
    expect(screen.getByTestId("node-permission-decided")).toBeInTheDocument()
  })

  it("draws nothing for another conversation's prompt", () => {
    attentionStore._setForTest({ items: [prompt("a", "t-2", "2026-10-27T09:01:00Z")] })
    const api = { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as never
    render(() => (
      <I18nProvider initialLocale="en">
        <ApiContext.Provider value={api}>
          <ThreadNodePermissions threadId="t-1" />
        </ApiContext.Provider>
      </I18nProvider>
    ))
    expect(screen.queryByTestId("thread-node-permissions")).toBeNull()
  })
})
