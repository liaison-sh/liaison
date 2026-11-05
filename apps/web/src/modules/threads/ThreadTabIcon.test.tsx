// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThreadTabIcon } from "~/modules/threads/ThreadTabIcon"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, userFromToken: () => ({ userId: "u1", name: "Owner" }) }
})

function seed(id: string, type: string, others: Array<Record<string, unknown>>) {
  addThread({
    id,
    handle: `@${id}`,
    title: type === "channel" ? "general" : null,
    type,
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    updatedAt: "2026-10-27T10:00:00Z",
    participants: [
      { id: "u1", name: "Owner", avatarUrl: null, participantType: "user" },
      ...others,
    ],
  })
}

describe("ThreadTabIcon", () => {
  beforeEach(() => resetThreadStore())
  afterEach(() => cleanup())

  it("shows the other person's face on a DM tab", () => {
    seed("dm1", "dm", [
      { id: "u2", name: "Maxime Durand", avatarUrl: null, participantType: "user" },
    ])
    render(() => <ThreadTabIcon entityId="dm1" size={14} />)
    const mark = screen.getByTestId("tab-avatar")
    expect(mark).toHaveAttribute("data-participant-id", "u2")
    expect(mark.textContent).toBe("MD")
  })

  it("shows the agent's mark on an agent chat tab", () => {
    seed("ac1", "agent_chat", [
      { id: "seat-a", name: "Personal agent", avatarUrl: null, participantType: "agent" },
    ])
    render(() => <ThreadTabIcon entityId="ac1" size={14} />)
    expect(screen.getByTestId("tab-avatar")).toHaveAttribute("data-participant-id", "seat-a")
  })

  it("keeps the message glyph for a channel or an unloaded conversation", () => {
    seed("ch1", "channel", [
      { id: "u2", name: "Maxime Durand", avatarUrl: null, participantType: "user" },
    ])
    render(() => (
      <>
        <ThreadTabIcon entityId="ch1" size={14} />
        <ThreadTabIcon entityId="missing" size={14} />
      </>
    ))
    expect(screen.queryByTestId("tab-avatar")).toBeNull()
  })
})
