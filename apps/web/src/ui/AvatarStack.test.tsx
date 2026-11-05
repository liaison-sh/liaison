// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { Avatar, AvatarStack } from "~/ui/AvatarStack"

/** The agent mark is an SVG, not a character: iOS has no glyph for the one
 *  this used to be, and a missing glyph is a box with a question mark in it. */
const AGENT_GLYPH_SELECTOR = "[data-agent-glyph]"
/** The retired well-known id the UI used to treat as "this row is the agent".
 *  Kept here only to prove the id itself no longer decides anything. */
const RETIRED_AGENT_SENTINEL = "00000000-0000-0000-0000-00000000agent"

describe("Avatar agent detection (P4b-T02)", () => {
  afterEach(() => cleanup())

  it("Avatar renders the agent glyph for participantType agent regardless of id", () => {
    render(() => (
      <Avatar
        user={{ id: "any-uuid", name: "Support", avatarUrl: null, participantType: "agent" }}
      />
    ))
    expect(document.querySelector(AGENT_GLYPH_SELECTOR)).not.toBeNull()
  })

  it("Avatar renders a normal avatar for participantType user even with the old sentinel id", () => {
    render(() => (
      <Avatar
        user={{
          id: RETIRED_AGENT_SENTINEL,
          name: "Quinn Dupont",
          avatarUrl: null,
          participantType: "user",
        }}
      />
    ))
    expect(document.querySelector(AGENT_GLYPH_SELECTOR)).toBeNull()
    expect(screen.getByText("QD")).toBeInTheDocument()
  })

  it("a stack circle renders the agent glyph from participantType, not from the id", () => {
    render(() => (
      <AvatarStack
        users={[
          { id: "u1", name: "Alice Smith", avatarUrl: null },
          { id: "a1", name: "Support", avatarUrl: null, participantType: "agent" },
        ]}
      />
    ))
    expect(document.querySelectorAll(AGENT_GLYPH_SELECTOR).length).toBeGreaterThan(0)
  })
})

// The expanded row used to be an overlay: hovering the stack in a thread
// header unrolled the circles OVER the channel title and hid half of it for as
// long as the stack was open. jsdom has no layout, so what is asserted here is
// the structure that makes the overlap impossible: expanded, the row is in
// flow and the box grows to hold it, which pushes its flex siblings right.
describe("AvatarStack expanded row takes its width in flow", () => {
  afterEach(() => cleanup())

  const USERS = [
    { id: "u1", name: "Alice Smith", avatarUrl: null },
    { id: "u2", name: "Bob Jones", avatarUrl: null },
    { id: "u3", name: "Cara Diaz", avatarUrl: null },
  ]

  it("expanding moves the row out of absolute positioning and widens the box", () => {
    render(() => <AvatarStack users={USERS} size="md" />)
    const stack = screen.getByTestId("avatar-stack")
    const row = screen.getByTestId("avatar-stack-expanded")

    // Collapsed: the row is an overlay on a fixed square, out of flow.
    expect(row.classList.contains("absolute")).toBe(true)
    expect(stack.style.width).toBe("32px")

    fireEvent.mouseEnter(stack)

    // Expanded: the row is in flow and the box is as wide as the row, so a
    // sibling title cannot be sitting underneath it.
    expect(row.classList.contains("absolute")).toBe(false)
    const width = Number.parseFloat(stack.style.width)
    expect(width).toBe(Number.parseFloat(row.style.width))
    // 3 circles of 26px with 4px gaps.
    expect(width).toBe(86)

    fireEvent.mouseLeave(stack)
    expect(row.classList.contains("absolute")).toBe(true)
    expect(stack.style.width).toBe("32px")
  })
})

// An uploaded picture is stored server-relative ("/api/avatars/<key>"). Under a
// native shell the page lives on capacitor:// or tauri://, so the <img> must
// point at the server the user connected to, not at the app bundle.
describe("Avatar photo under a native shell", () => {
  afterEach(() => {
    cleanup()
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = undefined
  })

  it("loads an uploaded picture from the connected server", () => {
    ;(globalThis as Record<string, unknown>).__LIAISON_SERVER_ADDRESS__ = "https://acme.example.com"
    render(() => (
      <>
        <Avatar user={{ id: "u1", name: "Quinn Dupont", avatarUrl: "/api/avatars/key-one" }} />
        <AvatarStack
          users={[
            { id: "u2", name: "Robin Leroy", avatarUrl: "/api/avatars/key-two" },
            { id: "u3", name: "Sam Martin", avatarUrl: null },
          ]}
        />
      </>
    ))
    const srcs = Array.from(document.querySelectorAll("img")).map((img) => img.getAttribute("src"))
    expect(srcs).toContain("https://acme.example.com/api/avatars/key-one")
    expect(srcs).toContain("https://acme.example.com/api/avatars/key-two")
    expect(srcs.every((src) => src?.startsWith("https://acme.example.com/"))).toBe(true)
  })
})
