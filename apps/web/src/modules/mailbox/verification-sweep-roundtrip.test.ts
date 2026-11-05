// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The sweep against REAL crypto, and its acknowledgement against the REAL
// verifier the server uses.
//
// Nothing here is faked: real enrollment, real sealing through the same
// SEAL SAFE half `apps/api` uses, a real unlocked session holding real key
// handles, and `verifyAck` from `@liaison/mailbox-crypto` (the exact function
// `apps/api/src/modules/mailbox-crypto/ack-verify.ts` calls) checking the
// signature the sweep produced. If the sweep assembled the signed bytes in any
// other order or encoding than the server's canonical encoder, the last
// assertion here fails.
//
// The negative half matters just as much: a mailbox with one message that does
// not open produces NO signature at all.

import { computeIdSetDigest, verifyAck } from "@liaison/mailbox-crypto/src/ack"
import { describe, expect, it } from "vitest"
import type { SealedMessagePayload } from "~/modules/mailbox/crypto-protocol"
import { createMailboxSession, type MailboxSession } from "~/modules/mailbox/crypto-session"
import { base64ToBytes } from "~/modules/mailbox/mailbox-bytes"
import {
  buildEnrollment,
  fakeArgon2id,
  memoryKeyStore,
  sealMessageFixture,
  TEST_USER_ID,
  type TestEnrollment,
} from "~/modules/mailbox/mailbox-fixtures"
import {
  MailboxSweepError,
  memorySweepResumeStore,
  runMailboxVerificationSweep,
  type SweepItem,
} from "~/modules/mailbox/verification-sweep"

const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333"
const PASSPHRASE = "correct horse battery staple 42"

function messageId(n: number): string {
  return `4444444${n}-4444-4444-8444-44444444444${n}`
}

async function unlockedSession(enrollment: TestEnrollment): Promise<MailboxSession> {
  const session = createMailboxSession({ keyStore: memoryKeyStore(), legacyKdf: fakeArgon2id })
  await session.unlock({
    userId: TEST_USER_ID,
    method: "passphrase",
    secret: PASSPHRASE,
    wrap: enrollment.passphraseWrap,
    keyring: enrollment.keyring,
  })
  return session
}

async function corpus(enrollment: TestEnrollment, count: number): Promise<SweepItem[]> {
  const items: SweepItem[] = []
  for (let n = 1; n <= count; n++) {
    const id = messageId(n)
    const message = {
      id,
      subject: `Invoice ${n}`,
      textBody: `Body number ${n} with a distinctive phrase.`,
      htmlBody: `<p>Body number ${n} with a distinctive phrase.</p>`,
    }
    items.push({
      sealed: await sealMessageFixture(enrollment, message),
      plaintext: {
        subject: message.subject,
        textBody: message.textBody,
        htmlBody: message.htmlBody,
        snippet: null,
      },
    })
  }
  return items
}

function sourceOf(items: SweepItem[], pageSize = 2) {
  return {
    async fetchPage(cursor: string | null, limit: number) {
      const start = cursor ? items.findIndex((i) => i.sealed.id === cursor) + 1 : 0
      const slice = items.slice(start, start + Math.min(limit, pageSize))
      return {
        cursor: slice[slice.length - 1]?.sealed.id ?? cursor ?? "",
        done: start + slice.length >= items.length,
        items: slice,
        total: items.length,
      }
    },
  }
}

function apiOf(
  posts: Array<{ path: string; body: unknown }>,
  nonce: string,
  backfillCursor: string,
  messageCount: number,
) {
  return {
    get: async () => ({}) as never,
    delete: async () => ({}) as never,
    post: async (path: string, body?: unknown) => {
      posts.push({ path, body })
      if (path === "/mailbox/verify-nonce") {
        return {
          nonce,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          backfillCursor,
          messageCount,
        } as never
      }
      return { verified: true, verifiedAt: "2026-08-28T00:00:00.000Z" } as never
    },
  }
}

describe("verification sweep, real crypto round trip", () => {
  it("produces an acknowledgement the server's own verifier accepts", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSPHRASE, userId: TEST_USER_ID })
    const session = await unlockedSession(enrollment)
    const items = await corpus(enrollment, 5)
    const posts: Array<{ path: string; body: unknown }> = []
    const nonce = "a-fresh-server-nonce"
    const backfillCursor = '{"messages":{"lastId":"zzz"}}'

    const result = await runMailboxVerificationSweep({
      api: apiOf(posts, nonce, backfillCursor, items.length),
      accountId: ACCOUNT_ID,
      source: sourceOf(items),
      store: memorySweepResumeStore(),
      pageSize: 2,
      yieldToMainThread: async () => {},
      open: (sealed: SealedMessagePayload) => session.openMessage(sealed),
      signAck: (statement) => session.signAck(statement),
    })

    expect(result.completed).toBe(true)
    expect(result.verified).toBe(5)

    const submitted = posts.find((p) => p.path === "/mailbox/verify-decrypt")?.body as Record<
      string,
      unknown
    >
    expect(submitted).toBeDefined()

    // The server recomputes the digest over ITS OWN row set and then verifies
    // the signature over the statement it assembles itself. Both halves are
    // reproduced here from the ids, never from the submitted body.
    const serverIds = items.map((i) => i.sealed.id)
    const serverDigest = await computeIdSetDigest(serverIds)
    const ok = await verifyAck(
      enrollment.entry.signSpki,
      {
        userId: TEST_USER_ID,
        accountId: ACCOUNT_ID,
        keyId: enrollment.entry.keyId,
        nonce,
        count: serverIds.length,
        idSetDigest: serverDigest,
        backfillCursor,
      },
      base64ToBytes(submitted.signature as string),
    )
    expect(ok).toBe(true)
    expect(submitted.keyId).toBe(enrollment.entry.keyId)
    expect(submitted.count).toBe(serverIds.length)
    expect(submitted.idSetDigest).toBe(Buffer.from(serverDigest).toString("base64"))
  })

  it("covers a row sealed at ingest, which never had plaintext, with real crypto", async () => {
    // The blocker this pins: every enrolled mailbox receives mail, and mail
    // sealed at ingest has all four plaintext columns NULL. A sweep that
    // refused those could never sign, so the acknowledgement could never be
    // recorded and the purge could never be armed on any live mailbox.
    //
    // The row is REALLY sealed and REALLY opened here; only the plaintext half
    // is absent, exactly as the database has it. Coverage is what matters and
    // it is unchanged: the digest the server recomputes still names it.
    const enrollment = await buildEnrollment({ passphrase: PASSPHRASE, userId: TEST_USER_ID })
    const session = await unlockedSession(enrollment)
    const items = await corpus(enrollment, 3)
    const ingestSealed: SweepItem = {
      sealed: await sealMessageFixture(enrollment, {
        id: messageId(8),
        subject: "Arrived after enrolment",
        textBody: "This body was never written in plaintext anywhere.",
        htmlBody: "<p>This body was never written in plaintext anywhere.</p>",
      }),
      hasPlaintext: false,
      plaintext: null,
    }
    items.splice(1, 0, ingestSealed)

    const posts: Array<{ path: string; body: unknown }> = []
    const nonce = "another-fresh-server-nonce"
    const result = await runMailboxVerificationSweep({
      api: apiOf(posts, nonce, "", items.length),
      accountId: ACCOUNT_ID,
      source: sourceOf(items),
      store: memorySweepResumeStore(),
      pageSize: 2,
      yieldToMainThread: async () => {},
      open: (sealed: SealedMessagePayload) => session.openMessage(sealed),
      signAck: (statement) => session.signAck(statement),
    })

    expect(result.completed).toBe(true)
    expect(result.verified).toBe(items.length)

    const submitted = posts.find((p) => p.path === "/mailbox/verify-decrypt")?.body as Record<
      string,
      unknown
    >
    const serverIds = items.map((i) => i.sealed.id)
    const serverDigest = await computeIdSetDigest(serverIds)
    // The server's own verifier accepts it, over the id set that INCLUDES the
    // ingest-sealed row.
    const ok = await verifyAck(
      enrollment.entry.signSpki,
      {
        userId: TEST_USER_ID,
        accountId: ACCOUNT_ID,
        keyId: enrollment.entry.keyId,
        nonce,
        count: serverIds.length,
        idSetDigest: serverDigest,
        backfillCursor: "",
      },
      base64ToBytes(submitted.signature as string),
    )
    expect(ok).toBe(true)
    expect(serverIds).toContain(messageId(8))
  })

  it("signs NOTHING when a row sealed at ingest does not open", async () => {
    // The decrypt-only path is still a gate. A row with no plaintext half that
    // cannot be opened is unread mail the purge would destroy.
    const enrollment = await buildEnrollment({ passphrase: PASSPHRASE, userId: TEST_USER_ID })
    const session = await unlockedSession(enrollment)
    const items = await corpus(enrollment, 2)
    const stranger = await buildEnrollment({ passphrase: PASSPHRASE, userId: TEST_USER_ID })
    items.push({
      sealed: await sealMessageFixture(stranger, {
        id: messageId(7),
        subject: "Not yours",
        textBody: "Sealed to a different Account Key.",
        htmlBody: "<p>Sealed to a different Account Key.</p>",
      }),
      hasPlaintext: false,
      plaintext: null,
    })

    const posts: Array<{ path: string; body: unknown }> = []
    const error = await runMailboxVerificationSweep({
      api: apiOf(posts, "nonce", "", items.length),
      accountId: ACCOUNT_ID,
      source: sourceOf(items),
      store: memorySweepResumeStore(),
      pageSize: 3,
      yieldToMainThread: async () => {},
      open: (sealed: SealedMessagePayload) => session.openMessage(sealed),
      signAck: (statement) => session.signAck(statement),
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MailboxSweepError)
    expect((error as MailboxSweepError).failures).toEqual([
      { id: messageId(7), reason: "undecryptable" },
    ])
    expect(posts).toHaveLength(0)
  })

  it("signs NOTHING when one message of the corpus does not open", async () => {
    const enrollment = await buildEnrollment({ passphrase: PASSPHRASE, userId: TEST_USER_ID })
    const session = await unlockedSession(enrollment)
    const items = await corpus(enrollment, 4)
    // A row whose ciphertext was written under another key: real ciphertext,
    // genuinely unopenable by this mailbox.
    const stranger = await buildEnrollment({ passphrase: PASSPHRASE, userId: TEST_USER_ID })
    const foreign = await sealMessageFixture(stranger, {
      id: messageId(9),
      subject: "Not yours",
      textBody: "Sealed to a different Account Key.",
      htmlBody: "<p>Sealed to a different Account Key.</p>",
    })
    items.splice(2, 0, {
      sealed: foreign,
      plaintext: { subject: "Not yours", textBody: "x", htmlBody: "x", snippet: null },
    })

    const posts: Array<{ path: string; body: unknown }> = []
    const error = await runMailboxVerificationSweep({
      api: apiOf(posts, "nonce", "", items.length),
      accountId: ACCOUNT_ID,
      source: sourceOf(items),
      store: memorySweepResumeStore(),
      pageSize: 3,
      yieldToMainThread: async () => {},
      open: (sealed: SealedMessagePayload) => session.openMessage(sealed),
      signAck: (statement) => session.signAck(statement),
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(MailboxSweepError)
    expect((error as MailboxSweepError).failures.map((f) => f.id)).toContain(messageId(9))
    expect(posts).toHaveLength(0)
  })
})
