// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P2-T11 (D24, D41): the one in-app level confirmation. It names the level and
// what it allows; Confirm posts one confirmation per node and returns the ids;
// a failure keeps it open with the error; Cancel creates nothing.
import type { NodeLevel } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { LevelConfirmDialog, type LevelConfirmPurpose } from "./LevelConfirmDialog"

function show(
  over: {
    level?: NodeLevel
    purpose?: LevelConfirmPurpose
    post?: ReturnType<typeof vi.fn>
    nodes?: Array<{ nodeId: string; nodeName: string }>
    sessionId?: string
  } = {},
) {
  let n = 0
  const post =
    over.post ??
    vi.fn(async (_path: string, body: { nodeId: string }) => ({
      confirmationId: `c-${body.nodeId}-${++n}`,
      expiresAt: "2026-10-13T11:00:00.000Z",
    }))
  const onConfirmed = vi.fn()
  const onCancel = vi.fn()
  const api = { get: vi.fn(), post, put: vi.fn(), patch: vi.fn(), delete: vi.fn() } as never
  render(() => (
    <I18nProvider initialLocale="en">
      <ApiContext.Provider value={api}>
        <LevelConfirmDialog
          open
          level={over.level ?? "open"}
          purpose={over.purpose ?? "session_start"}
          agentId="agent-1"
          agentName="Personal agent"
          sessionId={over.sessionId}
          nodes={over.nodes ?? [{ nodeId: "n1", nodeName: "Studio Mac" }]}
          onConfirmed={onConfirmed}
          onCancel={onCancel}
        />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return { post, onConfirmed, onCancel }
}

describe("LevelConfirmDialog (D24)", () => {
  it("names the level and what it allows, for this session on this node", async () => {
    show({ level: "open" })
    const dialog = await screen.findByTestId("node-level-confirm")
    expect(dialog.textContent).toContain("Run this session at Open?")
    expect(dialog.textContent).toContain("A plain Claude Code session: no sandbox")
    expect(dialog.textContent).toContain("Studio Mac")
    expect(screen.getByTestId("node-level-confirm-yes").textContent).toContain("Start at Open")
  })

  it("walk D18: a running session's raise says it raises this session, not that it starts it (EN, FR)", async () => {
    show({ level: "standard", purpose: "session_raise", sessionId: "s-1" })
    const dialog = await screen.findByTestId("node-level-confirm")
    expect(dialog.textContent).toContain("Raise this session to Standard?")
    expect(dialog.textContent).toContain("It restarts at Standard on Studio Mac")
    expect(screen.getByTestId("node-level-confirm-yes").textContent).toContain("Raise to Standard")
    expect(dialog.textContent).not.toContain("Start at")
  })

  it("a profile raise names the agent", async () => {
    show({ level: "standard", purpose: "profile_raise" })
    const dialog = await screen.findByTestId("node-level-confirm")
    expect(dialog.textContent).toContain("Raise Personal agent to Standard?")
  })

  it("Confirm posts one confirmation per node and returns the ids", async () => {
    const { post, onConfirmed } = show({
      level: "standard",
      nodes: [
        { nodeId: "n1", nodeName: "Studio Mac" },
        { nodeId: "n2", nodeName: "Laptop" },
      ],
    })
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(onConfirmed).toHaveBeenCalledTimes(1))
    expect(onConfirmed).toHaveBeenCalledWith(["c-n1-1", "c-n2-2"])
    expect(post.mock.calls.map((c) => c[1])).toEqual([
      { nodeId: "n1", level: "standard", purpose: "session_start", agentId: "agent-1" },
      { nodeId: "n2", level: "standard", purpose: "session_start", agentId: "agent-1" },
    ])
  })

  it("a session raise is bound to the session", async () => {
    const { post } = show({ level: "open", purpose: "session_raise", sessionId: "s-1" })
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][1]).toEqual({
      nodeId: "n1",
      level: "open",
      purpose: "session_raise",
      sessionId: "s-1",
    })
  })

  it("a failed confirmation keeps the dialog open with the error", async () => {
    const post = vi.fn(async () => {
      throw new ApiError("expired session", 410)
    })
    const { onConfirmed } = show({ post })
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    const alert = await screen.findByTestId("node-level-confirm-error")
    expect(alert.textContent).toContain("expired session")
    expect(screen.getByTestId("node-level-confirm")).toBeTruthy()
    expect(onConfirmed).not.toHaveBeenCalled()
  })

  it("a confirmation with no agent says so in the reader's language, never in English code words (m9)", async () => {
    const post = vi.fn()
    const api = { get: vi.fn(), post, put: vi.fn(), patch: vi.fn(), delete: vi.fn() } as never
    render(() => (
      <I18nProvider initialLocale="fr">
        <ApiContext.Provider value={api}>
          <LevelConfirmDialog
            open
            level="standard"
            purpose="session_start"
            nodes={[{ nodeId: "n1", nodeName: "Studio Mac" }]}
            onConfirmed={vi.fn()}
            onCancel={vi.fn()}
          />
        </ApiContext.Provider>
      </I18nProvider>
    ))
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    const alert = await screen.findByTestId("node-level-confirm-error")
    expect(alert.textContent).not.toContain("missing agent or session")
    expect(alert.textContent).toContain("Fermez-la et réessayez")
    expect(post).not.toHaveBeenCalled()
  })

  it("a network failure is said in words, not as the browser's error (m9)", async () => {
    const post = vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    })
    show({ post })
    fireEvent.click(await screen.findByTestId("node-level-confirm-yes"))
    const alert = await screen.findByTestId("node-level-confirm-error")
    expect(alert.textContent).not.toContain("Failed to fetch")
    expect(alert.textContent).toContain("Check your connection")
  })

  it("Cancel creates nothing", async () => {
    const { post, onCancel } = show()
    fireEvent.click(await screen.findByTestId("node-level-confirm-cancel"))
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(post).not.toHaveBeenCalled()
  })
})
