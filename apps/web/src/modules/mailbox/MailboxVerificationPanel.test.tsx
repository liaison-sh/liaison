// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The surface that runs the sweep. Without it the whole client half of spec
// section 7 step 6 is unreachable code, which is exactly how this feature has
// gone wrong before.
//
// Two properties matter on screen. Progress must be visible, because a real
// mailbox takes minutes and a still screen reads as a hang. And a refusal must
// be LOUD and must name what failed: "verification refused" with the message
// ids, never a quiet nothing that leaves the user to press the button again.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/mailbox/verification-sweep-host", () => ({
  startMailboxVerificationSweep: mocks.start,
  MAILBOX_VERIFY_LISTING_PATH: "/mailbox/sync-cursor",
}))

import { MailboxVerificationPanel } from "~/modules/mailbox/MailboxVerificationPanel"
import { MAILBOX_SWEEP_RESUME_KEY, MailboxSweepError } from "~/modules/mailbox/verification-sweep"

const ACCOUNT_ID = "66666666-6666-4666-8666-666666666666"

describe("MailboxVerificationPanel", () => {
  beforeEach(() => {
    mocks.start.mockReset()
  })

  it("runs the sweep and reports the accepted acknowledgement", async () => {
    mocks.start.mockImplementation(async (options: any) => {
      options.onProgress?.({ verified: 2, total: 4, phase: "verifying" })
      options.onProgress?.({ verified: 4, total: 4, phase: "done" })
      return { verified: 4, completed: true, ack: { count: 4, keyId: 1, verifiedAt: null } }
    })
    render(() => <MailboxVerificationPanel accountId={ACCOUNT_ID} />)

    fireEvent.click(screen.getByTestId("mailbox-verify.start"))

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-verify.result").textContent).toContain("4")
    })
    expect(mocks.start.mock.calls[0]?.[0].accountId).toBe(ACCOUNT_ID)
    expect(screen.getByTestId("mailbox-verify.progress").textContent).toContain("4")
  })

  it("says LOUDLY that verification was refused, and names the messages", async () => {
    mocks.start.mockRejectedValue(
      new MailboxSweepError("1 message(s) did not verify", [
        { id: "m-77", reason: "undecryptable" },
      ]),
    )
    render(() => <MailboxVerificationPanel accountId={ACCOUNT_ID} />)
    fireEvent.click(screen.getByTestId("mailbox-verify.start"))

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-verify.refused")).toBeTruthy()
    })
    const refused = screen.getByTestId("mailbox-verify.refused").textContent ?? ""
    expect(refused).toContain("m-77")
    expect(refused.toLowerCase()).toContain("nothing was signed")
  })

  it("offers a way to start the check over, so a stuck saved position is not a dead end", async () => {
    // The saved position is only cleared by a run that finished. A run that
    // cannot finish therefore has to be recoverable from the screen, or the
    // only remedy is editing browser storage by hand.
    localStorage.setItem(
      MAILBOX_SWEEP_RESUME_KEY,
      JSON.stringify({ cursor: "m-2", ids: ["m-1"], startedAt: "2026-08-27T00:00:00.000Z" }),
    )
    render(() => <MailboxVerificationPanel accountId={ACCOUNT_ID} />)

    fireEvent.click(screen.getByTestId("mailbox-verify.discard-resume"))

    await waitFor(() => {
      expect(localStorage.getItem(MAILBOX_SWEEP_RESUME_KEY)).toBeNull()
    })
    expect(screen.getByTestId("mailbox-verify.result").textContent).toMatch(/from the beginning/i)
  })

  it("reports a partial stop without claiming the mailbox was verified", async () => {
    mocks.start.mockResolvedValue({ verified: 3, completed: false, stoppedBecause: "locked" })
    render(() => <MailboxVerificationPanel accountId={ACCOUNT_ID} />)
    fireEvent.click(screen.getByTestId("mailbox-verify.start"))

    await waitFor(() => {
      expect(screen.getByTestId("mailbox-verify.result").textContent).toMatch(/not finished/i)
    })
  })
})
