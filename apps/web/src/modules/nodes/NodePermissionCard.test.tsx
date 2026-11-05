// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4 N-D T6b (S24, A24): a node chat's permission prompt, relayed by the node,
// reaches its owner on the web and the phone as an Allow / Deny card in the
// attention feed: what is asked, by which agent, from which node, and the
// decision goes to POST /api/nodes/permission-requests/:id/decision.
import type { AttentionItem } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import NodePermissionCard, {
  type NodePermissionPrompt,
  nodePermissionPromptOf,
} from "~/modules/nodes/NodePermissionCard"
import { ApiContext } from "~/modules/shell/ApiContext"
import { markAttentionRead } from "~/modules/shell/entity-opener"

vi.mock("~/modules/shell/entity-opener", () => ({
  openEntity: vi.fn(async () => {}),
  openAttentionLink: vi.fn(async () => {}),
  markAttentionRead: vi.fn(),
}))

import { I18nProvider } from "~/modules/i18n/i18n-context"
import { resetToastStore, toasts } from "~/modules/shell/toast-store"

function item(): AttentionItem {
  return {
    id: "kernel:agent_notification:n-1",
    app: "kernel",
    entity: "agent_notification",
    entityId: "n-1",
    kind: "agent_notification",
    summary: "Data on Minimac asks to use Bash: bun run build. Allow or deny within 10 minutes.",
    urgency: 80,
    occurredAt: "2026-10-07T21:00:00Z",
    action: { type: "open_entity", tabType: "thread", entityId: "t-1" },
    metadata: {
      nodePermissionPromptId: "prompt-1",
      nodePermission: {
        promptId: "prompt-1",
        jobId: "job-1",
        nodeName: "Minimac",
        agentName: "Data",
        toolName: "Bash",
        summary: "bun run build",
        expiresAt: "2026-10-07T21:10:00Z",
      },
    },
  } as AttentionItem
}

function renderCard(post: ReturnType<typeof vi.fn>, locale: "en" | "fr" = "en") {
  const api = { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() } as never
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <ApiContext.Provider value={api}>
        <ul>
          <NodePermissionCard
            item={item()}
            prompt={nodePermissionPromptOf(item()) as NodePermissionPrompt}
          />
        </ul>
      </ApiContext.Provider>
    </I18nProvider>
  ))
}

afterEach(() => {
  resetToastStore()
  vi.clearAllMocks()
})

describe("the node permission card (S24, A24)", () => {
  it("says what is asked, by which agent, from which node, with Allow and Deny", () => {
    // The prompt was raised at 21:00 and expires at 21:10 (fixture).
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-07T21:00:00Z"))
    try {
      renderCard(vi.fn())
      const card = screen.getByTestId("node-permission-card")
      expect(card.textContent).toContain("Data on Minimac asks to use Bash")
      expect(card.textContent).toContain("bun run build")
      // P6-fix9: the time left, not the rule, so a late prompt reads as late.
      expect(card.textContent).toContain("Denied automatically in 10 min without an answer.")
      expect(screen.getByRole("button", { name: "Allow" })).toBeTruthy()
      expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy()
      // A guided tour clicks them by these ids.
      expect(screen.getByTestId("node-permission-allow").textContent).toContain("Allow")
      expect(screen.getByTestId("node-permission-deny").textContent).toContain("Deny")
    } finally {
      vi.useRealTimers()
    }
  })

  it("says so once the 10 minutes are over", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-07T21:10:30Z"))
    try {
      renderCard(vi.fn())
      expect(screen.getByTestId("node-permission-expiry").textContent).toBe(
        "Expired: it was denied automatically.",
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("Allow posts the decision and clears the row", async () => {
    const post = vi.fn(async () => ({ status: "allowed" }))
    renderCard(post)
    fireEvent.click(screen.getByRole("button", { name: "Allow" }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/nodes/permission-requests/prompt-1/decision", {
        allow: true,
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("node-permission-card").textContent).toContain("You allowed it."),
    )
    expect(markAttentionRead).toHaveBeenCalledWith(
      expect.anything(),
      "kernel",
      "agent_notification",
      "n-1",
    )
  })

  it("Deny posts allow false", async () => {
    const post = vi.fn(async () => ({ status: "denied" }))
    renderCard(post)
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/nodes/permission-requests/prompt-1/decision", {
        allow: false,
      }),
    )
    await waitFor(() =>
      expect(screen.getByTestId("node-permission-card").textContent).toContain("You denied it."),
    )
  })

  it("a late answer says the request was already answered or expired", async () => {
    const post = vi.fn(async () => {
      throw new ApiError("this request was already denied", 409)
    })
    renderCard(post)
    fireEvent.click(screen.getByRole("button", { name: "Allow" }))
    await waitFor(() =>
      expect(toasts().map((t) => t.message)).toContain(
        "This request was already answered or has expired.",
      ),
    )
  })

  it("reads in French", () => {
    renderCard(vi.fn(), "fr")
    const card = screen.getByTestId("node-permission-card")
    expect(card.textContent).toContain("Data sur Minimac demande à utiliser Bash")
    expect(screen.getByRole("button", { name: "Autoriser" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Refuser" })).toBeTruthy()
  })
})
