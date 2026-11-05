// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"
import {
  AGENT_PLAINTEXT_CAPS,
  type AgentDecryptRequest,
  createAgentPlaintextResponder,
} from "~/modules/mailbox/agent-plaintext-responder"

const TURN = "turn-nonce-1"

function request(overrides: Partial<AgentDecryptRequest> = {}): AgentDecryptRequest {
  return {
    requestId: "inst:req-1",
    turnNonce: TURN,
    requestKind: "mail.read",
    messageIds: ["m1"],
    purpose: "read the conversation",
    expiresAt: new Date(Date.now() + 45_000).toISOString(),
    ...overrides,
  }
}

interface Posted {
  requestId: string
  body: Record<string, unknown>
}

function harness(
  opts: {
    openTurns?: string[]
    unlocked?: boolean
    allowed?: string[]
    agentAccess?: boolean
    confirmDisclosure?: (text: string, messageIds: string[]) => Promise<boolean>
    openAttachments?: (fileIds: string[]) => Promise<Array<{ fileId: string; bytesBase64: string }>>
  } = {},
) {
  const posted: Posted[] = []
  const disclosures: Array<{ requestId: string; messageIds: string[] }> = []
  const allowed = new Set(opts.allowed ?? ["m1", "m2", "m3"])
  const responder = createAgentPlaintextResponder({
    isOpenTurn: (nonce) => (opts.openTurns ?? [TURN]).includes(nonce),
    isUnlocked: () => opts.unlocked ?? true,
    isIdInTurnScope: (id) => allowed.has(id),
    agentMailAccessEnabled: () => opts.agentAccess ?? true,
    openMessages: async (ids) =>
      ids.map((id) => ({
        id,
        subject: `subject ${id}`,
        textBody: `body ${id}`,
        htmlBody: null,
        snippet: null,
      })),
    post: async (requestId, body) => {
      posted.push({ requestId, body: body as Record<string, unknown> })
    },
    recordDisclosure: (entry) => {
      disclosures.push(entry)
    },
    ...(opts.confirmDisclosure ? { confirmDisclosure: opts.confirmDisclosure } : {}),
    ...(opts.openAttachments ? { openAttachments: opts.openAttachments } : {}),
  })
  return { responder, posted, disclosures }
}

describe("agent plaintext responder", () => {
  let h: ReturnType<typeof harness>

  beforeEach(() => {
    h = harness()
  })

  it("non-vacuity: answers an in-scope request and counts what it released", async () => {
    const outcome = await h.responder.handle(request({ messageIds: ["m1", "m2"] }))
    expect(outcome.accepted).toBe(true)
    expect(h.posted.length).toBe(1)
    expect(h.posted[0].requestId).toBe("inst:req-1")
    const items = h.posted[0].body.items as Array<Record<string, unknown>>
    expect(items.map((i) => i.messageId)).toEqual(["m1", "m2"])
    expect(items[0].textBody).toBe("body m1")
    expect(h.responder.releasedThisSession()).toBe(2)
    expect(h.disclosures[0].messageIds).toEqual(["m1", "m2"])
  })

  // ── Task 9.7: converting to a ticket is a DISCLOSURE, not a read ──────────
  //
  // The ticket is team visible, so this is the one request kind that makes the
  // user's mail readable by other people. It therefore needs an explicit yes,
  // shown in the client's own words, and a missing answer is a no.
  it("refuses a conversion request when nothing asked the user to confirm it", async () => {
    // No `confirmDisclosure` dependency wired means nothing can have asked.
    const outcome = await h.responder.handle(
      request({
        requestKind: "mail.convert",
        disclosure: "This will make the message body and subject readable by everyone.",
      }),
    )
    expect(outcome.accepted).toBe(false)
    expect(h.posted[0].body.denied).toBeDefined()
  })

  it("refuses a conversion the user declined, and releases nothing", async () => {
    const declining = harness({
      confirmDisclosure: async () => false,
    })
    const outcome = await declining.responder.handle(
      request({
        requestKind: "mail.convert",
        disclosure: "This will make the message body and subject readable by everyone.",
      }),
    )
    expect(outcome.accepted).toBe(false)
    expect(declining.posted[0].body.items).toBeUndefined()
    expect(declining.responder.releasedThisSession()).toBe(0)
  })

  it("shows the disclosure sentence and answers with consent once the user agrees", async () => {
    const shown: string[] = []
    const agreeing = harness({
      confirmDisclosure: async (text: string) => {
        shown.push(text)
        return true
      },
    })
    const outcome = await agreeing.responder.handle(
      request({
        requestKind: "mail.convert",
        disclosure: "This will make the message body and subject readable by everyone.",
      }),
    )
    expect(outcome.accepted).toBe(true)
    expect(shown[0]).toContain("readable by everyone")
    expect(agreeing.posted[0].body.consented).toBe(true)
    const items = agreeing.posted[0].body.items as Array<Record<string, unknown>>
    expect(items[0].textBody).toBe("body m1")
  })

  // ── Task 9.9: attachment bytes ────────────────────────────────────────────
  it("refuses an attachment request when this client cannot open sealed files", async () => {
    const outcome = await h.responder.handle(
      request({ requestKind: "mail.attachment", messageIds: ["m1"] }),
    )
    expect(outcome.accepted).toBe(false)
    expect(h.posted[0].body.denied).toBeDefined()
  })

  it("answers an attachment request with the decrypted bytes when it can", async () => {
    const withFiles = harness({
      openAttachments: async (ids: string[]) =>
        ids.map((fileId) => ({ fileId, bytesBase64: "QUJD" })),
    })
    const outcome = await withFiles.responder.handle(
      request({ requestKind: "mail.attachment", messageIds: ["m1"] }),
    )
    expect(outcome.accepted).toBe(true)
    const items = withFiles.posted[0].body.items as Array<Record<string, unknown>>
    expect(items[0]).toEqual({ messageId: "m1", bytesBase64: "QUJD" })
  })

  // ── The agent reads a mail attachment (kernel__mail_attachment_read) ─────
  describe("an attachment read for the agent", () => {
    const FILE = "f-invoice"
    const opened = async (ids: string[]) =>
      ids.map((fileId) => ({ fileId, bytesBase64: "JVBERg==" }))

    it("serves an attachment of the user's own mail, loaded in this window or not", async () => {
      // The turn's own window is not stricter than the user's other apps: the
      // file is opened whatever this window has loaded (see the header).
      const reader = harness({ openAttachments: opened, allowed: [] })
      const outcome = await reader.responder.handle(
        request({ requestKind: "mail.attachment", messageIds: [FILE] }),
      )
      expect(outcome.accepted).toBe(true)
      expect(reader.posted[0].body.turnOwner).toBe(true)
      expect(reader.posted[0].body.items).toEqual([{ messageId: FILE, bytesBase64: "JVBERg==" }])
    })

    it("another unlocked app of the user answers with the request's token", async () => {
      const posted: Array<Record<string, unknown>> = []
      const otherApp = createAgentPlaintextResponder({
        answerWithToken: true,
        isOpenTurn: () => true,
        isUnlocked: () => true,
        isIdInTurnScope: () => true,
        agentMailAccessEnabled: () => true,
        openMessages: async () => [],
        openAttachments: opened,
        post: async (_id, body) => {
          posted.push(body as Record<string, unknown>)
        },
        recordDisclosure: () => {},
      })
      const outcome = await otherApp.handle(
        request({
          requestKind: "mail.attachment",
          messageIds: [FILE],
          turnNonce: "a-turn-of-the-phone",
          answerToken: "token-1",
        }),
      )
      expect(outcome.accepted).toBe(true)
      expect(posted[0]).toEqual({
        answerToken: "token-1",
        items: [{ messageId: FILE, bytesBase64: "JVBERg==" }],
        undecryptable: [],
      })
    })

    it("refuses an attachment over 25 MB plainly, without throwing", async () => {
      const reader = harness({
        openAttachments: async () => {
          throw Object.assign(new Error("too big"), { code: "too_large" })
        },
      })
      const outcome = await reader.responder.handle(
        request({ requestKind: "mail.attachment", messageIds: [FILE] }),
      )
      expect(outcome.accepted).toBe(false)
      expect(outcome.reason).toContain("25 MB")
      expect((reader.posted[0].body.denied as { reason: string }).reason).toContain("25 MB")
    })

    it("says the mailbox is locked when the worker is locked", async () => {
      const reader = harness({
        openAttachments: async () => {
          throw Object.assign(new Error("locked"), { code: "mailbox_locked" })
        },
      })
      await reader.responder.handle(request({ requestKind: "mail.attachment", messageIds: [FILE] }))
      expect(reader.posted[0].body.denied).toEqual({
        reason: "this mailbox is locked, so nothing can be decrypted",
        code: "locked",
      })
    })
  })

  it("refuses a turn nonce this client does not have open", async () => {
    const outcome = await h.responder.handle(request({ turnNonce: "someone-elses-turn" }))
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toContain("turn")
    // A refusal is POSTED, not silence: the turn must not sit waiting.
    expect(h.posted[0].body.denied).toBeDefined()
    expect(h.posted[0].body.items).toBeUndefined()
    expect(h.responder.releasedThisSession()).toBe(0)
  })

  it("serves a read of ids this window never loaded: the user's own mail, in the user's turn", async () => {
    const nothingLoaded = harness({ allowed: [] })
    const outcome = await nothingLoaded.responder.handle(request({ messageIds: ["m1", "m9"] }))
    expect(outcome.accepted).toBe(true)
    const items = nothingLoaded.posted[0].body.items as Array<Record<string, unknown>>
    expect(items.map((i) => i.messageId)).toEqual(["m1", "m9"])
    expect(nothingLoaded.posted[0].body).toMatchObject({ turnNonce: TURN, turnOwner: true })
  })

  it("still refuses a read of ids it never loaded while locked or switched off", async () => {
    for (const opts of [{ unlocked: false }, { agentAccess: false }]) {
      const refused = harness({ ...opts, allowed: [] })
      const outcome = await refused.responder.handle(request({ messageIds: ["m9"] }))
      expect(outcome.accepted).toBe(false)
      expect(refused.posted[0].body.denied).toBeDefined()
      expect(refused.posted[0].body.items).toBeUndefined()
      expect(refused.responder.releasedThisSession()).toBe(0)
    }
  })

  it("refuses a conversion naming an id that was not surfaced in this turn, before asking", async () => {
    let asked = 0
    const converting = harness({
      confirmDisclosure: async () => {
        asked += 1
        return true
      },
    })
    const outcome = await converting.responder.handle(
      request({ requestKind: "mail.convert", messageIds: ["m1", "not-in-scope"] }),
    )
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toContain("scope")
    expect(asked).toBe(0)
    // Partial service would be worse than refusal: it hands the agent exactly
    // the ids it was not allowed to enumerate, one probe at a time.
    expect(converting.posted[0].body.items).toBeUndefined()
    expect(converting.responder.releasedThisSession()).toBe(0)
  })

  it("refuses a batch over the per-request cap", async () => {
    const ids = Array.from({ length: AGENT_PLAINTEXT_CAPS.perRequest + 1 }, (_, i) => `m${i}`)
    const big = harness({ allowed: ids })
    const outcome = await big.responder.handle(request({ messageIds: ids }))
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toContain("at most")
    expect(big.responder.releasedThisSession()).toBe(0)
  })

  it("refuses past the per-turn request cap and the per-turn message cap", async () => {
    const ids = ["m1", "m2", "m3"]
    for (let i = 0; i < AGENT_PLAINTEXT_CAPS.requestsPerTurn; i++) {
      const outcome = await h.responder.handle(
        request({ requestId: `inst:r${i}`, messageIds: ids }),
      )
      expect(outcome.accepted).toBe(true)
    }
    const outcome = await h.responder.handle(request({ requestId: "inst:one-too-many" }))
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toContain("this turn")
  })

  it("refuses while the mailbox is locked", async () => {
    const locked = harness({ unlocked: false })
    const outcome = await locked.responder.handle(request())
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toContain("locked")
  })

  it("refuses when the user turned the agent's mail access off", async () => {
    const off = harness({ agentAccess: false })
    const outcome = await off.responder.handle(request())
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toContain("turned off")
    expect(off.posted[0].body.denied).toBeDefined()
  })

  it("stops at the per-session budget", async () => {
    const ids = ["m1"]
    const session = harness()
    // Drive the session counter straight to its cap rather than looping 2000
    // times: the cap is the property under test, not the loop.
    session.responder.__setReleasedForTest(AGENT_PLAINTEXT_CAPS.perSession)
    const outcome = await session.responder.handle(request({ messageIds: ids }))
    expect(outcome.accepted).toBe(false)
    expect(outcome.reason).toContain("session")
  })

  it("a new turn resets the per-turn counters but not the session counter", async () => {
    const two = harness({ openTurns: [TURN, "turn-2"] })
    await two.responder.handle(request())
    expect(two.responder.releasedThisSession()).toBe(1)
    for (let i = 1; i < AGENT_PLAINTEXT_CAPS.requestsPerTurn; i++) {
      await two.responder.handle(request({ requestId: `inst:a${i}` }))
    }
    expect((await two.responder.handle(request({ requestId: "inst:over" }))).accepted).toBe(false)
    const next = await two.responder.handle(
      request({ requestId: "inst:new-turn", turnNonce: "turn-2" }),
    )
    expect(next.accepted).toBe(true)
    expect(two.responder.releasedThisSession()).toBe(AGENT_PLAINTEXT_CAPS.requestsPerTurn + 1)
  })
})
