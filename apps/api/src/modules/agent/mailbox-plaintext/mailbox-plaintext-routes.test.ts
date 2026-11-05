// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The client's half of the two-phase mailbox read protocol: an authenticated
// HTTP POST, never the socket (spec section 15 A5, blueprint Task 9.3).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import {
  fulfilMailboxMarker,
  MAILBOX_LOCKED,
  type MailboxBrokerDeps,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-broker"
import {
  MailboxPlaintextRegistryTestAccess,
  pendingMailboxRequestCount,
} from "~/modules/agent/mailbox-plaintext/mailbox-plaintext-registry"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-0000009c0001"
const USER_ID = "00000000-0000-4000-8000-0000009c0002"
const OTHER_USER_ID = "00000000-0000-4000-8000-0000009c0003"
const THREAD_ID = "00000000-0000-4000-8000-0000009c0004"

const TURN_NONCE = "turn-nonce-abcdef"

let token: string
let otherToken: string

function frame(): RunContext {
  return {
    runId: crypto.randomUUID(),
    parentRunId: null,
    rootRunId: "root",
    nestingDepth: 0,
    mailboxTurnNonce: TURN_NONCE,
  } as RunContext
}

/** Start a turn waiting on a decrypt request, and hand back its requestId. */
function startPendingTurn(
  contexts: string[],
  opts: { answerers?: MailboxBrokerDeps["answerers"] } = {},
) {
  let requestId = ""
  let answerToken = ""
  const promise = fulfilMailboxMarker({
    result: {
      needsPlaintext: {
        requestKind: "mail.read",
        messageIds: ["m1"],
        purpose: "read the thread the user is looking at",
      },
      envelope: [{ messageId: "m1" }],
    },
    orgId: ORG_ID,
    userId: USER_ID,
    threadId: THREAD_ID,
    frame: frame(),
    deps: {
      getUnlock: async () => ({ unlocked: true, keyIds: [1], expiresAt: Date.now() + 60_000 }),
      emit: async (_action, data) => {
        requestId = String((data as Record<string, unknown>).requestId)
        answerToken = String((data as Record<string, unknown>).answerToken)
      },
      injectContext: (_runId, block) => {
        contexts.push(block)
      },
      ...(opts.answerers ? { answerers: opts.answerers, answerersPollMs: 5 } : {}),
    },
  })
  return { promise, getRequestId: () => requestId, getAnswerToken: () => answerToken }
}

async function post(path: string, body: unknown, bearer?: string): Promise<Response> {
  return await app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

describe("mailbox plaintext response endpoints", () => {
  beforeAll(async () => {
    await acquireTestLock()
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'MailboxRouteOrg', 'mailbox-route-org')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${USER_ID}, ${ORG_ID}, 'mailbox-route@test.com', 'Mailbox Route User')`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${OTHER_USER_ID}, ${ORG_ID}, 'mailbox-route-other@test.com', 'Other User')`
    token = await signAccessToken(
      {
        userId: USER_ID,
        orgId: ORG_ID,
        name: "Mailbox Route User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
    otherToken = await signAccessToken(
      {
        userId: OTHER_USER_ID,
        orgId: ORG_ID,
        name: "Other User",
        authVersion: 1,
        permissionVersion: 1,
        scopes: ["*"],
        dimensionGrants: {},
      },
      env.JWT_SECRET,
    )
  })

  afterAll(async () => {
    MailboxPlaintextRegistryTestAccess.reset()
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  beforeEach(() => {
    MailboxPlaintextRegistryTestAccess.reset()
  })

  it("resolves the pending request and the turn resumes (non-vacuity)", async () => {
    const contexts: string[] = []
    const turn = startPendingTurn(contexts)
    await Bun.sleep(10)
    const requestId = turn.getRequestId()
    expect(requestId.length).toBeGreaterThan(0)

    const res = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      {
        turnNonce: TURN_NONCE,
        items: [{ messageId: "m1", subject: "Invoice 42", textBody: "the plaintext body" }],
        undecryptable: [],
      },
      token,
    )
    expect(res.status).toBe(200)

    const outcome = await turn.promise
    expect((outcome.result as any).mailbox.status).toBe("delivered")
    expect(contexts[0]).toContain("the plaintext body")
    // The tool result the model sees never carries the body.
    expect(JSON.stringify(outcome.result)).not.toContain("the plaintext body")
  })

  it("rejects an unauthenticated response", async () => {
    const turn = startPendingTurn([])
    await Bun.sleep(10)
    const res = await post(`/api/agent/mailbox-plaintext/${turn.getRequestId()}`, {
      turnNonce: TURN_NONCE,
      items: [],
    })
    expect(res.status).toBe(401)
    expect(pendingMailboxRequestCount()).toBe(1)
    MailboxPlaintextRegistryTestAccess.reset()
    await turn.promise
  })

  it("answers 409 WRONG_INSTANCE for a requestId minted by another process", async () => {
    const res = await post(
      `/api/agent/mailbox-plaintext/${crypto.randomUUID()}:${crypto.randomUUID()}`,
      { turnNonce: TURN_NONCE, items: [] },
      token,
    )
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.message).toBe("WRONG_INSTANCE")
  })

  it("refuses a wrong turn nonce and leaves the request pending", async () => {
    const turn = startPendingTurn([])
    await Bun.sleep(10)
    const res = await post(
      `/api/agent/mailbox-plaintext/${turn.getRequestId()}`,
      { turnNonce: "not-the-nonce", items: [] },
      token,
    )
    expect(res.status).toBe(403)
    expect(pendingMailboxRequestCount()).toBe(1)
    MailboxPlaintextRegistryTestAccess.reset()
    await turn.promise
  })

  it("refuses a response from a different user", async () => {
    const turn = startPendingTurn([])
    await Bun.sleep(10)
    const res = await post(
      `/api/agent/mailbox-plaintext/${turn.getRequestId()}`,
      { turnNonce: TURN_NONCE, items: [] },
      otherToken,
    )
    expect(res.status).toBe(404)
    expect(pendingMailboxRequestCount()).toBe(1)
    MailboxPlaintextRegistryTestAccess.reset()
    await turn.promise
  })

  it("answers a late second response for the same requestId as already answered, not 404", async () => {
    const turn = startPendingTurn([])
    await Bun.sleep(10)
    const requestId = turn.getRequestId()
    const first = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      { turnNonce: TURN_NONCE, items: [], turnOwner: true },
      token,
    )
    expect(first.status).toBe(200)
    const second = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      { turnNonce: TURN_NONCE, items: [] },
      token,
    )
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ data: { accepted: false, alreadyAnswered: true } })
    // Another user still learns nothing about the id.
    const other = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      { turnNonce: TURN_NONCE, items: [] },
      otherToken,
    )
    expect(other.status).toBe(404)
    await turn.promise
  })

  // Production, 2026-11-04: the user typed on the phone (mailbox locked there)
  // while the desktop app was unlocked. The phone answered locked at once; the
  // desktop, which did not start the turn, answers with the request's token.
  it("any unlocked app answers: the turn's locked window refuses at once, another app's plaintext 2 s later wins", async () => {
    const contexts: string[] = []
    const turn = startPendingTurn(contexts, {
      answerers: async () => ({ turnWindowUnlocked: false, otherUnlocked: 1 }),
    })
    await Bun.sleep(10)
    const requestId = turn.getRequestId()
    const locked = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      {
        turnNonce: TURN_NONCE,
        denied: { reason: "this mailbox is locked", code: "locked" },
        turnOwner: true,
      },
      token,
    )
    expect(locked.status).toBe(200)
    await Bun.sleep(60)
    expect(pendingMailboxRequestCount()).toBe(1)
    // Another user holding the stolen token is refused, and learns nothing.
    const stolen = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      { answerToken: turn.getAnswerToken(), items: [{ messageId: "m1", textBody: "forged" }] },
      otherToken,
    )
    expect(stolen.status).toBe(404)
    const answer = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      {
        answerToken: turn.getAnswerToken(),
        items: [{ messageId: "m1", subject: "Invoice 42", textBody: "decrypted on the desktop" }],
        undecryptable: [],
      },
      token,
    )
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ data: { accepted: true } })
    const outcome = await turn.promise
    expect((outcome.result as Record<string, Record<string, unknown>>).mailbox.status).toBe(
      "delivered",
    )
    expect(contexts[0]).toContain("decrypted on the desktop")
    expect(contexts[0]).not.toContain("forged")
    // A late duplicate with the token is answered, not a 404.
    const late = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      { answerToken: turn.getAnswerToken(), items: [] },
      token,
    )
    expect(late.status).toBe(200)
    expect(await late.json()).toEqual({ data: { accepted: false, alreadyAnswered: true } })
  })

  it("refuses an answer that carries neither the turn's nonce nor the request's token", async () => {
    const turn = startPendingTurn([])
    await Bun.sleep(10)
    const res = await post(
      `/api/agent/mailbox-plaintext/${turn.getRequestId()}`,
      { items: [{ messageId: "m1", textBody: "x" }] },
      token,
    )
    expect(res.status).toBe(400)
    const wrong = await post(
      `/api/agent/mailbox-plaintext/${turn.getRequestId()}`,
      { answerToken: "guessed-token", items: [{ messageId: "m1", textBody: "x" }] },
      token,
    )
    expect(wrong.status).toBe(403)
    expect(pendingMailboxRequestCount()).toBe(1)
    MailboxPlaintextRegistryTestAccess.reset()
    await turn.promise
  })

  // A user with two clients open: the one that did not start the turn (an
  // older build, or one whose mailbox is locked) refuses at once, before any
  // CORS preflight of the other; the client that started the turn answers with
  // the plaintext a moment later. The plaintext must win.
  it("two clients: a quick refusal first does not pre-empt the plaintext answer", async () => {
    const contexts: string[] = []
    const turn = startPendingTurn(contexts)
    await Bun.sleep(10)
    const requestId = turn.getRequestId()
    const refusal = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      {
        turnNonce: TURN_NONCE,
        denied: { reason: "this request names a turn this browser did not start" },
      },
      token,
    )
    expect(refusal.status).toBe(200)
    expect(pendingMailboxRequestCount()).toBe(1)
    const answer = await post(
      `/api/agent/mailbox-plaintext/${requestId}`,
      {
        turnNonce: TURN_NONCE,
        items: [{ messageId: "m1", subject: "Invoice 42", textBody: "the plaintext body" }],
        undecryptable: [],
        turnOwner: true,
      },
      token,
    )
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ data: { accepted: true } })
    const outcome = await turn.promise
    expect((outcome.result as Record<string, Record<string, unknown>>).mailbox.status).toBe(
      "delivered",
    )
    expect(contexts[0]).toContain("the plaintext body")
  })

  it("an aborted turn returns the registry to its pre-turn size", async () => {
    const before = pendingMailboxRequestCount()
    const controller = new AbortController()
    const promise = fulfilMailboxMarker({
      result: {
        needsPlaintext: { requestKind: "mail.read", messageIds: ["m1"], purpose: "read" },
      },
      orgId: ORG_ID,
      userId: USER_ID,
      threadId: THREAD_ID,
      frame: frame(),
      abortSignal: controller.signal,
      deps: {
        getUnlock: async () => ({ unlocked: true, keyIds: [], expiresAt: Date.now() + 60_000 }),
        emit: async () => {},
        injectContext: () => {},
      },
    })
    await Bun.sleep(10)
    expect(pendingMailboxRequestCount()).toBe(before + 1)
    controller.abort("timeout")
    const outcome = await promise
    expect((outcome.result as any).mailbox.status).toBe(MAILBOX_LOCKED)
    expect(pendingMailboxRequestCount()).toBe(before)
  })

  it("accepts the search response shape on its own endpoint", async () => {
    let requestId = ""
    const promise = fulfilMailboxMarker({
      result: { needsClientSearch: { query: "invoice", limit: 20 } },
      orgId: ORG_ID,
      userId: USER_ID,
      threadId: THREAD_ID,
      frame: frame(),
      deps: {
        getUnlock: async () => ({ unlocked: true, keyIds: [], expiresAt: Date.now() + 60_000 }),
        emit: async (_a, data) => {
          requestId = String((data as Record<string, unknown>).requestId)
        },
        injectContext: () => {},
      },
    })
    await Bun.sleep(10)
    const res = await post(
      `/api/agent/mailbox-search/${requestId}`,
      { turnNonce: TURN_NONCE, messageIds: ["m7", "m8"] },
      token,
    )
    expect(res.status).toBe(200)
    const outcome = await promise
    expect((outcome.retryArgs as any).__mailboxSearchIds).toEqual(["m7", "m8"])
    // The retry has to be able to tell "no matches" from "this browser could
    // not answer", or an unbuilt index reads as an empty mailbox.
    expect((outcome.retryArgs as any).__mailboxSearchIndexComplete).toBe(true)
  })

  it("carries an incomplete index through to the retry", async () => {
    let requestId = ""
    const promise = fulfilMailboxMarker({
      result: { needsClientSearch: { query: "invoice", limit: 20 } },
      orgId: ORG_ID,
      userId: USER_ID,
      threadId: THREAD_ID,
      frame: frame(),
      deps: {
        getUnlock: async () => ({ unlocked: true, keyIds: [], expiresAt: Date.now() + 60_000 }),
        emit: async (_a, data) => {
          requestId = String((data as Record<string, unknown>).requestId)
        },
        injectContext: () => {},
      },
    })
    await Bun.sleep(10)
    const res = await post(
      `/api/agent/mailbox-search/${requestId}`,
      { turnNonce: TURN_NONCE, messageIds: [], indexComplete: false, turnOwner: true },
      token,
    )
    expect(res.status).toBe(200)
    const outcome = await promise
    expect((outcome.retryArgs as any).__mailboxSearchIds).toEqual([])
    expect((outcome.retryArgs as any).__mailboxSearchIndexComplete).toBe(false)
  })
})
