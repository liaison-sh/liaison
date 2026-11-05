// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-SEC-6. The agent read path returns plaintext ONLY to a turn that a live,
// unlocked browser session is willing to answer, and returns a MAILBOX_LOCKED
// marker in every other case (blueprint Task 9.2, spec section 6.2).
//
// The three cases that matter are not hypothetical:
//
//   * A turn running in a dedicated job-worker process (routine ticks, event handlers,
//     webhook work) holds NO socket at all: that process never calls
//     `setWsManager`. Modelled here by the absence of a manager, which is
//     exactly what that process has.
//   * A turn whose user has no live unlocked assertion.
//   * A turn that was never started by a browser, so it carries no turn nonce.
//
// All three must cost nothing: no request emitted, no registry entry, no budget
// spent. A design that queued instead would be a decryption oracle the operator
// could drive at leisure.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { getWsManager, setWsManager, WebSocketManager } from "~/infra/websocket"
import { redis } from "~/lib/redis"
import {
  fulfilMailboxMarker,
  MAILBOX_LOCKED,
  MAILBOX_LOCKED_ON_CLIENTS_MESSAGE,
  MAILBOX_TURN_WAIT_BUDGET_MS,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import {
  getEphemeralMailboxContext,
  MailboxPlaintextContextTestAccess,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-context"
import {
  MailboxPlaintextRegistryTestAccess,
  pendingMailboxRequestCount,
  resolveMailboxRequest,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import type { RunContext } from "~/modules/agent/runtime/run-context"

const ORG_ID = "00000000-0000-4000-8000-0000000b2001"
const USER_ID = "00000000-0000-4000-8000-0000000b2002"
const THREAD_ID = "00000000-0000-4000-8000-0000000b2003"
const TURN_NONCE = "sec6-turn-nonce"

const PLAINTEXT = "PLAINTEXT THAT MUST NEVER REACH A LOCKED TURN"

function markerResult() {
  return {
    needsPlaintext: {
      requestKind: "mail.read",
      messageIds: ["m1"],
      purpose: "read the conversation",
    },
    envelope: [{ messageId: "m1", from: "customer@example.com" }],
  }
}

function frame(nonce: string | null = TURN_NONCE): RunContext {
  return {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: "root",
    nestingDepth: 0,
    ...(nonce ? { mailboxTurnNonce: nonce } : {}),
  } as RunContext
}

let previousManager: WebSocketManager | null = null
let manager: WebSocketManager

async function readWith(frameValue: RunContext) {
  return await fulfilMailboxMarker({
    result: markerResult(),
    orgId: ORG_ID,
    userId: USER_ID,
    threadId: THREAD_ID,
    frame: frameValue,
  })
}

describe("T-SEC-6: the agent read path is gated on a live unlocked session", () => {
  beforeAll(() => {
    previousManager = getWsManager()
    manager = new WebSocketManager(redis)
  })

  afterEach(() => {
    MailboxPlaintextRegistryTestAccess.reset()
    MailboxPlaintextContextTestAccess.reset()
    if (previousManager) setWsManager(previousManager)
  })

  afterAll(() => {
    if (previousManager) setWsManager(previousManager)
  })

  it("non-vacuity: an unlocked session is asked, answers, and the turn gets the plaintext", async () => {
    setWsManager(manager)
    await manager.setMailboxUnlock(USER_ID, {
      unlocked: true,
      keyIds: [1],
      expiresAt: Date.now() + 60_000,
    })
    const f = frame()
    const pending = fulfilMailboxMarker({
      result: markerResult(),
      orgId: ORG_ID,
      userId: USER_ID,
      threadId: THREAD_ID,
      frame: f,
    })
    // Wait for the request to be registered, then answer it as the browser would.
    for (let i = 0; i < 50 && pendingMailboxRequestCount() === 0; i++) await Bun.sleep(5)
    expect(pendingMailboxRequestCount()).toBe(1)
    // The id travelled to the browser on the ephemeral event; the test reads it
    // off the registry instead of re-parsing the broadcast, and then makes the
    // same resolve call the HTTP route makes.
    const [requestId] = MailboxPlaintextRegistryTestAccess.listPendingRequestIds()
    expect(typeof requestId).toBe("string")
    expect(
      resolveMailboxRequest(requestId as string, {
        userId: USER_ID,
        turnNonce: TURN_NONCE,
        response: {
          kind: "plaintext",
          items: [{ messageId: "m1", subject: "Invoice", textBody: PLAINTEXT }],
        },
      }),
    ).toBe("resolved")
    const outcome = await pending
    expect((outcome.result as any).mailbox.status).toBe("delivered")
    // Even on the SUCCESS path the plaintext is context, never a tool result.
    expect(JSON.stringify(outcome.result)).not.toContain(PLAINTEXT)
    expect(getEphemeralMailboxContext(f.runId).join("\n")).toContain(PLAINTEXT)
  })

  it("a locked client opening after an unlocked one does not lock the read", async () => {
    // Two clients of the same user: the unlocked one asserted first, then a
    // second one opened with its mailbox locked and said so.
    setWsManager(manager)
    await manager.setMailboxUnlock(
      USER_ID,
      { unlocked: true, keyIds: [1], expiresAt: Date.now() + 60_000 },
      "conn-unlocked",
    )
    await manager.setMailboxUnlock(
      USER_ID,
      { unlocked: false, keyIds: [], expiresAt: Date.now() + 60_000 },
      "conn-locked",
    )
    const f = frame()
    const pending = readWith(f)
    for (let i = 0; i < 50 && pendingMailboxRequestCount() === 0; i++) await Bun.sleep(5)
    expect(pendingMailboxRequestCount()).toBe(1)
    const [requestId] = MailboxPlaintextRegistryTestAccess.listPendingRequestIds()
    resolveMailboxRequest(requestId as string, {
      userId: USER_ID,
      turnNonce: TURN_NONCE,
      response: { kind: "plaintext", items: [{ messageId: "m1", textBody: PLAINTEXT }] },
      turnOwner: true,
    })
    const outcome = await pending
    expect((outcome.result as Record<string, Record<string, unknown>>).mailbox.status).toBe(
      "delivered",
    )
    await manager.setMailboxUnlock(
      USER_ID,
      { unlocked: false, keyIds: [], expiresAt: 0 },
      "conn-unlocked",
    )
  })

  it("every unlocked app of the user goes away mid-request: the read settles at once, as locked on all apps", async () => {
    setWsManager(manager)
    // Only this test's two connections: an assertion from a client that sends
    // no turn list (earlier tests) reads as "might be the owner", by design.
    await redis.del(`ws:mailboxUnlock:${USER_ID}`)
    const ttl = Date.now() + 60_000
    // The owner's window started this turn; another tab is unlocked but did not.
    await manager.setMailboxUnlock(
      USER_ID,
      { unlocked: true, keyIds: [1], expiresAt: ttl, turns: [TURN_NONCE] },
      "conn-owner",
    )
    await manager.setMailboxUnlock(
      USER_ID,
      { unlocked: true, keyIds: [1], expiresAt: ttl, turns: [] },
      "conn-other",
    )
    const started = Date.now()
    const pending = readWith(frame())
    for (let i = 0; i < 50 && pendingMailboxRequestCount() === 0; i++) await Bun.sleep(5)
    expect(pendingMailboxRequestCount()).toBe(1)
    // The owner's socket closes (a reload, a closed window). The other tab
    // could still answer, so the read waits for it...
    await manager.live.setMailboxUnlock(USER_ID, "conn-owner", null)
    await Bun.sleep(2_500)
    expect(pendingMailboxRequestCount()).toBe(1)
    // ...until it locks too: nobody is left who can answer.
    await manager.live.setMailboxUnlock(USER_ID, "conn-other", null)
    try {
      const outcome = await pending
      expect(Date.now() - started).toBeLessThan(10_000)
      const mailbox = (outcome.result as Record<string, Record<string, unknown>>).mailbox
      expect(mailbox.status).toBe(MAILBOX_LOCKED)
      expect(mailbox.message).toBe(MAILBOX_LOCKED_ON_CLIENTS_MESSAGE)
      expect(pendingMailboxRequestCount()).toBe(0)
    } finally {
      await redis.del(`ws:mailboxUnlock:${USER_ID}`)
    }
  }, 15_000)

  it("a turn in a process with no socket manager (the worker) takes the locked path", async () => {
    // A dedicated job worker never calls setWsManager. This is that process.
    setWsManager(undefined as unknown as WebSocketManager)
    const outcome = await readWith(frame())
    expect((outcome.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
    expect(pendingMailboxRequestCount()).toBe(0)
    expect(JSON.stringify(outcome.result)).not.toContain(PLAINTEXT)
  })

  it("a user with no live unlocked assertion takes the locked path and spends no budget", async () => {
    setWsManager(manager)
    await manager.setMailboxUnlock(USER_ID, {
      unlocked: false,
      keyIds: [],
      expiresAt: Date.now() + 60_000,
    })
    const f = frame()
    const outcome = await readWith(f)
    expect((outcome.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
    expect(pendingMailboxRequestCount()).toBe(0)
    expect(f.mailbox?.remainingWaitMs ?? MAILBOX_TURN_WAIT_BUDGET_MS).toBe(
      MAILBOX_TURN_WAIT_BUDGET_MS,
    )
  })

  it("an expired unlock assertion is not an unlocked session", async () => {
    setWsManager(manager)
    await manager.setMailboxUnlock(USER_ID, {
      unlocked: true,
      keyIds: [1],
      expiresAt: Date.now() - 1,
    })
    const outcome = await readWith(frame())
    expect((outcome.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
  })

  it("a turn with no client-minted nonce is never asked, even with an unlocked session", async () => {
    setWsManager(manager)
    await manager.setMailboxUnlock(USER_ID, {
      unlocked: true,
      keyIds: [1],
      expiresAt: Date.now() + 60_000,
    })
    const outcome = await readWith(frame(null))
    expect((outcome.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
    expect(pendingMailboxRequestCount()).toBe(0)
  })
})
