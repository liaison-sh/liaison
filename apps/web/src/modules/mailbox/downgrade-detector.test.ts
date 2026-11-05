// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-SEC-14. The downgrade detector, tested against the REAL crypto: a real
// enrollment, a real keyring, real seals, and a real unlocked worker session.
// Nothing here is mocked, because the property under test is precisely that
// the check is cryptographic rather than a comparison of two server-written
// columns (spec section 9.2).
//
// The three alarm cases are asserted INDEPENDENTLY: each fixture is corrupted
// in exactly one way, so a single over-broad implementation cannot make all
// three pass for the wrong reason.

import {
  generateContentKey,
  mailboxAad,
  sealContentKey,
  sealField,
  signKeyringAttestation,
} from "@liaison/mailbox-crypto"
import { unwrapIdentityKey } from "@liaison/mailbox-crypto/src/client"
import { beforeEach, describe, expect, it } from "vitest"
import { createMailboxCryptoClient } from "~/modules/mailbox/crypto-client"
import type { SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import { createMailboxSession, type MailboxSession } from "~/modules/mailbox/crypto-session"
import { handleWorkerRequest } from "~/modules/mailbox/crypto-worker-handler"
import {
  currentDowngradeFindings,
  type DowngradeFinding,
  ledgerRowFromSealed,
  loadDowngradeAlarm,
  MAX_ROWS_PER_SYNC,
  openMailboxLedger,
  resetDowngradeAlarm,
  verifySyncBatch,
} from "~/modules/mailbox/downgrade-detector"
import type { IdentityView } from "~/modules/mailbox/mailbox-api"
import { type Bytes, bytesToBase64, encodeUtf8 } from "~/modules/mailbox/mailbox-bytes"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealMessageFixture,
  type TestEnrollment,
} from "~/modules/mailbox/mailbox-fixtures"
import { createMemoryIndexBlobStore } from "~/modules/mailbox/search-index/index-blob-store"

const PASSPHRASE = "correct horse battery staple 9"

async function unlockedSession(enrollment: TestEnrollment): Promise<MailboxSession> {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  await session.unlock({
    userId: enrollment.userId,
    method: "passphrase",
    secret: PASSPHRASE,
    wrap: enrollment.passphraseWrap,
    keyring: enrollment.keyring,
  })
  return session
}

/** The pinned Ed25519 signing key, and an attestation over exactly `views`. */
async function attestationOver(
  enrollment: TestEnrollment,
  views: readonly {
    keyId: number
    status: "active" | "retired"
    ecdhSpki: Bytes
    signSpki: Bytes
  }[],
): Promise<string> {
  const { signPrivate } = await unwrapIdentityKey({
    accountKey: enrollment.accountKey,
    userId: enrollment.userId,
    entry: enrollment.entry,
  })
  const signature = await signKeyringAttestation({
    signPrivateKey: signPrivate,
    userId: enrollment.userId,
    identities: views.map((view) => ({
      keyId: view.keyId,
      status: view.status,
      ecdhSpki: view.ecdhSpki,
      signSpki: view.signSpki,
    })),
  })
  return bytesToBase64(signature)
}

function identityView(input: {
  keyId: number
  ecdhSpki: Bytes
  signSpki: Bytes
  attestation: string
  status?: "active" | "retired"
}): IdentityView {
  return {
    id: `identity-${input.keyId}`,
    keyId: input.keyId,
    status: input.status ?? "active",
    ecdhPublicKey: bytesToBase64(input.ecdhSpki),
    signPublicKey: bytesToBase64(input.signSpki),
    attestation: input.attestation,
    createdAt: "2026-08-20T10:00:00.000Z",
    retiredAt: null,
  }
}

/** The honest keyring: one active identity, attested by its own signing key. */
async function honestKeyring(enrollment: TestEnrollment): Promise<IdentityView[]> {
  const view = {
    keyId: enrollment.entry.keyId,
    status: "active" as const,
    ecdhSpki: enrollment.entry.ecdhSpki,
    signSpki: enrollment.entry.signSpki,
  }
  return [identityView({ ...view, attestation: await attestationOver(enrollment, [view]) })]
}

/**
 * The key-substitution attack, built the way an operator would build it: a real
 * seal, to a key the operator holds, carrying the VICTIM's key id so a metadata
 * comparison of `enc_key_id` would pass.
 */
async function sealToForeignKey(
  victim: TestEnrollment,
  attacker: TestEnrollment,
  id: string,
): Promise<SealedMessagePayload> {
  const contentKey = generateContentKey()
  const sealed = await sealContentKey({
    recipientEcdhSpki: attacker.entry.ecdhSpki,
    userId: victim.userId,
    keyId: victim.entry.keyId,
    contentKey,
  })
  return {
    id,
    encVersion: 1,
    encKeyId: victim.entry.keyId,
    contentKeyWrapped: bytesToBase64(sealed.wrapped),
    contentKeyEpk: bytesToBase64(sealed.epkSpki),
    subjectCiphertext: bytesToBase64(
      await sealField({
        contentKey,
        context: mailboxAad.messageSubject(id),
        keyId: victim.entry.keyId,
        plaintext: encodeUtf8("intercepted"),
      }),
    ),
    textBodyCiphertext: null,
    htmlBodyCiphertext: null,
    snippetCiphertext: null,
  }
}

function unsealedRow(id: string): SealedMessagePayload {
  return {
    id,
    encVersion: 0,
    encKeyId: 0,
    contentKeyWrapped: "",
    contentKeyEpk: "",
    subjectCiphertext: null,
    textBodyCiphertext: null,
    htmlBodyCiphertext: null,
    snippetCiphertext: null,
  }
}

function kinds(findings: readonly DowngradeFinding[]): string[] {
  return findings.map((finding) => finding.kind).sort()
}

describe("T-SEC-14 downgrade detector, per sync verification", () => {
  let victim: TestEnrollment
  let session: MailboxSession
  let identities: IdentityView[]

  beforeEach(async () => {
    resetDowngradeAlarm()
    victim = await buildEnrollment({ passphrase: PASSPHRASE })
    session = await unlockedSession(victim)
    identities = await honestKeyring(victim)
  })

  it("T-SEC-14 an honest sync raises no finding at all", async () => {
    const rows = [
      await sealMessageFixture(victim, {
        id: "msg-1",
        subject: "hello",
        textBody: "body",
        htmlBody: "<p>body</p>",
      }),
    ]
    const report = await verifySyncBatch({
      userId: victim.userId,
      identities,
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows,
      crypto: session,
    })
    expect(report.findings).toEqual([])
    expect(report.identitiesAttested).toBe(true)
    expect(report.verifiedIds).toEqual(["msg-1"])
    expect(currentDowngradeFindings()).toEqual([])
  })

  it("T-SEC-14 case a, an unsealed row raises an alarm", async () => {
    const report = await verifySyncBatch({
      userId: victim.userId,
      identities,
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows: [unsealedRow("msg-plain")],
      crypto: session,
    })
    expect(kinds(report.findings)).toEqual(["unsealed-row"])
    expect(report.findings[0].subject).toBe("msg-plain")
    expect(currentDowngradeFindings()).toHaveLength(1)
  })

  it("T-SEC-14 case b, a row sealed to a key the client does not hold raises an alarm", async () => {
    const attacker = await buildEnrollment({ passphrase: PASSPHRASE, userId: victim.userId })
    const row = await sealToForeignKey(victim, attacker, "msg-substituted")
    // The metadata an operator controls is honest here, which is the point:
    // only the real unwrap can tell this row from a legitimate one.
    expect(row.encVersion).toBe(1)
    expect(row.encKeyId).toBe(victim.entry.keyId)

    const report = await verifySyncBatch({
      userId: victim.userId,
      identities,
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows: [row],
      crypto: session,
    })
    expect(kinds(report.findings)).toEqual(["unopenable-seal"])
    expect(report.findings[0].subject).toBe("msg-substituted")
  })

  it("T-SEC-14 case c, an unattested extra active identity raises an alarm", async () => {
    const attacker = await buildEnrollment({ passphrase: PASSPHRASE, userId: victim.userId })
    const injected = identityView({
      keyId: 200,
      ecdhSpki: attacker.entry.ecdhSpki,
      signSpki: attacker.entry.signSpki,
      attestation: identities[0].attestation,
    })
    const report = await verifySyncBatch({
      userId: victim.userId,
      identities: [...identities, injected],
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows: [],
      crypto: session,
    })
    expect(kinds(report.findings)).toEqual(["unattested-identity"])
    expect(report.identitiesAttested).toBe(false)
  })

  it("T-SEC-14 case c holds when the injected identity carries its own attestation", async () => {
    const attacker = await buildEnrollment({ passphrase: PASSPHRASE, userId: victim.userId })
    const views = [
      {
        keyId: victim.entry.keyId,
        status: "active" as const,
        ecdhSpki: victim.entry.ecdhSpki,
        signSpki: victim.entry.signSpki,
      },
      {
        keyId: 200,
        status: "active" as const,
        ecdhSpki: attacker.entry.ecdhSpki,
        signSpki: attacker.entry.signSpki,
      },
    ]
    // Signed by the ATTACKER over the full list. It verifies under the
    // attacker's key and must still fail, because the client pins its own.
    const forged = await attestationOver(attacker, views)
    const report = await verifySyncBatch({
      userId: victim.userId,
      identities: views.map((view) => identityView({ ...view, attestation: forged })),
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows: [],
      crypto: session,
    })
    expect(kinds(report.findings)).toEqual(["unattested-identity"])
  })

  it("T-SEC-14 case c, a keyring the server signed with its own key is not attested", async () => {
    // The strongest form of the substitution: the operator does not ADD a row,
    // it replaces the identity outright with one whose signing key it holds and
    // signs a perfectly self consistent list. Everything the server returned
    // agrees with everything else the server returned, which is exactly why
    // verification has to be anchored on a key the client pinned instead.
    const attacker = await buildEnrollment({ passphrase: PASSPHRASE, userId: victim.userId })
    const views = [
      {
        keyId: attacker.entry.keyId,
        status: "active" as const,
        ecdhSpki: attacker.entry.ecdhSpki,
        signSpki: attacker.entry.signSpki,
      },
    ]
    const selfConsistent = await attestationOver(attacker, views)
    const report = await verifySyncBatch({
      userId: victim.userId,
      identities: views.map((view) => identityView({ ...view, attestation: selfConsistent })),
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows: [],
      crypto: session,
    })
    expect(kinds(report.findings)).toEqual(["unattested-identity"])
    expect(report.identitiesAttested).toBe(false)
  })

  it("T-SEC-14 the three cases raise independently when combined", async () => {
    const attacker = await buildEnrollment({ passphrase: PASSPHRASE, userId: victim.userId })
    const injected = identityView({
      keyId: 200,
      ecdhSpki: attacker.entry.ecdhSpki,
      signSpki: attacker.entry.signSpki,
      attestation: identities[0].attestation,
    })
    const report = await verifySyncBatch({
      userId: victim.userId,
      identities: [...identities, injected],
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows: [unsealedRow("msg-plain"), await sealToForeignKey(victim, attacker, "msg-substituted")],
      crypto: session,
    })
    expect(kinds(report.findings)).toEqual([
      "unattested-identity",
      "unopenable-seal",
      "unsealed-row",
    ])
  })

  it("a locked mailbox defers verification instead of alarming", async () => {
    await session.lock()
    const rows = [unsealedRow("msg-plain")]
    const report = await verifySyncBatch({
      userId: victim.userId,
      identities,
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows,
      crypto: session,
    })
    expect(report.findings).toEqual([])
    expect(report.deferredIds).toEqual(["msg-plain"])
    expect(report.verifiedIds).toEqual([])
  })

  it("bounds the per sync cost by deferring the overflow rather than skipping it", async () => {
    const row = await sealMessageFixture(victim, {
      id: "msg-1",
      subject: "hello",
      textBody: "body",
      htmlBody: "<p>body</p>",
    })
    const rows = Array.from({ length: 5 }, (_, index) => ({ ...row, id: `msg-${index}` }))
    const report = await verifySyncBatch({
      userId: victim.userId,
      identities,
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows,
      crypto: session,
      maxRows: 2,
    })
    expect(report.verifiedIds).toEqual(["msg-0", "msg-1"])
    expect(report.deferredIds).toEqual(["msg-2", "msg-3", "msg-4"])
    expect(MAX_ROWS_PER_SYNC).toBeGreaterThan(0)
  })

  it("the alarm is sticky: nothing the server sends clears it", async () => {
    await verifySyncBatch({
      userId: victim.userId,
      identities,
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows: [unsealedRow("msg-plain")],
      crypto: session,
    })
    expect(currentDowngradeFindings()).toHaveLength(1)
    // A clean sync afterwards, which is exactly what an operator who put the
    // row back would serve. The finding must survive it.
    const clean = await verifySyncBatch({
      userId: victim.userId,
      identities,
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows: [
        await sealMessageFixture(victim, {
          id: "msg-1",
          subject: "hello",
          textBody: "body",
          htmlBody: "<p>body</p>",
        }),
      ],
      crypto: session,
    })
    expect(clean.findings).toEqual([])
    expect(currentDowngradeFindings()).toHaveLength(1)
  })

  it("a raised alarm survives a reload through the persisted store", async () => {
    const store = createMemoryIndexBlobStore()
    await verifySyncBatch({
      userId: victim.userId,
      identities,
      trustedSignSpki: bytesToBase64(victim.entry.signSpki),
      rows: [unsealedRow("msg-plain")],
      crypto: session,
      store,
    })
    resetDowngradeAlarm()
    expect(currentDowngradeFindings()).toEqual([])
    await loadDowngradeAlarm(store, victim.userId)
    expect(kinds(currentDowngradeFindings())).toEqual(["unsealed-row"])
  })
})

describe("T-SEC-14 the worker protocol round trip", () => {
  it("carries verdicts and MACs through the real page to worker protocol", async () => {
    resetDowngradeAlarm()
    const enrollment = await buildEnrollment({ passphrase: PASSPHRASE })
    const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
    const client = createMailboxCryptoClient({
      post: (request) => handleWorkerRequest(session, request),
    })
    await client.unlock({
      userId: enrollment.userId,
      method: "passphrase",
      secret: PASSPHRASE,
      wrap: enrollment.passphraseWrap,
      keyring: enrollment.keyring,
    })
    const good = await sealMessageFixture(enrollment, {
      id: "msg-1",
      subject: "hello",
      textBody: "body",
      htmlBody: "<p>body</p>",
    })
    const verdicts = await client.verifySeals([good, unsealedRow("msg-plain")])
    expect(verdicts).toEqual([
      { id: "msg-1", sealed: true, opens: true, keyId: enrollment.entry.keyId },
      { id: "msg-plain", sealed: false, opens: false, keyId: 0 },
    ])

    const macs = await client.ledgerMac(["statement one", "statement two"])
    expect(macs).toHaveLength(2)
    expect(macs[0]).not.toBe(macs[1])
    // Deterministic under the same Account Key, which is what makes the chain
    // checkable on the next load.
    expect(await client.ledgerMac(["statement one"])).toEqual([macs[0]])

    await client.lock()
    await expect(client.verifySeals([good])).rejects.toThrow()
    await expect(client.ledgerMac(["statement one"])).rejects.toThrow()
  })
})

describe("T-SEC-14 the client MAC ledger", () => {
  let victim: TestEnrollment
  let session: MailboxSession
  let rows: SealedMessagePayload[]

  beforeEach(async () => {
    resetDowngradeAlarm()
    victim = await buildEnrollment({ passphrase: PASSPHRASE })
    session = await unlockedSession(victim)
    rows = [
      await sealMessageFixture(victim, {
        id: "msg-1",
        subject: "one",
        textBody: "body one",
        htmlBody: "<p>one</p>",
      }),
      await sealMessageFixture(victim, {
        id: "msg-2",
        subject: "two",
        textBody: "body two",
        htmlBody: "<p>two</p>",
      }),
    ]
  })

  async function ledgerWithRows() {
    const store = createMemoryIndexBlobStore()
    const ledger = await openMailboxLedger({ store, userId: victim.userId, crypto: session })
    await ledger.append(
      await Promise.all(
        rows.map((row, index) =>
          ledgerRowFromSealed(row, {
            externalMessageId: `<ext-${index}@example.test>`,
            receivedAt: `2026-08-2${index}T10:00:00.000Z`,
          }),
        ),
      ),
    )
    return { store, ledger }
  }

  it("detects a modified ciphertext on a message it has already seen", async () => {
    const { ledger } = await ledgerWithRows()
    const tampered = rows.map((row) =>
      row.id === "msg-2" ? { ...row, textBodyCiphertext: rows[0].textBodyCiphertext } : row,
    )
    const findings = await ledger.verifyAgainstServer(tampered)
    expect(kinds(findings)).toEqual(["ledger-ciphertext-changed"])
    expect(findings[0].subject).toBe("msg-2")
  })

  it("detects a deleted row when the listing is authoritative", async () => {
    const { ledger } = await ledgerWithRows()
    const findings = await ledger.verifyAgainstServer(
      rows.filter((row) => row.id !== "msg-1"),
      { authoritative: true },
    )
    expect(kinds(findings)).toEqual(["ledger-row-missing"])
    expect(findings[0].subject).toBe("msg-1")
  })

  it("does not call a paginated page a deletion", async () => {
    const { ledger } = await ledgerWithRows()
    const findings = await ledger.verifyAgainstServer(rows.filter((row) => row.id !== "msg-1"))
    expect(findings).toEqual([])
  })

  it("reports no anomaly for a freshly injected well formed row, the honest negative", async () => {
    const { ledger } = await ledgerWithRows()
    const injected = await sealMessageFixture(victim, {
      id: "msg-injected",
      subject: "from nowhere",
      textBody: "minted by whoever can write the row",
      htmlBody: "<p>x</p>",
    })
    const findings = await ledger.verifyAgainstServer([...rows, injected], { authoritative: true })
    expect(findings).toEqual([])
  })

  it("detects an entry removed from the middle of its own MAC chain", async () => {
    const { store, ledger } = await ledgerWithRows()
    const third = await sealMessageFixture(victim, {
      id: "msg-3",
      subject: "three",
      textBody: "body three",
      htmlBody: "<p>three</p>",
    })
    await ledger.append([
      await ledgerRowFromSealed(third, {
        externalMessageId: "<ext-3@example.test>",
        receivedAt: "2026-08-23T10:00:00.000Z",
      }),
    ])
    expect(await ledger.verifyChain()).toEqual([])

    const raw = await store.get(`mailbox-ledger:${victim.userId}`)
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw as string) as { version: number; entries: unknown[] }
    parsed.entries.splice(1, 1)
    await store.put(`mailbox-ledger:${victim.userId}`, JSON.stringify(parsed))

    const reopened = await openMailboxLedger({ store, userId: victim.userId, crypto: session })
    expect(kinds(await reopened.verifyChain())).toEqual(["ledger-chain-broken"])
  })

  it("detects a rewritten digest inside its own MAC chain", async () => {
    const { store } = await ledgerWithRows()
    const raw = (await store.get(`mailbox-ledger:${victim.userId}`)) as string
    const parsed = JSON.parse(raw) as { version: number; entries: { ciphertextDigest: string }[] }
    parsed.entries[0].ciphertextDigest = parsed.entries[1].ciphertextDigest
    await store.put(`mailbox-ledger:${victim.userId}`, JSON.stringify(parsed))
    const reopened = await openMailboxLedger({ store, userId: victim.userId, crypto: session })
    expect(kinds(await reopened.verifyChain())).toEqual(["ledger-chain-broken"])
  })
})
