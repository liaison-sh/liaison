// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Blueprint task 4.8. Between the deploy that suspends unenrolled personal
// mailboxes and the moment the user finishes enrolling, the only observable
// product behaviour is "mail stopped arriving". This banner is the sentence
// that keeps that from reading as a fault, so its copy is tested like code.

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MailEncryptionEnrollmentBanner } from "~/modules/mail/MailEncryptionEnrollmentBanner"
import type { MailAccount } from "~/modules/mail/mail-account-store"
import { MAILBOX_UNLOCK_EVENT } from "~/modules/mailbox/mailbox-unlock-bus"
import { PHONE_QUERY, syncShellTier } from "~/modules/shell/shell-tier"

vi.mock("~/modules/shell/tab-store", () => ({ openTab: vi.fn() }))

function setTier(tier: "phone" | "desktop"): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: tier === "phone" ? query === PHONE_QUERY : query === "(min-width: 1024px)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
  syncShellTier()
}

function account(overrides: Partial<MailAccount> & Pick<MailAccount, "id">): MailAccount {
  return {
    connectedAccountId: null,
    provider: "gmail",
    emailAddress: "someone@example.com",
    displayName: null,
    ownerType: "user",
    ownerId: "user-1",
    syncStatus: "idle",
    lastSyncAt: null,
    lastSyncError: null,
    unreadCount: 0,
    allowedImageSenderDomains: [],
    connectionHealth: null,
    encryptionState: "ready",
    messagesSynced: 0,
    ...overrides,
  }
}

/** Every dash form the house rule bans as punctuation. */
const DASH_PUNCTUATION = ["—", "–", "--"]

describe("MailEncryptionEnrollmentBanner", () => {
  it("renders for a pending_enrollment personal account and names the address", () => {
    render(() => (
      <MailEncryptionEnrollmentBanner
        accounts={[
          account({
            id: "a1",
            emailAddress: "ada@example.com",
            encryptionState: "pending_enrollment",
          }),
        ]}
      />
    ))
    const banner = screen.getByTestId("mail-encryption-enrollment-banner")
    // Non-vacuity: a component that renders nothing cannot pass the negatives.
    expect(banner.textContent?.length ?? 0).toBeGreaterThan(0)
    expect(banner.textContent).toContain("ada@example.com")
    expect(banner.textContent).toContain("is paused")
    expect(screen.getByTestId("mail-encryption-enrollment-banner.action").textContent).toBe(
      "Set up your mailbox",
    )
  })

  it("names the paused state", () => {
    render(() => (
      <MailEncryptionEnrollmentBanner
        accounts={[
          account({ id: "a1", emailAddress: "grace@example.com", encryptionState: "paused" }),
        ]}
      />
    ))
    const banner = screen.getByTestId("mail-encryption-enrollment-banner")
    expect(banner.getAttribute("data-encryption-state")).toBe("paused")
    expect(banner.textContent).toContain("paused")
    expect(banner.textContent).toContain("grace@example.com")
  })

  it("a blocked mailbox says mail stopped and offers a reset that opens the reset flow", () => {
    const onSetUp = vi.fn()
    const requests: unknown[] = []
    const listener = (event: Event) => requests.push((event as CustomEvent).detail)
    window.addEventListener(MAILBOX_UNLOCK_EVENT, listener)
    try {
      render(() => (
        <MailEncryptionEnrollmentBanner
          accounts={[
            account({ id: "a1", emailAddress: "alan@example.com", encryptionState: "blocked" }),
          ]}
          onSetUp={onSetUp}
        />
      ))
      const banner = screen.getByTestId("mail-encryption-enrollment-banner")
      expect(banner.getAttribute("data-encryption-state")).toBe("blocked")
      expect(banner.textContent).toContain(
        "Mail for alan@example.com stopped arriving. Reset the mailbox to start it again",
      )
      // No word about keys or setting anything up: a setup cannot unblock it.
      expect(banner.textContent).not.toMatch(/\bkey|encrypt|set up/i)
      const action = screen.getByTestId("mail-encryption-enrollment-banner.action")
      expect(action.textContent).toBe("Reset the mailbox")
      fireEvent.click(action)
      expect(requests).toEqual([{ view: "reset" }])
      expect(onSetUp).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(MAILBOX_UNLOCK_EVENT, listener)
    }
  })

  it("renders nothing for a ready account", () => {
    render(() => (
      <MailEncryptionEnrollmentBanner
        accounts={[account({ id: "a1", encryptionState: "ready" })]}
      />
    ))
    expect(screen.queryByTestId("mail-encryption-enrollment-banner")).toBeNull()
  })

  it("renders nothing for an org account, whatever its state", () => {
    render(() => (
      <MailEncryptionEnrollmentBanner
        accounts={[
          account({
            id: "a1",
            ownerType: "org",
            ownerId: null,
            encryptionState: "pending_enrollment",
          }),
        ]}
      />
    ))
    expect(screen.queryByTestId("mail-encryption-enrollment-banner")).toBeNull()
  })

  it("renders nothing when the server does not report a state yet", () => {
    render(() => (
      <MailEncryptionEnrollmentBanner accounts={[account({ id: "a1", encryptionState: null })]} />
    ))
    expect(screen.queryByTestId("mail-encryption-enrollment-banner")).toBeNull()
  })

  it("renders one row per suspended personal mailbox", () => {
    render(() => (
      <MailEncryptionEnrollmentBanner
        accounts={[
          account({
            id: "a1",
            emailAddress: "one@example.com",
            encryptionState: "pending_enrollment",
          }),
          account({ id: "a2", emailAddress: "two@example.com", encryptionState: "paused" }),
          account({ id: "a3", emailAddress: "three@example.com", encryptionState: "ready" }),
        ]}
      />
    ))
    const banners = screen.getAllByTestId("mail-encryption-enrollment-banner")
    expect(banners.length).toBe(2)
    expect(banners.map((b) => b.getAttribute("data-account-id"))).toEqual(["a1", "a2"])
  })

  it("uses no dash punctuation in any rendered string", () => {
    for (const state of ["pending_enrollment", "paused", "blocked", "none"] as const) {
      const { unmount } = render(() => (
        <MailEncryptionEnrollmentBanner
          accounts={[
            account({ id: "a1", emailAddress: "ada@example.com", encryptionState: state }),
          ]}
        />
      ))
      const text = screen.getByTestId("mail-encryption-enrollment-banner").textContent ?? ""
      for (const dash of DASH_PUNCTUATION) expect(text).not.toContain(dash)
      unmount()
    }
  })

  it("invokes the set-up action", () => {
    const onSetUp = vi.fn()
    render(() => (
      <MailEncryptionEnrollmentBanner
        accounts={[account({ id: "a1", encryptionState: "pending_enrollment" })]}
        onSetUp={onSetUp}
      />
    ))
    screen.getByTestId("mail-encryption-enrollment-banner.action").click()
    expect(onSetUp).toHaveBeenCalledTimes(1)
  })

  // K3: two or three full `AccountBanner`s pushed the phone list below the
  // fold. At phone tier this collapses to ONE compact row naming the count,
  // never the full per-account notices.
  describe("at phone tier", () => {
    afterEach(() => {
      cleanup()
      vi.unstubAllGlobals()
      setTier("desktop")
    })

    it("K3: collapses two paused mailboxes into one compact banner with count 2", () => {
      setTier("phone")
      render(() => (
        <MailEncryptionEnrollmentBanner
          accounts={[
            account({ id: "a1", emailAddress: "one@example.com", encryptionState: "paused" }),
            account({ id: "a2", emailAddress: "two@example.com", encryptionState: "paused" }),
          ]}
        />
      ))
      const compact = screen.getByTestId("mail-encryption-enrollment-compact")
      expect(compact.getAttribute("data-count")).toBe("2")
      expect(compact.textContent).toContain("2")
      expect(compact.textContent).toContain("mailboxes need setup")
      expect(screen.queryByTestId("mail-encryption-enrollment-banner")).toBeNull()
    })

    it("K3: uses the singular wording for exactly one mailbox", () => {
      setTier("phone")
      render(() => (
        <MailEncryptionEnrollmentBanner
          accounts={[
            account({ id: "a1", emailAddress: "one@example.com", encryptionState: "paused" }),
          ]}
        />
      ))
      const compact = screen.getByTestId("mail-encryption-enrollment-compact")
      expect(compact.textContent).toContain("1 mailbox needs setup")
    })

    it("K3: opens a sheet listing each mailbox with its own set-up action", () => {
      setTier("phone")
      const onSetUp = vi.fn()
      render(() => (
        <MailEncryptionEnrollmentBanner
          accounts={[
            account({ id: "a1", emailAddress: "one@example.com", encryptionState: "paused" }),
            account({ id: "a2", emailAddress: "two@example.com", encryptionState: "paused" }),
          ]}
          onSetUp={onSetUp}
        />
      ))
      expect(screen.queryByTestId("mail-encryption-enrollment-compact.row")).toBeNull()
      fireEvent.click(screen.getByTestId("mail-encryption-enrollment-compact"))
      const rows = screen.getAllByTestId("mail-encryption-enrollment-compact.row")
      expect(rows.map((r) => r.getAttribute("data-account-id"))).toEqual(["a1", "a2"])
      expect(rows[0].textContent).toContain("one@example.com")

      const actions = screen.getAllByTestId("mail-encryption-enrollment-compact.action")
      fireEvent.click(actions[1])
      expect(onSetUp).toHaveBeenCalledTimes(1)
      expect(onSetUp.mock.calls[0][0].id).toBe("a2")
    })

    it("a blocked mailbox in the sheet offers the reset, not the setup", () => {
      setTier("phone")
      const onSetUp = vi.fn()
      const onReset = vi.fn()
      render(() => (
        <MailEncryptionEnrollmentBanner
          accounts={[
            account({ id: "a1", emailAddress: "one@example.com", encryptionState: "paused" }),
            account({ id: "a2", emailAddress: "two@example.com", encryptionState: "blocked" }),
          ]}
          onSetUp={onSetUp}
          onReset={onReset}
        />
      ))
      fireEvent.click(screen.getByTestId("mail-encryption-enrollment-compact"))
      const actions = screen.getAllByTestId("mail-encryption-enrollment-compact.action")
      expect(actions[1].textContent).toBe("Reset the mailbox")
      fireEvent.click(actions[1])
      expect(onReset).toHaveBeenCalledTimes(1)
      expect(onReset.mock.calls[0][0].id).toBe("a2")
      expect(onSetUp).not.toHaveBeenCalled()
    })
  })

  it("K3: keeps the full per-account notices at desktop tier", () => {
    setTier("desktop")
    render(() => (
      <MailEncryptionEnrollmentBanner
        accounts={[
          account({ id: "a1", emailAddress: "one@example.com", encryptionState: "paused" }),
          account({ id: "a2", emailAddress: "two@example.com", encryptionState: "paused" }),
        ]}
      />
    ))
    expect(screen.getAllByTestId("mail-encryption-enrollment-banner").length).toBe(2)
    expect(screen.queryByTestId("mail-encryption-enrollment-compact")).toBeNull()
  })
})
