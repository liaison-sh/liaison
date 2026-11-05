// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The enrollment wizard (spec section 5.1). Pinned here: the mailbox password
// is required and comes first, no recovery phrase is ever shown or sent,
// abandoning before the end persists NOTHING, a passkey that did not enable PRF
// never produces a wrap row, and any non-empty password is accepted, however
// weak (product decision); only an empty one is refused.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MailboxEnrollment } from "~/modules/mailbox/MailboxEnrollment"
import { TEST_USER_ID } from "~/modules/mailbox/mailbox-fixtures"

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  passkeysUsable: true,
  client: null as unknown,
  unlock: vi.fn(async (..._args: unknown[]) => true),
  loadKeyring: vi.fn(async () => ({})),
  order: [] as string[],
}))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/mailbox/passkey-availability", () => ({
  passkeysUsableHere: async () => mocks.passkeysUsable,
}))
vi.mock("~/modules/mailbox/crypto-worker-boot", () => ({
  startMailboxCryptoWorker: async () => null,
}))
vi.mock("~/modules/mailbox/mailbox-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/modules/mailbox/mailbox-store")>()),
  mailboxCryptoClient: () => mocks.client,
  unlockMailbox: mocks.unlock,
  loadMailboxKeyring: mocks.loadKeyring,
}))

function emptyKeyring() {
  mocks.api.get.mockImplementation(async (path: string) => {
    if (path === "/mailbox-keys/me") {
      return { identityId: null, keyId: null, identities: [], wraps: [] }
    }
    throw new Error(`unexpected path ${path}`)
  })
}

const floorOk = async () => ({ ok: true as const, reasons: [] })

/** Setup is one screen: the password step is there from the start, no "begin" click. */
async function reachPasswordStep() {
  await waitFor(() => expect(screen.getByTestId("mailbox-enrollment.passphrase")).toBeTruthy())
}

async function acceptPassword(value = "copper lantern orbit meadow 1987", again = value) {
  fireEvent.input(screen.getByTestId("mailbox-enrollment.passphrase"), { target: { value } })
  fireEvent.input(screen.getByTestId("mailbox-enrollment.passphrase-confirm"), {
    target: { value: again },
  })
  fireEvent.click(screen.getByTestId("mailbox-enrollment.accept-passphrase"))
}

describe("MailboxEnrollment", () => {
  beforeEach(() => {
    mocks.api.get.mockReset()
    mocks.api.post.mockReset()
    mocks.api.post.mockResolvedValue({ identityId: "id-1", keyId: 1, identities: [], wraps: [] })
    mocks.passkeysUsable = true
    mocks.client = null
    mocks.unlock.mockReset()
    mocks.unlock.mockResolvedValue(true)
    mocks.loadKeyring.mockReset()
    mocks.order.length = 0
    localStorage.clear()
    emptyKeyring()
  })

  it("asks for a mailbox password first and says it is not the login password", async () => {
    render(() => (
      <MailboxEnrollment
        userId={TEST_USER_ID}
        emailAddress="a@example.com"
        checkPassphraseFn={floorOk}
      />
    ))
    await reachPasswordStep()
    const explainer = screen.getByTestId("mailbox-enrollment.password-explainer")
    expect(explainer.textContent).toContain("not your Liaison login password")
    expect(explainer.textContent).toContain("Liaison never sees it")
    // There is no way past this step without a password: no skip, no passkey.
    expect(screen.queryByTestId("mailbox-enrollment.skip-passkey")).toBeNull()
    expect(screen.queryByTestId("mailbox-enrollment.use-passkey")).toBeNull()
    expect(screen.queryByTestId("mailbox-enrollment.skip-passphrase")).toBeNull()
  })

  it("says so when the password step fails, instead of a button that does nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    render(() => (
      <MailboxEnrollment
        userId={TEST_USER_ID}
        emailAddress="a@example.com"
        checkPassphraseFn={async () => {
          throw new Error("CompileError: Refused to create a WebAssembly object")
        }}
      />
    ))
    await reachPasswordStep()
    await acceptPassword()
    await waitFor(() =>
      expect(screen.getByTestId("mailbox-enrollment.passphrase-refusal").textContent).toMatch(
        /could not be (saved|set up)/,
      ),
    )
    expect(screen.getByTestId("mailbox-enrollment.accept-passphrase")).toBeTruthy()
    expect(mocks.api.post).not.toHaveBeenCalled()
  })

  it("persists nothing when the user abandons before the end", async () => {
    const { unmount } = render(() => (
      <MailboxEnrollment
        userId={TEST_USER_ID}
        emailAddress="a@example.com"
        checkPassphraseFn={floorOk}
      />
    ))
    await reachPasswordStep()
    await acceptPassword()
    // Non-vacuity: the wizard really got past the password.
    await waitFor(() => expect(screen.getByTestId("mailbox-enrollment.skip-passkey")).toBeTruthy())
    unmount()
    expect(mocks.api.post).not.toHaveBeenCalled()
  })

  it("refuses two passwords that do not match", async () => {
    render(() => (
      <MailboxEnrollment
        userId={TEST_USER_ID}
        emailAddress="a@example.com"
        checkPassphraseFn={floorOk}
      />
    ))
    await reachPasswordStep()
    await acceptPassword("copper lantern orbit meadow 1987", "copper lantern orbit meadow 1988")
    const refusal = await screen.findByTestId("mailbox-enrollment.passphrase-refusal")
    expect(refusal.textContent).toContain("do not match")
    expect(screen.queryByTestId("mailbox-enrollment.skip-passkey")).toBeNull()
    expect(mocks.api.post).not.toHaveBeenCalled()
  })

  it("enrolls the mailbox password and never shows or sends a recovery phrase", async () => {
    const { container } = render(() => (
      <MailboxEnrollment
        userId={TEST_USER_ID}
        emailAddress="a@example.com"
        checkPassphraseFn={floorOk}
      />
    ))
    const seen: string[] = []
    await reachPasswordStep()
    seen.push(container.textContent ?? "")
    await acceptPassword()
    await waitFor(() => expect(screen.getByTestId("mailbox-enrollment.skip-passkey")).toBeTruthy())
    seen.push(container.textContent ?? "")
    fireEvent.click(screen.getByTestId("mailbox-enrollment.skip-passkey"))

    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledTimes(1))
    await screen.findByTestId("mailbox-enrollment.done")
    seen.push(container.textContent ?? "")
    const [path, body] = mocks.api.post.mock.calls[0] as [string, { wraps: { wrapType: string }[] }]
    expect(path).toBe("/mailbox-keys/enroll")
    expect(body.wraps.map((wrap) => wrap.wrapType)).toEqual(["passphrase"])
    for (const text of seen) {
      expect(text).not.toMatch(/recovery|twelve words|12 words/i)
    }
    expect(screen.queryByTestId("mailbox-enrollment.recovery-phrase")).toBeNull()
  })

  it("enrolls the wrapped private halves so another device can rebuild the keyring", async () => {
    render(() => (
      <MailboxEnrollment
        userId={TEST_USER_ID}
        emailAddress="a@example.com"
        checkPassphraseFn={floorOk}
      />
    ))
    await reachPasswordStep()
    await acceptPassword()
    await waitFor(() => expect(screen.getByTestId("mailbox-enrollment.skip-passkey")).toBeTruthy())
    fireEvent.click(screen.getByTestId("mailbox-enrollment.skip-passkey"))

    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledTimes(1))
    const [, body] = mocks.api.post.mock.calls[0] as [string, Record<string, unknown>]
    // Ciphertext under the Account Key, so the server holds nothing it can
    // read. Without these four, a cleared profile loses the mailbox forever.
    for (const field of [
      "wrappedEcdhPrivate",
      "wrappedSignPrivate",
      "ecdhWrapIv",
      "signWrapIv",
    ] as const) {
      expect(typeof body[field]).toBe("string")
      expect((body[field] as string).length).toBeGreaterThan(0)
    }
    // Non-vacuity: these are the wrapped halves, not a copy of a public one.
    expect(body.wrappedEcdhPrivate).not.toBe(body.ecdhPublicKey)
  })

  it("persists no passkey_prf wrap when the authenticator did not enable PRF", async () => {
    vi.stubGlobal("navigator", {
      credentials: {
        create: async () => ({
          rawId: new Uint8Array([1, 2, 3]).buffer,
          getClientExtensionResults: () => ({ prf: { enabled: false } }),
        }),
        get: vi.fn(),
      },
    })
    render(() => (
      <MailboxEnrollment
        userId={TEST_USER_ID}
        emailAddress="a@example.com"
        checkPassphraseFn={floorOk}
      />
    ))
    await reachPasswordStep()
    await acceptPassword()
    await waitFor(() => expect(screen.getByTestId("mailbox-enrollment.use-passkey")).toBeTruthy())
    fireEvent.click(screen.getByTestId("mailbox-enrollment.use-passkey"))

    const notice = await screen.findByTestId("mailbox-enrollment.passkey-unavailable")
    expect(notice.textContent).toMatch(/PRF/)
    expect(mocks.api.post).not.toHaveBeenCalled()
    // Continuing without it enrolls the password alone.
    fireEvent.click(screen.getByTestId("mailbox-enrollment.skip-passkey"))
    await waitFor(() => expect(mocks.api.post).toHaveBeenCalledTimes(1))
    const [, body] = mocks.api.post.mock.calls[0] as [string, { wraps: { wrapType: string }[] }]
    expect(body.wraps.map((wrap) => wrap.wrapType)).toEqual(["passphrase"])
    vi.unstubAllGlobals()
  })

  it("refuses a short password such as 1234", async () => {
    render(() => <MailboxEnrollment userId={TEST_USER_ID} emailAddress="a@example.com" />)
    await reachPasswordStep()
    await acceptPassword("1234")

    // The password wraps the key a stolen session or a database copy can try
    // offline: a guessable one is refused before anything is minted.
    await screen.findByTestId("mailbox-enrollment.passphrase-refusal")
    expect(screen.queryByTestId("mailbox-enrollment.skip-passkey")).toBeNull()
    expect(mocks.api.post).not.toHaveBeenCalled()
  })

  it("refuses a common password even when it is long enough", async () => {
    render(() => <MailboxEnrollment userId={TEST_USER_ID} emailAddress="a@example.com" />)
    await reachPasswordStep()
    await acceptPassword("Password-1234!")
    await screen.findByTestId("mailbox-enrollment.passphrase-refusal")
    expect(mocks.api.post).not.toHaveBeenCalled()
  })

  it("refuses an empty password, and says so", async () => {
    render(() => <MailboxEnrollment userId={TEST_USER_ID} emailAddress="a@example.com" />)
    await reachPasswordStep()
    await acceptPassword("")

    const refusal = await screen.findByTestId("mailbox-enrollment.passphrase-refusal")
    expect(refusal.textContent).toContain("Type a mailbox password.")
    expect(mocks.api.post).not.toHaveBeenCalled()
  })

  it("short circuits to the existing keyring when the user already has one", async () => {
    mocks.api.get.mockImplementation(async () => ({
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
          id: "w0",
          type: "passphrase",
          label: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          lastUsedAt: null,
        },
        {
          // A legacy row: it stays in the database but is never listed.
          id: "w1",
          type: "recovery_phrase",
          label: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          lastUsedAt: null,
        },
      ],
    }))
    render(() => <MailboxEnrollment userId={TEST_USER_ID} emailAddress="a@example.com" />)
    const existing = await screen.findByTestId("mailbox-enrollment.existing-keyring")
    expect(existing.textContent).toContain("Mailbox password")
    expect(existing.textContent).not.toMatch(/recovery/i)
    expect(screen.queryByTestId("mailbox-enrollment.passphrase")).toBeNull()
  })

  it("uses no dash punctuation anywhere in the wizard", async () => {
    const { container } = render(() => (
      <MailboxEnrollment userId={TEST_USER_ID} emailAddress="a@example.com" />
    ))
    await waitFor(() => expect(screen.getByTestId("mailbox-enrollment.passphrase")).toBeTruthy())
    const text = container.textContent ?? ""
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toMatch(/[–—]/)
    expect(text).not.toMatch(/ -- /)
  })
  it("ends setup with the mailbox open, unlocked with the password just chosen", async () => {
    const password = "copper lantern orbit meadow 1987"
    mocks.client = { endMinting: vi.fn() }
    mocks.api.post.mockResolvedValue({
      identityId: "id-1",
      keyId: 1,
      identities: [],
      wraps: [
        {
          id: "wrap-pw",
          type: "passphrase",
          label: "Mailbox password",
          createdAt: "2026-09-29T00:00:00.000Z",
          lastUsedAt: null,
        },
      ],
    })
    mocks.unlock.mockImplementation(async () => {
      mocks.order.push("unlock")
      return true
    })
    const onEnrolled = vi.fn(() => mocks.order.push("enrolled"))
    render(() => (
      <MailboxEnrollment
        userId={TEST_USER_ID}
        emailAddress="a@example.com"
        checkPassphraseFn={floorOk}
        onEnrolled={onEnrolled}
      />
    ))
    await reachPasswordStep()
    await acceptPassword(password)
    fireEvent.click(await screen.findByTestId("mailbox-enrollment.skip-passkey"))

    await waitFor(() => expect(onEnrolled).toHaveBeenCalled())
    expect(mocks.unlock).toHaveBeenCalledTimes(1)
    const [, attempt] = mocks.unlock.mock.calls[0] as [
      unknown,
      { userId: string; wrap: { id: string }; secret: string },
    ]
    expect(attempt).toMatchObject({ userId: TEST_USER_ID, secret: password })
    expect(attempt.wrap.id).toBe("wrap-pw")
    // Open BEFORE the handoff, so nothing downstream sees a locked mailbox.
    expect(mocks.order).toEqual(["unlock", "enrolled"])
  })

  it("skips the passkey offer entirely where passkeys cannot work", async () => {
    mocks.passkeysUsable = false
    const onEnrolled = vi.fn()
    render(() => (
      <MailboxEnrollment
        userId={TEST_USER_ID}
        emailAddress="a@example.com"
        checkPassphraseFn={floorOk}
        onEnrolled={onEnrolled}
      />
    ))
    await reachPasswordStep()
    await acceptPassword()
    await waitFor(() => expect(onEnrolled).toHaveBeenCalled())
    expect(mocks.api.post).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("mailbox-enrollment.skip-passkey")).toBeNull()
    expect(screen.queryByTestId("mailbox-enrollment.use-passkey")).toBeNull()
  })

  it("says so when this browser cannot make the mailbox keys, instead of doing nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const generate = vi
      .spyOn(crypto.subtle, "generateKey")
      .mockRejectedValue(new DOMException("Ed25519 is not supported", "NotSupportedError"))
    try {
      render(() => (
        <MailboxEnrollment
          userId={TEST_USER_ID}
          emailAddress="a@example.com"
          checkPassphraseFn={floorOk}
        />
      ))
      await reachPasswordStep()
      await acceptPassword()
      const refusal = await screen.findByTestId("mailbox-enrollment.passphrase-refusal")
      expect(refusal.textContent).toContain("cannot set up your mail here")
      expect(mocks.api.post).not.toHaveBeenCalled()
    } finally {
      generate.mockRestore()
    }
  })

  it("submits on Enter and is a form a password manager understands", async () => {
    mocks.api.get.mockImplementation(async (path: string) => {
      if (path === "/mailbox-keys/me") {
        return { identityId: null, keyId: null, identities: [], wraps: [] }
      }
      if (path === "/users/me") return { email: "owner@example.com" }
      throw new Error(`unexpected path ${path}`)
    })
    render(() => (
      <MailboxEnrollment userId={TEST_USER_ID} emailAddress="" checkPassphraseFn={floorOk} />
    ))
    await reachPasswordStep()
    const field = screen.getByTestId("mailbox-enrollment.passphrase")
    expect(field.getAttribute("autocomplete")).toBe("new-password")
    expect(
      screen.getByTestId("mailbox-enrollment.passphrase-confirm").getAttribute("autocomplete"),
    ).toBe("new-password")
    // The real address, not an empty string, names what the password is for.
    await waitFor(() =>
      expect((screen.getByTestId("mailbox-enrollment.username") as HTMLInputElement).value).toBe(
        "mailbox:owner@example.com",
      ),
    )
    expect(screen.getByTestId("mailbox-enrollment.username").getAttribute("autocomplete")).toBe(
      "username",
    )
    fireEvent.input(field, { target: { value: "copper lantern orbit meadow 1987" } })
    fireEvent.input(screen.getByTestId("mailbox-enrollment.passphrase-confirm"), {
      target: { value: "copper lantern orbit meadow 1987" },
    })
    fireEvent.submit(screen.getByTestId("mailbox-enrollment.password-step"))
    await screen.findByTestId("mailbox-enrollment.skip-passkey")
  })
})
