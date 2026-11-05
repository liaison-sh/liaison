// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The first import of a large mailbox runs for a long time. Without this
// banner the inbox is an unexplained half-filled list and the only status
// word never moves. The copy is tested like code, the same way the
// enrollment banner's is.

import { Route, Router } from "@solidjs/router"
import { render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { isImporting, MailSyncProgressBanner } from "~/modules/mail/MailSyncProgressBanner"
import type { MailAccount } from "~/modules/mail/mail-account-store"
import { ApiProvider } from "~/modules/shell/ApiContext"

function account(overrides: Partial<MailAccount> & Pick<MailAccount, "id">): MailAccount {
  return {
    connectedAccountId: null,
    provider: "gmail",
    emailAddress: "someone@example.com",
    displayName: null,
    ownerType: "user",
    ownerId: "user-1",
    syncStatus: "active",
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

function renderBanner(accounts: MailAccount[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in this test"))),
  )
  // ApiProvider reaches for the router, so the banner mounts inside a Route
  // exactly as the settings tests do.
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <MailSyncProgressBanner accounts={accounts} refreshMs={0} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("MailSyncProgressBanner", () => {
  it("names the mailbox and the running count while the first import pages through it", () => {
    renderBanner([
      account({
        id: "a1",
        emailAddress: "quinn@example.com",
        syncStatus: "syncing",
        messagesSynced: 9405,
      }),
    ])
    const banner = screen.getByTestId("mail-sync-progress-banner")
    expect(banner.getAttribute("data-sync-status")).toBe("syncing")
    const text = banner.textContent ?? ""
    expect(text).toContain("quinn@example.com")
    expect(text).toContain("9,405 messages so far")
    expect(text).toContain("New mail keeps arriving")
    for (const dash of DASH_PUNCTUATION) expect(text).not.toContain(dash)
  })

  it("says the import is starting when nothing has been counted yet", () => {
    renderBanner([account({ id: "a1", syncStatus: "pre-sync", messagesSynced: 0 })])
    const text = screen.getByTestId("mail-sync-progress-banner.text").textContent ?? ""
    expect(text).toContain("Importing someone@example.com")
    expect(text).toContain("takes a while")
    expect(text).not.toContain("so far")
  })

  it("renders nothing for an active mailbox", () => {
    renderBanner([account({ id: "a1", syncStatus: "active", messagesSynced: 12000 })])
    expect(screen.queryByTestId("mail-sync-progress-banner")).toBeNull()
  })

  it("leaves a mailbox suspended by encryption enrollment to the enrollment banner", () => {
    // Such a mailbox can carry `syncing` from before it was suspended. It is
    // not importing anything, and two banners on one mailbox would contradict
    // each other.
    expect(
      isImporting(
        account({ id: "a1", syncStatus: "syncing", encryptionState: "pending_enrollment" }),
      ),
    ).toBe(false)
    renderBanner([account({ id: "a1", syncStatus: "syncing", encryptionState: "paused" })])
    expect(screen.queryByTestId("mail-sync-progress-banner")).toBeNull()
  })

  it("a shared mailbox importing shows too, it is not in the encryption regime", () => {
    renderBanner([
      account({
        id: "shared",
        ownerType: "org",
        ownerId: null,
        encryptionState: "none",
        emailAddress: "support@example.com",
        syncStatus: "syncing",
        messagesSynced: 120,
      }),
    ])
    expect(screen.getByTestId("mail-sync-progress-banner").textContent).toContain(
      "support@example.com",
    )
  })
})
