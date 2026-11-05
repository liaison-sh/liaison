// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The unlock modal's way out: one "Not now", and Escape, on the unlock screen
// only. On every other screen (the reset, setting a password, the passkey
// offer) leaving halfway is what stranded users between a reset and a mailbox
// with nothing to unlock it, so those screens carry their own way out.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, setTokens } from "~/modules/auth/auth-store"
import type { MailboxUnlockProps } from "~/modules/mailbox/MailboxUnlock"
import { MailboxUnlockHost } from "~/modules/mailbox/MailboxUnlockHost"
import { requestMailboxReset, requestMailboxUnlock } from "~/modules/mailbox/mailbox-unlock-bus"

const seen = vi.hoisted(() => ({ props: null as MailboxUnlockProps | null }))
vi.mock("~/modules/mailbox/MailboxUnlock", () => ({
  MailboxUnlock: (props: MailboxUnlockProps) => {
    seen.props = props
    props.onViewChange?.(props.initialView === "reset" ? "reset-confirm" : "unlock")
    return <div data-testid="stub-unlock" />
  },
}))

const pressEscape = () => fireEvent.keyDown(window, { key: "Escape" })

function signInWith(scopes: string[]): void {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "")
  const payload = {
    userId: "user-1",
    orgId: "org-1",
    scopes,
    roles: [],
    exp: Math.floor(Date.now() / 1000) + 3600,
    name: "Member",
  }
  setTokens(`${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.sig`)
}

describe("MailboxUnlockHost", () => {
  beforeEach(() => {
    seen.props = null
    signInWith(["mail:conversations:read"])
  })
  afterEach(() => clearAuth())

  // A member without mail access has no mailbox to unlock: the modal covered
  // the whole app (Settings included) with an error they could do nothing
  // about (walk 2026-10-19, #18).
  it("never opens for a user without mail access", async () => {
    signInWith(["kernel:threads"])
    render(() => <MailboxUnlockHost userId="user-1" />)
    requestMailboxUnlock()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByTestId("mailbox-unlock-host")).toBeNull()
    expect(screen.queryByTestId("stub-unlock")).toBeNull()
  })

  it("offers one Not now and Escape on the unlock screen, and none elsewhere", async () => {
    render(() => <MailboxUnlockHost userId="user-1" />)
    requestMailboxUnlock()
    await screen.findByTestId("stub-unlock")
    expect(screen.getAllByTestId("mailbox-unlock-host.dismiss")).toHaveLength(1)

    // The user moved on to the reset: no host dismiss, Escape does nothing.
    seen.props?.onViewChange?.("reset-confirm")
    await waitFor(() => expect(screen.queryByTestId("mailbox-unlock-host.dismiss")).toBeNull())
    pressEscape()
    expect(screen.getByTestId("mailbox-unlock-host")).toBeTruthy()

    for (const view of ["set-password", "offer-passkey"] as const) {
      seen.props?.onViewChange?.(view)
      await waitFor(() => expect(screen.queryByTestId("mailbox-unlock-host.dismiss")).toBeNull())
    }

    // Back on the unlock screen, Escape closes it.
    seen.props?.onViewChange?.("unlock")
    await screen.findByTestId("mailbox-unlock-host.dismiss")
    pressEscape()
    await waitFor(() => expect(screen.queryByTestId("mailbox-unlock-host")).toBeNull())
  })

  it("opens straight on the reset when asked, with no dismiss", async () => {
    render(() => <MailboxUnlockHost userId="user-1" />)
    requestMailboxReset()
    await screen.findByTestId("stub-unlock")
    expect(seen.props?.initialView).toBe("reset")
    expect(screen.queryByTestId("mailbox-unlock-host.dismiss")).toBeNull()
  })

  it("closes when the unlock surface reports the mailbox open", async () => {
    render(() => <MailboxUnlockHost userId="user-1" />)
    requestMailboxUnlock()
    await screen.findByTestId("stub-unlock")
    seen.props?.onUnlocked?.()
    await waitFor(() => expect(screen.queryByTestId("mailbox-unlock-host")).toBeNull())
  })
})
