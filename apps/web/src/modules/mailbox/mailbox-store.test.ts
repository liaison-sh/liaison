// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SC10: a fresh browser profile with no device-local keyring unlocks the
// mailbox with the mailbox password alone. And a device whose cached keyring is
// from BEFORE a mailbox reset unlocks with the new password, because the
// server's keyring wins.
//
// The wrapped private halves are CIPHERTEXT under the Account Key, so the
// server may hold them without holding anything it can read. This pins that the
// store restores them from the server when this device has none: without that,
// clearing site data destroys the mailbox permanently, whatever the user still
// knows.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { clearAuth, LOGIN_SESSION_TTL_MS, setTokens } from "~/modules/auth/auth-store"
import {
  type KeyringEntryPayload,
  MailboxCryptoError,
  type UnlockRequest,
} from "~/modules/mailbox/crypto-protocol"
import {
  clearWrappedKeyring,
  loadWrappedKeyring,
  saveWrappedKeyring,
} from "~/modules/mailbox/keyring-storage"
import type { KeyringView, MailboxApi, WrapMetadataView } from "~/modules/mailbox/mailbox-api"
import {
  loadMailboxKeyring,
  mailboxResetElsewhere,
  mailboxStore,
  setMailboxCryptoClient,
  unlockMailbox,
} from "~/modules/mailbox/mailbox-store"

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

const WRAP: WrapMetadataView = {
  id: "wrap-1",
  type: "passphrase",
  label: "Mailbox password",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
}

/** The four wrapped-private fields, as base64 the way the routes carry them. */
const WRAPPED = {
  wrappedEcdhPrivate: "ZWNkaC1wcml2YXRl",
  wrappedSignPrivate: "c2lnbi1wcml2YXRl",
  ecdhWrapIv: "ZWNkaC1pdg==",
  signWrapIv: "c2lnbi1pdg==",
}

function serverKeyring(withPrivates: boolean): KeyringView {
  return {
    identityId: "identity-1",
    keyId: 1,
    identities: [
      {
        id: "identity-1",
        keyId: 1,
        status: "active",
        ecdhPublicKey: "ZWNkaC1wdWJsaWM=",
        signPublicKey: "c2lnbi1wdWJsaWM=",
        attestation: "YXR0ZXN0YXRpb24=",
        createdAt: "2026-01-01T00:00:00.000Z",
        retiredAt: null,
        ...(withPrivates ? WRAPPED : {}),
      },
    ],
    wraps: [WRAP],
  }
}

function fakeApi(keyring: KeyringView): MailboxApi {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: a stand-in for the generic api client
    get: vi.fn(async (path: string): Promise<any> => {
      if (path === "/mailbox-keys/me") return keyring as unknown
      if (path === `/mailbox-keys/wraps/${WRAP.id}/blob`) {
        return { wrappedAccountKey: "d3JhcHBlZA==", kdfParams: { salt: "c2FsdA==" } } as unknown
      }
      throw new Error(`unexpected path ${path}`)
    }),
    post: vi.fn(),
    delete: vi.fn(),
  }
}

function fakeClient(unlocks: UnlockRequest[]) {
  return {
    unlock: vi.fn(async (request: UnlockRequest) => {
      unlocks.push(request)
      return { unlocked: true as const, prompting: "re-prompt-each-session" as const }
    }),
    lock: vi.fn(async () => {}),
    isUnlocked: () => true,
  }
}

describe("unlockMailbox keyring recovery", () => {
  beforeEach(() => {
    localStorage.clear()
    clearWrappedKeyring(USER_ID)
    setMailboxCryptoClient(null)
  })

  it("restores the wrapped keyring from the server when this device holds none", async () => {
    const unlocks: UnlockRequest[] = []
    // biome-ignore lint/suspicious/noExplicitAny: a partial client stands in for the worker handle
    setMailboxCryptoClient(fakeClient(unlocks) as any)
    // Non-vacuity: this profile really is fresh.
    expect(loadWrappedKeyring(USER_ID)).toEqual([])

    const api = fakeApi(serverKeyring(true))
    const ok = await unlockMailbox(api, {
      userId: USER_ID,
      wrap: WRAP,
      secret: "the mailbox password",
    })

    expect(ok).toBe(true)
    expect(mailboxStore.status).toBe("unlocked")
    const sent = unlocks[0]?.keyring as KeyringEntryPayload[]
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ keyId: 1, status: "active", ...WRAPPED })
    // Restored once, then cached, so an offline unlock still works.
    expect(loadWrappedKeyring(USER_ID)).toHaveLength(1)
  })

  it("refuses only when neither this device nor the server holds a keyring", async () => {
    const unlocks: UnlockRequest[] = []
    // biome-ignore lint/suspicious/noExplicitAny: a partial client stands in for the worker handle
    setMailboxCryptoClient(fakeClient(unlocks) as any)

    const api = fakeApi(serverKeyring(false))
    const ok = await unlockMailbox(api, {
      userId: USER_ID,
      wrap: WRAP,
      secret: "the mailbox password",
    })

    expect(ok).toBe(false)
    expect(mailboxStore.lastErrorCode).toBe("MAILBOX_KEYRING_UNAVAILABLE")
    expect(unlocks).toHaveLength(0)
  })

  it("uses the server's keyring over a stale device cache from before a reset", async () => {
    const unlocks: UnlockRequest[] = []
    setMailboxCryptoClient({ ...fakeClient(unlocks), endMinting: vi.fn() } as any)
    // This computer cached the keyring the reset destroyed.
    const stale: KeyringEntryPayload = {
      keyId: 1,
      status: "active",
      ecdhSpki: "b2xkLWVjZGg=",
      signSpki: "b2xkLXNpZ24=",
      wrappedEcdhPrivate: "b2xkLXByaXY=",
      wrappedSignPrivate: "b2xkLXNpZ24tcHJpdg==",
      ecdhWrapIv: "b2xkLWl2",
      signWrapIv: "b2xkLWl2Mg==",
    }
    saveWrappedKeyring(USER_ID, [stale])

    const api = fakeApi(serverKeyring(true))
    const ok = await unlockMailbox(api, { userId: USER_ID, wrap: WRAP, secret: "new password" })

    expect(ok).toBe(true)
    const sent = unlocks[0]?.keyring as KeyringEntryPayload[]
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ ecdhSpki: "ZWNkaC1wdWJsaWM=", ...WRAPPED })
    // The new keyring, which the user's own password opened, replaces the cache.
    expect(loadWrappedKeyring(USER_ID)[0]?.ecdhSpki).toBe("ZWNkaC1wdWJsaWM=")
  })

  it("never reports a worker that could not run as a wrong password", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    setMailboxCryptoClient({
      unlock: vi.fn(async () => {
        // What the client throws for the worker's MAILBOX_INTERNAL answer.
        throw new Error("the mailbox worker could not complete that operation")
      }),
      lock: vi.fn(async () => {}),
      isUnlocked: () => false,
    } as any)
    const ok = await unlockMailbox(fakeApi(serverKeyring(true)), {
      userId: USER_ID,
      wrap: WRAP,
      secret: "pw",
    })
    expect(ok).toBe(false)
    expect(mailboxStore.lastErrorCode).toBe("MAILBOX_RUNTIME_FAILED")
    expect(console.error).toHaveBeenCalled()
  })

  it("names a reset made on another device when this device's old keyring meets a refusal", async () => {
    const refusing = {
      unlock: vi.fn(async () => {
        throw new MailboxCryptoError("MAILBOX_UNLOCK_REFUSED")
      }),
      lock: vi.fn(async () => {}),
      isUnlocked: () => false,
    }
    setMailboxCryptoClient(refusing as any)
    const api = fakeApi(serverKeyring(true))
    // First, a plain refusal on a device whose cache matches the server.
    expect(await unlockMailbox(api, { userId: USER_ID, wrap: WRAP, secret: "typo" })).toBe(false)
    expect(mailboxStore.lastErrorCode).toBe("MAILBOX_UNLOCK_REFUSED")
    expect(mailboxResetElsewhere(USER_ID, serverKeyring(true))).toBe(false)

    // Then a device that cached the keyring from before a reset.
    saveWrappedKeyring(USER_ID, [
      {
        keyId: 1,
        status: "active",
        ecdhSpki: "b2xkLWVjZGg=",
        signSpki: "b2xkLXNpZ24=",
        wrappedEcdhPrivate: "b2xkLXByaXY=",
        wrappedSignPrivate: "b2xkLXNpZ24tcHJpdg==",
        ecdhWrapIv: "b2xkLWl2",
        signWrapIv: "b2xkLWl2Mg==",
      },
    ])
    expect(mailboxResetElsewhere(USER_ID, serverKeyring(true))).toBe(true)
    expect(await unlockMailbox(api, { userId: USER_ID, wrap: WRAP, secret: "old pw" })).toBe(false)
    expect(mailboxStore.lastErrorCode).toBe("MAILBOX_RESET_ELSEWHERE")
  })

  it("a passkey prompt that did not complete is not a passkey mismatch", async () => {
    // A cancelled prompt never checked the passkey. Calling it a mismatch told
    // the mail surfaces "this device's passkey cannot unlock" for a cancel.
    const unlocks: UnlockRequest[] = []
    setMailboxCryptoClient(fakeClient(unlocks) as any)
    const ok = await unlockMailbox(fakeApi(serverKeyring(true)), {
      userId: USER_ID,
      wrap: { ...WRAP, type: "passkey_prf" },
      resolveSecret: async () => {
        throw new DOMException("The operation was cancelled", "NotAllowedError")
      },
    })
    expect(ok).toBe(false)
    expect(unlocks).toHaveLength(0)
    expect(mailboxStore.lastErrorCode).toBe("MAILBOX_PASSKEY_CEREMONY_FAILED")
  })

  it("refuses a legacy recovery phrase wrap without calling the worker", async () => {
    const unlocks: UnlockRequest[] = []
    setMailboxCryptoClient(fakeClient(unlocks) as any)
    const ok = await unlockMailbox(fakeApi(serverKeyring(true)), {
      userId: USER_ID,
      wrap: { ...WRAP, type: "recovery_phrase" },
      secret: "twelve words",
    })
    expect(ok).toBe(false)
    expect(unlocks).toHaveLength(0)
  })
})

// The silent migration of a legacy (Argon2id) password row. The worker hands
// back a PBKDF2 re-wrap; the store saves it and only THEN deletes the legacy
// row, so no failure can leave the mailbox without a password row.
describe("unlockMailbox legacy password row migration", () => {
  const UPGRADED = {
    wrapType: "passphrase" as const,
    wrappedAccountKey: "bmV3LXdyYXA=",
    kdfParams: { salt: "bmV3LXNhbHQ=", kdf: "pbkdf2-sha256" as const, iterations: 600_000 },
  }

  beforeEach(() => {
    localStorage.clear()
    clearWrappedKeyring(USER_ID)
    setMailboxCryptoClient(null)
  })

  function upgradingClient() {
    return {
      unlock: vi.fn(async () => ({
        unlocked: true as const,
        prompting: "re-prompt-each-session" as const,
        holdsAccountKeyBytes: false,
        upgradedWrap: UPGRADED,
      })),
      lock: vi.fn(async () => {}),
      isUnlocked: () => true,
    }
  }

  it("adds the PBKDF2 row first, then deletes the legacy one, with no prompt", async () => {
    setMailboxCryptoClient(upgradingClient() as any)
    const api = fakeApi(serverKeyring(true))
    const order: string[] = []
    api.post = vi.fn(async (path: string, body?: unknown) => {
      order.push(`post ${path}`)
      expect(body).toMatchObject({ ...UPGRADED, label: "Mailbox password" })
      return { id: "wrap-2" } as never
    })
    api.delete = vi.fn(async (path: string) => {
      order.push(`delete ${path}`)
      return {} as never
    })

    const ok = await unlockMailbox(api, { userId: USER_ID, wrap: WRAP, secret: "pw" })

    expect(ok).toBe(true)
    expect(mailboxStore.status).toBe("unlocked")
    expect(order).toEqual(["post /mailbox-keys/wraps", `delete /mailbox-keys/wraps/${WRAP.id}`])
  })

  it("keeps the legacy row when the new one could not be saved, and still unlocks", async () => {
    setMailboxCryptoClient(upgradingClient() as any)
    const api = fakeApi(serverKeyring(true))
    api.post = vi.fn(async () => {
      throw new Error("network down")
    })
    api.delete = vi.fn()

    const ok = await unlockMailbox(api, { userId: USER_ID, wrap: WRAP, secret: "pw" })

    expect(ok).toBe(true)
    expect(api.delete).not.toHaveBeenCalled()
  })

  it("still unlocks when the legacy row could not be deleted", async () => {
    setMailboxCryptoClient(upgradingClient() as any)
    const api = fakeApi(serverKeyring(true))
    api.post = vi.fn(async () => ({ id: "wrap-2" }) as never)
    api.delete = vi.fn(async () => {
      throw new Error("409")
    })

    const ok = await unlockMailbox(api, { userId: USER_ID, wrap: WRAP, secret: "pw" })

    expect(ok).toBe(true)
    expect(mailboxStore.status).toBe("unlocked")
  })

  it("touches no row when the worker offers no re-wrap", async () => {
    const unlocks: UnlockRequest[] = []
    setMailboxCryptoClient(fakeClient(unlocks) as any)
    const api = fakeApi(serverKeyring(true))

    await unlockMailbox(api, { userId: USER_ID, wrap: WRAP, secret: "pw" })

    expect(api.post).not.toHaveBeenCalled()
    expect(api.delete).not.toHaveBeenCalled()
  })
})

// An unlock lasts until logout: a reload (or a browser restart) re-opens the
// mailbox from this device's persisted handles while the keyring loads, and the
// status goes straight from "unknown" to "unlocked", never through "locked"
// (which is what raises the unlock prompt).
describe("loadMailboxKeyring device restore", () => {
  beforeEach(() => setMailboxCryptoClient(null))

  function restoringClient(restores: boolean) {
    let unlocked = false
    const seen: string[] = []
    const leases: unknown[] = []
    const client = {
      restore: vi.fn(
        async (request: { userId: string; keyring: KeyringEntryPayload[]; lease?: unknown }) => {
          seen.push(`${request.userId}:${request.keyring.length}`)
          leases.push(request.lease)
          unlocked = restores
          return restores
        },
      ),
      lock: vi.fn(async () => {}),
      isUnlocked: () => unlocked,
    }
    return { client, seen, leases }
  }

  /** A signed-in page: the lease is read from the login. */
  function signIn(): void {
    const body = btoa(
      JSON.stringify({
        userId: USER_ID,
        orgId: "00000000-0000-4000-8000-0000000000a1",
        scopes: [],
        roles: [],
        name: "Test",
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    )
    setTokens(`${btoa("{}")}.${body}.signature`)
  }

  it("re-opens a mailbox this device already unlocked, without a locked state", async () => {
    signIn()
    const { client, seen, leases } = restoringClient(true)
    // biome-ignore lint/suspicious/noExplicitAny: a partial stand-in for the worker client
    setMailboxCryptoClient(client as any)
    const statuses: string[] = []
    const pending = loadMailboxKeyring(fakeApi(serverKeyring(true)), USER_ID)
    statuses.push(mailboxStore.status)
    await pending
    statuses.push(mailboxStore.status)
    expect(seen).toEqual([`${USER_ID}:1`])
    expect(statuses).not.toContain("locked")
    expect(mailboxStore.status).toBe("unlocked")
    // Under the current login's lease: its organisation, and its end.
    const lease = leases[0] as { orgId: string; expiresAt: number; exclusive: boolean }
    expect(lease.orgId).toBe("00000000-0000-4000-8000-0000000000a1")
    expect(lease.exclusive).toBe(true)
    expect(lease.expiresAt).toBeGreaterThan(Date.now() + LOGIN_SESSION_TTL_MS - 60_000)
  })

  it("restores nothing without a login to bind the unlock to", async () => {
    clearAuth()
    const { client, seen } = restoringClient(true)
    // biome-ignore lint/suspicious/noExplicitAny: a partial stand-in for the worker client
    setMailboxCryptoClient(client as any)
    await loadMailboxKeyring(fakeApi(serverKeyring(true)), USER_ID)
    expect(seen).toEqual([])
    expect(mailboxStore.status).toBe("locked")
  })

  it("stays locked when this device has nothing to restore", async () => {
    const { client } = restoringClient(false)
    // biome-ignore lint/suspicious/noExplicitAny: a partial stand-in for the worker client
    setMailboxCryptoClient(client as any)
    await loadMailboxKeyring(fakeApi(serverKeyring(true)), USER_ID)
    expect(mailboxStore.status).toBe("locked")
  })
})
