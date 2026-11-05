// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The boot path, tested as the browser runs it.
//
// Every other mailbox test installs a crypto client by hand, which is exactly
// how the shipped app came to have none: `crypto-worker.ts`, `bootVerifiedWorker`
// and `createMailboxCryptoClient` all existed and were all tested, and nothing in
// production ever called them, so `mailboxCryptoClient()` stayed null forever and
// every client-side decrypt path was unreachable.
//
// So these tests install NOTHING. They call the boot entry the app calls and
// assert on what the store holds afterwards, and they assert the boot went
// through the integrity check rather than around it.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { MAILBOX_WORKER_TIMEOUT_MS } from "~/modules/mailbox/crypto-client"
import type { WorkerRequest } from "~/modules/mailbox/crypto-protocol"
import { createMailboxSession, type MailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"
import type { KeyringView, MailboxApi } from "~/modules/mailbox/mailbox-api"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealMessageFixture,
  TEST_USER_ID,
  type TestEnrollment,
} from "~/modules/mailbox/mailbox-fixtures"
import type { WorkerBootOptions } from "~/modules/mailbox/worker-integrity"

const PASSPHRASE = "correct horse battery staple 42"
const SEALED_ID = "77777777-7777-4777-8777-777777777777"

const bootCalls: WorkerBootOptions[] = []
let bootResult: "worker" | "refused" = "worker"
let liveSession: MailboxSession | null = null
const terminated: FakeWorker[] = []
/** The device's IndexedDB: shared by every worker this "browser" boots, across reloads. */
let deviceStore = memoryKeyStore()
/** The last worker booted, so a test can crash it. */
let lastWorker: FakeWorker | null = null

/** Requests the worker receives and does not answer (a throttled or suspended window). */
const stalledOps = new Set<string>()

/**
 * A Worker stand-in that runs the REAL worker request handler in this process.
 * `workerTransport` only needs `addEventListener("message")`, `postMessage` and
 * `terminate`, so this is the whole surface the page side touches.
 */
class FakeWorker extends EventTarget {
  constructor(private readonly session: MailboxSession) {
    super()
  }
  postMessage(request: WorkerRequest): void {
    if (stalledOps.has(request.op)) return
    void handleWorkerRequest(this.session, request).then((response) => {
      this.dispatchEvent(new MessageEvent("message", { data: response }))
    })
  }
  terminate(): void {
    terminated.push(this)
  }
}

vi.mock("~/modules/mailbox/worker-integrity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/mailbox/worker-integrity")>()
  return {
    ...actual,
    bootVerifiedWorker: async (options: WorkerBootOptions) => {
      bootCalls.push(options)
      if (bootResult === "refused") return null
      liveSession = createMailboxSession({
        keyStore: deviceStore,
        legacyKdf: fakeArgon2id,
      })
      lastWorker = new FakeWorker(liveSession)
      return lastWorker as unknown as Worker
    },
  }
})

/** The stores are module singletons, so each test gets a fresh module graph. */
async function freshModules() {
  const boot = await import("~/modules/mailbox/crypto-worker-boot")
  const store = await import("~/modules/mailbox/mailbox-store")
  const keyring = await import("~/modules/mailbox/keyring-storage")
  // From the SAME graph: a statically imported `teardownSession` would drain a
  // registry no module in this test ever registered into, and every teardown
  // assertion would pass vacuously.
  const lifecycle = await import("~/lib/session-lifecycle")
  const auth = await import("~/modules/auth/auth-store")
  return {
    ...boot,
    ...store,
    ...keyring,
    teardownSession: lifecycle.teardownSession,
    setTokens: auth.setTokens,
    clearAuth: auth.clearAuth,
  }
}

const ORG_ID = "00000000-0000-4000-8000-0000000000a1"

/** An access token as the page decodes it (the signature is never checked client side). */
function accessTokenFor(userId: string): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId,
      orgId: ORG_ID,
      scopes: [],
      roles: [],
      name: "Test",
      exp: Math.floor(Date.now() / 1000) + 900,
    }),
  )
  return `${header}.${body}.signature`
}

/** The server's keyring listing for this enrollment, wrapped halves included. */
function keyringView(enrollment: TestEnrollment): KeyringView {
  return {
    identityId: "identity-1",
    keyId: enrollment.entry.keyId,
    wraps: [PASSPHRASE_WRAP],
    identities: enrollment.keyring.map((entry) => ({
      id: `identity-${entry.keyId}`,
      keyId: entry.keyId,
      status: entry.status,
      ecdhPublicKey: entry.ecdhSpki,
      signPublicKey: entry.signSpki,
      attestation: "",
      createdAt: "2026-08-01T00:00:00.000Z",
      retiredAt: null,
      wrappedEcdhPrivate: entry.wrappedEcdhPrivate,
      wrappedSignPrivate: entry.wrappedSignPrivate,
      ecdhWrapIv: entry.ecdhWrapIv,
      signWrapIv: entry.signWrapIv,
    })),
  }
}

/** The mailbox API with the keyring listing as well as the wrap blob. */
function serverApi(enrollment: TestEnrollment) {
  return {
    get: async (path: string) => {
      if (path === "/mailbox-keys/me") return keyringView(enrollment)
      if (path.endsWith("/blob")) {
        return {
          wrappedAccountKey: enrollment.passphraseWrap.wrappedAccountKey,
          kdfParams: enrollment.passphraseWrap.kdfParams,
        }
      }
      throw new Error(`unexpected path ${path}`)
    },
    post: async () => ({}),
    delete: async () => ({}),
  } as unknown as MailboxApi
}

/** Enough of the mailbox API for `unlockMailbox` to reach the passphrase wrap. */
function wrapApi(enrollment: TestEnrollment) {
  return {
    get: async (path: string) => {
      if (path.endsWith("/blob")) {
        return {
          wrappedAccountKey: enrollment.passphraseWrap.wrappedAccountKey,
          kdfParams: enrollment.passphraseWrap.kdfParams,
        }
      }
      throw new Error(`unexpected path ${path}`)
    },
    post: async () => ({}),
    delete: async () => ({}),
    // Only `get` is reached on the unlock path; the rest is shape.
  } as unknown as MailboxApi
}

const PASSPHRASE_WRAP = {
  id: "wrap-passphrase",
  type: "passphrase" as const,
  label: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastUsedAt: null,
}

describe("mailbox crypto worker boot", () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    // The dev-and-test boot path hashes the bytes this origin serves for the
    // worker, so there has to be something to serve.
    vi.stubGlobal("fetch", async () => new Response("// the crypto worker bundle\n"))
    bootCalls.length = 0
    terminated.length = 0
    liveSession = null
    bootResult = "worker"
    deviceStore = memoryKeyStore()
    stalledOps.clear()
    localStorage.clear()
  })

  it("installs a usable crypto client on the store", async () => {
    const { startMailboxCryptoWorker, mailboxCryptoClient } = await freshModules()

    const client = await startMailboxCryptoWorker()

    expect(client).not.toBeNull()
    expect(mailboxCryptoClient()).toBe(client)
  })

  it("boots through the integrity check, never around it", async () => {
    const { startMailboxCryptoWorker } = await freshModules()
    await startMailboxCryptoWorker()

    expect(bootCalls).toHaveLength(1)
    expect(typeof bootCalls[0].url).toBe("string")
    expect(bootCalls[0].url.length).toBeGreaterThan(0)
    expect(typeof bootCalls[0].expectedHash).toBe("string")
    expect(bootCalls[0].expectedHash.length).toBeGreaterThan(0)
  })

  it("installs no client when the integrity check refuses the worker", async () => {
    bootResult = "refused"
    const { startMailboxCryptoWorker, mailboxCryptoClient } = await freshModules()

    expect(await startMailboxCryptoWorker()).toBeNull()
    expect(mailboxCryptoClient()).toBeNull()
  })

  it("retries a boot that failed instead of caching the failure", async () => {
    bootResult = "refused"
    const { startMailboxCryptoWorker, mailboxCryptoClient } = await freshModules()
    expect(await startMailboxCryptoWorker()).toBeNull()

    bootResult = "worker"
    const client = await startMailboxCryptoWorker()
    expect(bootCalls).toHaveLength(2)
    expect(client).not.toBeNull()
    expect(mailboxCryptoClient()).toBe(client)
  })

  it("a worker that crashed is dropped, and the next start boots a fresh one", async () => {
    // A dead worker answers "locked" forever; while its client stayed installed,
    // every unlock failed with "reload the page" and nothing booted a new one.
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { startMailboxCryptoWorker, mailboxCryptoClient, mailboxStore } = await freshModules()
    const first = await startMailboxCryptoWorker()
    const crashed = lastWorker
    crashed?.dispatchEvent(new Event("error"))

    expect(mailboxCryptoClient()).toBeNull()
    expect(mailboxStore.status).toBe("locked")
    expect(terminated).toContain(crashed)
    const second = await startMailboxCryptoWorker()
    expect(bootCalls).toHaveLength(2)
    expect(second).not.toBe(first)
    expect(mailboxCryptoClient()).toBe(second)
  })

  it("boots once per session, not once per caller", async () => {
    const { startMailboxCryptoWorker } = await freshModules()
    const [a, b] = await Promise.all([startMailboxCryptoWorker(), startMailboxCryptoWorker()])

    expect(bootCalls).toHaveLength(1)
    expect(a).toBe(b)
  })

  it("opens a sealed row through the booted worker", async () => {
    const { startMailboxCryptoWorker, openSealedMessage } = await freshModules()
    const client = await startMailboxCryptoWorker()
    if (!client) throw new Error("the worker did not boot")

    const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
    await client.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: PASSPHRASE,
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    const sealed = await sealMessageFixture(enrollment, {
      id: SEALED_ID,
      subject: "Sealed subject",
      textBody: "Sealed body text",
      htmlBody: "<p>Sealed body text</p>",
    })

    const opened = await openSealedMessage(sealed)

    expect(opened?.subject).toBe("Sealed subject")
    expect(opened?.textBody).toBe("Sealed body text")
  })

  it("unlocks the mailbox through the store on the booted worker", async () => {
    const { startMailboxCryptoWorker, unlockMailbox, mailboxStore, saveWrappedKeyring } =
      await freshModules()
    await startMailboxCryptoWorker()
    const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)

    const ok = await unlockMailbox(wrapApi(enrollment), {
      userId: TEST_USER_ID,
      wrap: PASSPHRASE_WRAP,
      secret: PASSPHRASE,
    })

    expect(ok).toBe(true)
    expect(mailboxStore.status).toBe("unlocked")
  })

  it("locks and terminates the worker on session teardown", async () => {
    const { startMailboxCryptoWorker, mailboxCryptoClient, teardownSession } = await freshModules()
    const client = await startMailboxCryptoWorker()
    if (!client) throw new Error("the worker did not boot")
    const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
    await client.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: PASSPHRASE,
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    expect(liveSession?.isUnlocked()).toBe(true)

    teardownSession()

    await vi.waitFor(() => expect(liveSession?.isUnlocked()).toBe(false))
    await vi.waitFor(() => expect(terminated).toHaveLength(1))
    expect(mailboxCryptoClient()).toBeNull()
  })

  it("re-boots after a teardown, so the next login gets a worker", async () => {
    const { startMailboxCryptoWorker, teardownSession } = await freshModules()
    await startMailboxCryptoWorker()
    teardownSession()

    const second = await startMailboxCryptoWorker()

    expect(second).not.toBeNull()
    expect(bootCalls).toHaveLength(2)
  })

  it("flips the store to locked when the worker's idle timeout wipes the keys", async () => {
    vi.useFakeTimers()
    const {
      startMailboxCryptoWorker,
      MAILBOX_STATUS_POLL_MS,
      unlockMailbox,
      mailboxStore,
      saveWrappedKeyring,
    } = await freshModules()
    await startMailboxCryptoWorker()
    const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
    saveWrappedKeyring(TEST_USER_ID, enrollment.keyring)
    await unlockMailbox(wrapApi(enrollment), {
      userId: TEST_USER_ID,
      wrap: PASSPHRASE_WRAP,
      secret: PASSPHRASE,
    })
    expect(mailboxStore.status).toBe("unlocked")

    // The worker's own idle sweep wipes the keys without telling the page.
    await liveSession?.lock()
    await vi.advanceTimersByTimeAsync(MAILBOX_STATUS_POLL_MS + 1)

    expect(mailboxStore.status).toBe("locked")
  })

  // "The unlock lives as long as the login does": a reload, an app restart
  // or a closed tab keeps the mailbox open; only the end of the login closes it.
  describe("the unlock lasts as long as the login", () => {
    it("a reload re-opens the mailbox with no password while the login lasts", async () => {
      const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
      const first = await freshModules()
      first.setTokens(accessTokenFor(enrollment.userId))
      await first.startMailboxCryptoWorker()
      expect(
        await first.unlockMailbox(serverApi(enrollment), {
          userId: enrollment.userId,
          wrap: PASSPHRASE_WRAP,
          secret: PASSPHRASE,
        }),
      ).toBe(true)
      expect(deviceStore.size()).toBeGreaterThan(0)

      // The reload: a new page, a new worker, the same device store.
      vi.resetModules()
      const reloaded = await freshModules()
      reloaded.setTokens(accessTokenFor(enrollment.userId))
      await reloaded.startMailboxCryptoWorker()
      await reloaded.loadMailboxKeyring(serverApi(enrollment))

      expect(reloaded.mailboxStore.status).toBe("unlocked")
      expect(liveSession?.isUnlocked()).toBe(true)
    })

    it("a status reply that comes late locks the page, never the device", async () => {
      vi.useFakeTimers()
      const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
      const modules = await freshModules()
      modules.setTokens(accessTokenFor(enrollment.userId))
      await modules.startMailboxCryptoWorker()
      await modules.unlockMailbox(serverApi(enrollment), {
        userId: enrollment.userId,
        wrap: PASSPHRASE_WRAP,
        secret: PASSPHRASE,
      })
      const persisted = deviceStore.size()
      expect(persisted).toBeGreaterThan(0)

      // The window is throttled: the poll's status request is never answered
      // inside its deadline, though the worker is alive and still unlocked.
      stalledOps.add("status")
      await vi.advanceTimersByTimeAsync(
        modules.MAILBOX_STATUS_POLL_MS + MAILBOX_WORKER_TIMEOUT_MS + 1,
      )
      stalledOps.clear()
      await vi.advanceTimersByTimeAsync(0)

      expect(modules.mailboxStore.status).toBe("locked")
      expect(deviceStore.size()).toBe(persisted)
      expect(liveSession?.isUnlocked()).toBe(true)
    })

    it("a login the server ended (refresh refused) ends the unlock on this device", async () => {
      const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
      const modules = await freshModules()
      modules.setTokens(accessTokenFor(enrollment.userId))
      await modules.startMailboxCryptoWorker()
      await modules.unlockMailbox(serverApi(enrollment), {
        userId: enrollment.userId,
        wrap: PASSPHRASE_WRAP,
        secret: PASSPHRASE,
      })
      expect(deviceStore.size()).toBeGreaterThan(0)

      modules.clearAuth()

      await vi.waitFor(() => expect(deviceStore.size()).toBe(0))
      await vi.waitFor(() => expect(liveSession?.isUnlocked()).toBe(false))
      await vi.waitFor(() => expect(modules.mailboxStore.status).toBe("locked"))
    })
  })
})
