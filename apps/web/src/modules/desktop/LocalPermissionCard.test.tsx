// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T12: the permission prompt is answered where the tool is.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import type { DesktopToolActivity } from "~/lib/desktop-shell-contract"
import { installFakeBridge, liveSession, uninstallFakeBridge } from "./fake-bridge"
import LocalPermissionCard, { resetLocalPrompts } from "./LocalPermissionCard"

const EDIT_ROW: DesktopToolActivity = {
  id: "toolu_edit",
  toolName: "Edit",
  summary: "src/modules/desktop/RuntimeControl.tsx",
  status: "running",
  startedAt: 1_000,
}

function withPrompt(over: Partial<ReturnType<typeof basePrompt>> = {}) {
  return { ...basePrompt(), ...over }
}

function basePrompt() {
  return {
    requestId: "req-1",
    toolName: "Edit",
    summary: "Write 24 lines to src/modules/desktop/RuntimeControl.tsx",
    // The row the SHELL resolved this prompt to (P6d-FX1): placement is never
    // guessed from the tool's name on this side.
    toolUseId: "toolu_edit",
  }
}

describe("LocalPermissionCard", () => {
  afterEach(() => {
    resetLocalPrompts()
    uninstallFakeBridge()
  })

  it("local permission card answers allow with the request id it was given", async () => {
    const fake = installFakeBridge(
      liveSession("t1", "a1", { toolActivity: [EDIT_ROW], pendingPermissions: [withPrompt()] }),
    )
    render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    fireEvent.click(screen.getByRole("button", { name: "Allow" }))
    await waitFor(() =>
      expect(fake.calls.permissions).toEqual([{ requestId: "req-1", decision: "allow" }]),
    )
  })

  it("local permission card answers deny with the request id it was given", async () => {
    const fake = installFakeBridge(
      liveSession("t1", "a1", { toolActivity: [EDIT_ROW], pendingPermissions: [withPrompt()] }),
    )
    render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    await waitFor(() =>
      expect(fake.calls.permissions).toEqual([{ requestId: "req-1", decision: "deny" }]),
    )
  })

  // P6d-FX2 (SK-5): the card used to be HIDDEN whenever the mode read bypass,
  // on the theory that a prompt left over from a mode change was stale. It is
  // not stale: the SDK is parked on it and the shell still holds the request
  // id, so hiding it blocked the tool call until the sidecar's own timeout
  // with nothing anywhere to answer it.
  it("a prompt parked before the switch to bypass is answered, not hidden", async () => {
    const fake = installFakeBridge(
      liveSession("t1", "a1", { toolActivity: [EDIT_ROW], pendingPermissions: [withPrompt()] }),
    )
    render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    expect(screen.getByTestId("local-permission-card")).toBeInTheDocument()
    await fake.bridge.setPermissionMode("bypass")
    // Bypass means allow, so the shell allows what was already asked.
    expect(fake.calls.permissions).toEqual([{ requestId: "req-1", decision: "allow" }])
    await waitFor(() => expect(screen.queryByTestId("local-permission-card")).toBeNull())
  })

  it("a prompt the shell is still holding draws a card whatever the pill reads", () => {
    installFakeBridge(
      liveSession("t1", "a1", {
        permissionMode: "bypass",
        toolActivity: [EDIT_ROW],
        pendingPermissions: [withPrompt()],
      }),
    )
    render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    // Outstanding is outstanding: a card nobody can act on is the defect, and
    // an unanswerable prompt with no card is the same defect one layer down.
    expect(screen.getByTestId("local-permission-card")).toBeInTheDocument()
  })

  it("local permission card renders nothing in a browser", () => {
    uninstallFakeBridge()
    const { container } = render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    expect(container.innerHTML).toBe("")
  })

  it("a second prompt waits for the first to be answered", async () => {
    const fake = installFakeBridge(
      liveSession("t1", "a1", { toolActivity: [EDIT_ROW], pendingPermissions: [withPrompt()] }),
    )
    render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    fake.push({
      pendingPermissions: [
        withPrompt(),
        withPrompt({ requestId: "req-2", summary: "Run bun test" }),
      ],
    })

    await waitFor(() => expect(screen.getAllByTestId("local-permission-card")).toHaveLength(1))
    expect(screen.getByTestId("local-permission-card").getAttribute("data-request-id")).toBe(
      "req-1",
    )

    fireEvent.click(screen.getByRole("button", { name: "Allow" }))
    await waitFor(() =>
      expect(screen.getByTestId("local-permission-card").getAttribute("data-request-id")).toBe(
        "req-2",
      ),
    )
    expect(fake.calls.permissions).toEqual([{ requestId: "req-1", decision: "allow" }])
  })

  // P6d-FX1 (SK-5): the shell held ONE slot, so a second prompt arriving
  // before the first was answered overwrote it and the first could never be
  // answered from the UI at all.
  it("two prompts in flight are both answerable, in arrival order", async () => {
    const fake = installFakeBridge(
      liveSession("t1", "a1", {
        toolActivity: [EDIT_ROW],
        pendingPermissions: [
          withPrompt(),
          withPrompt({ requestId: "req-2", summary: "Run bun test" }),
        ],
      }),
    )
    render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    expect(screen.getByTestId("local-permission-card").getAttribute("data-request-id")).toBe(
      "req-1",
    )
    fireEvent.click(screen.getByRole("button", { name: "Allow" }))
    await waitFor(() =>
      expect(screen.getByTestId("local-permission-card").getAttribute("data-request-id")).toBe(
        "req-2",
      ),
    )
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    await waitFor(() =>
      expect(fake.calls.permissions).toEqual([
        { requestId: "req-1", decision: "allow" },
        { requestId: "req-2", decision: "deny" },
      ]),
    )
  })

  // P6d-FX1 (SK-8): two calls to the SAME tool in one turn both resolved to
  // the last running row, so the card appeared on the wrong one.
  it("the card sits in the row the shell named, not the last row of that tool", () => {
    const second: DesktopToolActivity = { ...EDIT_ROW, id: "toolu_edit_2", summary: "src/b.ts" }
    installFakeBridge(
      liveSession("t1", "a1", {
        toolActivity: [EDIT_ROW, second],
        pendingPermissions: [withPrompt({ toolUseId: "toolu_edit" })],
      }),
    )
    const first = render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    const last = render(() => <LocalPermissionCard toolCallId="toolu_edit_2" />)
    expect(first.container.querySelectorAll('[data-testid="local-permission-card"]').length).toBe(1)
    expect(last.container.innerHTML).toBe("")
  })

  it("the card names the tool the way every other row names it", () => {
    installFakeBridge(
      liveSession("t1", "a1", {
        toolActivity: [{ ...EDIT_ROW, toolName: "kernel__user_memory_set" }],
        pendingPermissions: [withPrompt({ toolName: "kernel__user_memory_set" })],
      }),
    )
    render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    expect(screen.getByText("User Memory Set")).toBeInTheDocument()
    expect(screen.getByText("Permission needed")).toBeInTheDocument()
  })

  it("the card carries no inline style attribute", () => {
    installFakeBridge(
      liveSession("t1", "a1", { toolActivity: [EDIT_ROW], pendingPermissions: [withPrompt()] }),
    )
    const { container } = render(() => <LocalPermissionCard toolCallId="toolu_edit" />)
    expect(container.querySelectorAll("[style]").length).toBe(0)
  })
})

// THE OWNER'S STUCK TURN (2026-09-23): two calls to one tool stack into
// "Skill Read ×2", collapsed, and the card lives inside a row the collapsed
// stack never rendered. The SDK waited on an Allow nobody could see.
describe("a prompt inside a stacked group of calls", () => {
  afterEach(() => {
    resetLocalPrompts()
    uninstallFakeBridge()
  })

  it("opens the group so the card is visible and answerable", async () => {
    const { StackedToolCallGroup } = await import("~/modules/agent/ToolCallRow")
    const read = "mcp__liaison__kernel__skill_read"
    const fake = installFakeBridge(
      liveSession("t1", "a1", {
        toolActivity: [
          { id: "toolu_1", toolName: read, summary: "name: a", status: "done", startedAt: 1 },
          { id: "toolu_2", toolName: read, summary: "name: b", status: "running", startedAt: 2 },
        ],
        pendingPermissions: [
          { requestId: "req-1", toolName: read, summary: "name: b", toolUseId: "toolu_2" },
        ],
      }),
    )
    render(() => (
      <StackedToolCallGroup
        toolCalls={[
          { toolCallId: "toolu_1", toolName: read, args: {}, status: "completed" },
          { toolCallId: "toolu_2", toolName: read, args: {}, status: "running" },
        ]}
      />
    ))
    expect(screen.getByTestId("local-permission-card").getAttribute("data-request-id")).toBe(
      "req-1",
    )
    fireEvent.click(screen.getByRole("button", { name: "Allow" }))
    await waitFor(() =>
      expect(fake.calls.permissions).toEqual([{ requestId: "req-1", decision: "allow" }]),
    )
  })
})
