// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-WEB-1 and T-WEB-2, and the unlock surface without a recovery phrase. They
// drive the real crypto: a real enrollment fixture, a real wrap, the real worker
// protocol, and then a real message opened and rendered. Nothing about the
// unseal is mocked.
//
// Pinned here:
//   * the mailbox password unlocks, and a sealed message then opens,
//   * no recovery phrase is offered, even for a keyring that still carries one,
//   * the passkey is offered first only on the computer it last worked on,
//   * a keyring with no mailbox password (passkey plus a legacy phrase) is
//     asked to set one after a passkey unlock, and the password is minted from
//     that session,
//   * "Forgot your mailbox password? Reset the mailbox" is always there, says
//     what is lost, needs an emailed code, and calls the reset endpoint.

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import { createMailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"
import { devicePasskeyWrapId, rememberDevicePasskey } from "~/modules/mailbox/device-state"
import { loadWrappedKeyring, saveWrappedKeyring } from "~/modules/mailbox/keyring-storage"
import { MailboxUnlock } from "~/modules/mailbox/MailboxUnlock"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealMessageFixture,
  TEST_USER_ID,
  type TestEnrollment,
} from "~/modules/mailbox/mailbox-fixtures"
import {
  mailboxStore,
  openSealedMessage,
  resetMailboxStore,
  setMailboxCryptoClient,
} from "~/modules/mailbox/mailbox-store"

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  startWorker: vi.fn(async () => null as unknown),
  passkeysUsable: true,
}))
vi.mock("~/modules/mailbox/passkey-availability", () => ({
  passkeysUsableHere: async () => mocks.passkeysUsable,
}))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/mailbox/crypto-worker-boot", () => ({
  startMailboxCryptoWorker: mocks.startWorker,
}))

type WrapKind = "passphrase" | "recovery_phrase" | "passkey_prf"

const WRAP_IDS: Record<WrapKind, string> = {
  passphrase: "wrap-passphrase",
  recovery_phrase: "wrap-recovery",
  passkey_prf: "wrap-passkey",
}

const floorOk = async () => ({ ok: true as const, reasons: [] })

function wireApi(enrollment: TestEnrollment, wraps: WrapKind[]) {
  mocks.api.get.mockImplementation(async (path: string) => {
    if (path === "/mailbox-keys/me") {
      return {
        identityId: "identity-1",
        keyId: enrollment.entry.keyId,
        identities: [
          {
            id: "identity-1",
            keyId: enrollment.entry.keyId,
            status: "active",
            ecdhPublicKey: enrollment.keyring[0].ecdhSpki,
            signPublicKey: enrollment.keyring[0].signSpki,
            attestation: "",
            createdAt: "2026-08-01T00:00:00.000Z",
            retiredAt: null,
          },
        ],
        wraps: wraps.map((type) => ({
          id: WRAP_IDS[type],
          type,
          label: null,
          createdAt: "2026-08-01T00:00:00.000Z",
          lastUsedAt: null,
        })),
      }
    }
    if (path.endsWith("/wrap-passphrase/blob")) {
      return {
        wrappedAccountKey: enrollment.passphraseWrap.wrappedAccountKey,
        kdfParams: enrollment.passphraseWrap.kdfParams,
      }
    }
    if (path.endsWith("/wrap-passkey/blob")) {
      return {
        wrappedAccountKey: enrollment.passkeyWrap?.wrappedAccountKey,
        kdfParams: enrollment.passkeyWrap?.kdfParams,
      }
    }
    throw new Error(`unexpected path ${path}`)
  })
}

function inProcessClient() {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  return createMailboxCryptoClient({ post: (request) => handleWorkerRequest(session, request) })
}

/** An authenticator on this device that returns `prf` for any wrap. */
function stubAuthenticator(prf: Uint8Array, withCreate = false) {
  vi.stubGlobal("navigator", {
    credentials: {
      get: async () => ({
        rawId: new Uint8Array([1, 2, 3, 4]).buffer,
        getClientExtensionResults: () => ({ prf: { results: { first: prf.slice().buffer } } }),
      }),
      ...(withCreate ? { create: vi.fn() } : {}),
    },
  })
}

const PASSWORD = "correct horse battery staple 42"

describe("MailboxUnlock", () => {
  beforeEach(() => {
    resetMailboxStore()
    mocks.api.get.mockReset()
    mocks.api.post.mockReset()
    mocks.startWorker.mockReset()
    mocks.startWorker.mockResolvedValue(null)
    mocks.passkeysUsable = true
    localStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("T-WEB-1 unlocks with the mailbox password and then opens a sealed message", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    const onUnlocked = vi.fn()

    render(() => <MailboxUnlock userId={TEST_USER_ID} onUnlocked={onUnlocked} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))

    await waitFor(() => expect(mailboxStore.status).toBe("unlocked"))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled())

    const sealed = await sealMessageFixture(enrollment, {
      id: "66666666-6666-4666-8666-666666666666",
      subject: "Readable again",
      textBody: "The body the reader sees.",
      htmlBody: "<p>The body the reader sees.</p>",
    })
    const opened = await openSealedMessage(sealed)
    expect(opened?.subject).toBe("Readable again")
    expect(opened?.textBody).toBe("The body the reader sees.")
  })

  // A member without mail access is refused the keyring (403). That is not a
  // connection problem, and saying "Liaison could not be reached" sent the
  // walk's member looking for a network fault (walk 2026-10-19, #18).
  it("says a refused keyring is a missing permission, never an unreachable server", async () => {
    mocks.api.get.mockImplementation(async () => {
      throw new ApiError("Permission denied", 403, "FORBIDDEN")
    })
    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    expect(await screen.findByTestId("mailbox-unlock.no-access")).toHaveTextContent(
      "You do not have access to mail",
    )
    expect(screen.queryByText(/could not be reached/)).toBeNull()
  })

  it("offers no recovery phrase, even for a keyring that still carries one", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase", "recovery_phrase"])
    setMailboxCryptoClient(inProcessClient())

    const { container } = render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    // Non-vacuity: the keyring (with its legacy row) has really arrived.
    await waitFor(() => expect(mailboxStore.keyring?.wraps.length).toBe(2))
    expect(screen.getByTestId("mailbox-unlock.method-passphrase").textContent).toBe(
      "Mailbox password",
    )
    expect(screen.queryByTestId("mailbox-unlock.method-recovery_phrase")).toBeNull()
    expect(container.textContent).not.toMatch(/recovery|12 word/i)
  })

  it("T-WEB-2 a wrong password is a refusal, not corruption, and the reset is offered", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), {
      target: { value: "the wrong password entirely" },
    })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))

    const message = await screen.findByTestId("mailbox-unlock.refusal")
    expect(message.textContent).toBeTruthy()
    expect(message.textContent).not.toMatch(/corrupt|damaged|lost|data loss/i)
    expect(message.getAttribute("data-failure")).toBe("refused")
    // After a wrong password the reset is a real button, and the small link
    // below it goes: the popup offers the reset once, not twice.
    expect(screen.queryByTestId("mailbox-unlock.reset")).toBeNull()
    const offer = screen.getByTestId("mailbox-unlock.reset-offer")
    expect(offer.textContent).toBe("Forgot it? Reset the mailbox")
    fireEvent.click(offer)
    await screen.findByTestId("mailbox-unlock.reset-confirm")
  })

  it("tells a native app user with a legacy password row to unlock once on a computer", async () => {
    // The native build carries no legacy KDF, so its worker answers this code
    // for an Argon2id row (crypto-session.test.ts drives that end to end).
    const enrollment = await buildEnrollment({ passphrase: PASSWORD, legacyPassphrase: true })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    // A passkey is on file, so the copy may point at it.
    wireApi(enrollment, ["passphrase", "passkey_prf"])
    setMailboxCryptoClient(
      createMailboxCryptoClient({
        post: async (request) =>
          request.op === "unlock"
            ? {
                id: request.id,
                ok: false,
                code: "MAILBOX_PASSWORD_FORMAT_UNSUPPORTED",
                message: "",
              }
            : { id: request.id, ok: true, value: { unlocked: false } },
      }),
    )

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))

    const message = await screen.findByTestId("mailbox-unlock.refusal")
    expect(message.textContent).toMatch(/older format/)
    expect(message.textContent).toMatch(/on your computer/)
    expect(message.textContent).toMatch(/passkey/)
    expect(message.textContent).not.toMatch(/Check your mailbox password/)
  })

  it("does not point at a passkey for a legacy password row when none is on file", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD, legacyPassphrase: true })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(
      createMailboxCryptoClient({
        post: async (request) =>
          request.op === "unlock"
            ? {
                id: request.id,
                ok: false,
                code: "MAILBOX_PASSWORD_FORMAT_UNSUPPORTED",
                message: "",
              }
            : { id: request.id, ok: true, value: { unlocked: false } },
      }),
    )
    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    const message = await screen.findByTestId("mailbox-unlock.refusal")
    expect(message.getAttribute("data-failure")).toBe("password-format-unsupported-no-passkey")
    expect(message.textContent).toMatch(/older format/)
    expect(message.textContent).not.toMatch(/passkey/)
  })

  it("unlocks with the newest password row when a legacy one lingers beside it", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    const wired = mocks.api.get.getMockImplementation()
    mocks.api.get.mockImplementation(async (path: string) => {
      const answer = await wired?.(path)
      if (path !== "/mailbox-keys/me") return answer
      return {
        ...answer,
        wraps: [
          {
            id: "wrap-legacy",
            type: "passphrase",
            label: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            lastUsedAt: null,
          },
          ...answer.wraps,
        ],
      }
    })
    setMailboxCryptoClient(inProcessClient())

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(mailboxStore.keyring?.wraps.length).toBe(2))
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))

    await waitFor(() => expect(mailboxStore.status).toBe("unlocked"))
    const blobPaths = mocks.api.get.mock.calls
      .map(([path]) => path as string)
      .filter((path) => path.endsWith("/blob"))
    expect(blobPaths).toEqual(["/mailbox-keys/wraps/wrap-passphrase/blob"])
  })

  it("offers this computer's passkey first and names the device when its PRF does not match", async () => {
    const prfSecret = new Uint8Array(32).fill(5) as Uint8Array<ArrayBuffer>
    const credentialId = new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>
    const enrollment = await buildEnrollment({
      passphrase: PASSWORD,
      withPasskey: { prfSecret, credentialId },
    })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passkey_prf", "passphrase"])
    rememberDevicePasskey(TEST_USER_ID, "wrap-passkey")
    setMailboxCryptoClient(inProcessClient())
    // A device whose authenticator returns a DIFFERENT PRF output.
    stubAuthenticator(new Uint8Array(32).fill(6))

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() =>
      expect(
        screen.getByTestId("mailbox-unlock.method-passkey_prf").getAttribute("aria-pressed"),
      ).toBe("true"),
    )
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))

    const message = await screen.findByTestId("mailbox-unlock.refusal")
    expect(message.getAttribute("data-failure")).toBe("device-prf-mismatch")
    expect(message.textContent).not.toMatch(/corrupt|damaged|lost/i)
    // It stops being offered first here.
    expect(devicePasskeyWrapId(TEST_USER_ID)).toBeNull()
  })

  it("defaults to the mailbox password on a computer where no passkey has worked", async () => {
    const enrollment = await buildEnrollment({
      passphrase: PASSWORD,
      withPasskey: {
        prfSecret: new Uint8Array(32).fill(5) as Uint8Array<ArrayBuffer>,
        credentialId: new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>,
      },
    })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passkey_prf", "passphrase"])
    setMailboxCryptoClient(inProcessClient())

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    // The keyring first: before it lands, the password is the only chip anyway.
    await waitFor(() => expect(mailboxStore.keyring?.wraps.length).toBe(2))
    await waitFor(() =>
      expect(
        screen.getByTestId("mailbox-unlock.method-passphrase").getAttribute("aria-pressed"),
      ).toBe("true"),
    )
    // Non-vacuity: a passkey is on file, it is just not first here.
    expect(screen.getByTestId("mailbox-unlock.method-passkey_prf")).toBeTruthy()
    expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy()
  })

  it("asks a keyring with no mailbox password to set one after a passkey unlock", async () => {
    const prfSecret = new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>
    const enrollment = await buildEnrollment({
      passphrase: PASSWORD,
      withPasskey: { prfSecret, credentialId: new Uint8Array([9, 9]) as Uint8Array<ArrayBuffer> },
    })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    // Enrolled before the phrase was retired: a passkey and a phrase, no password.
    wireApi(enrollment, ["passkey_prf", "recovery_phrase"])
    setMailboxCryptoClient(inProcessClient())
    stubAuthenticator(prfSecret)
    mocks.api.post.mockImplementation(async (path: string, body: { wrapType: string }) => ({
      id: "wrap-new-password",
      type: body.wrapType,
      label: "Mailbox password",
      createdAt: "2026-09-24T00:00:00.000Z",
      lastUsedAt: null,
      path,
    }))
    const onUnlocked = vi.fn()

    render(() => (
      <MailboxUnlock userId={TEST_USER_ID} onUnlocked={onUnlocked} checkPassphraseFn={floorOk} />
    ))
    await waitFor(() =>
      expect(screen.getByTestId("mailbox-unlock.method-passkey_prf")).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))

    await screen.findByTestId("mailbox-unlock.set-password")
    // Unlocked already, but the prompt holds the "done" until it is answered.
    expect(mailboxStore.status).toBe("unlocked")
    expect(onUnlocked).not.toHaveBeenCalled()
    fireEvent.input(screen.getByTestId("mailbox-unlock.new-password"), {
      target: { value: "a brand new mailbox password 7" },
    })
    fireEvent.input(screen.getByTestId("mailbox-unlock.new-password-again"), {
      target: { value: "a brand new mailbox password 7" },
    })
    fireEvent.click(screen.getByTestId("mailbox-unlock.save-password"))

    await waitFor(() => expect(onUnlocked).toHaveBeenCalled())
    const [path, body] = mocks.api.post.mock.calls[0] as [
      string,
      { wrapType: string; wrappedAccountKey: string },
    ]
    expect(path).toBe("/mailbox-keys/wraps")
    expect(body.wrapType).toBe("passphrase")
    expect(body.wrappedAccountKey.length).toBeGreaterThan(0)
  })

  it("offers to add this computer's passkey after a password unlock, and remembers a no", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    stubAuthenticator(new Uint8Array(32), true)
    const onUnlocked = vi.fn()

    render(() => <MailboxUnlock userId={TEST_USER_ID} onUnlocked={onUnlocked} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))

    await screen.findByTestId("mailbox-unlock.offer-passkey")
    fireEvent.click(screen.getByTestId("mailbox-unlock.decline-passkey"))
    expect(onUnlocked).toHaveBeenCalled()
    expect(localStorage.getItem(`liaison.mailbox.passkey-declined.${TEST_USER_ID}`)).toBe("1")
  })

  it("resets the mailbox after an emailed code, says what is lost, and clears this device", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    mocks.api.post.mockImplementation(async (path: string) => {
      if (path === "/mailbox-keys/reset") {
        // The server's keyring is gone from here on.
        mocks.api.get.mockImplementation(async () => ({
          identityId: null,
          keyId: null,
          identities: [],
          wraps: [],
        }))
        return { accountIds: ["acc-1"] }
      }
      return { sent: true }
    })

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    fireEvent.click(await screen.findByTestId("mailbox-unlock.reset"))

    const consequences = await screen.findByTestId("mailbox-unlock.reset-consequences")
    expect(consequences.textContent).toMatch(/downloads again from Gmail/)
    expect(consequences.textContent).toMatch(/Drafts written in Liaison/)
    expect(consequences.textContent).toMatch(/waiting for your approval/)
    expect(consequences.textContent).toMatch(/every other (computer|device)/)
    // Nothing happens before the confirmation code.
    expect(mocks.api.post).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("mailbox-unlock.reset-send-code"))
    await waitFor(() =>
      expect(mocks.api.post).toHaveBeenCalledWith("/auth/totp/step-up", {
        purpose: "mailbox_reset",
      }),
    )
    fireEvent.input(await screen.findByTestId("mailbox-unlock.reset-code"), {
      target: { value: "123456" },
    })
    fireEvent.click(screen.getByTestId("mailbox-unlock.reset-confirm-button"))

    await waitFor(() =>
      expect(mocks.api.post).toHaveBeenCalledWith("/mailbox-keys/reset", { stepUpCode: "123456" }),
    )
    // The device's cached keys wrap keys that no longer exist.
    await screen.findByTestId("mailbox-unlock.setup")
    expect(loadWrappedKeyring(TEST_USER_ID)).toEqual([])
    // And the user sets up the new mailbox password straight away, on the
    // same screen: no "nothing on file" dead end.
    expect(await screen.findByTestId("mailbox-enrollment.passphrase")).toBeTruthy()
    expect(screen.queryByTestId("mailbox-unlock.method-unavailable")).toBeNull()
  })

  it("does not greet the user with a refusal left behind by a locked message", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    // Rendering a sealed row while locked records MAILBOX_LOCKED in the store.
    const sealed = await sealMessageFixture(enrollment, {
      id: "77777777-7777-4777-8777-777777777777",
      subject: "s",
      textBody: "b",
      htmlBody: "<p>b</p>",
    })
    expect(await openSealedMessage(sealed)).toBeNull()
    expect(mailboxStore.lastErrorCode, "non-vacuity: the store holds a code").toBe("MAILBOX_LOCKED")

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    expect(screen.queryByTestId("mailbox-unlock.refusal")).toBeNull()
  })

  it("starts the crypto worker once when it is missing, and says to reload if it cannot", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(null)

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))

    const refusal = await screen.findByTestId("mailbox-unlock.refusal")
    expect(refusal.getAttribute("data-failure")).toBe("worker-missing")
    expect(refusal.textContent).toMatch(/Reload the page/)
    expect(mocks.startWorker).toHaveBeenCalledTimes(1)
  })

  it("unlocks after starting a missing crypto worker", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(null)
    mocks.startWorker.mockImplementation(async () => {
      const client = inProcessClient()
      setMailboxCryptoClient(client)
      return client
    })

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    await waitFor(() => expect(mailboxStore.status).toBe("unlocked"))
  })

  it("says so when the server rate limits the unlock", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    const wired = mocks.api.get.getMockImplementation()
    mocks.api.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/blob")) throw new ApiError("Too many unlock attempts", 429)
      return wired?.(path)
    })
    setMailboxCryptoClient(inProcessClient())

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    const refusal = await screen.findByTestId("mailbox-unlock.refusal")
    expect(refusal.getAttribute("data-failure")).toBe("rate-limited")
  })

  it("tells a cancelled passkey prompt apart from a browser without PRF", async () => {
    const prfSecret = new Uint8Array(32).fill(5) as Uint8Array<ArrayBuffer>
    const enrollment = await buildEnrollment({
      passphrase: PASSWORD,
      withPasskey: { prfSecret, credentialId: new Uint8Array([1, 2]) as Uint8Array<ArrayBuffer> },
    })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passkey_prf", "passphrase"])
    rememberDevicePasskey(TEST_USER_ID, "wrap-passkey")
    setMailboxCryptoClient(inProcessClient())

    vi.stubGlobal("navigator", {
      credentials: {
        get: async () => {
          // A person looking at the prompt, then pressing Cancel.
          await new Promise((resolve) => setTimeout(resolve, 1_100))
          throw new DOMException(
            "The operation either timed out or was not allowed.",
            "NotAllowedError",
          )
        },
      },
    })
    const first = render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() =>
      expect(
        screen.getByTestId("mailbox-unlock.method-passkey_prf").getAttribute("aria-pressed"),
      ).toBe("true"),
    )
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    const cancelled = await screen.findByTestId("mailbox-unlock.refusal", {}, { timeout: 5_000 })
    expect(cancelled.getAttribute("data-failure")).toBe("passkey-cancelled")
    first.unmount()

    // The same error with no prompt ever shown (a webview that will not run
    // the ceremony) is not the user cancelling.
    vi.stubGlobal("navigator", {
      credentials: {
        get: async () => {
          throw new DOMException(
            "The operation either timed out or was not allowed.",
            "NotAllowedError",
          )
        },
      },
    })
    const instant = render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() =>
      expect(
        screen.getByTestId("mailbox-unlock.method-passkey_prf").getAttribute("aria-pressed"),
      ).toBe("true"),
    )
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    const refused = await screen.findByTestId("mailbox-unlock.refusal")
    expect(refused.getAttribute("data-failure")).toBe("passkey-unsupported")
    expect(refused.textContent).not.toMatch(/cancelled/)
    instant.unmount()

    // An authenticator that answers but returns no PRF output (no PRF support).
    vi.stubGlobal("navigator", {
      credentials: {
        get: async () => ({
          rawId: new Uint8Array([1, 2]).buffer,
          getClientExtensionResults: () => ({}),
        }),
      },
    })
    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() =>
      expect(
        screen.getByTestId("mailbox-unlock.method-passkey_prf").getAttribute("aria-pressed"),
      ).toBe("true"),
    )
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    const noPrf = await screen.findByTestId("mailbox-unlock.refusal")
    expect(noPrf.getAttribute("data-failure")).toBe("passkey-no-prf")
    expect(noPrf.textContent).toMatch(/mailbox password/)
  })

  it("names why a reset failed: wrong code, rate limit, network", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    const failures = [
      new ApiError("Invalid or expired step-up code", 422),
      new ApiError("Too many mailbox reset attempts", 429),
      new TypeError("Failed to fetch"),
    ]
    mocks.api.post.mockImplementation(async (path: string) => {
      if (path === "/mailbox-keys/reset") throw failures.shift()
      return { sent: true }
    })

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    fireEvent.click(await screen.findByTestId("mailbox-unlock.reset"))
    fireEvent.click(await screen.findByTestId("mailbox-unlock.reset-send-code"))
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      fireEvent.input(await screen.findByTestId("mailbox-unlock.reset-code"), {
        target: { value: "123456" },
      })
      fireEvent.click(screen.getByTestId("mailbox-unlock.reset-confirm-button"))
      await waitFor(() => {
        const text = screen.getByTestId("mailbox-unlock.step-error").textContent ?? ""
        expect(seen).not.toContain(text)
        seen.push(text)
      })
    }
    expect(seen[0]).toMatch(/wrong or has expired/)
    expect(seen[1]).toMatch(/Too many reset attempts/)
    expect(seen[2]).toMatch(/could not be reached/)
  })
  it("says the password was not checked when the unlock could not run here", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    // The worker's own internal failure: a WebAssembly compile a policy
    // refused, memory, anything that is not a verdict on the password.
    setMailboxCryptoClient(
      createMailboxCryptoClient({
        post: async (request) =>
          request.op === "unlock"
            ? { id: request.id, ok: false, code: "MAILBOX_INTERNAL", message: "" }
            : { id: request.id, ok: true, value: { unlocked: false } },
      }),
    )
    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    const message = await screen.findByTestId("mailbox-unlock.refusal")
    expect(message.getAttribute("data-failure")).toBe("runtime-failed")
    expect(message.textContent).toContain("Your password was not checked")
    // Not a wrong password, so no push towards a reset.
    expect(screen.queryByTestId("mailbox-unlock.reset-offer")).toBeNull()
  })

  it("names a reset made on another device before and after a refused password", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    // This device cached the keyring from before the reset.
    const old = await buildEnrollment({ passphrase: "the old password 1" })
    saveWrappedKeyring(TEST_USER_ID, old.keyring)
    wireApi(enrollment, ["passphrase"])
    // A server that carries the wrapped private halves, as it does today.
    const wired = mocks.api.get.getMockImplementation()
    mocks.api.get.mockImplementation(async (path: string) => {
      const answer = await wired?.(path)
      if (path !== "/mailbox-keys/me") return answer
      const entry = enrollment.keyring[0]
      return {
        ...answer,
        identities: answer.identities.map((row: Record<string, unknown>) => ({
          ...row,
          wrappedEcdhPrivate: entry.wrappedEcdhPrivate,
          wrappedSignPrivate: entry.wrappedSignPrivate,
          ecdhWrapIv: entry.ecdhWrapIv,
          signWrapIv: entry.signWrapIv,
        })),
      }
    })
    setMailboxCryptoClient(inProcessClient())

    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    const upfront = await screen.findByTestId("mailbox-unlock.reset-elsewhere")
    expect(upfront.textContent).toContain("reset on another device")
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), {
      target: { value: "the old password 1" },
    })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    const message = await screen.findByTestId("mailbox-unlock.refusal")
    expect(message.getAttribute("data-failure")).toBe("reset-elsewhere")
    expect(message.textContent).toContain("new mailbox password you chose there")
  })

  it("says the connection failed when the keys cannot be listed, not to retype the password", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    // Nothing cached on this device.
    wireApi(enrollment, ["passphrase"])
    const wired = mocks.api.get.getMockImplementation()
    let listings = 0
    mocks.api.get.mockImplementation(async (path: string) => {
      if (path === "/mailbox-keys/me" && ++listings > 1) throw new TypeError("Failed to fetch")
      return wired?.(path)
    })
    setMailboxCryptoClient(inProcessClient())
    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    const message = await screen.findByTestId("mailbox-unlock.refusal")
    expect(message.getAttribute("data-failure")).toBe("network")
  })

  it("closes itself when the mailbox opens while it is on screen", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    const onUnlocked = vi.fn()
    render(() => <MailboxUnlock userId={TEST_USER_ID} onUnlocked={onUnlocked} />)
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    expect(onUnlocked).not.toHaveBeenCalled()
    // Something else opened it (the startup restore finishing, say).
    const passwordRow = mailboxStore.keyring?.wraps[0]
    expect(passwordRow).toBeTruthy()
    const { unlockMailbox } = await import("~/modules/mailbox/mailbox-store")
    await unlockMailbox(mocks.api, {
      userId: TEST_USER_ID,
      wrap: passwordRow as never,
      secret: PASSWORD,
    })
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled())
  })

  it("offers no passkey anywhere where passkeys cannot work", async () => {
    mocks.passkeysUsable = false
    const enrollment = await buildEnrollment({
      passphrase: PASSWORD,
      withPasskey: {
        prfSecret: new Uint8Array(32).fill(5) as Uint8Array<ArrayBuffer>,
        credentialId: new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>,
      },
    })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passkey_prf", "passphrase"])
    rememberDevicePasskey(TEST_USER_ID, "wrap-passkey")
    setMailboxCryptoClient(inProcessClient())
    stubAuthenticator(new Uint8Array(32), true)
    const onUnlocked = vi.fn()

    render(() => <MailboxUnlock userId={TEST_USER_ID} onUnlocked={onUnlocked} />)
    await waitFor(() => expect(mailboxStore.keyring?.wraps.length).toBe(2))
    await waitFor(() => expect(screen.getByTestId("mailbox-unlock.secret")).toBeTruthy())
    expect(screen.queryByTestId("mailbox-unlock.method-passkey_prf")).toBeNull()
    fireEvent.input(screen.getByTestId("mailbox-unlock.secret"), { target: { value: PASSWORD } })
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    // Straight through: no "add a passkey on this device" offer.
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled())
    expect(screen.queryByTestId("mailbox-unlock.offer-passkey")).toBeNull()
  })

  it("shows the setup in place of the unlock when nothing is enrolled", async () => {
    mocks.api.get.mockImplementation(async (path: string) => {
      if (path === "/mailbox-keys/me") {
        return { identityId: null, keyId: null, identities: [], wraps: [] }
      }
      throw new Error(`unexpected path ${path}`)
    })
    setMailboxCryptoClient(inProcessClient())
    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    await screen.findByTestId("mailbox-unlock.setup")
    expect(await screen.findByTestId("mailbox-enrollment.passphrase")).toBeTruthy()
    expect(screen.queryByTestId("mailbox-unlock.method-unavailable")).toBeNull()
    expect(screen.queryByTestId("mailbox-unlock.submit")).toBeNull()
  })

  it("submits on Enter, with the fields a password manager fills", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    render(() => <MailboxUnlock userId={TEST_USER_ID} />)
    const field = await screen.findByTestId("mailbox-unlock.secret")
    expect(field.getAttribute("autocomplete")).toBe("current-password")
    expect(screen.getByTestId("mailbox-unlock.username").getAttribute("autocomplete")).toBe(
      "username",
    )
    fireEvent.input(field, { target: { value: PASSWORD } })
    fireEvent.submit(screen.getByTestId("mailbox-unlock.form"))
    await waitFor(() => expect(mailboxStore.status).toBe("unlocked"))
  })

  it("says it is still working when an unlock takes long", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const enrollment = await buildEnrollment({ passphrase: PASSWORD })
      saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
      wireApi(enrollment, ["passphrase"])
      setMailboxCryptoClient(
        createMailboxCryptoClient({
          post: (request) =>
            request.op === "unlock"
              ? new Promise(() => {})
              : Promise.resolve({ id: request.id, ok: true, value: { unlocked: false } }),
        }),
      )
      render(() => <MailboxUnlock userId={TEST_USER_ID} />)
      const field = await screen.findByTestId("mailbox-unlock.secret")
      fireEvent.input(field, { target: { value: PASSWORD } })
      fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
      await vi.advanceTimersByTimeAsync(5_000)
      expect(screen.queryByTestId("mailbox-unlock.still-working")).toBeNull()
      await vi.advanceTimersByTimeAsync(11_000)
      const line = await screen.findByTestId("mailbox-unlock.still-working")
      expect(line.textContent).toBe("Still working, this can take a few seconds")
    } finally {
      vi.useRealTimers()
    }
  })

  it("says why a new password could not be saved instead of doing nothing", async () => {
    const prfSecret = new Uint8Array(32).fill(7) as Uint8Array<ArrayBuffer>
    const enrollment = await buildEnrollment({
      passphrase: PASSWORD,
      withPasskey: { prfSecret, credentialId: new Uint8Array([9, 9]) as Uint8Array<ArrayBuffer> },
    })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passkey_prf", "recovery_phrase"])
    setMailboxCryptoClient(inProcessClient())
    stubAuthenticator(prfSecret)
    render(() => <MailboxUnlock userId={TEST_USER_ID} checkPassphraseFn={floorOk} />)
    await waitFor(() =>
      expect(screen.getByTestId("mailbox-unlock.method-passkey_prf")).toBeTruthy(),
    )
    fireEvent.click(screen.getByTestId("mailbox-unlock.submit"))
    await screen.findByTestId("mailbox-unlock.set-password")
    // The worker died between the unlock and the save.
    setMailboxCryptoClient(null)
    fireEvent.click(screen.getByTestId("mailbox-unlock.save-password"))
    const error = await screen.findByTestId("mailbox-unlock.step-error")
    expect(error.textContent?.length).toBeGreaterThan(0)
  })

  it("carries on into setup when this device's old state cannot be cleared after a reset", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    const client = inProcessClient()
    setMailboxCryptoClient({
      ...client,
      lock: async () => {
        throw new Error("the worker is gone")
      },
    })
    mocks.api.post.mockImplementation(async (path: string) => {
      if (path === "/mailbox-keys/reset") {
        mocks.api.get.mockImplementation(async (p: string) => {
          if (p === "/users/me") return { email: "owner@example.com" }
          return { identityId: null, keyId: null, identities: [], wraps: [] }
        })
        return { accountIds: ["acc-1"] }
      }
      return { sent: true }
    })
    const wired = mocks.api.get.getMockImplementation()
    mocks.api.get.mockImplementation(async (path: string) =>
      path === "/users/me" ? { email: "owner@example.com" } : wired?.(path),
    )

    render(() => <MailboxUnlock userId={TEST_USER_ID} initialView="reset" />)
    fireEvent.click(await screen.findByTestId("mailbox-unlock.reset-send-code"))
    await waitFor(() =>
      expect(screen.getByTestId("mailbox-unlock.reset-code-sent").textContent).toBe(
        "We sent a 6 digit code to owner@example.com.",
      ),
    )
    // A new code can be asked for from here.
    fireEvent.click(screen.getByTestId("mailbox-unlock.reset-resend"))
    await waitFor(() =>
      expect(
        mocks.api.post.mock.calls.filter(([path]) => path === "/auth/totp/step-up"),
      ).toHaveLength(2),
    )
    fireEvent.input(await screen.findByTestId("mailbox-unlock.reset-code"), {
      target: { value: "123456" },
    })
    fireEvent.click(screen.getByTestId("mailbox-unlock.reset-confirm-button"))
    await screen.findByTestId("mailbox-unlock.setup")
    setMailboxCryptoClient(null)
  })
  it("opens straight on the reset when asked, even over an unlocked mailbox", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    const { unlockMailbox, loadMailboxKeyring } = await import("~/modules/mailbox/mailbox-store")
    const keyring = await loadMailboxKeyring(mocks.api, TEST_USER_ID)
    await unlockMailbox(mocks.api, {
      userId: TEST_USER_ID,
      wrap: keyring.wraps[0] as never,
      secret: PASSWORD,
    })
    expect(mailboxStore.status, "non-vacuity: the mailbox is open").toBe("unlocked")
    const onUnlocked = vi.fn()
    const views: string[] = []

    render(() => (
      <MailboxUnlock
        userId={TEST_USER_ID}
        initialView="reset"
        onUnlocked={onUnlocked}
        onViewChange={(view) => views.push(view)}
      />
    ))
    await screen.findByTestId("mailbox-unlock.reset-confirm")
    // An open mailbox does not close the reset it was asked for.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onUnlocked).not.toHaveBeenCalled()
    expect(views[0]).toBe("reset-confirm")
    // Keeping the mailbox as it is leaves nothing to unlock: the screen closes.
    fireEvent.click(screen.getByTestId("mailbox-unlock.reset-cancel"))
    await waitFor(() => expect(onUnlocked).toHaveBeenCalled())
  })
})
