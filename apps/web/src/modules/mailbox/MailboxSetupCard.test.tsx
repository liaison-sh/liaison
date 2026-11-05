// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => apiMocks,
  useOptionalApi: () => apiMocks,
}))
const authMocks = vi.hoisted(() => ({ userFromToken: vi.fn(() => ({ userId: "me" })) }))
vi.mock("~/modules/auth/auth-store", () => authMocks)
// The enrollment itself (keys, password, passkey) is MailboxEnrollment's, tested
// on its own: here it is the same component, rendered in the conversation.
vi.mock("~/modules/mailbox/MailboxEnrollment", () => ({
  MailboxEnrollment: (props: { emailAddress: string; onEnrolled?: () => void }) => (
    <button
      type="button"
      data-testid="mailbox-enrollment"
      data-email={props.emailAddress}
      onClick={() => props.onEnrolled?.()}
    >
      enroll
    </button>
  ),
}))

import { MailboxSetupCard, mailboxSetupCardRef } from "./MailboxSetupCard"

function account(over: Record<string, unknown> = {}) {
  return {
    id: "acc-1",
    connectedAccountId: "ca-1",
    provider: "imap",
    emailAddress: "ana@gmail.com",
    displayName: null,
    ownerType: "user",
    ownerId: "me",
    syncStatus: "pre-sync",
    lastSyncAt: null,
    lastSyncError: null,
    unreadCount: 0,
    allowedImageSenderDomains: [],
    encryptionState: "pending_enrollment",
    messagesSynced: 0,
    ...over,
  }
}

function serve(accounts: unknown[], identities: unknown[] = []): void {
  apiMocks.get.mockImplementation(async (path: string) => {
    if (path === "/mail/accounts") return accounts
    if (path === "/mailbox-keys/me") return { identities, wraps: [] }
    throw new Error(`unexpected ${path}`)
  })
}

beforeEach(() => {
  apiMocks.get.mockReset()
  apiMocks.post.mockReset()
  apiMocks.post.mockResolvedValue({})
  authMocks.userFromToken.mockReturnValue({ userId: "me" })
})
afterEach(() => vi.restoreAllMocks())

describe("mailboxSetupCardRef", () => {
  it("shows the card only for a finished mailbox_setup call that asks for it", () => {
    const call = {
      toolName: "kernel__mailbox_setup",
      status: "complete",
      result: { card: "shown" },
    }
    expect(mailboxSetupCardRef(call)).toEqual({})
    expect(mailboxSetupCardRef({ ...call, args: { email: "ana@gmail.com" } })).toEqual({
      email: "ana@gmail.com",
    })
    expect(mailboxSetupCardRef({ ...call, result: { card: "none" } })).toBeNull()
    expect(mailboxSetupCardRef({ ...call, status: "error" })).toBeNull()
    expect(mailboxSetupCardRef({ ...call, toolName: "kernel__drive_picker" })).toBeNull()
  })
})

describe("MailboxSetupCard", () => {
  it("a mailbox waiting for its password: says nothing arrives, and draws the Settings enrollment inline", async () => {
    serve([account()])
    render(() => <MailboxSetupCard />)
    await waitFor(() => expect(screen.getByTestId("mailbox-setup-card")).toBeTruthy())
    expect(screen.getByTestId("mailbox-setup-card.why").textContent).toContain("ana@gmail.com")
    const enrollment = screen.getByTestId("mailbox-enrollment")
    expect(enrollment.getAttribute("data-email")).toBe("ana@gmail.com")
    fireEvent.click(enrollment)
    await waitFor(() => expect(screen.getByTestId("mailbox-setup-card.done")).toBeTruthy())
    expect(screen.queryByTestId("mailbox-enrollment")).toBeNull()
    expect(apiMocks.post).toHaveBeenCalledWith("/mail/accounts/acc-1/sync", undefined, {
      suppressGlobalError: true,
    })
  })

  it("an owner who already has a mailbox password turns the mailbox on, as Settings does", async () => {
    serve([account({ encryptionState: "paused" })], [{ status: "active" }])
    render(() => <MailboxSetupCard />)
    await waitFor(() => expect(screen.getByTestId("mailbox-setup-card.turn-on")).toBeTruthy())
    expect(screen.queryByTestId("mailbox-enrollment")).toBeNull()
    fireEvent.click(screen.getByTestId("mailbox-setup-card.turn-on"))
    await waitFor(() => expect(screen.getByTestId("mailbox-setup-card.done")).toBeTruthy())
    expect(apiMocks.post).toHaveBeenCalledWith("/mailbox-keys/arm", undefined, {
      suppressGlobalError: true,
    })
  })

  it("only the owner gets the form: anyone else sees one quiet line", async () => {
    authMocks.userFromToken.mockReturnValue({ userId: "someone-else" })
    serve([account()])
    render(() => <MailboxSetupCard email="ana@gmail.com" />)
    await waitFor(() => expect(screen.getByTestId("mailbox-setup-card.owner-only")).toBeTruthy())
    expect(screen.queryByTestId("mailbox-enrollment")).toBeNull()
  })

  it("quiet (inside the connect card): nothing for a mailbox already ready, nor for a shared one", async () => {
    serve([
      account({ encryptionState: "ready" }),
      account({ id: "acc-2", ownerType: "org", ownerId: null, encryptionState: "none" }),
    ])
    const { container } = render(() => <MailboxSetupCard quiet />)
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("/mail/accounts"))
    await Promise.resolve()
    expect(container.querySelector("[data-testid='mailbox-setup-card']")).toBeNull()
  })

  it("quiet, the connected mailbox waits: the form follows the connect at once", async () => {
    serve([account({ emailAddress: "Ana@Gmail.com" })])
    render(() => <MailboxSetupCard quiet email="ana@gmail.com" />)
    await waitFor(() => expect(screen.getByTestId("mailbox-enrollment")).toBeTruthy())
  })
})

describe("MailboxSetupCard: making a transparent mailbox private", () => {
  it("reads private from the call's arguments", () => {
    expect(
      mailboxSetupCardRef({
        toolName: "kernel__mailbox_setup",
        status: "complete",
        result: { card: "shown" },
        args: { private: true },
      }),
    ).toEqual({ makePrivate: true })
  })

  it("is silent for a transparent mailbox unless asked to make it private", async () => {
    serve([account({ encryptionState: "managed" })])
    render(() => <MailboxSetupCard quiet email="ana@gmail.com" />)
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("/mail/accounts"))
    expect(screen.queryByTestId("mailbox-setup-card")).toBeNull()
  })

  it("sets the mailbox password first when there is none, then makes it private", async () => {
    serve([account({ encryptionState: "managed" })])
    render(() => <MailboxSetupCard makePrivate email="ana@gmail.com" />)
    fireEvent.click(await screen.findByTestId("mailbox-setup-card.make-private"))
    fireEvent.click(await screen.findByTestId("mailbox-enrollment"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/mailbox/encryption/accounts/acc-1/make-private",
        undefined,
        { suppressGlobalError: true },
      ),
    )
  })

  it("makes it private at once for an owner who already has a mailbox password", async () => {
    serve([account({ encryptionState: "managed" })], [{ id: "k", keyId: 1, status: "active" }])
    render(() => <MailboxSetupCard makePrivate email="ana@gmail.com" />)
    fireEvent.click(await screen.findByTestId("mailbox-setup-card.make-private"))
    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        "/mailbox/encryption/accounts/acc-1/make-private",
        undefined,
        { suppressGlobalError: true },
      ),
    )
    expect(screen.queryByTestId("mailbox-enrollment")).toBeNull()
  })
})
