// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import {
  AGENT_PLAINTEXT_CAPS,
  createAgentPlaintextResponder,
} from "~/modules/mailbox/agent-plaintext-responder"
import { createJobAgentTurnRunner } from "~/modules/mailbox/agent-turn-runner"
import { createAgentTurnSession, openMessagesForTurn } from "~/modules/mailbox/agent-turn-session"

function opened(id: string) {
  return { id, subject: `s ${id}`, textBody: `b ${id}`, htmlBody: null, snippet: null }
}

describe("agent turn session", () => {
  it("scopes ids to the turn that named them", () => {
    const session = createAgentTurnSession()
    const a = session.begin({ allowedIds: ["m1"] })
    const b = session.begin({ allowedIds: ["m2"] })
    expect(session.isOpenTurn(a)).toBe(true)
    expect(session.isIdInTurnScope("m1", a)).toBe(true)
    expect(session.isIdInTurnScope("m2", a)).toBe(false)
    expect(session.isIdInTurnScope("m2", b)).toBe(true)
    session.end(a)
    expect(session.isOpenTurn(a)).toBe(false)
    expect(session.isIdInTurnScope("m1", a)).toBe(false)
  })

  it("forgets a turn nobody closed", () => {
    let clock = 0
    const session = createAgentTurnSession({ now: () => clock })
    const nonce = session.begin({ allowedIds: ["m1"] })
    clock += 16 * 60 * 1000
    expect(session.isOpenTurn(nonce)).toBe(false)
  })
})

describe("the client job turn runner, which is Phase 11's integration point", () => {
  it("opens a scope, answers the turn's decrypt request from it, and closes it", async () => {
    const session = createAgentTurnSession()
    const posted: Array<Record<string, unknown>> = []
    let openedCalls = 0

    const responder = createAgentPlaintextResponder({
      isOpenTurn: (nonce) => session.isOpenTurn(nonce),
      isUnlocked: () => true,
      isIdInTurnScope: (id, nonce) => session.isIdInTurnScope(id, nonce),
      agentMailAccessEnabled: () => true,
      // The production wiring: the turn scope serves what it already holds, and
      // only the rest reaches the worker.
      openMessages: openMessagesForTurn(session, async (ids) => {
        openedCalls += 1
        return ids.map((id) => opened(id))
      }),
      post: async (_requestId, body) => {
        posted.push(body)
      },
      recordDisclosure: () => {},
    })

    const runner = createJobAgentTurnRunner({
      session,
      submitTurn: async ({ turnNonce }) => {
        // This is the server asking, mid-turn, for the ids the job named.
        const outcome = await responder.handle({
          requestId: "inst:req-job",
          turnNonce,
          requestKind: "mail.read",
          messageIds: ["m1"],
          purpose: "summarise the queued mail",
          expiresAt: new Date(Date.now() + 45_000).toISOString(),
        })
        expect(outcome.accepted).toBe(true)
        return { text: "summary" }
      },
    })

    const result = await runner({
      jobId: "job-1",
      kind: "summarise",
      prompt: "Run the queued mailbox job",
      turnNonce: "placeholder",
      messageIds: ["m1"],
      plaintext: [opened("m1")],
    })

    expect(result.text).toBe("summary")
    expect((posted[0].items as Array<Record<string, unknown>>)[0].textBody).toBe("b m1")
    expect(openedCalls).toBe(0)
    // The scope is gone the moment the turn ends: an open scope is standing
    // permission to decrypt.
    expect(session.openTurnCount()).toBe(0)
    expect(responder.releasedThisSession()).toBe(1)
    expect(AGENT_PLAINTEXT_CAPS.perRequest).toBe(25)
  })

  it("closes the scope even when the turn throws", async () => {
    const session = createAgentTurnSession()
    const runner = createJobAgentTurnRunner({
      session,
      submitTurn: async () => {
        throw new Error("provider down")
      },
    })
    await expect(
      runner({
        jobId: "job-2",
        kind: "summarise",
        prompt: "p",
        turnNonce: "placeholder",
        messageIds: ["m1"],
        plaintext: [opened("m1")],
      }),
    ).rejects.toThrow("provider down")
    expect(session.openTurnCount()).toBe(0)
  })
})
