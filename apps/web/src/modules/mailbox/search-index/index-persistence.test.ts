// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-SEC-12 and the persistence round trip (blueprint tasks 10.2 and 10.3).
//
// The whole point of the client index is that it is the one place decrypted
// mail is allowed to accumulate on a device. If it accumulated in the clear, a
// stolen laptop would yield the mailbox with no unlock at all, and the design
// would have moved the plaintext rather than removed it. So this file drives
// the REAL crypto session (real Account Key, real D7, real AES-GCM) and then
// reads the persisted bytes back the way an attacker would.

import { describe, expect, it } from "vitest"
import { createMailboxSession } from "~/modules/mailbox/crypto-session"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  TEST_USER_ID,
} from "~/modules/mailbox/mailbox-fixtures"
import { createMemoryIndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"
import {
  loadIndexCursor,
  persistIndex,
  restoreIndex,
  saveIndexCursor,
  sessionShardSealer,
} from "~/modules/mailbox/search-index/index-persistence"
import { createMemorySearchIndexAdapter } from "~/modules/mailbox/search-index/memory-adapter"

const PASSPHRASE = "correct horse battery staple 42"
/** A phrase that appears in no library, no key, and no envelope field. */
const DISTINCTIVE = "pangolinsemaphore"

async function unlockedSession() {
  const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
  const session = createMailboxSession({
    keyStore: memoryKeyStore(),
    legacyKdf: fakeArgon2id,
  })
  await session.unlock({
    userId: TEST_USER_ID,
    method: "passphrase",
    secret: PASSPHRASE,
    wrap: enrollment.passphraseWrap,
    keyring: enrollment.keyring,
  })
  return { session, enrollment }
}

describe("T-SEC-12: the persisted client index yields nothing without unlock", () => {
  it("stores no recoverable plaintext token in any persisted blob", async () => {
    const { session } = await unlockedSession()
    const adapter = createMemorySearchIndexAdapter()
    await adapter.add({
      id: "m1",
      accountId: "acc-1",
      conversationId: "conv-1",
      sentAt: "2026-08-01T00:00:00.000Z",
      metadata: "ada@example.com inbox",
      content: `the ${DISTINCTIVE} invoice is overdue`,
    })

    const store = createMemoryIndexBlobStore()
    await persistIndex({ adapter, store, sealer: sessionShardSealer(session) })

    const keys = await store.keys()
    // Non-vacuity: an implementation that persisted NOTHING would pass every
    // assertion below without storing a single byte.
    expect(keys.length).toBeGreaterThan(0)

    for (const key of keys) {
      const blob = await store.get(key)
      expect(blob).toBeTruthy()
      const raw = blob as string
      expect(raw).not.toContain(DISTINCTIVE)
      expect(raw).not.toContain("invoice")
      expect(raw).not.toContain("ada@example.com")
      // Base64 hides nothing: decode and look again, byte for byte.
      const decoded = atob(raw)
      expect(decoded).not.toContain(DISTINCTIVE)
      expect(decoded).not.toContain("invoice")
      expect(decoded).not.toContain("ada@example.com")
    }
  })

  it("restores into a working index for the session that sealed it", async () => {
    const { session } = await unlockedSession()
    const adapter = createMemorySearchIndexAdapter()
    await adapter.add({
      id: "m1",
      accountId: "acc-1",
      conversationId: "conv-1",
      sentAt: "2026-08-01T00:00:00.000Z",
      metadata: "ada@example.com inbox",
      content: `the ${DISTINCTIVE} invoice is overdue`,
    })
    const store = createMemoryIndexBlobStore()
    const sealer = sessionShardSealer(session)
    await persistIndex({ adapter, store, sealer })

    const restoredAdapter = createMemorySearchIndexAdapter()
    expect(await restoredAdapter.search({ text: DISTINCTIVE })).toEqual([])
    const outcome = await restoreIndex({ adapter: restoredAdapter, store, sealer })
    expect(outcome.restored).toBe(true)
    expect(await restoredAdapter.search({ text: DISTINCTIVE })).toEqual(["m1"])
  })

  it("refuses to restore a shard that was sealed for another mailbox", async () => {
    const first = await unlockedSession()
    const second = await unlockedSession()
    const adapter = createMemorySearchIndexAdapter()
    await adapter.add({
      id: "m1",
      accountId: "acc-1",
      conversationId: "conv-1",
      sentAt: "2026-08-01T00:00:00.000Z",
      metadata: "inbox",
      content: DISTINCTIVE,
    })
    const store = createMemoryIndexBlobStore()
    await persistIndex({ adapter, store, sealer: sessionShardSealer(first.session) })

    const restoredAdapter = createMemorySearchIndexAdapter()
    const outcome = await restoreIndex({
      adapter: restoredAdapter,
      store,
      sealer: sessionShardSealer(second.session),
    })
    // A shard that does not authenticate is a rebuild, never a throw and never
    // a partially restored index.
    expect(outcome.restored).toBe(false)
    if (outcome.restored) throw new Error("unreachable")
    expect(outcome.reason).toBe("shard-did-not-open")
    expect(await restoredAdapter.size()).toBe(0)
  })

  it("keeps the last indexed cursor with the index", async () => {
    const { session } = await unlockedSession()
    const store = createMemoryIndexBlobStore()
    const sealer = sessionShardSealer(session)
    expect(await loadIndexCursor({ store, sealer })).toBeNull()
    await saveIndexCursor({ store, sealer, cursor: "cursor-42" })
    expect(await loadIndexCursor({ store, sealer })).toBe("cursor-42")
    // The cursor is a mailbox fact too: it says how far this device has read.
    const raw = (await store.get([...(await store.keys())].find((k) => k.includes("cursor"))!))!
    expect(atob(raw)).not.toContain("cursor-42")
  })

  it("refuses a shard whose id was swapped, so a blob cannot be relocated", async () => {
    const { session } = await unlockedSession()
    const sealer = sessionShardSealer(session)
    const sealed = await sealer.seal("shard-a", "the quarterly numbers")
    await expect(sealer.open("shard-b", sealed)).rejects.toThrow()
    expect(await sealer.open("shard-a", sealed)).toBe("the quarterly numbers")
  })
})
