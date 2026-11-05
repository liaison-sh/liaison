// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Claude account local sessions run on, in Settings > Profile on every
// desktop OS. No OS has a native Account menu, so this is where the account
// is read and signed out of. A browser renders nothing.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import DesktopClaudeAccount from "./DesktopClaudeAccount"
import { installFakeBridge, uninstallFakeBridge } from "./fake-bridge"

describe("DesktopClaudeAccount", () => {
  afterEach(() => uninstallFakeBridge())

  it("renders nothing in a browser", () => {
    render(() => <DesktopClaudeAccount />)
    expect(screen.queryByTestId("desktop-claude-account")).toBeNull()
  })

  it("names the signed in account and asks the shell to sign out of Claude", async () => {
    const handle = installFakeBridge(
      { claudeAccount: { loggedIn: true, email: "someone@example.com" } },
      { platform: "windows" },
    )
    const signOut = vi.fn(async () => {})
    ;(handle.bridge as { signOutOfClaude?: () => Promise<void> }).signOutOfClaude = signOut
    render(() => <DesktopClaudeAccount />)
    expect(await screen.findByText("Claude: someone@example.com")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("desktop-claude-sign-out"))
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
  })

  it("says when nobody is signed in to Claude, and offers the sign in", async () => {
    const handle = installFakeBridge(
      { claudeAccount: { loggedIn: false, email: null } },
      { platform: "linux" },
    )
    render(() => <DesktopClaudeAccount />)
    expect(await screen.findByText("Not signed in to Claude")).toBeInTheDocument()
    expect(screen.queryByTestId("desktop-claude-sign-out")).toBeNull()
    fireEvent.click(screen.getByTestId("desktop-claude-sign-in"))
    await waitFor(() => expect(handle.calls.claudeSignIns).toBe(1))
  })
})
