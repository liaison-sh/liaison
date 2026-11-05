// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The owner's clear of the downgrade alarm, driven through the real alarm, the
// real unlock path and the real crypto worker protocol over a real enrollment.
// The persisted alarm lives in a memory blob store in the exact format the
// detector writes, so "rehydrate shows nothing" is checked the way a reload
// would check it.
//
// Pinned here:
//   * a wrong mailbox password clears nothing: not the rendered alarm, not the
//     persisted record, and nothing is reported to the server,
//   * the right password clears the rendered alarm AND the persisted record,
//     and the audit endpoint is called with exactly the findings shown,
//   * when the server does not record the clear, nothing is cleared,
//   * a wrong password typed to confirm does not lock a mailbox that is open,
//   * a keyring with no mailbox password is confirmed with the passkey,
//   * the dialog lists the findings and says clearing undoes no exposure.

import { dictionariesFor, englishDictionaries } from "@liaison/shared"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createMailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"
import {
  currentDowngradeFindings,
  type DowngradeFinding,
  loadDowngradeAlarm,
  resetDowngradeAlarm,
} from "~/modules/mailbox/downgrade-detector"
import { saveWrappedKeyring } from "~/modules/mailbox/keyring-storage"
import { MailboxDowngradeAlarm } from "~/modules/mailbox/MailboxDowngradeAlarm"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  TEST_USER_ID,
  type TestEnrollment,
} from "~/modules/mailbox/mailbox-fixtures"
import {
  mailboxStore,
  resetMailboxStore,
  setMailboxCryptoClient,
  unlockMailbox,
} from "~/modules/mailbox/mailbox-store"
import {
  createMemoryIndexBlobStore,
  type IndexBlobStore,
} from "~/modules/mailbox/search-index/index-blob-store"

const mocks = vi.hoisted(() => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  startWorker: vi.fn(async () => null as unknown),
}))
vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => mocks.api }))
vi.mock("~/modules/mailbox/crypto-worker-boot", () => ({
  startMailboxCryptoWorker: mocks.startWorker,
}))

const PASSWORD = "correct horse battery staple 42"
const AUDIT_PATH = "/mailbox-keys/integrity-alarm-cleared"
const ALARM_KEY = `mailbox-alarm:${TEST_USER_ID}`
const PRF = new Uint8Array(32).fill(7)

const FINDINGS: DowngradeFinding[] = [
  {
    kind: "unopenable-seal",
    subject: "11111111-1111-4111-8111-111111111111",
    detectedAt: "2026-09-24T10:00:00.000Z",
  },
  {
    kind: "unopenable-seal",
    subject: "22222222-2222-4222-8222-222222222222",
    detectedAt: "2026-09-24T10:00:01.000Z",
  },
]

function wireApi(enrollment: TestEnrollment, wraps: Array<"passphrase" | "passkey_prf">) {
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
          id: type === "passphrase" ? "wrap-passphrase" : "wrap-passkey",
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

function stubAuthenticator(prf: Uint8Array) {
  vi.stubGlobal("navigator", {
    credentials: {
      get: async () => ({
        rawId: new Uint8Array([1, 2, 3, 4]).buffer,
        getClientExtensionResults: () => ({ prf: { results: { first: prf.slice().buffer } } }),
      }),
    },
  })
}

/** Persist the alarm exactly as the detector does, then rehydrate it. */
async function persistedAlarm(store: IndexBlobStore): Promise<void> {
  await store.put(ALARM_KEY, JSON.stringify({ version: 1, findings: FINDINGS }))
  await loadDowngradeAlarm(store, TEST_USER_ID)
}

async function rehydrated(store: IndexBlobStore): Promise<DowngradeFinding[]> {
  resetDowngradeAlarm()
  return loadDowngradeAlarm(store, TEST_USER_ID)
}

function auditCalls() {
  return mocks.api.post.mock.calls.filter(([path]) => path === AUDIT_PATH)
}

async function openClearDialog(): Promise<void> {
  fireEvent.click(await screen.findByTestId("mailbox-downgrade-alarm.clear"))
  await screen.findByTestId("mailbox-alarm-clear")
}

describe("MailboxAlarmClearDialog", () => {
  let store: IndexBlobStore

  beforeEach(async () => {
    resetMailboxStore()
    resetDowngradeAlarm()
    mocks.api.get.mockReset()
    mocks.api.post.mockReset()
    mocks.api.post.mockImplementation(async (path: string) =>
      path === AUDIT_PATH ? { recorded: true, clearedAt: "2026-09-25T09:00:00.000Z" } : undefined,
    )
    mocks.startWorker.mockReset()
    mocks.startWorker.mockResolvedValue(null)
    localStorage.clear()
    store = createMemoryIndexBlobStore()
    await persistedAlarm(store)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("a wrong mailbox password clears nothing and reports nothing", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())

    render(() => <MailboxDowngradeAlarm userId={TEST_USER_ID} store={() => store} />)
    await openClearDialog()
    fireEvent.input(await screen.findByTestId("mailbox-alarm-clear.password"), {
      target: { value: "not the mailbox password" },
    })
    fireEvent.click(screen.getByTestId("mailbox-alarm-clear.confirm"))

    const error = await screen.findByTestId("mailbox-alarm-clear.error")
    expect(error.textContent).toContain("The warning was not cleared")
    expect(screen.getByTestId("mailbox-downgrade-alarm")).toBeTruthy()
    expect(currentDowngradeFindings()).toHaveLength(2)
    expect(await store.get(ALARM_KEY)).not.toBeNull()
    expect(await rehydrated(store)).toHaveLength(2)
    expect(auditCalls()).toHaveLength(0)
  })

  it("a wrong password typed to confirm does not lock an open mailbox", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    const wrap = {
      id: "wrap-passphrase",
      type: "passphrase" as const,
      label: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastUsedAt: null,
    }
    expect(await unlockMailbox(mocks.api, { userId: TEST_USER_ID, wrap, secret: PASSWORD })).toBe(
      true,
    )
    expect(mailboxStore.status).toBe("unlocked")

    render(() => <MailboxDowngradeAlarm userId={TEST_USER_ID} store={() => store} />)
    await openClearDialog()
    fireEvent.input(await screen.findByTestId("mailbox-alarm-clear.password"), {
      target: { value: "not the mailbox password" },
    })
    fireEvent.click(screen.getByTestId("mailbox-alarm-clear.confirm"))

    await screen.findByTestId("mailbox-alarm-clear.error")
    expect(mailboxStore.status).toBe("unlocked")
  })

  it("the right password clears the alarm and its persisted record, and audits the ids", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())

    render(() => <MailboxDowngradeAlarm userId={TEST_USER_ID} store={() => store} />)
    await openClearDialog()
    fireEvent.input(await screen.findByTestId("mailbox-alarm-clear.password"), {
      target: { value: PASSWORD },
    })
    fireEvent.click(screen.getByTestId("mailbox-alarm-clear.confirm"))

    await waitFor(() => expect(screen.queryByTestId("mailbox-downgrade-alarm")).toBeNull())
    expect(auditCalls()).toHaveLength(1)
    expect(auditCalls()[0][1]).toEqual({
      findings: FINDINGS.map(({ kind, subject, detectedAt }) => ({ kind, subject, detectedAt })),
    })
    expect(await store.get(ALARM_KEY)).toBeNull()
    expect(await rehydrated(store)).toEqual([])
  })

  it("confirms with the newest password row when a stale one lingers beside it", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    const base = mocks.api.get.getMockImplementation()!
    // A legacy row whose delete failed after the silent re-wrap: older, listed
    // first, and its blob is gone.
    mocks.api.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/wrap-passphrase-stale/blob")) throw new Error("wrap not found")
      const body = await base(path)
      if (path !== "/mailbox-keys/me") return body
      const stale = {
        id: "wrap-passphrase-stale",
        type: "passphrase",
        label: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        lastUsedAt: null,
      }
      return { ...body, wraps: [stale, ...body.wraps] }
    })
    setMailboxCryptoClient(inProcessClient())

    render(() => <MailboxDowngradeAlarm userId={TEST_USER_ID} store={() => store} />)
    await openClearDialog()
    fireEvent.input(await screen.findByTestId("mailbox-alarm-clear.password"), {
      target: { value: PASSWORD },
    })
    fireEvent.click(screen.getByTestId("mailbox-alarm-clear.confirm"))

    await waitFor(() => expect(screen.queryByTestId("mailbox-downgrade-alarm")).toBeNull())
    expect(auditCalls()).toHaveLength(1)
  })

  it("clears nothing when the server does not record the clear", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passphrase"])
    setMailboxCryptoClient(inProcessClient())
    mocks.api.post.mockImplementation(async (path: string) => {
      if (path === AUDIT_PATH) throw new TypeError("network down")
      return undefined
    })

    render(() => <MailboxDowngradeAlarm userId={TEST_USER_ID} store={() => store} />)
    await openClearDialog()
    fireEvent.input(await screen.findByTestId("mailbox-alarm-clear.password"), {
      target: { value: PASSWORD },
    })
    fireEvent.click(screen.getByTestId("mailbox-alarm-clear.confirm"))

    const error = await screen.findByTestId("mailbox-alarm-clear.error")
    expect(error.textContent).toContain("could not record")
    expect(auditCalls()).toHaveLength(1)
    expect(screen.getByTestId("mailbox-downgrade-alarm")).toBeTruthy()
    expect(await rehydrated(store)).toHaveLength(2)
  })

  it("a keyring with no mailbox password is confirmed with this computer's passkey", async () => {
    const enrollment = await buildEnrollment({
      passphrase: PASSWORD,
      withPasskey: { prfSecret: PRF, credentialId: new Uint8Array([1, 2, 3, 4]) },
    })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passkey_prf"])
    setMailboxCryptoClient(inProcessClient())
    stubAuthenticator(PRF)

    render(() => <MailboxDowngradeAlarm userId={TEST_USER_ID} store={() => store} />)
    await openClearDialog()
    await screen.findByTestId("mailbox-alarm-clear.passkey-hint")
    expect(screen.queryByTestId("mailbox-alarm-clear.password")).toBeNull()
    fireEvent.click(screen.getByTestId("mailbox-alarm-clear.confirm"))

    await waitFor(() => expect(screen.queryByTestId("mailbox-downgrade-alarm")).toBeNull())
    expect(auditCalls()).toHaveLength(1)
    expect(await rehydrated(store)).toEqual([])
  })

  it("a passkey whose PRF does not open the keyring clears nothing", async () => {
    const enrollment = await buildEnrollment({
      passphrase: PASSWORD,
      withPasskey: { prfSecret: PRF, credentialId: new Uint8Array([1, 2, 3, 4]) },
    })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    wireApi(enrollment, ["passkey_prf"])
    setMailboxCryptoClient(inProcessClient())
    stubAuthenticator(new Uint8Array(32).fill(9))

    render(() => <MailboxDowngradeAlarm userId={TEST_USER_ID} store={() => store} />)
    await openClearDialog()
    fireEvent.click(await screen.findByTestId("mailbox-alarm-clear.confirm"))

    await screen.findByTestId("mailbox-alarm-clear.error")
    expect(auditCalls()).toHaveLength(0)
    expect(await rehydrated(store)).toHaveLength(2)
  })

  it("lists the findings being cleared and says clearing undoes nothing", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSWORD })
    wireApi(enrollment, ["passphrase"])
    render(() => <MailboxDowngradeAlarm userId={TEST_USER_ID} store={() => store} />)
    await openClearDialog()
    expect(screen.getByTestId("mailbox-alarm-clear.list").children).toHaveLength(2)
    expect(screen.getByTestId("mailbox-alarm-clear.list").textContent).toContain(
      FINDINGS[1].subject,
    )
    expect(screen.getByTestId("mailbox-alarm-clear.meaning").textContent).toContain(
      "Clearing does not undo anything",
    )
  })

  it("offers no clear control without a signed in owner", () => {
    render(() => <MailboxDowngradeAlarm store={() => store} />)
    expect(screen.getByTestId("mailbox-downgrade-alarm")).toBeTruthy()
    expect(screen.queryByTestId("mailbox-downgrade-alarm.clear")).toBeNull()
  })

  it("the clear copy exists in English and French with no dash punctuation", () => {
    const en = (englishDictionaries() as Record<string, Record<string, unknown>>).kernel
      .mailboxAlarmClear as Record<string, unknown>
    const fr = (dictionariesFor("fr") as Record<string, Record<string, unknown>>).kernel
      .mailboxAlarmClear as Record<string, unknown>
    const flat = (dict: Record<string, unknown>): string[] =>
      Object.values(dict).flatMap((value) =>
        typeof value === "string" ? [value] : flat(value as Record<string, unknown>),
      )
    const keys = (dict: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(dict).flatMap(([key, value]) =>
        typeof value === "string"
          ? [`${prefix}${key}`]
          : keys(value as Record<string, unknown>, `${prefix}${key}.`),
      )
    expect(keys(fr).sort()).toEqual(keys(en).sort())
    for (const text of [...flat(en), ...flat(fr)]) {
      expect(text).not.toMatch(/[–—]/)
      expect(text).not.toContain("--")
      expect(text.toLowerCase()).not.toContain("bricked")
    }
  })
})
