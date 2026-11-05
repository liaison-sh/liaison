// SPDX-License-Identifier: FSL-1.1-ALv2
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { createMailboxCryptoClient, workerTransport } from "~/modules/mailbox/crypto-client"
import { MAILBOX_LOCKED } from "~/modules/mailbox/crypto-protocol"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealMessageFixture,
  TEST_USER_ID,
} from "~/modules/mailbox/mailbox-fixtures"
import { sha256Base64, verifyWorkerSource } from "~/modules/mailbox/worker-integrity"

function sourceOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

/** An in-process stand in for the Worker: same request and response shapes. */
function inProcessTransport() {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  return {
    session,
    post: (request: Parameters<typeof handleWorkerRequest>[1]) =>
      handleWorkerRequest(session, request),
  }
}

/**
 * A Worker that never answers, and can be killed. Only the three members the
 * transport uses are real: the event target, `postMessage` and `terminate`.
 */
function fakeWorker() {
  const target = new EventTarget()
  const posted: unknown[] = []
  const handle = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    postMessage: (request: unknown) => {
      posted.push(request)
    },
    terminate: () => {},
  } as unknown as Worker
  return {
    handle,
    posted,
    die: (kind: "error" | "close") => target.dispatchEvent(new Event(kind)),
  }
}

/** Shape only: a dead worker never looks at the ciphertext. */
function sealedFixture() {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    encVersion: 1,
    encKeyId: 1,
    contentKeyWrapped: "d3JhcHBlZA==",
    contentKeyEpk: "ZXBr",
    subjectCiphertext: "c3ViamVjdA==",
    textBodyCiphertext: "Ym9keQ==",
    htmlBodyCiphertext: null,
    snippetCiphertext: null,
  }
}

describe("mailbox crypto client", () => {
  it("exposes no path from the page to raw key material", () => {
    const source = sourceOf("./crypto-client.ts")
    // The page module must not import the opening half of the crypto package,
    // must not touch the key store, and must not name a CryptoKey. Everything
    // that holds key material lives behind the worker boundary.
    expect(source).not.toMatch(/@liaison\/mailbox-crypto/)
    expect(source).not.toMatch(/CryptoKey/)
    expect(source).not.toMatch(/exportKey|getRandomValues|indexedDB/)
    // Raw key material can only leave this file as bytes, and nothing the page
    // handle does needs bytes: every field of the protocol is a base64 string.
    // Banning the byte types is what makes this a guard rather than a spelling
    // check, and it is what catches an accessor that hands the page an array
    // instead of naming a key type.
    expect(source).not.toMatch(/Uint8Array|ArrayBuffer|accountKey|keyring|secret/i)
    // Non-vacuity: the file really is the page handle under test.
    expect(source).toContain("createMailboxCryptoClient")
  })

  it("relays unlock and open through the worker protocol and refuses once locked", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const transport = inProcessTransport()
    const client = createMailboxCryptoClient({ post: transport.post })

    await client.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    expect(client.isUnlocked()).toBe(true)

    const sealed = await sealMessageFixture(enrollment, {
      id: "33333333-3333-4333-8333-333333333333",
      subject: "Through the worker",
      textBody: "body text",
      htmlBody: "<p>body text</p>",
    })
    const opened = await client.openMessage(sealed)
    expect(opened.subject).toBe("Through the worker")

    await client.lock()
    expect(client.isUnlocked()).toBe(false)
    await expect(client.openMessage(sealed)).rejects.toMatchObject({ code: MAILBOX_LOCKED })
  })

  it("turns a DEAD worker into a locked mailbox instead of hanging every read", async () => {
    // The failure this pins is a HANG, which is strictly worse than a lock: the
    // message renders "(No content)" with no lock affordance and the user has
    // no way to tell anything is wrong. The documented intent is that a failed
    // worker boot renders a LOCKED mailbox, so the transport must fail closed
    // on `error` and `close` rather than leaving the request pending forever.
    const worker = fakeWorker()
    const client = createMailboxCryptoClient({ post: workerTransport(worker.handle) })

    const inFlight = client.openMessage(sealedFixture())
    // The worker died at load. Nothing will ever answer.
    worker.die("error")

    await expect(inFlight).rejects.toMatchObject({ code: MAILBOX_LOCKED })
    expect(client.isUnlocked()).toBe(false)

    // And every LATER request fails closed at once, rather than queueing on a
    // channel with nothing at the other end.
    await expect(client.openMessage(sealedFixture())).rejects.toMatchObject({
      code: MAILBOX_LOCKED,
    })
  })

  it("treats a worker that closes itself the same way", async () => {
    const worker = fakeWorker()
    const client = createMailboxCryptoClient({ post: workerTransport(worker.handle) })
    const inFlight = client.openMessage(sealedFixture())
    worker.die("close")
    await expect(inFlight).rejects.toMatchObject({ code: MAILBOX_LOCKED })
  })

  it("times out a request the worker never answers, rather than waiting forever", async () => {
    // A worker that boots, accepts the message and then wedges fires no event
    // at all. Without a deadline the read is indistinguishable from a slow one,
    // forever.
    const worker = fakeWorker()
    const client = createMailboxCryptoClient({
      post: workerTransport(worker.handle, { timeoutMs: 20, unlockTimeoutMs: 20 }),
    })
    const started = Date.now()
    await expect(client.openMessage(sealedFixture())).rejects.toMatchObject({
      code: MAILBOX_LOCKED,
    })
    expect(Date.now() - started).toBeLessThan(5_000)
    // Non-vacuity: the request really was delivered and really was unanswered.
    expect(worker.posted).toHaveLength(1)
  })

  it("boots the worker only when its source hash matches the pinned hash", async () => {
    const source = "self.onmessage = () => {}"
    const hash = await sha256Base64(source)
    await expect(verifyWorkerSource(source, hash)).resolves.toBe(true)
    await expect(verifyWorkerSource(`${source} // tampered`, hash)).resolves.toBe(false)
  })
})
