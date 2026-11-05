// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The wiring, which is where a detector usually dies: the check itself can be
// perfect and still never run, or run against the wrong key, or alarm on a
// shared mailbox where plaintext is correct.
//
// Three properties are pinned here:
//   * the signing key is taken from THIS DEVICE, never from the identity list
//     being checked, because a key taken from the answer verifies nothing,
//   * a sweep only ever looks at rows of a personal mailbox the server says is
//     `ready`, so a shared org mailbox cannot produce a false alarm,
//   * a row already verified in this tab is not verified again, which is what
//     keeps the per-sync cost proportional to new mail.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { loadAccounts } from "~/modules/mail/mail-account-store"
import { upsertConversation } from "~/modules/mail/mail-conversation-store"
import {
  loadMessages,
  resetMailMessageStore,
  sealedRowsForDowngradeCheck,
} from "~/modules/mail/mail-message-store"
import type { SealedMessagePayload, SealVerdict } from "~/modules/mailbox/crypto-protocol"
import { currentDowngradeFindings, resetDowngradeAlarm } from "~/modules/mailbox/downgrade-detector"
import { clearWrappedKeyring, saveWrappedKeyring } from "~/modules/mailbox/keyring-storage"
import { pinnedSignSpki, runDowngradeSweep } from "~/modules/mailbox/MailboxDowngradeAlarmHost"
import type { KeyringView, MailboxApi } from "~/modules/mailbox/mailbox-api"
import { type Bytes, bytesToBase64, encodeUtf8 } from "~/modules/mailbox/mailbox-bytes"
import {
  createMemoryIndexBlobStore,
  type IndexBlobStore,
} from "~/modules/mailbox/search-index/index-blob-store"

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"

/** Real Ed25519 SPKIs, so nothing here passes by way of a parse failure. */
async function signSpki(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair
  return bytesToBase64(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)) as Bytes,
  )
}

let PINNED_SIGN_SPKI = ""
let SERVER_SIGN_SPKI = ""

function deviceKeyring(spki = PINNED_SIGN_SPKI) {
  saveWrappedKeyring(USER_ID, [
    {
      keyId: 1,
      status: "active",
      ecdhSpki: "ZWNkaA==",
      signSpki: spki,
      wrappedEcdhPrivate: "",
      wrappedSignPrivate: "",
      ecdhWrapIv: "",
      signWrapIv: "",
    },
  ])
}

function keyringView(): KeyringView {
  return {
    identityId: "identity-1",
    keyId: 1,
    identities: [
      {
        id: "identity-1",
        keyId: 1,
        status: "active",
        ecdhPublicKey: "ZWNkaA==",
        // The server offering a DIFFERENT signing key is the attack. The sweep
        // must not adopt it.
        signPublicKey: SERVER_SIGN_SPKI,
        attestation: "YXR0ZXN0YXRpb24=",
        createdAt: "2026-08-20T10:00:00.000Z",
        retiredAt: null,
      },
    ],
    wraps: [],
  }
}

/** The generic `get` of the real client cannot be met by a plain literal. */
function fakeApi(get: () => Promise<unknown>): MailboxApi {
  return {
    get: (async () => get()) as MailboxApi["get"],
    post: (async () => ({})) as MailboxApi["post"],
    delete: (async () => ({})) as MailboxApi["delete"],
  }
}

function row(id: string): SealedMessagePayload {
  return {
    id,
    encVersion: 1,
    encKeyId: 1,
    contentKeyWrapped: "d3JhcHBlZA==",
    contentKeyEpk: "ZXBr",
    subjectCiphertext: null,
    textBodyCiphertext: null,
    htmlBodyCiphertext: null,
    snippetCiphertext: null,
  }
}

describe("runDowngradeSweep", () => {
  beforeEach(async () => {
    resetDowngradeAlarm()
    clearWrappedKeyring(USER_ID)
    PINNED_SIGN_SPKI = await signSpki()
    SERVER_SIGN_SPKI = await signSpki()
  })

  it("pins the signing key from this device, not from the server answer", async () => {
    deviceKeyring()
    expect(pinnedSignSpki(USER_ID)).toBe(PINNED_SIGN_SPKI)

    const verifySeals = vi.fn(async (rows: readonly SealedMessagePayload[]) =>
      rows.map((r) => ({ id: r.id, sealed: true, opens: true, keyId: 1 }) satisfies SealVerdict),
    )
    await runDowngradeSweep({
      userId: USER_ID,
      api: fakeApi(async () => keyringView()),
      crypto: { verifySeals, ledgerMac: async () => [] },
      verified: new Set(),
      rows: () => [row("msg-1")],
    })
    // The server's identity list is signed by a key this device never pinned,
    // so the list is unattested and the alarm is raised.
    expect(currentDowngradeFindings().map((f) => f.kind)).toContain("unattested-identity")
  })

  it("does nothing at all when this device has never enrolled", async () => {
    const verifySeals = vi.fn(async () => [])
    await runDowngradeSweep({
      userId: USER_ID,
      api: fakeApi(async () => {
        throw new Error("the sweep must not call the server before it has a pinned key")
      }),
      crypto: { verifySeals, ledgerMac: async () => [] },
      verified: new Set(),
      rows: () => [row("msg-1")],
    })
    expect(verifySeals).not.toHaveBeenCalled()
    expect(currentDowngradeFindings()).toEqual([])
  })

  it("verifies a row once per tab, not once per sync", async () => {
    deviceKeyring()
    const seen: string[][] = []
    const crypto = {
      verifySeals: async (rows: readonly SealedMessagePayload[]) => {
        seen.push(rows.map((r) => r.id))
        return rows.map((r) => ({ id: r.id, sealed: true, opens: true, keyId: 1 }))
      },
      ledgerMac: async () => [],
    }
    const verified = new Set<string>()
    const api = fakeApi(async () => keyringView())
    await runDowngradeSweep({ userId: USER_ID, api, crypto, verified, rows: () => [row("msg-1")] })
    await runDowngradeSweep({
      userId: USER_ID,
      api,
      crypto,
      verified,
      rows: () => [row("msg-1"), row("msg-2")],
    })
    expect(seen).toEqual([["msg-1"], ["msg-2"]])
  })
})

// ---------------------------------------------------------------------------
// The ledger half of the sweep (spec section 9.2 and section 9.6).
//
// The per-row seal verdict only ever looks at mail as it ARRIVES. Everything
// that happens to a message afterwards, a rewritten ciphertext or a row taken
// out of this browser's own record, is invisible to it. That is what the MAC
// ledger is for, and a ledger that no sync path calls is not a control.
// ---------------------------------------------------------------------------

let ledgerKey: CryptoKey

async function fakeLedgerMac(statements: readonly string[]): Promise<string[]> {
  const macs: string[] = []
  for (const statement of statements) {
    const mac = await crypto.subtle.sign("HMAC", ledgerKey, encodeUtf8(statement))
    macs.push(bytesToBase64(new Uint8Array(mac) as Bytes))
  }
  return macs
}

function sweepCrypto() {
  return {
    verifySeals: async (rows: readonly SealedMessagePayload[]) =>
      rows.map((r) => ({ id: r.id, sealed: true, opens: true, keyId: 1 }) satisfies SealVerdict),
    ledgerMac: fakeLedgerMac,
  }
}

describe("runDowngradeSweep keeps the client ledger", () => {
  let store: IndexBlobStore

  beforeEach(async () => {
    resetDowngradeAlarm()
    clearWrappedKeyring(USER_ID)
    PINNED_SIGN_SPKI = await signSpki()
    SERVER_SIGN_SPKI = await signSpki()
    deviceKeyring()
    store = createMemoryIndexBlobStore()
    ledgerKey = await crypto.subtle.importKey(
      "raw",
      encodeUtf8("ledger-test-key"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
  })

  function sweep(rows: SealedMessagePayload[], verified: Set<string>) {
    return runDowngradeSweep({
      userId: USER_ID,
      api: fakeApi(async () => keyringView()),
      crypto: sweepCrypto(),
      store,
      verified,
      rows: () => rows,
      meta: () => ({}),
    })
  }

  /**
   * The fixture keyring is deliberately unattested, so every sweep here also
   * raises `unattested-identity`. These assertions are about the LEDGER half.
   */
  function ledgerFindings() {
    return currentDowngradeFindings().filter((f) => f.kind.startsWith("ledger-"))
  }

  async function ledgerBlob(): Promise<{ entries: { messageId: string; mac: string }[] }> {
    const raw = await store.get(`mailbox-ledger:${USER_ID}`)
    expect(raw).not.toBeNull()
    return JSON.parse(raw as string)
  }

  it("appends what the sweep saw, so the ledger is not dead code", async () => {
    await sweep([row("msg-1"), row("msg-2")], new Set())
    const blob = await ledgerBlob()
    expect(blob.entries.map((e) => e.messageId)).toEqual(["msg-1", "msg-2"])
    for (const entry of blob.entries) expect(entry.mac.length).toBeGreaterThan(0)
  })

  it("alarms when a message it already saw has its ciphertext rewritten", async () => {
    const verified = new Set<string>()
    await sweep([row("msg-1"), row("msg-2")], verified)
    resetDowngradeAlarm()
    const rewritten = { ...row("msg-2"), textBodyCiphertext: "cmV3cml0dGVu" }
    await sweep([row("msg-1"), rewritten], verified)
    const found = currentDowngradeFindings().filter((f) => f.kind === "ledger-ciphertext-changed")
    expect(found.map((f) => f.subject)).toEqual(["msg-2"])
  })

  it("alarms when an entry is removed from the middle of its own chain", async () => {
    const verified = new Set<string>()
    await sweep([row("msg-1"), row("msg-2"), row("msg-3")], verified)
    resetDowngradeAlarm()
    const blob = await ledgerBlob()
    ;(blob.entries as unknown[]).splice(1, 1)
    await store.put(`mailbox-ledger:${USER_ID}`, JSON.stringify(blob))

    await sweep([row("msg-1"), row("msg-2"), row("msg-3")], verified)
    expect(currentDowngradeFindings().map((f) => f.kind)).toContain("ledger-chain-broken")
  })

  it("does not alarm on the first sweep of a device that has no ledger yet", async () => {
    await sweep([row("msg-1")], new Set())
    expect(ledgerFindings()).toEqual([])
  })

  it("does not silently discard a truncated ledger file", async () => {
    await sweep([row("msg-1")], new Set())
    const raw = (await store.get(`mailbox-ledger:${USER_ID}`)) as string
    await store.put(`mailbox-ledger:${USER_ID}`, raw.slice(0, Math.floor(raw.length / 2)))
    resetDowngradeAlarm()
    await sweep([row("msg-1")], new Set())
    expect(currentDowngradeFindings().map((f) => f.kind)).toContain("ledger-chain-broken")
  })

  it("ignores a ledger belonging to another mailbox instead of alarming on it", async () => {
    await store.put(
      `mailbox-ledger:${USER_ID}`,
      JSON.stringify({
        version: 1,
        userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        entries: [
          {
            messageId: "not-mine",
            externalMessageId: "",
            receivedAt: "",
            ciphertextDigest: "x",
            mac: "y",
          },
        ],
      }),
    )
    await sweep([row("msg-1")], new Set())
    expect(ledgerFindings()).toEqual([])
    const blob = await ledgerBlob()
    expect(blob.entries.map((e) => e.messageId)).toEqual(["msg-1"])
  })
})

describe("sealedRowsForDowngradeCheck", () => {
  beforeEach(() => {
    resetMailMessageStore()
  })

  async function loadOneMessage(accountEncryptionState: string | null, ownerType: "user" | "org") {
    await loadAccounts({
      get: (async () => [
        {
          id: "acct-1",
          ownerType,
          emailAddress: "someone@example.test",
          encryptionState: accountEncryptionState,
        },
      ]) as <T>() => Promise<T>,
      post: (async () => ({})) as <T>() => Promise<T>,
    })
    upsertConversation({
      id: CONVERSATION_ID,
      accountId: "acct-1",
      subject: "Thread",
    } as never)
    await loadMessages(
      {
        get: async () =>
          ({
            conversation: { id: CONVERSATION_ID, accountId: "acct-1", subject: "Thread" },
            messages: [
              {
                id: "msg-1",
                conversationId: CONVERSATION_ID,
                fromAddress: { email: "a@example.test" },
                toAddresses: [],
                ccAddresses: [],
                subject: "In the clear",
                htmlBody: "<p>hi</p>",
                textBody: "hi",
                direction: "inbound",
                sentAt: "2026-08-27T10:00:00.000Z",
                isRead: false,
              },
            ],
            nextMessageCursor: null,
          }) as never,
      },
      CONVERSATION_ID,
    )
  }

  it("reports a plaintext row of a ready personal mailbox, which is the downgrade", async () => {
    await loadOneMessage("ready", "user")
    const rows = sealedRowsForDowngradeCheck()
    expect(rows).toHaveLength(1)
    // Raw, never defaulted to 1: defaulting is how an unsealed row would be
    // made to look sealed.
    expect(rows[0].encVersion).toBe(0)
    expect(rows[0].contentKeyWrapped).toBe("")
  })

  it("never looks at a shared org mailbox, where plaintext is correct", async () => {
    await loadOneMessage("ready", "org")
    expect(sealedRowsForDowngradeCheck()).toEqual([])
  })

  it("never looks at a personal mailbox that is not ready", async () => {
    await loadOneMessage("pending", "user")
    expect(sealedRowsForDowngradeCheck()).toEqual([])
  })

  it("never looks at a mailbox whose state the server did not report", async () => {
    await loadOneMessage(null, "user")
    expect(sealedRowsForDowngradeCheck()).toEqual([])
  })
})
