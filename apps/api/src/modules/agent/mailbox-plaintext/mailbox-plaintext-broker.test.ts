// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "bun:test"
import {
  fulfilMailboxMarker,
  MAILBOX_DENIED,
  MAILBOX_LOCKED,
  MAILBOX_LOCKED_ON_CLIENTS_MESSAGE,
  MAILBOX_MAX_REQUESTS_PER_TURN,
  MAILBOX_MAX_SINGLE_WAIT_MS,
  MAILBOX_TURN_WAIT_BUDGET_MS,
  mailboxSingleWaitMs,
  readMailboxMarker,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import {
  MailboxPlaintextRegistryTestAccess,
  pendingMailboxRequestCount,
  resolveMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import type { RunContext } from "~/modules/agent/runtime/run-context"

const orgId = "44444444-4444-4444-4444-444444444444"
const userId = "55555555-5555-5555-5555-555555555555"
const threadId = "66666666-6666-6666-6666-666666666666"

function readMarkerResult() {
  return {
    needsPlaintext: {
      requestKind: "mail.read",
      messageIds: ["m1", "m2"],
      purpose: "answer the user's question about this thread",
    },
    envelope: [{ messageId: "m1", from: "a@b.c" }],
  }
}

function frame(overrides: Partial<RunContext> = {}): RunContext {
  return {
    runId: "run-1",
    parentRunId: null,
    rootRunId: "run-1",
    nestingDepth: 0,
    mailboxTurnNonce: "nonce-a",
    ...overrides,
  } as RunContext
}

interface Emitted {
  action: string
  data: Record<string, unknown>
}

function deps(opts: { unlocked: boolean; emitted?: Emitted[]; contexts?: string[] }) {
  return {
    getUnlock: async () =>
      opts.unlocked ? { unlocked: true, keyIds: [1], expiresAt: Date.now() + 60_000 } : undefined,
    emit: async (action: string, data: Record<string, unknown>) => {
      opts.emitted?.push({ action, data })
    },
    injectContext: (_runId: string, block: string) => {
      opts.contexts?.push(block)
    },
  }
}

describe("mailbox plaintext broker", () => {
  beforeEach(() => {
    MailboxPlaintextRegistryTestAccess.reset()
  })

  it("reads the marker off a tool result and ignores everything else", () => {
    expect(readMailboxMarker(readMarkerResult())?.requestKind).toBe("mail.read")
    expect(readMailboxMarker({ items: [] })).toBeNull()
    expect(readMailboxMarker(null)).toBeNull()
    expect(
      readMailboxMarker({ needsClientSearch: { query: "invoice", limit: 20 } })?.requestKind,
    ).toBe("mail.search")
  })

  it("passes a non-marker result through by reference", async () => {
    const result = { items: [1] }
    const out = await fulfilMailboxMarker({
      result,
      orgId,
      userId,
      threadId,
      frame: frame(),
      deps: deps({ unlocked: true }),
    })
    expect(out.result).toBe(result)
  })

  it("returns MAILBOX_LOCKED without emitting or spending budget when no client is unlocked", async () => {
    const emitted: Emitted[] = []
    const f = frame()
    const out = await fulfilMailboxMarker({
      result: readMarkerResult(),
      orgId,
      userId,
      threadId,
      frame: f,
      deps: deps({ unlocked: false, emitted }),
    })
    const record = out.result as Record<string, any>
    expect(record.mailbox.status).toBe(MAILBOX_LOCKED)
    expect(emitted.length).toBe(0)
    expect(f.mailbox?.remainingWaitMs ?? MAILBOX_TURN_WAIT_BUDGET_MS).toBe(
      MAILBOX_TURN_WAIT_BUDGET_MS,
    )
    expect(JSON.stringify(out.result)).not.toContain("textBody")
    expect(pendingMailboxRequestCount()).toBe(0)
  })

  it("returns MAILBOX_LOCKED when the turn carries no client-minted nonce", async () => {
    const emitted: Emitted[] = []
    const out = await fulfilMailboxMarker({
      result: readMarkerResult(),
      orgId,
      userId,
      threadId,
      frame: frame({ mailboxTurnNonce: undefined }),
      deps: deps({ unlocked: true, emitted }),
    })
    expect((out.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
    expect(emitted.length).toBe(0)
  })

  it("emits an ids-only request and injects the plaintext as ephemeral context", async () => {
    const emitted: Emitted[] = []
    const contexts: string[] = []
    const f = frame()
    const pending = fulfilMailboxMarker({
      result: readMarkerResult(),
      orgId,
      userId,
      threadId,
      frame: f,
      deps: deps({ unlocked: true, emitted, contexts }),
    })
    // The request goes out before anything is awaited on the client side.
    await Bun.sleep(5)
    expect(emitted.length).toBe(1)
    expect(emitted[0].action).toBe("mailbox_decrypt_request")
    const payload = emitted[0].data as Record<string, any>
    expect(payload.messageIds).toEqual(["m1", "m2"])
    expect(payload.turnNonce).toBe("nonce-a")
    expect(typeof payload.requestId).toBe("string")
    // Ids only: nothing that could be content travels this direction.
    expect(JSON.stringify(payload)).not.toContain("body")

    expect(
      resolveMailboxRequest(payload.requestId, {
        userId,
        turnNonce: "nonce-a",
        response: {
          kind: "plaintext",
          items: [{ messageId: "m1", subject: "Invoice", textBody: "the secret body" }],
          undecryptable: ["m2"],
        },
      }),
    ).toBe("resolved")

    const out = await pending
    // The plaintext is context, never a tool result.
    expect(JSON.stringify(out.result)).not.toContain("the secret body")
    expect(contexts.length).toBe(1)
    expect(contexts[0]).toContain("the secret body")
    expect((out.result as any).mailbox.status).toBe("delivered")
    expect((out.result as any).mailbox.undecryptable).toEqual(["m2"])
    expect(f.mailbox?.requests).toBe(1)
    expect(f.mailbox?.releasedMessages).toBe(1)
  })

  it("surfaces a client refusal as MAILBOX_DENIED with its reason", async () => {
    const emitted: Emitted[] = []
    const pending = fulfilMailboxMarker({
      result: readMarkerResult(),
      orgId,
      userId,
      threadId,
      frame: frame(),
      deps: deps({ unlocked: true, emitted }),
    })
    await Bun.sleep(5)
    const requestId = (emitted[0].data as any).requestId as string
    resolveMailboxRequest(requestId, {
      userId,
      turnNonce: "nonce-a",
      response: { kind: "denied", reason: "that message is out of scope for this turn" },
      turnOwner: true,
    })
    const out = await pending
    expect((out.result as any).mailbox.status).toBe(MAILBOX_DENIED)
    expect((out.result as any).mailbox.message).toContain("out of scope")
  })

  // A user with two clients open: both hear the request; the one that did not
  // start the turn (or whose mailbox is locked) answers first, and fast.
  describe("several clients of the same user", () => {
    function mailboxOf(out: { result: unknown }): Record<string, unknown> {
      const result = out.result as Record<string, unknown>
      return result.mailbox as Record<string, unknown>
    }

    it("a locked client's quick refusal does not pre-empt the unlocked client", async () => {
      const emitted: Emitted[] = []
      const contexts: string[] = []
      const pending = fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame(),
        deps: deps({ unlocked: true, emitted, contexts }),
      })
      await Bun.sleep(5)
      const requestId = (emitted[0].data as Record<string, unknown>).requestId as string
      // An older client that did not start the turn refuses it at once.
      expect(
        resolveMailboxRequest(requestId, {
          userId,
          turnNonce: "nonce-a",
          response: {
            kind: "denied",
            reason: "this request names a turn this browser did not start",
          },
        }),
      ).toBe("held")
      await Bun.sleep(20)
      // The client that started the turn answers a moment later, with plaintext.
      expect(
        resolveMailboxRequest(requestId, {
          userId,
          turnNonce: "nonce-a",
          response: {
            kind: "plaintext",
            items: [
              { messageId: "m1", textBody: "the body" },
              { messageId: "m2", textBody: "b2" },
            ],
          },
          turnOwner: true,
        }),
      ).toBe("resolved")
      const out = await pending
      expect(mailboxOf(out).status).toBe("delivered")
      expect(contexts[0]).toContain("the body")
    })

    it("when no client could decrypt, the agent is told the mailbox is locked on the user's open windows", async () => {
      MailboxPlaintextRegistryTestAccess.setAnswerGraceMs(10)
      const emitted: Emitted[] = []
      const pending = fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame(),
        deps: deps({ unlocked: true, emitted }),
      })
      await Bun.sleep(5)
      const requestId = (emitted[0].data as Record<string, unknown>).requestId as string
      resolveMailboxRequest(requestId, {
        userId,
        turnNonce: "nonce-a",
        response: { kind: "denied", reason: "this mailbox is locked", code: "locked" },
      })
      const out = await pending
      expect(mailboxOf(out).status).toBe(MAILBOX_LOCKED)
      expect(mailboxOf(out).message).toBe(MAILBOX_LOCKED_ON_CLIENTS_MESSAGE)
      expect(MAILBOX_LOCKED_ON_CLIENTS_MESSAGE).toContain("unlock it on any of them")
    })

    function tokenOf(emitted: Emitted[]): string {
      const token = emitted[0].data.answerToken
      if (typeof token !== "string") throw new Error("the request carries no answer token")
      return token
    }

    it("production: the phone that started the turn answers locked at once, the unlocked desktop answers 2 s later, plaintext wins", async () => {
      const emitted: Emitted[] = []
      const contexts: string[] = []
      const pending = fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame(),
        deps: {
          ...deps({ unlocked: true, emitted, contexts }),
          // The turn's window (the phone) is locked; the desktop app is unlocked.
          answerers: async () => ({ turnWindowUnlocked: false, otherUnlocked: 1 }),
          answerersPollMs: 5,
        },
      })
      await Bun.sleep(5)
      const requestId = emitted[0].data.requestId as string
      const answerToken = tokenOf(emitted)
      expect(
        resolveMailboxRequest(requestId, {
          userId,
          orgId,
          turnNonce: "nonce-a",
          response: { kind: "denied", reason: "this mailbox is locked", code: "locked" },
          turnOwner: true,
        }),
      ).toBe("held")
      // "2 s later", scaled: many polls and graces pass first.
      await Bun.sleep(80)
      expect(pendingMailboxRequestCount()).toBe(1)
      expect(
        resolveMailboxRequest(requestId, {
          userId,
          orgId,
          answerToken,
          response: {
            kind: "plaintext",
            items: [
              { messageId: "m1", textBody: "decrypted on the desktop" },
              { messageId: "m2", textBody: "b2" },
            ],
          },
        }),
      ).toBe("resolved")
      const out = await pending
      expect(mailboxOf(out).status).toBe("delivered")
      expect(contexts[0]).toContain("decrypted on the desktop")
    })

    it("only locked apps: once every unlocked app has answered locked, the agent is told plainly", async () => {
      const emitted: Emitted[] = []
      const started = Date.now()
      const pending = fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame(),
        deps: {
          ...deps({ unlocked: true, emitted }),
          answerers: async () => ({ turnWindowUnlocked: true, otherUnlocked: 1 }),
          answerersPollMs: 5,
        },
      })
      await Bun.sleep(5)
      const requestId = emitted[0].data.requestId as string
      const locked = {
        kind: "denied" as const,
        reason: "this mailbox is locked",
        code: "locked" as const,
      }
      resolveMailboxRequest(requestId, {
        userId,
        orgId,
        turnNonce: "nonce-a",
        response: locked,
        turnOwner: true,
      })
      await Bun.sleep(20)
      expect(pendingMailboxRequestCount()).toBe(1)
      resolveMailboxRequest(requestId, {
        userId,
        orgId,
        answerToken: tokenOf(emitted),
        response: locked,
      })
      const out = await pending
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(mailboxOf(out).status).toBe(MAILBOX_LOCKED)
      expect(mailboxOf(out).message).toBe(MAILBOX_LOCKED_ON_CLIENTS_MESSAGE)
      expect(MAILBOX_LOCKED_ON_CLIENTS_MESSAGE).toContain(
        "Your mailbox is locked on all your open Liaison apps; unlock it on any of them.",
      )
    })

    it("the turn's window closes while another app is unlocked: that app is still waited for", async () => {
      const emitted: Emitted[] = []
      const pending = fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame(),
        deps: {
          ...deps({ unlocked: true, emitted }),
          answerers: async () => ({ turnWindowUnlocked: false, otherUnlocked: 1 }),
          answerersPollMs: 5,
        },
      })
      await Bun.sleep(60)
      expect(pendingMailboxRequestCount()).toBe(1)
      resolveMailboxRequest(emitted[0].data.requestId as string, {
        userId,
        orgId,
        answerToken: tokenOf(emitted),
        response: {
          kind: "plaintext",
          items: [
            { messageId: "m1", textBody: "x" },
            { messageId: "m2", textBody: "y" },
          ],
        },
      })
      expect(mailboxOf(await pending).status).toBe("delivered")
    })

    it("no app of the user is unlocked any more: the wait ends at once, as locked on all apps", async () => {
      const emitted: Emitted[] = []
      let unlockedApps = 1
      const started = Date.now()
      const pending = fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame(),
        deps: {
          ...deps({ unlocked: true, emitted }),
          answerers: async () => ({ turnWindowUnlocked: false, otherUnlocked: unlockedApps }),
          answerersPollMs: 10,
        },
      })
      await Bun.sleep(30)
      expect(pendingMailboxRequestCount()).toBe(1)
      unlockedApps = 0
      const out = await pending
      expect(Date.now() - started).toBeLessThan(2_000)
      expect(mailboxOf(out).status).toBe(MAILBOX_LOCKED)
      expect(mailboxOf(out).message).toBe(MAILBOX_LOCKED_ON_CLIENTS_MESSAGE)
      expect(pendingMailboxRequestCount()).toBe(0)
    })

    it("an unlocked app that never answers: the held refusal waits out the whole budget, then reads as locked", async () => {
      MailboxPlaintextRegistryTestAccess.setAnswerGraceMs(10)
      const emitted: Emitted[] = []
      const f = frame()
      f.mailbox = { remainingWaitMs: 150, requests: 0, releasedMessages: 0 }
      const started = Date.now()
      const pending = fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: f,
        deps: {
          ...deps({ unlocked: true, emitted }),
          answerers: async () => ({ turnWindowUnlocked: false, otherUnlocked: 1 }),
          answerersPollMs: 5,
        },
      })
      await Bun.sleep(5)
      resolveMailboxRequest(emitted[0].data.requestId as string, {
        userId,
        orgId,
        turnNonce: "nonce-a",
        response: { kind: "denied", reason: "this mailbox is locked", code: "locked" },
        turnOwner: true,
      })
      const out = await pending
      expect(Date.now() - started).toBeGreaterThanOrEqual(140)
      expect(mailboxOf(out).status).toBe(MAILBOX_LOCKED)
      expect(mailboxOf(out).message).toBe(MAILBOX_LOCKED_ON_CLIENTS_MESSAGE)
      expect(pendingMailboxRequestCount()).toBe(0)
    })

    it("every request carries its own answer token", async () => {
      const emitted: Emitted[] = []
      for (let i = 0; i < 2; i++) {
        const pending = fulfilMailboxMarker({
          result: readMarkerResult(),
          orgId,
          userId,
          threadId,
          frame: frame(),
          deps: deps({ unlocked: true, emitted }),
        })
        await Bun.sleep(2)
        resolveMailboxRequest(emitted[i].data.requestId as string, {
          userId,
          orgId,
          answerToken: emitted[i].data.answerToken as string,
          response: { kind: "plaintext", items: [{ messageId: "m1", textBody: "x" }] },
        })
        await pending
      }
      const tokens = emitted.map((e) => e.data.answerToken)
      expect(typeof tokens[0]).toBe("string")
      expect(tokens[0]).not.toBe(tokens[1])
      expect(tokens[0]).not.toBe(emitted[0].data.turnNonce)
    })

    it("a read that decrypted nothing is not reported as delivered", async () => {
      const emitted: Emitted[] = []
      const contexts: string[] = []
      const pending = fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame(),
        deps: deps({ unlocked: true, emitted, contexts }),
      })
      await Bun.sleep(5)
      const requestId = (emitted[0].data as Record<string, unknown>).requestId as string
      resolveMailboxRequest(requestId, {
        userId,
        turnNonce: "nonce-a",
        response: { kind: "plaintext", items: [], undecryptable: ["m1", "m2"] },
        turnOwner: true,
      })
      const out = await pending
      expect(mailboxOf(out).status).toBe(MAILBOX_LOCKED)
      expect(mailboxOf(out).message).toBe(MAILBOX_LOCKED_ON_CLIENTS_MESSAGE)
      expect(mailboxOf(out).undecryptable).toEqual(["m1", "m2"])
      expect(contexts.length).toBe(0)
    })
  })

  it("an aborted turn settles the wait as locked and evicts the registry entry", async () => {
    const emitted: Emitted[] = []
    const controller = new AbortController()
    const before = pendingMailboxRequestCount()
    const pending = fulfilMailboxMarker({
      result: readMarkerResult(),
      orgId,
      userId,
      threadId,
      frame: frame(),
      abortSignal: controller.signal,
      deps: deps({ unlocked: true, emitted }),
    })
    await Bun.sleep(5)
    expect(pendingMailboxRequestCount()).toBe(before + 1)
    controller.abort("timeout")
    const out = await pending
    expect((out.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
    expect(pendingMailboxRequestCount()).toBe(before)
  })

  it("draws every wait from ONE turn-scoped budget and stops asking when it is spent", async () => {
    const f = frame()
    f.mailbox = {
      remainingWaitMs: 20,
      requests: 0,
      releasedMessages: 0,
    }
    const emitted: Emitted[] = []
    const first = await fulfilMailboxMarker({
      result: readMarkerResult(),
      orgId,
      userId,
      threadId,
      frame: f,
      deps: deps({ unlocked: true, emitted }),
    })
    expect((first.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
    expect(f.mailbox.remainingWaitMs).toBe(0)
    const second = await fulfilMailboxMarker({
      result: readMarkerResult(),
      orgId,
      userId,
      threadId,
      frame: f,
      deps: deps({ unlocked: true, emitted }),
    })
    expect((second.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
    // One emitted request, not two: an exhausted budget never asks again.
    expect(emitted.length).toBe(1)
  })

  it("a read of many messages gets a longer wait than a read of a few", async () => {
    expect(mailboxSingleWaitMs(2)).toBe(MAILBOX_MAX_SINGLE_WAIT_MS)
    expect(mailboxSingleWaitMs(10)).toBeGreaterThan(MAILBOX_MAX_SINGLE_WAIT_MS)
    expect(mailboxSingleWaitMs(25)).toBeGreaterThan(mailboxSingleWaitMs(10))
    // The client caps a request at 25 messages; the wait stays well under a turn.
    expect(mailboxSingleWaitMs(1_000)).toBe(mailboxSingleWaitMs(25))
    expect(MAILBOX_TURN_WAIT_BUDGET_MS).toBeGreaterThanOrEqual(mailboxSingleWaitMs(25))
    const emitted: Emitted[] = []
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`)
    const before = Date.now()
    const pending = fulfilMailboxMarker({
      result: {
        needsPlaintext: { requestKind: "mail.read", messageIds: ids, purpose: "read the thread" },
      },
      orgId,
      userId,
      threadId,
      frame: frame(),
      deps: deps({ unlocked: true, emitted }),
    })
    await Bun.sleep(5)
    const data = emitted[0].data as Record<string, unknown>
    const expiresIn = Date.parse(data.expiresAt as string) - before
    expect(expiresIn).toBeGreaterThan(MAILBOX_MAX_SINGLE_WAIT_MS)
    resolveMailboxRequest(data.requestId as string, {
      userId,
      turnNonce: "nonce-a",
      response: {
        kind: "plaintext",
        items: ids.map((messageId) => ({ messageId, textBody: "x" })),
      },
      turnOwner: true,
    })
    await pending
  })

  it("refuses past the per-turn request cap", async () => {
    const f = frame()
    f.mailbox = {
      remainingWaitMs: MAILBOX_TURN_WAIT_BUDGET_MS,
      requests: MAILBOX_MAX_REQUESTS_PER_TURN,
      releasedMessages: 0,
    }
    const emitted: Emitted[] = []
    const out = await fulfilMailboxMarker({
      result: readMarkerResult(),
      orgId,
      userId,
      threadId,
      frame: f,
      deps: deps({ unlocked: true, emitted }),
    })
    expect((out.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
    expect(emitted.length).toBe(0)
  })

  it("hands a mail.quote response back as retry arguments, never as context", async () => {
    const emitted: Emitted[] = []
    const contexts: string[] = []
    const pending = fulfilMailboxMarker({
      result: {
        needsPlaintext: {
          requestKind: "mail.quote",
          messageIds: ["m9"],
          purpose: "quote the message being forwarded",
        },
      },
      orgId,
      userId,
      threadId,
      frame: frame(),
      deps: deps({ unlocked: true, emitted, contexts }),
    })
    await Bun.sleep(5)
    const requestId = (emitted[0].data as any).requestId as string
    resolveMailboxRequest(requestId, {
      userId,
      turnNonce: "nonce-a",
      response: {
        kind: "plaintext",
        items: [
          { messageId: "m9", quotedBody: "> original text", resolvedSubject: "Fwd: Invoice" },
        ],
      },
    })
    const out = await pending
    expect(out.retryArgs).toBeDefined()
    const quote = (out.retryArgs as any).__mailboxQuote
    expect(quote.m9.quotedBody).toBe("> original text")
    expect(quote.m9.resolvedSubject).toBe("Fwd: Invoice")
    expect(contexts.length).toBe(0)
  })

  describe("server-managed mailboxes", () => {
    it("answers server-side with no browser, no unlock and no nonce (a routine turn)", async () => {
      const emitted: Emitted[] = []
      const contexts: string[] = []
      const asked: Array<{ userId: string; kind: string }> = []
      const out = await fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame({
          mailboxTurnNonce: undefined,
          routineId: "routine-1",
          routineMailboxReaderUserId: userId,
        }),
        toolName: "mail__get_conversation",
        deps: {
          ...deps({ unlocked: false, emitted, contexts }),
          answerManaged: async (input) => {
            asked.push({ userId: input.userId, kind: input.marker.requestKind })
            expect(input.purpose).toEqual({
              kind: "tool",
              tool: "mail__get_conversation",
              agentId: null,
              routineId: "routine-1",
            })
            return {
              kind: "plaintext",
              items: [{ messageId: "m1", subject: "Hello", textBody: "MANAGEDBODY" }],
              undecryptable: [],
            }
          },
        },
      })
      expect(asked).toEqual([{ userId, kind: "mail.read" }])
      // Nothing went to a browser.
      expect(emitted).toHaveLength(0)
      expect(contexts.join("\n")).toContain("MANAGEDBODY")
      const mailbox = (out.result as { mailbox: { status: string } }).mailbox
      expect(mailbox.status).toBe("delivered")
      // The body is context, never the tool result.
      expect(JSON.stringify(out.result)).not.toContain("MANAGEDBODY")
    })

    it("takes the browser path unchanged when the mailbox is not a managed one", async () => {
      const out = await fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame({ mailboxTurnNonce: undefined }),
        deps: { ...deps({ unlocked: false }), answerManaged: async () => null },
      })
      expect((out.result as { mailbox: { status: string } }).mailbox.status).toBe(MAILBOX_LOCKED)
    })

    it("never reads server-side for a turn that is not the reader's own", async () => {
      const asked: string[] = []
      for (const f of [
        // An agent's ask, a background re-run, a sub-run: no person typed it.
        frame({ mailboxTurnNonce: undefined, coordinated: true }),
        frame({ mailboxTurnNonce: undefined, background: true }),
        // A nonce alone is not enough: the frame must be a person's typed turn.
        frame({ mailboxTurnNonce: "nonce-x" }),
        // A site visitor's turn and the MCP gateway's frame are never the owner's.
        frame({ humanTurn: true, visitorTurn: true }),
        frame({ humanTurn: true, mcpGateway: true }),
        // A routine tick that is not the owner's own work (someone else
        // created or edited it, or someone else ran it now): the worker
        // stamps no reader.
        frame({ mailboxTurnNonce: undefined, routineId: "routine-1" }),
        // A routine whose reader is somebody else.
        frame({
          mailboxTurnNonce: undefined,
          routineId: "routine-1",
          routineMailboxReaderUserId: "someone-else",
        }),
        // A reader stamp without a routine tick.
        frame({ mailboxTurnNonce: undefined, routineMailboxReaderUserId: userId }),
      ]) {
        const out = await fulfilMailboxMarker({
          result: readMarkerResult(),
          orgId,
          userId,
          threadId,
          frame: f,
          deps: {
            ...deps({ unlocked: false }),
            answerManaged: async () => {
              asked.push("asked")
              return null
            },
          },
        })
        expect((out.result as { mailbox: { status: string } }).mailbox.status).toBe(MAILBOX_LOCKED)
      }
      expect(asked).toHaveLength(0)
    })

    it("reads server-side for the reader's own typed turn", async () => {
      const contexts: string[] = []
      await fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame({ humanTurn: true, mailboxTurnNonce: "nonce-own" }),
        deps: {
          ...deps({ unlocked: false, contexts }),
          answerManaged: async () => ({
            kind: "plaintext",
            items: [{ messageId: "m1", subject: "s", textBody: "OWNTURN" }],
            undecryptable: [],
          }),
        },
      })
      expect(contexts.join("")).toContain("OWNTURN")
    })

    it("reads server-side for a typed turn from outside the web app (no browser nonce)", async () => {
      // The CLI, a channel or the phone: a person typed it, no browser is open.
      const contexts: string[] = []
      const readers: string[] = []
      await fulfilMailboxMarker({
        result: readMarkerResult(),
        orgId,
        userId,
        threadId,
        frame: frame({ humanTurn: true, mailboxTurnNonce: undefined }),
        deps: {
          ...deps({ unlocked: false, contexts }),
          answerManaged: async (input) => {
            readers.push(input.userId)
            return {
              kind: "plaintext",
              items: [{ messageId: "m1", subject: "s", textBody: "NOBROWSER" }],
              undecryptable: [],
            }
          },
        },
      })
      expect(readers).toEqual([userId])
      expect(contexts.join("")).toContain("NOBROWSER")
    })
  })
})
