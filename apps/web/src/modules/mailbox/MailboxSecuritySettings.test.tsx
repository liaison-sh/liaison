// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The security page is a promise made to a customer, so its copy is tested like
// code. Three properties: every field that STAYS visible is named, none of the
// forbidden claims appears, and no dash punctuation appears anywhere.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MailboxSecuritySettings } from "~/modules/mailbox/MailboxSecuritySettings"
import { approvedZeroAccessClaim, FORBIDDEN_MAILBOX_PHRASES } from "~/modules/mailbox/mailbox-copy"
import { TEST_USER_ID } from "~/modules/mailbox/mailbox-fixtures"
import { MAILBOX_UNLOCK_EVENT } from "~/modules/mailbox/mailbox-unlock-bus"

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  unlockMailbox: vi.fn(),
  loadMailboxKeyring: vi.fn(),
  client: { mintWrap: vi.fn(), endMinting: vi.fn() },
}))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/mailbox/mailbox-store", () => ({
  agentMailAccessSyncDeps: () => ({ userId: null, crypto: null }),
  unlockMailbox: mocks.unlockMailbox,
  loadMailboxKeyring: mocks.loadMailboxKeyring,
  mailboxCryptoClient: () => mocks.client,
}))
vi.mock("~/modules/mailbox/passphrase-strength", () => ({
  checkPassphrase: async () => ({ ok: true, reasons: [] }),
}))

function wire(options: {
  withPassphrase: boolean
  backupsClearAfter: string | null
  withPasskey?: boolean
}) {
  mocks.api.get.mockImplementation(async (path: string) => {
    if (path === "/mailbox-keys/me") {
      return {
        identityId: "id-1",
        keyId: 1,
        identities: [
          {
            id: "id-1",
            keyId: 1,
            status: "active",
            ecdhPublicKey: "AA==",
            signPublicKey: "AA==",
            attestation: "",
            createdAt: "2026-08-01T00:00:00.000Z",
            retiredAt: null,
          },
        ],
        wraps: [
          {
            id: "w1",
            type: "recovery_phrase",
            label: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            lastUsedAt: null,
          },
          ...(options.withPassphrase
            ? [
                {
                  id: "w2",
                  type: "passphrase",
                  label: null,
                  createdAt: "2026-08-01T00:00:00.000Z",
                  lastUsedAt: null,
                },
              ]
            : []),
          ...(options.withPasskey
            ? [
                {
                  id: "w3",
                  type: "passkey_prf",
                  label: "Passkey",
                  createdAt: "2026-08-02T00:00:00.000Z",
                  lastUsedAt: null,
                },
              ]
            : []),
        ],
      }
    }
    if (path === "/mailbox/migration-state") {
      return {
        enrolledAt: "2026-08-01T00:00:00.000Z",
        backfillStartedAt: null,
        backfillCompletedAt: null,
        messagesTotal: 10,
        messagesSealed: 10,
        clientVerifiedAt: null,
        plaintextPurgedAt: null,
        backupsClearAfter: options.backupsClearAfter,
      }
    }
    throw new Error(`unexpected path ${path}`)
  })
}

async function renderPage(options?: {
  withPassphrase?: boolean
  backupsClearAfter?: string | null
  withPasskey?: boolean
}) {
  wire({
    withPassphrase: options?.withPassphrase ?? false,
    backupsClearAfter: options?.backupsClearAfter ?? null,
    withPasskey: options?.withPasskey ?? false,
  })
  const view = render(() => (
    <MailboxSecuritySettings userId={TEST_USER_ID} mode="personal" emailAddress="a@example.com" />
  ))
  await waitFor(() => expect(screen.getByTestId("mailbox-security-settings")).toBeTruthy())
  await waitFor(() => expect(screen.getByTestId("mailbox-security.unlock-methods")).toBeTruthy())
  return view
}

describe("MailboxSecuritySettings", () => {
  beforeEach(() => {
    mocks.api.get.mockReset()
    mocks.api.post.mockReset()
    mocks.api.delete.mockReset().mockResolvedValue({ deleted: true })
    mocks.unlockMailbox.mockReset()
    mocks.loadMailboxKeyring.mockReset().mockResolvedValue(undefined)
    mocks.client.mintWrap.mockReset()
    mocks.client.endMinting.mockReset().mockResolvedValue(undefined)
  })

  it("names every field that stays visible to org admins and to Liaison", async () => {
    const { container } = await renderPage()
    const text = container.textContent ?? ""
    // Non-vacuity: the page rendered real copy, not an empty shell.
    expect(text.length).toBeGreaterThan(500)
    for (const field of [
      "that this mailbox exists",
      "who you correspond with",
      "when each message arrived",
      "how often",
      "the shape of each thread",
      "how big each message is",
      "attachment filenames",
      "audit events",
    ]) {
      expect(text).toContain(field)
    }
  })

  it("carries the approved claim and none of the forbidden phrases", async () => {
    const { container } = await renderPage()
    const text = (container.textContent ?? "").replace(/\s+/g, " ")
    expect(text).toContain(approvedZeroAccessClaim().replace(/\s+/g, " "))
    for (const phrase of FORBIDDEN_MAILBOX_PHRASES) {
      expect(text.toLowerCase()).not.toContain(phrase.toLowerCase())
    }
  })

  it("uses no dash punctuation anywhere", async () => {
    const { container } = await renderPage({
      withPassphrase: true,
      backupsClearAfter: "2026-09-30T00:00:00.000Z",
    })
    const text = container.textContent ?? ""
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/[–—]/)
    expect(text).not.toMatch(/ -- /)
  })

  it("states the agent residual and names the switch that turns it off", async () => {
    const { container } = await renderPage()
    const text = container.textContent ?? ""
    expect(text).toContain("stays in that chat history")
    expect(screen.getByTestId("mailbox-security.agent-access-toggle")).toBeTruthy()
  })

  it("shows the mailbox password caveat only when a password wrap is enrolled", async () => {
    const withOut = await renderPage()
    expect(screen.queryByTestId("mailbox-security.passphrase-caveat")).toBeNull()
    withOut.unmount()

    await renderPage({ withPassphrase: true })
    const caveat = await screen.findByTestId("mailbox-security.passphrase-caveat")
    expect(caveat.textContent).toContain("offline")
  })

  it("names the date until which the zero access claim is false for this mailbox", async () => {
    await renderPage({ backupsClearAfter: "2026-09-30T00:00:00.000Z" })
    const banner = await screen.findByTestId("mailbox-security.backups-clear-after")
    expect(banner.textContent).toContain("2026")
    expect(banner.textContent).toMatch(/backup/i)
  })

  it("never presents key rotation as a remedy for a compromised mailbox", async () => {
    const { container } = await renderPage()
    const text = (container.textContent ?? "").toLowerCase()
    expect(text).not.toMatch(/rotate[^.]{0,60}(compromis|breach|remedy|fix)/)
    const rotation = screen.getByTestId("mailbox-security.rotation-note")
    expect(rotation.textContent).toContain("does not")
  })

  it("has no idle lock control and explains the mailbox password and the reset", async () => {
    const { container } = await renderPage({ withPassphrase: true })
    // The unlock lasts until logout: there is no "lock after" to choose.
    expect(screen.queryByTestId("mailbox-security.idle-timeout")).toBeNull()
    const policy = screen.getByTestId("mailbox-security.password-policy")
    expect(policy.textContent).toContain("not your Liaison login password")
    expect(policy.textContent).toMatch(/reset the mailbox/i)
    // The legacy recovery phrase row on file is not listed, and nothing
    // mentions a phrase at all.
    expect(screen.getByTestId("mailbox-security.wrap-passphrase").textContent).toContain(
      "Mailbox password",
    )
    expect(screen.queryByTestId("mailbox-security.wrap-recovery_phrase")).toBeNull()
    expect(container.textContent ?? "").not.toMatch(/recovery phrase/i)
  })

  // Without this the client half of the migration is unreachable code: the
  // sweep exists, the routes exist, and nothing can start one.
  it("offers the full-mailbox check on a personal mailbox, and not on a shared one", async () => {
    wire({ withPassphrase: false, backupsClearAfter: null })
    const personal = render(() => (
      <MailboxSecuritySettings
        userId={TEST_USER_ID}
        mode="personal"
        emailAddress="a@example.com"
        accountId="77777777-7777-4777-8777-777777777777"
      />
    ))
    await waitFor(() => expect(screen.getByTestId("mailbox-verification-panel")).toBeTruthy())
    expect(screen.getByTestId("mailbox-verify.start")).toBeTruthy()
    personal.unmount()

    wire({ withPassphrase: false, backupsClearAfter: null })
    render(() => (
      <MailboxSecuritySettings
        userId={TEST_USER_ID}
        mode="shared"
        emailAddress="team@example.com"
        accountId="77777777-7777-4777-8777-777777777777"
      />
    ))
    await waitFor(() => expect(screen.getByTestId("mailbox-security-settings")).toBeTruthy())
    expect(screen.queryByTestId("mailbox-verification-panel")).toBeNull()
  })

  it("states which mode this mailbox is in", async () => {
    await renderPage()
    const mode = screen.getByTestId("mailbox-security.mode")
    expect(mode.textContent).toContain("personal")
  })
  it("changes the mailbox password: proves the current one, adds the new row, then deletes the old", async () => {
    await renderPage({ withPassphrase: true })
    mocks.unlockMailbox.mockResolvedValue(true)
    mocks.client.mintWrap.mockResolvedValue({
      wrapType: "passphrase",
      wrappedAccountKey: "NEW",
      kdfParams: { kdf: "pbkdf2" },
    })
    mocks.api.post.mockResolvedValue({ id: "w9", type: "passphrase" })
    fireEvent.click(screen.getByTestId("mailbox-security.change-password"))
    fireEvent.input(screen.getByTestId("mailbox-security.current-password"), {
      target: { value: "old secret words" },
    })
    fireEvent.input(screen.getByTestId("mailbox-security.new-password"), {
      target: { value: "brand new secret words" },
    })
    fireEvent.input(screen.getByTestId("mailbox-security.new-password-again"), {
      target: { value: "brand new secret words" },
    })
    fireEvent.click(screen.getByTestId("mailbox-security.save-password"))

    await waitFor(() => expect(screen.getByTestId("mailbox-security.notice")).toBeTruthy())
    const attempt = mocks.unlockMailbox.mock.calls[0][1]
    expect(attempt).toMatchObject({ secret: "old secret words", mintWraps: true })
    expect(attempt.wrap.id).toBe("w2")
    expect(mocks.client.mintWrap).toHaveBeenCalledWith({
      kind: "passphrase",
      passphrase: "brand new secret words",
    })
    expect(mocks.api.post).toHaveBeenCalledWith(
      "/mailbox-keys/wraps",
      expect.objectContaining({ wrappedAccountKey: "NEW" }),
    )
    expect(mocks.api.delete).toHaveBeenCalledWith("/mailbox-keys/wraps/w2")
    // Add before delete: no failure can leave the mailbox without a password.
    expect(mocks.api.post.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.api.delete.mock.invocationCallOrder[0],
    )
    expect(mocks.client.endMinting).toHaveBeenCalled()
    expect(screen.queryByTestId("mailbox-security.change-password-form")).toBeNull()
  })

  it("a wrong current password changes nothing and says so", async () => {
    await renderPage({ withPassphrase: true })
    mocks.unlockMailbox.mockResolvedValue(false)
    fireEvent.click(screen.getByTestId("mailbox-security.change-password"))
    fireEvent.input(screen.getByTestId("mailbox-security.current-password"), {
      target: { value: "wrong" },
    })
    fireEvent.input(screen.getByTestId("mailbox-security.new-password"), {
      target: { value: "brand new secret words" },
    })
    fireEvent.input(screen.getByTestId("mailbox-security.new-password-again"), {
      target: { value: "brand new secret words" },
    })
    fireEvent.click(screen.getByTestId("mailbox-security.save-password"))
    const error = await screen.findByTestId("mailbox-security.error")
    expect(error.textContent).toContain("not your current mailbox password")
    expect(mocks.client.mintWrap).not.toHaveBeenCalled()
    expect(mocks.api.post).not.toHaveBeenCalled()
    expect(mocks.api.delete).not.toHaveBeenCalled()
  })

  it("removes a passkey while a mailbox password remains, and never offers it without one", async () => {
    const first = await renderPage({ withPassphrase: true, withPasskey: true })
    const remove = await screen.findByTestId("mailbox-security.remove-passkey")
    fireEvent.click(remove)
    await waitFor(() => expect(mocks.api.delete).toHaveBeenCalledWith("/mailbox-keys/wraps/w3"))
    first.unmount()

    await renderPage({ withPassphrase: false, withPasskey: true })
    await screen.findByTestId("mailbox-security.wrap-passkey_prf")
    expect(screen.queryByTestId("mailbox-security.remove-passkey")).toBeNull()
  })

  it("offers the reset right here, opening the reset flow even while unlocked", async () => {
    await renderPage({ withPassphrase: true })
    const requests: unknown[] = []
    const listener = (event: Event) => requests.push((event as CustomEvent).detail)
    window.addEventListener(MAILBOX_UNLOCK_EVENT, listener)
    try {
      fireEvent.click(screen.getByTestId("mailbox-security.reset"))
      expect(requests).toEqual([{ view: "reset" }])
    } finally {
      window.removeEventListener(MAILBOX_UNLOCK_EVENT, listener)
    }
    // It no longer points at a screen the user cannot reach while unlocked.
    expect(screen.getByTestId("mailbox-security.password-policy").textContent).not.toMatch(
      /unlock screen/i,
    )
  })

  it("keeps the offline attack caveat behind Learn more", async () => {
    await renderPage({ withPassphrase: true })
    const caveat = screen.getByTestId("mailbox-security.passphrase-caveat")
    expect(caveat.closest("details")).toBe(screen.getByTestId("mailbox-security.learn-more"))
    expect((screen.getByTestId("mailbox-security.learn-more") as HTMLDetailsElement).open).toBe(
      false,
    )
  })
})
