// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client-verified sweep (spec section 7 step 6, SC6).
//
// THE PROPERTY THAT MATTERS MOST IS A REFUSAL. The acknowledgement this module
// signs is the only thing that lets the purge destroy plaintext, so a sweep
// that signed after skipping a message would authorise destroying mail nobody
// can read. Every test below that says "refuses" is guarding that, and none of
// them may be relaxed to make a feature pass.
//
// The other properties: it walks EVERY message rather than a sample, it is
// resumable across a closed tab, it reports progress, and it never fetches a
// nonce before it has something to sign.

import { computeIdSetDigest } from "@liaison/mailbox-crypto/src/ack"
import { describe, expect, it } from "vitest"
import {
  MAILBOX_LOCKED,
  MailboxCryptoError,
  type OpenedMessage,
  type SealedMessagePayload,
} from "~/modules/mailbox/crypto-protocol"
import {
  MailboxSweepError,
  memorySweepResumeStore,
  runMailboxVerificationSweep,
  type SweepItem,
  type SweepPage,
  type SweepResumeStore,
} from "~/modules/mailbox/verification-sweep"

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111"

function sealedOf(id: string): SealedMessagePayload {
  return {
    id,
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

function item(id: string, overrides: Partial<SweepItem["plaintext"]> = {}): SweepItem {
  return {
    sealed: sealedOf(id),
    plaintext: {
      subject: `subject ${id}`,
      textBody: `body ${id}`,
      htmlBody: null,
      snippet: null,
      ...overrides,
    },
  }
}

function opened(id: string, overrides: Partial<OpenedMessage> = {}): OpenedMessage {
  return {
    id,
    subject: `subject ${id}`,
    textBody: `body ${id}`,
    htmlBody: null,
    snippet: null,
    ...overrides,
  }
}

interface Harness {
  posts: Array<{ path: string; body: unknown }>
  signCalls: number
  deps: Parameters<typeof runMailboxVerificationSweep>[0]
  progress: Array<{ verified: number; total: number | null; phase: string }>
  store: SweepResumeStore
}

interface HarnessOptions {
  ids?: string[]
  pageSize?: number
  /** Ids whose decryption fails. `null` return, not a throw. */
  undecryptable?: string[]
  /** Ids whose decryption throws MAILBOX_LOCKED. */
  locked?: string[]
  /** Ids whose decryption throws MAILBOX_LOCKED the FIRST time only, which is
   *  what a real session expiry looks like: the next run opens them fine. */
  lockOnce?: string[]
  /** Ids whose decrypted text disagrees with the plaintext column. */
  mismatched?: string[]
  serverCount?: number
  store?: SweepResumeStore
  fetchPage?: SweepPage[]
}

function harness(options: HarnessOptions = {}): Harness {
  const ids = options.ids ?? ["m-1", "m-2", "m-3"]
  const undecryptable = new Set(options.undecryptable ?? [])
  const locked = new Set(options.locked ?? [])
  const lockOnce = new Set(options.lockOnce ?? [])
  const mismatched = new Set(options.mismatched ?? [])
  const posts: Array<{ path: string; body: unknown }> = []
  const progress: Array<{ verified: number; total: number | null; phase: string }> = []
  const store = options.store ?? memorySweepResumeStore()
  let signCalls = 0

  const api = {
    get: async () => ({}) as never,
    delete: async () => ({}) as never,
    post: async (path: string, body?: unknown) => {
      posts.push({ path, body })
      if (path === "/mailbox/verify-nonce") {
        return {
          nonce: "nonce-from-server",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          backfillCursor: '{"phase":"done"}',
          messageCount: options.serverCount ?? ids.length,
        } as never
      }
      return { verified: true, verifiedAt: "2026-08-28T00:00:00.000Z" } as never
    },
  }

  const pageSize = options.pageSize ?? 2
  const source = {
    async fetchPage(cursor: string | null, limit: number): Promise<SweepPage> {
      const start = cursor ? ids.indexOf(cursor) + 1 : 0
      const slice = ids.slice(start, start + Math.min(limit, pageSize))
      const last = slice[slice.length - 1] ?? cursor ?? ""
      return {
        cursor: last,
        done: start + slice.length >= ids.length,
        items: slice.map((id) => item(id)),
        total: ids.length,
      }
    },
  }

  const deps: Parameters<typeof runMailboxVerificationSweep>[0] = {
    api,
    accountId: ACCOUNT_ID,
    source,
    store,
    pageSize,
    onProgress: (p) => progress.push({ verified: p.verified, total: p.total, phase: p.phase }),
    yieldToMainThread: async () => {},
    async open(sealed) {
      if (lockOnce.has(sealed.id)) {
        lockOnce.delete(sealed.id)
        throw new MailboxCryptoError(MAILBOX_LOCKED, "the mailbox locked mid sweep")
      }
      if (locked.has(sealed.id)) {
        throw new MailboxCryptoError(MAILBOX_LOCKED, "the mailbox locked mid sweep")
      }
      if (undecryptable.has(sealed.id)) return null
      if (mismatched.has(sealed.id)) return opened(sealed.id, { textBody: "something else" })
      return opened(sealed.id)
    },
    async signAck(statement) {
      signCalls++
      return { keyId: 1, signature: `signature-over-${statement.nonce}` }
    },
  }

  return {
    posts,
    progress,
    store,
    deps,
    get signCalls() {
      return signCalls
    },
  }
}

describe("mailbox verification sweep", () => {
  it("REFUSES TO SIGN when a single message does not decrypt", async () => {
    // The load-bearing test of this module. One message of three fails to
    // open. Signing anyway would authorise destroying the plaintext of a
    // message the user demonstrably cannot read.
    const h = harness({ undecryptable: ["m-2"] })

    await expect(runMailboxVerificationSweep(h.deps)).rejects.toBeInstanceOf(MailboxSweepError)

    expect(h.signCalls).toBe(0)
    expect(h.posts.map((p) => p.path)).not.toContain("/mailbox/verify-decrypt")
    // The nonce is fetched only once there is something to sign, so a refused
    // sweep does not even burn one.
    expect(h.posts.map((p) => p.path)).not.toContain("/mailbox/verify-nonce")
  })

  it("names the message that did not decrypt rather than failing vaguely", async () => {
    const h = harness({ undecryptable: ["m-3"] })
    const error = await runMailboxVerificationSweep(h.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailboxSweepError)
    const failures = (error as MailboxSweepError).failures
    expect(failures).toHaveLength(1)
    expect(failures[0]?.id).toBe("m-3")
    expect(failures[0]?.reason).toBe("undecryptable")
  })

  it("REFUSES TO SIGN when a decrypted body disagrees with the plaintext column", async () => {
    const h = harness({ mismatched: ["m-1"] })
    const error = await runMailboxVerificationSweep(h.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailboxSweepError)
    expect((error as MailboxSweepError).failures[0]).toMatchObject({
      id: "m-1",
      reason: "mismatch",
      field: "textBody",
    })
    expect(h.signCalls).toBe(0)
  })

  it("REFUSES TO SIGN when the server holds more messages than the sweep covered", async () => {
    // Coverage is the whole claim. If the server's own count disagrees with the
    // walked set, the sweep has not seen the mailbox and must not say it has.
    const h = harness({ serverCount: 4 })
    const error = await runMailboxVerificationSweep(h.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailboxSweepError)
    expect((error as MailboxSweepError).message).toMatch(/coverage/i)
    expect(h.signCalls).toBe(0)
    expect(h.posts.map((p) => p.path)).not.toContain("/mailbox/verify-decrypt")
  })

  it("signs and submits an acknowledgement over every message id it walked", async () => {
    const h = harness()
    const result = await runMailboxVerificationSweep(h.deps)

    expect(result.completed).toBe(true)
    expect(result.verified).toBe(3)
    expect(h.signCalls).toBe(1)

    const submitted = h.posts.find((p) => p.path === "/mailbox/verify-decrypt")
    expect(submitted).toBeDefined()
    const body = submitted?.body as Record<string, unknown>
    expect(body.accountId).toBe(ACCOUNT_ID)
    expect(body.count).toBe(3)
    expect(body.nonce).toBe("nonce-from-server")
    expect(body.backfillCursor).toBe('{"phase":"done"}')
    expect(body.keyId).toBe(1)
    expect(body.signature).toBe("signature-over-nonce-from-server")

    // The digest is the one the server recomputes: SHA-256 over the ASCII
    // sorted ids joined by a single newline, with no trailing newline.
    const expectedDigest = Buffer.from(await computeIdSetDigest(["m-1", "m-2", "m-3"])).toString(
      "base64",
    )
    expect(body.idSetDigest).toBe(expectedDigest)
  })

  it("stops without signing when the mailbox locks mid sweep, and resumes where it stopped", async () => {
    const store = memorySweepResumeStore()
    const first = harness({ ids: ["m-1", "m-2", "m-3", "m-4"], locked: ["m-3"], store })
    const stopped = await runMailboxVerificationSweep(first.deps)
    expect(stopped.completed).toBe(false)
    expect(stopped.stoppedBecause).toBe("locked")
    expect(first.signCalls).toBe(0)
    expect(stopped.verified).toBe(2)

    // A second run with the same store picks up the two already-verified ids
    // rather than starting the mailbox again.
    const second = harness({ ids: ["m-1", "m-2", "m-3", "m-4"], store })
    const done = await runMailboxVerificationSweep(second.deps)
    expect(done.completed).toBe(true)
    expect(done.verified).toBe(4)
    const body = second.posts.find((p) => p.path === "/mailbox/verify-decrypt")?.body as Record<
      string,
      unknown
    >
    expect(body.count).toBe(4)
    expect(body.idSetDigest).toBe(
      Buffer.from(await computeIdSetDigest(["m-1", "m-2", "m-3", "m-4"])).toString("base64"),
    )
  })

  it("resumes a sweep that locked in the MIDDLE of a page, without counting anything twice", async () => {
    // The designed common case, and the one the shipped test missed by locking
    // on the first item of a page. A lock on the SECOND item of a page saves
    // the pre-advance cursor next to ids the run had already verified, so the
    // resume re-fetches that same page. Pushing those ids again overshoots the
    // count the server holds, the coverage check refuses, and since the resume
    // state is only cleared on success the mailbox could never be swept again.
    const store = memorySweepResumeStore()
    const ids = ["m-1", "m-2", "m-3", "m-4"]
    const first = harness({ ids, pageSize: 2, lockOnce: ["m-2"], store })
    const stopped = await runMailboxVerificationSweep(first.deps)
    expect(stopped.completed).toBe(false)
    expect(stopped.stoppedBecause).toBe("locked")
    expect(first.signCalls).toBe(0)

    const second = harness({ ids, pageSize: 2, store })
    const done = await runMailboxVerificationSweep(second.deps)
    expect(done.completed).toBe(true)
    expect(done.verified).toBe(4)
    const body = second.posts.find((p) => p.path === "/mailbox/verify-decrypt")?.body as Record<
      string,
      unknown
    >
    expect(body.count).toBe(4)
    expect(body.idSetDigest).toBe(Buffer.from(await computeIdSetDigest(ids)).toString("base64"))
    expect(await store.load()).toBeNull()
  })

  it("heals a resume state that already double counted rather than refusing forever", async () => {
    // The exact shape a browser that ran the defective build is left holding:
    // a cursor at m-2 with m-3 already in the id list. Left as is, every rerun
    // walks m-3 again, reports five for a mailbox of four, and refuses.
    const store = memorySweepResumeStore()
    const ids = ["m-1", "m-2", "m-3", "m-4"]
    await store.save({
      cursor: "m-2",
      ids: ["m-1", "m-2", "m-3"],
      startedAt: "2026-08-27T00:00:00.000Z",
    })
    const h = harness({ ids, pageSize: 2, store })
    const done = await runMailboxVerificationSweep(h.deps)
    expect(done.completed).toBe(true)
    expect(done.verified).toBe(4)
    expect(await store.load()).toBeNull()
  })

  it("clears its resume state once the acknowledgement is accepted", async () => {
    const store = memorySweepResumeStore()
    const h = harness({ store })
    await runMailboxVerificationSweep(h.deps)
    expect(await store.load()).toBeNull()
  })

  it("REFUSES TO SIGN over an item the listing gave no plaintext half for", async () => {
    // A sweep whose comparison silently becomes a decryptability check proves
    // nothing about content fidelity, and it is the shape a listing served in
    // the wrong mode has: the default mode carries no plaintext columns at all.
    // Signing over it would authorise destroying plaintext nothing compared.
    const h = harness({ ids: ["m-1"] })
    h.deps.source = {
      async fetchPage() {
        return {
          cursor: "m-1",
          done: true,
          total: 1,
          items: [{ sealed: sealedOf("m-1"), plaintext: null }],
        }
      },
    }
    const error = await runMailboxVerificationSweep(h.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailboxSweepError)
    expect((error as MailboxSweepError).failures[0]).toMatchObject({
      id: "m-1",
      reason: "unverifiable",
    })
    expect(h.signCalls).toBe(0)
  })

  it("VERIFIES a row the server says has no plaintext by decrypting it, and signs", async () => {
    // Every enrolled mailbox receives mail, and a row sealed at ingest never
    // had plaintext. Refusing those would mean no live mailbox could ever be
    // swept, so the acknowledgement could never be recorded and the purge could
    // never be armed. The server states the absence authoritatively; the sweep
    // then verifies the only property such a row HAS, that it opens.
    const h = harness({ ids: ["m-1", "m-2"] })
    h.deps.source = {
      async fetchPage() {
        return {
          cursor: "m-2",
          done: true,
          total: 2,
          items: [
            { sealed: sealedOf("m-1"), hasPlaintext: false, plaintext: null },
            { sealed: sealedOf("m-2"), hasPlaintext: false, plaintext: null },
          ],
        }
      },
    }
    const result = await runMailboxVerificationSweep(h.deps)
    expect(result.completed).toBe(true)
    expect(result.verified).toBe(2)
    expect(h.signCalls).toBe(1)
    // Coverage is unchanged: the acknowledgement still names every id.
    const body = h.posts.find((p) => p.path === "/mailbox/verify-decrypt")?.body as Record<
      string,
      unknown
    >
    expect(body.count).toBe(2)
    expect(body.idSetDigest).toBe(
      Buffer.from(await computeIdSetDigest(["m-1", "m-2"])).toString("base64"),
    )
  })

  it("REFUSES TO SIGN when a row with no plaintext half fails to decrypt", async () => {
    // The decrypt-only check is still a check. A row sealed at ingest that does
    // not open is exactly the mail the purge would destroy unread.
    const h = harness({ ids: ["m-1", "m-2"], undecryptable: ["m-2"] })
    h.deps.source = {
      async fetchPage() {
        return {
          cursor: "m-2",
          done: true,
          total: 2,
          items: [
            { sealed: sealedOf("m-1"), hasPlaintext: false, plaintext: null },
            { sealed: sealedOf("m-2"), hasPlaintext: false, plaintext: null },
          ],
        }
      },
    }
    const error = await runMailboxVerificationSweep(h.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailboxSweepError)
    expect((error as MailboxSweepError).failures).toEqual([{ id: "m-2", reason: "undecryptable" }])
    expect(h.signCalls).toBe(0)
  })

  it("REFUSES TO SIGN when the server says a row HAS plaintext and the half is missing", async () => {
    // The flag is authoritative in BOTH directions. A row the server says still
    // holds plaintext, arriving with nothing to compare against, is a listing
    // that lost half its payload, not a row that never had one.
    const h = harness({ ids: ["m-1"] })
    h.deps.source = {
      async fetchPage() {
        return {
          cursor: "m-1",
          done: true,
          total: 1,
          items: [{ sealed: sealedOf("m-1"), hasPlaintext: true, plaintext: null }],
        }
      },
    }
    const error = await runMailboxVerificationSweep(h.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailboxSweepError)
    expect((error as MailboxSweepError).failures[0]).toMatchObject({
      id: "m-1",
      reason: "unverifiable",
    })
    expect(h.signCalls).toBe(0)
  })

  it("REFUSES TO SIGN when a row that HAS plaintext decrypts to something else", async () => {
    // The legacy comparison is untouched by the ingest-sealed carve-out.
    const h = harness({ ids: ["m-1", "m-2"], mismatched: ["m-2"] })
    h.deps.source = {
      async fetchPage() {
        return {
          cursor: "m-2",
          done: true,
          total: 2,
          items: [
            { sealed: sealedOf("m-1"), hasPlaintext: false, plaintext: null },
            { ...item("m-2"), hasPlaintext: true },
          ],
        }
      },
    }
    const error = await runMailboxVerificationSweep(h.deps).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MailboxSweepError)
    expect((error as MailboxSweepError).failures[0]).toMatchObject({
      id: "m-2",
      reason: "mismatch",
      field: "textBody",
    })
    expect(h.signCalls).toBe(0)
  })

  it("reports progress as it walks, so a long sweep is not a frozen screen", async () => {
    const h = harness({ ids: ["m-1", "m-2", "m-3", "m-4", "m-5"], pageSize: 2 })
    await runMailboxVerificationSweep(h.deps)
    expect(h.progress.length).toBeGreaterThan(1)
    expect(h.progress.map((p) => p.verified)).toEqual([2, 4, 5, 5])
    expect(h.progress.at(-1)?.phase).toBe("done")
    expect(h.progress[0]?.total).toBe(5)
  })

  it("treats an empty plaintext column and an empty decrypted field as equal", async () => {
    // Review finding 23: a draft with `html_body = ''` is not a mismatch
    // against a decrypted null, and calling it one would block every sweep.
    const h = harness({ ids: ["m-1"] })
    h.deps.source = {
      async fetchPage() {
        return {
          cursor: "m-1",
          done: true,
          total: 1,
          items: [
            {
              sealed: sealedOf("m-1"),
              plaintext: {
                subject: "subject m-1",
                textBody: "body m-1",
                htmlBody: "",
                snippet: "",
              },
            },
          ],
        }
      },
    }
    const result = await runMailboxVerificationSweep(h.deps)
    expect(result.completed).toBe(true)
  })

  it("aborts without signing when the caller cancels", async () => {
    const controller = new AbortController()
    const h = harness({ ids: ["m-1", "m-2", "m-3", "m-4"] })
    h.deps.signal = controller.signal
    h.deps.onProgress = () => controller.abort()
    const result = await runMailboxVerificationSweep(h.deps)
    expect(result.completed).toBe(false)
    expect(result.stoppedBecause).toBe("aborted")
    expect(h.signCalls).toBe(0)
  })
})
