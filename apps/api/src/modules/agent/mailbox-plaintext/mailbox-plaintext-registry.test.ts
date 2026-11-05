// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import { INSTANCE_ID } from "~/infra/instance-id"
import {
  MailboxPlaintextRegistryTestAccess,
  mintMailboxRequestId,
  ownsMailboxRequestId,
  pendingMailboxRequestCount,
  registerMailboxRequest,
  resolveMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"

const userId = "11111111-1111-1111-1111-111111111111"
const otherUserId = "22222222-2222-2222-2222-222222222222"

function register(overrides: Record<string, unknown> = {}) {
  return registerMailboxRequest({
    requestId: mintMailboxRequestId(),
    userId,
    orgId: "33333333-3333-3333-3333-333333333333",
    turnNonce: "nonce-a",
    kind: "mail.read",
    messageIds: ["m1"],
    ...overrides,
  })
}

describe("mailbox plaintext registry", () => {
  beforeEach(() => {
    MailboxPlaintextRegistryTestAccess.reset()
  })

  it("resolves a pending request and settles its promise (non-vacuity)", async () => {
    const entry = register()
    expect(pendingMailboxRequestCount()).toBe(1)
    const outcome = resolveMailboxRequest(entry.requestId, {
      userId,
      turnNonce: "nonce-a",
      response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "hello" }] },
    })
    expect(outcome).toBe("resolved")
    const settled = await entry.promise
    expect(settled).toEqual({
      kind: "plaintext",
      items: [{ messageId: "m1", textBody: "hello" }],
    })
    expect(pendingMailboxRequestCount()).toBe(0)
  })

  it("mints ids owned by this instance and rejects a foreign prefix", () => {
    const id = mintMailboxRequestId()
    expect(id.startsWith(`${INSTANCE_ID}:`)).toBe(true)
    expect(ownsMailboxRequestId(id)).toBe(true)
    expect(ownsMailboxRequestId("00000000-0000-4000-8000-000000000000:abc")).toBe(false)
    expect(ownsMailboxRequestId("no-colon")).toBe(false)
  })

  it("refuses a wrong turn nonce and keeps the request pending", () => {
    const entry = register()
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId,
        turnNonce: "nonce-b",
        response: { kind: "plaintext", items: [] },
      }),
    ).toBe("nonce_mismatch")
    expect(pendingMailboxRequestCount()).toBe(1)
  })

  it("refuses a different user and keeps the request pending", () => {
    const entry = register()
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId: otherUserId,
        turnNonce: "nonce-a",
        response: { kind: "plaintext", items: [] },
      }),
    ).toBe("not_found")
    expect(pendingMailboxRequestCount()).toBe(1)
  })

  it("names a late second answer from the same user and turn as already settled", () => {
    const entry = register()
    resolveMailboxRequest(entry.requestId, {
      userId,
      turnNonce: "nonce-a",
      response: { kind: "plaintext", items: [] },
      turnOwner: true,
    })
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId,
        turnNonce: "nonce-a",
        response: { kind: "plaintext", items: [] },
      }),
    ).toBe("already_settled")
    // Anyone else still learns nothing about the id.
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId: otherUserId,
        turnNonce: "nonce-a",
        response: { kind: "plaintext", items: [] },
      }),
    ).toBe("not_found")
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId,
        turnNonce: "nonce-b",
        response: { kind: "plaintext", items: [] },
      }),
    ).toBe("not_found")
  })

  it("cancel evicts the entry and settles the promise as cancelled", async () => {
    const entry = register()
    entry.cancel("aborted")
    expect(pendingMailboxRequestCount()).toBe(0)
    expect(await entry.promise).toEqual({ kind: "cancelled", reason: "aborted" })
  })

  it("a refusal from the client settles as denied without plaintext", async () => {
    const entry = register()
    resolveMailboxRequest(entry.requestId, {
      userId,
      turnNonce: "nonce-a",
      response: { kind: "denied", reason: "out of scope" },
      turnOwner: true,
    })
    expect(await entry.promise).toEqual({ kind: "denied", reason: "out of scope" })
  })
})

// A user with several clients open (a browser tab and the desktop app, say):
// every one of them hears the request, and only the client that started the
// turn can decrypt for it. A refusal or an empty answer from another client
// must never settle the request ahead of the usable answer.
describe("mailbox plaintext registry, several clients of one user", () => {
  beforeEach(() => {
    MailboxPlaintextRegistryTestAccess.reset()
  })

  it("a locked client answering first does not pre-empt the unlocked client", async () => {
    const entry = register()
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId,
        turnNonce: "nonce-a",
        response: { kind: "denied", reason: "this mailbox is locked", code: "locked" },
      }),
    ).toBe("held")
    expect(pendingMailboxRequestCount()).toBe(1)
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId,
        turnNonce: "nonce-a",
        response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "hello" }] },
        turnOwner: true,
      }),
    ).toBe("resolved")
    expect(await entry.promise).toEqual({
      kind: "plaintext",
      items: [{ messageId: "m1", textBody: "hello" }],
    })
  })

  it("an answer that decrypted nothing is held too, and a usable one still wins", async () => {
    const entry = register()
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId,
        turnNonce: "nonce-a",
        response: { kind: "plaintext", items: [], undecryptable: ["m1"] },
      }),
    ).toBe("held")
    resolveMailboxRequest(entry.requestId, {
      userId,
      turnNonce: "nonce-a",
      response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "hello" }] },
    })
    expect(await entry.promise).toMatchObject({ kind: "plaintext", items: [{ messageId: "m1" }] })
  })

  it("an empty search from a client with no index is held for one that has it", async () => {
    const entry = register({ kind: "mail.search", messageIds: [] })
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId,
        turnNonce: "nonce-a",
        response: { kind: "search", messageIds: [], indexComplete: false },
      }),
    ).toBe("held")
    resolveMailboxRequest(entry.requestId, {
      userId,
      turnNonce: "nonce-a",
      response: { kind: "search", messageIds: [], indexComplete: true },
    })
    expect(await entry.promise).toEqual({ kind: "search", messageIds: [], indexComplete: true })
  })

  it("the client that started the turn settles even a refusal at once", async () => {
    const entry = register()
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId,
        turnNonce: "nonce-a",
        response: { kind: "denied", reason: "you chose not to", code: undefined },
        turnOwner: true,
      }),
    ).toBe("resolved")
    expect(await entry.promise).toMatchObject({ kind: "denied", reason: "you chose not to" })
  })

  it("only unusable answers: the best one settles once the grace runs out, marked unconfirmed", async () => {
    MailboxPlaintextRegistryTestAccess.setAnswerGraceMs(20)
    const entry = register()
    resolveMailboxRequest(entry.requestId, {
      userId,
      turnNonce: "nonce-a",
      response: { kind: "denied", reason: "this browser did not start this turn" },
    })
    expect(pendingMailboxRequestCount()).toBe(1)
    expect(await entry.promise).toEqual({
      kind: "denied",
      reason: "this browser did not start this turn",
      unconfirmed: true,
    })
    expect(pendingMailboxRequestCount()).toBe(0)
  })

  describe("any of the user's unlocked apps answers", () => {
    const orgId = "33333333-3333-3333-3333-333333333333"
    const token = "answer-token-1"

    function tracked(overrides: Record<string, unknown> = {}) {
      return registerMailboxRequest(
        {
          requestId: mintMailboxRequestId(),
          userId,
          orgId,
          turnNonce: "nonce-a",
          answerToken: token,
          kind: "mail.read",
          messageIds: ["m1"],
          ...overrides,
        },
        { trackAnswerers: true },
      )
    }

    it("production: the turn's window answers locked at once, another app answers with plaintext later, plaintext wins", async () => {
      MailboxPlaintextRegistryTestAccess.setAnswerGraceMs(5)
      const entry = tracked()
      // The phone that started the turn is locked; the desktop app is unlocked.
      entry.noteAnswerers({ turnWindowUnlocked: false, otherUnlocked: 1 })
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          orgId,
          turnNonce: "nonce-a",
          response: { kind: "denied", reason: "this mailbox is locked", code: "locked" },
          turnOwner: true,
        }),
      ).toBe("held")
      await Bun.sleep(40)
      expect(pendingMailboxRequestCount()).toBe(1)
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          orgId,
          answerToken: token,
          response: {
            kind: "plaintext",
            items: [{ messageId: "m1", textBody: "from the desktop" }],
          },
        }),
      ).toBe("resolved")
      expect(await entry.promise).toMatchObject({
        kind: "plaintext",
        items: [{ messageId: "m1", textBody: "from the desktop" }],
      })
    })

    it("only locked apps: the refusal settles once every unlocked app has answered", async () => {
      const entry = tracked()
      entry.noteAnswerers({ turnWindowUnlocked: true, otherUnlocked: 1 })
      resolveMailboxRequest(entry.requestId, {
        userId,
        orgId,
        turnNonce: "nonce-a",
        response: { kind: "denied", reason: "this mailbox is locked", code: "locked" },
        turnOwner: true,
      })
      expect(pendingMailboxRequestCount()).toBe(1)
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          orgId,
          answerToken: token,
          response: { kind: "denied", reason: "this mailbox is locked", code: "locked" },
        }),
      ).toBe("resolved")
      expect(await entry.promise).toMatchObject({
        kind: "denied",
        code: "locked",
        unconfirmed: true,
      })
    })

    it("a held refusal settles as soon as no app of the user is unlocked any more", async () => {
      const entry = tracked()
      entry.noteAnswerers({ turnWindowUnlocked: false, otherUnlocked: 1 })
      resolveMailboxRequest(entry.requestId, {
        userId,
        orgId,
        turnNonce: "nonce-a",
        response: { kind: "denied", reason: "this mailbox is locked", code: "locked" },
        turnOwner: true,
      })
      entry.noteAnswerers("unknown")
      expect(pendingMailboxRequestCount()).toBe(1)
      entry.noteAnswerers({ turnWindowUnlocked: false, otherUnlocked: 0 })
      expect(await entry.promise).toMatchObject({ kind: "denied", unconfirmed: true })
    })

    it("a held refusal is never settled by the grace while an unlocked app may answer", async () => {
      MailboxPlaintextRegistryTestAccess.setAnswerGraceMs(5)
      const entry = tracked()
      entry.noteAnswerers({ turnWindowUnlocked: false, otherUnlocked: 2 })
      resolveMailboxRequest(entry.requestId, {
        userId,
        orgId,
        answerToken: token,
        response: { kind: "denied", reason: "agent access is off here" },
      })
      await Bun.sleep(40)
      expect(pendingMailboxRequestCount()).toBe(1)
      entry.cancel("timeout")
      expect(await entry.promise).toMatchObject({ kind: "denied", unconfirmed: true })
    })

    it("a deliberate refusal from the turn's window still settles at once", async () => {
      const entry = tracked()
      entry.noteAnswerers({ turnWindowUnlocked: true, otherUnlocked: 1 })
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          orgId,
          turnNonce: "nonce-a",
          response: { kind: "denied", reason: "agent access is turned off" },
          turnOwner: true,
        }),
      ).toBe("resolved")
    })

    it("another user with a stolen token is refused, and so is another org", () => {
      const entry = tracked()
      for (const input of [
        { userId: otherUserId, orgId },
        { userId, orgId: "99999999-9999-9999-9999-999999999999" },
      ]) {
        expect(
          resolveMailboxRequest(entry.requestId, {
            ...input,
            answerToken: token,
            response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "x" }] },
          }),
        ).toBe("not_found")
      }
      expect(pendingMailboxRequestCount()).toBe(1)
    })

    it("a wrong token, or a token with no org, is no proof", () => {
      const entry = tracked()
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          orgId,
          answerToken: "guessed",
          response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "x" }] },
        }),
      ).toBe("nonce_mismatch")
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          answerToken: token,
          response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "x" }] },
        }),
      ).toBe("nonce_mismatch")
      expect(pendingMailboxRequestCount()).toBe(1)
    })

    it("a token answer cannot claim to be the turn's window", () => {
      const entry = tracked()
      entry.noteAnswerers({ turnWindowUnlocked: true, otherUnlocked: 1 })
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          orgId,
          answerToken: token,
          response: { kind: "denied", reason: "no" },
          turnOwner: true,
        }),
      ).toBe("held")
    })

    it("a conversion accepts the turn's nonce only: the owner confirms it in their window", () => {
      const entry = tracked({ kind: "mail.convert" })
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          orgId,
          answerToken: token,
          response: { kind: "plaintext", items: [{ messageId: "m1" }], consented: true },
        }),
      ).toBe("nonce_mismatch")
      expect(pendingMailboxRequestCount()).toBe(1)
    })

    it("a late duplicate with the token is already answered; another user still gets not found", async () => {
      const entry = tracked()
      resolveMailboxRequest(entry.requestId, {
        userId,
        orgId,
        answerToken: token,
        response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "x" }] },
      })
      await entry.promise
      const late = { kind: "plaintext" as const, items: [{ messageId: "m1", textBody: "x" }] }
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          orgId,
          answerToken: token,
          response: late,
        }),
      ).toBe("already_settled")
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId,
          orgId,
          turnNonce: "nonce-a",
          response: late,
        }),
      ).toBe("already_settled")
      expect(
        resolveMailboxRequest(entry.requestId, {
          userId: otherUserId,
          orgId,
          answerToken: token,
          response: late,
        }),
      ).toBe("not_found")
    })
  })

  it("a timeout settles with the held answer rather than as cancelled", async () => {
    const entry = register()
    resolveMailboxRequest(entry.requestId, {
      userId,
      turnNonce: "nonce-a",
      response: { kind: "plaintext", items: [], undecryptable: ["m1"] },
    })
    entry.cancel("timeout")
    expect(await entry.promise).toEqual({ kind: "plaintext", items: [], undecryptable: ["m1"] })
  })

  it("a late answer after a held one settled is already settled, not unknown", async () => {
    const entry = register()
    resolveMailboxRequest(entry.requestId, {
      userId,
      turnNonce: "nonce-a",
      response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "hello" }] },
    })
    await entry.promise
    expect(
      resolveMailboxRequest(entry.requestId, {
        userId,
        turnNonce: "nonce-a",
        response: { kind: "denied", reason: "this mailbox is locked", code: "locked" },
      }),
    ).toBe("already_settled")
  })
})
