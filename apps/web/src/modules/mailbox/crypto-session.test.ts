// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DeviceLeaseRequest } from "~/modules/mailbox/crypto-protocol"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import { bytesToBase64 } from "~/modules/mailbox/mailbox-bytes"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealApprovalDraftFixture,
  sealMessageFixture,
  TEST_USER_ID,
} from "~/modules/mailbox/mailbox-fixtures"

const ORG_ID = "00000000-0000-4000-8000-0000000000a1"
const DAY = 24 * 60 * 60 * 1000

describe("mailbox crypto session", () => {
  let clock = 1_000_000
  /** The current login's device lease, as the page passes it: a browser by default. */
  const lease = (over: Partial<DeviceLeaseRequest> = {}): DeviceLeaseRequest => ({
    orgId: ORG_ID,
    expiresAt: clock + 30 * DAY,
    exclusive: true,
    ...over,
  })

  beforeEach(() => {
    clock = 1_000_000
  })

  it("unlocks with a passphrase wrap and opens a sealed message", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const store = memoryKeyStore()
    const session = createMailboxSession({
      keyStore: store,
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })

    const result = await session.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    expect(result.unlocked).toBe(true)
    expect(session.isUnlocked()).toBe(true)

    const sealed = await sealMessageFixture(enrollment, {
      id: "11111111-1111-4111-8111-111111111111",
      subject: "Quarterly numbers",
      textBody: "The numbers are attached.",
      htmlBody: "<p>The numbers are attached.</p>",
    })
    const opened = await session.openMessage(sealed)
    expect(opened.subject).toBe("Quarterly numbers")
    expect(opened.textBody).toBe("The numbers are attached.")
    expect(opened.htmlBody).toBe("<p>The numbers are attached.</p>")
  })

  it("mints PBKDF2 password rows, and unlocking one offers no re-wrap", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    expect(enrollment.passphraseWrap.kdfParams).toMatchObject({
      kdf: "pbkdf2-sha256",
      iterations: 600_000,
    })
    const session = createMailboxSession({ keyStore: memoryKeyStore(), now: () => clock })
    const result = await session.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    expect(result.upgradedWrap).toBeUndefined()
  })

  it("re-wraps a legacy password row under PBKDF2 on unlock, and the re-wrap opens alone", async () => {
    const passphrase = "correct horse battery staple 42"
    const enrollment = await buildEnrollment({ passphrase, legacyPassphrase: true })
    expect(enrollment.passphraseWrap.kdfParams?.kdf).toBeUndefined()
    const first = createMailboxSession({
      keyStore: memoryKeyStore(),
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    const result = await first.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: passphrase,
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    const upgraded = result.upgradedWrap
    expect(upgraded?.wrapType).toBe("passphrase")
    expect(upgraded?.kdfParams).toMatchObject({ kdf: "pbkdf2-sha256", iterations: 600_000 })
    expect(upgraded?.kdfParams.salt).not.toBe(enrollment.passphraseWrap.kdfParams?.salt)
    // The session did not keep the Account Key bytes to produce it.
    expect(result.holdsAccountKeyBytes).toBe(false)

    // A session WITHOUT any legacy KDF opens the re-wrap with the same password
    // and reads the same mail: it is the same Account Key.
    if (!upgraded) throw new Error("no re-wrap")
    const second = createMailboxSession({ keyStore: memoryKeyStore(), now: () => clock })
    const again = await second.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: passphrase,
      wrap: { id: "upgraded", ...upgraded },
      keyring: enrollment.keyring,
    })
    expect(again.upgradedWrap).toBeUndefined()
    const sealed = await sealMessageFixture(enrollment, {
      id: "33333333-3333-4333-8333-333333333333",
      subject: "Still readable",
      textBody: "after the re-wrap",
      htmlBody: "<p>after the re-wrap</p>",
    })
    expect((await second.openMessage(sealed)).subject).toBe("Still readable")
  })

  it("offers no re-wrap when a passkey unlocks, even beside a legacy password row", async () => {
    const prfSecret = crypto.getRandomValues(new Uint8Array(32))
    const credentialId = crypto.getRandomValues(new Uint8Array(16))
    const enrollment = await buildEnrollment({
      passphrase: "correct horse battery staple 42",
      legacyPassphrase: true,
      withPasskey: { prfSecret, credentialId },
    })
    if (!enrollment.passkeyWrap) throw new Error("no passkey wrap")
    const session = createMailboxSession({ keyStore: memoryKeyStore(), now: () => clock })
    const result = await session.unlock({
      userId: TEST_USER_ID,
      method: "passkey_prf",
      secret: bytesToBase64(prfSecret),
      wrap: enrollment.passkeyWrap,
      keyring: enrollment.keyring,
    })
    expect(result.upgradedWrap).toBeUndefined()
  })

  it("refuses a legacy password row with its own code when the build has no legacy KDF", async () => {
    // What the native mobile build does: the legacy module is the stand-in.
    vi.resetModules()
    vi.doMock(
      "@liaison/mailbox-crypto/src/legacy-passphrase-kdf",
      async () => import("@liaison/mailbox-crypto/src/legacy-passphrase-kdf.native"),
    )
    try {
      const { createMailboxSession: createNative } = await import(
        "~/modules/mailbox/crypto-session"
      )
      const enrollment = await buildEnrollment({
        passphrase: "correct horse battery staple 42",
        legacyPassphrase: true,
      })
      const session = createNative({ keyStore: memoryKeyStore(), now: () => clock })
      await expect(
        session.unlock({
          userId: TEST_USER_ID,
          method: "passphrase",
          secret: "correct horse battery staple 42",
          wrap: enrollment.passphraseWrap,
          keyring: enrollment.keyring,
        }),
      ).rejects.toMatchObject({ code: "MAILBOX_PASSWORD_FORMAT_UNSUPPORTED" })
      expect(session.isUnlocked()).toBe(false)
    } finally {
      vi.doUnmock("@liaison/mailbox-crypto/src/legacy-passphrase-kdf")
      vi.resetModules()
    }
  })

  // Blueprint Task 9.8. A gated send from a sealed mailbox stores its drafted
  // body and subject as ciphertext, so the approval card cannot render, and the
  // send cannot execute, without opening them HERE.
  it("opens the sealed draft of a gated send's approval payload", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const session = createMailboxSession({
      keyStore: memoryKeyStore(),
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    await session.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    const approvalRequestId = "22222222-2222-4222-8222-222222222222"
    const sealed = await sealApprovalDraftFixture(enrollment, {
      approvalRequestId,
      subject: "Re: Invoice 42",
      textBody: "Attached, as promised.",
      note: "forwarding for context",
    })
    const opened = await session.openApprovalDraft(sealed)
    expect(opened.subject).toBe("Re: Invoice 42")
    expect(opened.textBody).toBe("Attached, as promised.")
    expect(opened.note).toBe("forwarding for context")
  })

  it("refuses to open one approval's draft under another approval's id", async () => {
    // The AAD binds each blob to its approval request. Without that binding a
    // sealed draft could be replayed into a different, already-approved send.
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const session = createMailboxSession({
      keyStore: memoryKeyStore(),
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    await session.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    const sealed = await sealApprovalDraftFixture(enrollment, {
      approvalRequestId: "22222222-2222-4222-8222-222222222222",
      textBody: "Attached, as promised.",
    })
    await expect(
      session.openApprovalDraft({
        ...sealed,
        approvalRequestId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toThrow()
  })

  it("keeps every session key handle non extractable", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const session = createMailboxSession({
      keyStore: memoryKeyStore(),
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    await session.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    const handles = session.inspectHandlesForTest()
    expect(handles.length).toBeGreaterThan(0)
    for (const handle of handles) expect(handle.extractable).toBe(false)
  })

  it("lock empties the key store and refuses to open afterwards", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const store = memoryKeyStore()
    const session = createMailboxSession({
      keyStore: store,
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    await session.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
      lease: lease(),
    })
    expect(store.size()).toBeGreaterThan(0)

    await session.lock()
    expect(store.size()).toBe(0)
    expect(session.isUnlocked()).toBe(false)

    const sealed = await sealMessageFixture(enrollment, {
      id: "22222222-2222-4222-8222-222222222222",
      subject: "After lock",
      textBody: "hidden",
      htmlBody: "<p>hidden</p>",
    })
    await expect(session.openMessage(sealed)).rejects.toThrow(/MAILBOX_LOCKED/)
  })

  it("wipes itself after the idle timeout and clamps the configured window", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const store = memoryKeyStore()
    const session = createMailboxSession({
      keyStore: store,
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    await session.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    // By default the unlock lasts until logout: nothing idles it shut.
    expect(session.idleTimeoutMs()).toBe(Number.POSITIVE_INFINITY)
    clock += 30 * 24 * 60 * 60 * 1000
    expect(await session.expireIfIdle()).toBe(false)
    expect(session.isUnlocked()).toBe(true)

    session.setIdleTimeoutMs(60 * 1000)
    expect(session.idleTimeoutMs()).toBe(15 * 60 * 1000)
    session.setIdleTimeoutMs(99 * 60 * 60 * 1000)
    expect(session.idleTimeoutMs()).toBe(8 * 60 * 60 * 1000)

    session.setIdleTimeoutMs(15 * 60 * 1000)
    clock += 15 * 60 * 1000 + 1
    expect(await session.expireIfIdle()).toBe(true)
    expect(session.isUnlocked()).toBe(false)
    expect(store.size()).toBe(0)
  })

  it("mints a mailbox password for a passkey only keyring, which then unlocks it", async () => {
    // A legacy keyring (passkey plus a retired recovery phrase) has no method
    // that works on another computer. After a passkey unlock the session adds
    // the mailbox password, and a FRESH session opens the same keyring with it.
    const prfSecret = new Uint8Array(32).fill(9) as Uint8Array<ArrayBuffer>
    const credentialId = new Uint8Array([4, 3, 2, 1]) as Uint8Array<ArrayBuffer>
    const enrollment = await buildEnrollment({
      passphrase: "correct horse battery staple 42",
      withPasskey: { prfSecret, credentialId },
    })
    const session = createMailboxSession({
      keyStore: memoryKeyStore(),
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    await session.unlock({
      userId: TEST_USER_ID,
      method: "passkey_prf",
      secret: bytesToBase64(prfSecret),
      wrap: enrollment.passkeyWrap as NonNullable<typeof enrollment.passkeyWrap>,
      keyring: enrollment.keyring,
      mintWraps: true,
    })
    const minted = await session.mintWrap({
      kind: "passphrase",
      passphrase: "a brand new mailbox password 7",
    })
    expect(minted.wrapType).toBe("passphrase")
    session.endMinting()
    expect(session.holdsAccountKeyBytes()).toBe(false)

    const elsewhere = createMailboxSession({
      keyStore: memoryKeyStore(),
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    const result = await elsewhere.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "a brand new mailbox password 7",
      wrap: { id: "wrap-new", ...minted },
      keyring: enrollment.keyring,
    })
    expect(result.unlocked).toBe(true)
  })

  it("refuses to mint an unlock method from a session that did not keep the key", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const session = createMailboxSession({
      keyStore: memoryKeyStore(),
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    await session.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    // Non-vacuity: the session is open, only the key bytes are gone.
    expect(session.isUnlocked()).toBe(true)
    await expect(
      session.mintWrap({ kind: "passphrase", passphrase: "another password entirely 9" }),
    ).rejects.toMatchObject({ code: "MAILBOX_LOCKED" })
  })

  it("reports a wrong passphrase as a refusal, not as corruption", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const session = createMailboxSession({
      keyStore: memoryKeyStore(),
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    await expect(
      session.unlock({
        userId: TEST_USER_ID,
        method: "passphrase",
        secret: "not the passphrase at all",
        wrap: enrollment.passphraseWrap,
        keyring: enrollment.keyring,
      }),
    ).rejects.toThrow(/MAILBOX_UNLOCK_REFUSED/)
  })

  it("reports an unlock the runtime refused as a runtime failure, never a wrong password", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    // What the desktop webview did under a CSP without 'wasm-unsafe-eval': the
    // legacy KDF cannot compile, and the password is never checked.
    const legacy = await buildEnrollment({
      passphrase: "correct horse battery staple 42",
      legacyPassphrase: true,
    })
    const blocked = createMailboxSession({
      keyStore: memoryKeyStore(),
      now: () => clock,
      legacyKdf: async () => {
        throw new Error("CompileError: WebAssembly.Module(): Refused to compile")
      },
    })
    await expect(
      blocked.unlock({
        userId: TEST_USER_ID,
        method: "passphrase",
        secret: "correct horse battery staple 42",
        wrap: legacy.passphraseWrap,
        keyring: legacy.keyring,
      }),
    ).rejects.toMatchObject({ code: "MAILBOX_RUNTIME_FAILED" })

    // And the PBKDF2 path when the engine throws something that is not the
    // unwrap's integrity refusal.
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const session = createMailboxSession({ keyStore: memoryKeyStore(), now: () => clock })
    const derive = vi
      .spyOn(crypto.subtle, "deriveBits")
      .mockRejectedValueOnce(new TypeError("out of memory"))
    try {
      await expect(
        session.unlock({
          userId: TEST_USER_ID,
          method: "passphrase",
          secret: "correct horse battery staple 42",
          wrap: enrollment.passphraseWrap,
          keyring: enrollment.keyring,
        }),
      ).rejects.toMatchObject({ code: "MAILBOX_RUNTIME_FAILED" })
    } finally {
      derive.mockRestore()
    }
    expect(console.error).toHaveBeenCalled()
  })

  // A page reload or a browser restart is a NEW worker over the SAME store.
  // One unlock must carry over until logout, with no secret asked again.
  it("a fresh session restores from the persisted handles and opens mail", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const store = memoryKeyStore()
    const first = createMailboxSession({
      keyStore: store,
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    const result = await first.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
      lease: lease(),
    })
    expect(result.prompting).toBe("restored-from-store")

    const reloaded = createMailboxSession({ keyStore: store, now: () => clock })
    expect(reloaded.isUnlocked()).toBe(false)
    expect(
      await reloaded.restore({ userId: TEST_USER_ID, keyring: enrollment.keyring, lease: lease() }),
    ).toBe(true)
    expect(reloaded.isUnlocked()).toBe(true)
    const sealed = await sealMessageFixture(enrollment, {
      id: "11111111-1111-4111-8111-111111111111",
      subject: "Quarterly numbers",
      textBody: "The numbers are attached.",
      htmlBody: "<p>The numbers are attached.</p>",
    })
    expect((await reloaded.openMessage(sealed)).subject).toBe("Quarterly numbers")
    for (const handle of reloaded.inspectHandlesForTest()) expect(handle.extractable).toBe(false)
  })

  it("does not restore for another keyring, another user, or after a lock", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const store = memoryKeyStore()
    const first = createMailboxSession({
      keyStore: store,
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    await first.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
      lease: lease(),
    })
    // A mailbox reset elsewhere: same key ids, new keys.
    const reset = await buildEnrollment({ passphrase: "a brand new mailbox password 7" })
    const fresh = () => createMailboxSession({ keyStore: store, now: () => clock })
    expect(
      await fresh().restore({ userId: TEST_USER_ID, keyring: reset.keyring, lease: lease() }),
    ).toBe(false)
    expect(
      await fresh().restore({
        userId: "99999999-9999-4999-8999-999999999999",
        keyring: enrollment.keyring,
        lease: lease(),
      }),
    ).toBe(false)
    await first.lock()
    expect(
      await fresh().restore({ userId: TEST_USER_ID, keyring: enrollment.keyring, lease: lease() }),
    ).toBe(false)
  })

  it("degrades to re-prompting when the key store cannot persist", async () => {
    const enrollment = await buildEnrollment({ passphrase: "correct horse battery staple 42" })
    const broken = {
      async put() {
        throw new Error("site data is blocked")
      },
      async get() {
        return undefined
      },
      async delete() {},
      async clear() {},
    }
    const session = createMailboxSession({
      keyStore: broken,
      now: () => clock,
      legacyKdf: fakeArgon2id,
    })
    const result = await session.unlock({
      userId: TEST_USER_ID,
      method: "passphrase",
      secret: "correct horse battery staple 42",
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    expect(result.unlocked).toBe(true)
    expect(result.prompting).toBe("re-prompt-each-session")
  })

  // "The unlock lives as long as the login does" (spec 3.3 step 4). A reload,
  // an app restart or a closed tab is a NEW worker over the SAME device store.
  describe("device lease", () => {
    const PASS = "correct horse battery staple 42"
    const OTHER_USER = "99999999-9999-4999-8999-999999999999"
    const OTHER_ORG = "00000000-0000-4000-8000-0000000000b2"

    async function unlockedOn(
      store: ReturnType<typeof memoryKeyStore>,
      opts: { userId?: string; leaseOver?: Partial<DeviceLeaseRequest> | null } = {},
    ) {
      const enrollment = await buildEnrollment({ passphrase: PASS, userId: opts.userId })
      const session = createMailboxSession({ keyStore: store, now: () => clock })
      const result = await session.unlock({
        userId: enrollment.userId,
        method: "passphrase",
        secret: PASS,
        wrap: enrollment.passphraseWrap,
        keyring: enrollment.keyring,
        ...(opts.leaseOver === null ? {} : { lease: lease(opts.leaseOver ?? {}) }),
      })
      return { enrollment, result }
    }

    const reloaded = (store: ReturnType<typeof memoryKeyStore>) =>
      createMailboxSession({ keyStore: store, now: () => clock })

    it("keeps the mailbox unlocked across reloads for as long as the login lasts", async () => {
      const store = memoryKeyStore()
      const { enrollment, result } = await unlockedOn(store)
      expect(result.prompting).toBe("restored-from-store")
      // Two weeks and three reloads later, inside the 30 day login.
      for (const days of [1, 7, 14]) {
        clock = 1_000_000 + days * DAY
        const session = reloaded(store)
        expect(
          await session.restore({
            userId: enrollment.userId,
            keyring: enrollment.keyring,
            lease: lease({ expiresAt: 1_000_000 + 30 * DAY }),
          }),
        ).toBe(true)
        const sealed = await sealMessageFixture(enrollment, {
          id: "11111111-1111-4111-8111-111111111111",
          subject: "Still open",
          textBody: "after a reload",
          htmlBody: "<p>after a reload</p>",
        })
        expect((await session.openMessage(sealed)).subject).toBe("Still open")
      }
    })

    it("a token renewal extends the lease, and without one the lease expires and is deleted", async () => {
      const store = memoryKeyStore()
      const { enrollment } = await unlockedOn(store, { leaseOver: { expiresAt: clock + DAY } })
      const renewed = reloaded(store)
      // The renewal moves the end of the login, and with it the lease.
      expect(
        await renewed.extendLease({
          userId: enrollment.userId,
          orgId: ORG_ID,
          expiresAt: clock + 31 * DAY,
        }),
      ).toBe(true)
      clock += 2 * DAY
      expect(
        await reloaded(store).restore({
          userId: enrollment.userId,
          keyring: enrollment.keyring,
          lease: lease(),
        }),
      ).toBe(true)

      // Past the renewed end with no renewal since: asked again, records gone.
      clock += 40 * DAY
      expect(
        await reloaded(store).restore({
          userId: enrollment.userId,
          keyring: enrollment.keyring,
          lease: lease(),
        }),
      ).toBe(false)
      expect(store.size()).toBe(0)
    })

    it("an expired lease is deleted on restore and the user unlocks again", async () => {
      const store = memoryKeyStore()
      const { enrollment } = await unlockedOn(store, { leaseOver: { expiresAt: clock + DAY } })
      clock += 2 * DAY
      const session = reloaded(store)
      expect(
        await session.restore({
          userId: enrollment.userId,
          keyring: enrollment.keyring,
          lease: lease(),
        }),
      ).toBe(false)
      expect(session.isUnlocked()).toBe(false)
      expect(store.size()).toBe(0)
      // A renewal cannot revive a lease that has ended.
      expect(
        await session.extendLease({
          userId: enrollment.userId,
          orgId: ORG_ID,
          expiresAt: clock + 30 * DAY,
        }),
      ).toBe(false)
    })

    it("a lock (sign-out) deletes the lease and every handle", async () => {
      const store = memoryKeyStore()
      const { enrollment } = await unlockedOn(store)
      const session = reloaded(store)
      expect(
        await session.restore({
          userId: enrollment.userId,
          keyring: enrollment.keyring,
          lease: lease(),
        }),
      ).toBe(true)
      await session.lock()
      expect(store.size()).toBe(0)
      expect(
        await reloaded(store).restore({
          userId: enrollment.userId,
          keyring: enrollment.keyring,
          lease: lease(),
        }),
      ).toBe(false)
    })

    it("user A's stored handles never open for user B, nor for A in another organisation", async () => {
      const store = memoryKeyStore()
      const { enrollment } = await unlockedOn(store, { leaseOver: { exclusive: false } })
      // B presents A's very keyring (the worst case): still nothing.
      expect(
        await reloaded(store).restore({
          userId: OTHER_USER,
          keyring: enrollment.keyring,
          lease: lease({ exclusive: false }),
        }),
      ).toBe(false)
      expect(
        await reloaded(store).restore({
          userId: enrollment.userId,
          keyring: enrollment.keyring,
          lease: lease({ orgId: OTHER_ORG, exclusive: false }),
        }),
      ).toBe(false)
      // A's lease cannot be moved by anyone else either.
      expect(
        await reloaded(store).extendLease({
          userId: OTHER_USER,
          orgId: ORG_ID,
          expiresAt: clock + 60 * DAY,
        }),
      ).toBe(false)
      // And A, non-exclusive, still has it.
      expect(
        await reloaded(store).restore({
          userId: enrollment.userId,
          keyring: enrollment.keyring,
          lease: lease({ exclusive: false }),
        }),
      ).toBe(true)
    })

    it("in a browser, another user signing in deletes the previous user's handles", async () => {
      const store = memoryKeyStore()
      const { enrollment } = await unlockedOn(store)
      expect(store.size()).toBeGreaterThan(0)
      // User B's session starts on this browser: B has nothing to restore,
      // and A's records go with A's ended session.
      const other = await buildEnrollment({ passphrase: PASS, userId: OTHER_USER })
      expect(
        await reloaded(store).restore({
          userId: OTHER_USER,
          keyring: other.keyring,
          lease: lease(),
        }),
      ).toBe(false)
      expect(store.size()).toBe(0)
      expect(
        await reloaded(store).restore({
          userId: enrollment.userId,
          keyring: enrollment.keyring,
          lease: lease(),
        }),
      ).toBe(false)
    })

    it("in a shell, two saved servers keep their own unlocks side by side", async () => {
      const store = memoryKeyStore()
      const first = await unlockedOn(store, { leaseOver: { exclusive: false } })
      const second = await unlockedOn(store, {
        userId: OTHER_USER,
        leaseOver: { orgId: OTHER_ORG, exclusive: false },
      })
      expect(
        await reloaded(store).restore({
          userId: first.enrollment.userId,
          keyring: first.enrollment.keyring,
          lease: lease({ exclusive: false }),
        }),
      ).toBe(true)
      expect(
        await reloaded(store).restore({
          userId: OTHER_USER,
          keyring: second.enrollment.keyring,
          lease: lease({ orgId: OTHER_ORG, exclusive: false }),
        }),
      ).toBe(true)
    })

    it("persists nothing without a lease", async () => {
      const store = memoryKeyStore()
      const { result } = await unlockedOn(store, { leaseOver: null })
      expect(result.prompting).toBe("re-prompt-each-session")
      expect(store.size()).toBe(0)
    })

    it("stores only non-extractable handles and a lease that holds no key material", async () => {
      const store = memoryKeyStore()
      await unlockedOn(store)
      const ids = (await store.keys?.()) ?? []
      expect(ids.length).toBeGreaterThan(1)
      let leases = 0
      for (const id of ids) {
        const value = await store.get(id)
        if (value instanceof CryptoKey) {
          expect(value.extractable).toBe(false)
          continue
        }
        leases++
        // Plain fields only: no CryptoKey, no bytes.
        expect(JSON.parse(JSON.stringify(value))).toEqual(value)
        expect(Object.keys(value as object).sort()).toEqual([
          "expiresAt",
          "ids",
          "orgId",
          "userId",
          "v",
        ])
      }
      expect(leases).toBe(1)
    })
  })
})
