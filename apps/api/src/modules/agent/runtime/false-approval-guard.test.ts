// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The corrective continuation's text is held until its verdict: a kept
// rewrite is released, a dropped one is never streamed (a fixed platform line
// takes its place), so what a live viewer saw of the rewrite is what the
// stored reply keeps.
import { describe, expect, it } from "bun:test"
import { claimedCards } from "./card-claim"
import {
  CORRECTION_SEPARATOR,
  containsShownCard,
  preCallTextContradicted,
  type Retraction,
  retractFromText,
  toolOutcome,
  withFalseApprovalGuard,
} from "./false-approval-guard"

type Chunk = Record<string, unknown>

function run(chunks: Chunk[]) {
  return {
    fullStream: (async function* () {
      for (const c of chunks) yield c
    })(),
    responseMessages: Promise.resolve([]),
  }
}

const textRun = (text: string): Chunk[] => [
  { type: "text-delta", text: text.slice(0, 10) },
  { type: "text-delta", text: text.slice(10) },
  { type: "finish-step", finishReason: "stop" },
  { type: "finish", finishReason: "stop" },
]

const FIRST = "Colissimo is the cheapest. I'll book the shipment now."
const NOTICE = "Nothing was run for this yet."

async function drive(second: Chunk[], keep: (t: { text: string; calledTool: boolean }) => boolean) {
  let retraction: Retraction | null = null
  const events: Chunk[] = []
  for await (const raw of withFalseApprovalGuard({
    first: run(textRun(FIRST)),
    shouldCorrect: async () => true,
    continueWith: () => run(second),
    onRetract: (r) => {
      retraction = r
    },
    keepContinuation: keep,
    droppedNotice: () => NOTICE,
  })) {
    events.push(raw as Chunk)
  }
  const streamed = events
    .filter((e) => e.type === "text-delta")
    .map((e) => e.text as string)
    .join("")
  const stored = retraction ? retractFromText(streamed, retraction) : streamed
  return { events, streamed, stored, retraction }
}

describe("the corrective continuation streams only what is stored", () => {
  it("a kept rewrite is released and is what the reply stores", async () => {
    const rewrite = "No shipping app is connected, so I cannot book it."
    const { streamed, stored, events } = await drive(textRun(rewrite), () => true)
    expect(stored).toBe(rewrite)
    // The live stream is the first answer, the separator, then exactly the stored reply.
    expect(streamed).toBe(FIRST + CORRECTION_SEPARATOR + stored)
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1)
    expect(events[events.length - 1].type).toBe("finish")
  })

  it("a dropped rewrite is never streamed; the stored reply is exactly what was streamed", async () => {
    const fabricated = "I just re-checked the options: Colissimo is still the cheapest."
    const { streamed, stored, retraction } = await drive(textRun(fabricated), () => false)
    expect(streamed).not.toContain("re-checked")
    expect(retraction).toBeNull()
    expect(stored).toBe(streamed)
    expect(stored).toBe(FIRST + CORRECTION_SEPARATOR + NOTICE)
  })

  it("text before a tool call is released at the call, in order, and the rewrite is kept", async () => {
    const chunks: Chunk[] = [
      { type: "text-delta", text: "Searching. " },
      { type: "tool-call", toolCallId: "c1", toolName: "kernel__tool_search" },
      { type: "tool-result", toolCallId: "c1", output: {} },
      { type: "finish-step", finishReason: "tool-calls" },
      { type: "text-delta", text: "None is connected." },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish", finishReason: "stop" },
    ]
    let seen: { text: string; calledTool: boolean } | null = null
    const { events, stored } = await drive(chunks, (r) => {
      seen = r
      return true
    })
    const kinds = events.map((e) => e.type)
    const firstSearch = events.findIndex((e) => e.type === "text-delta" && e.text === "Searching. ")
    expect(firstSearch).toBeGreaterThan(-1)
    expect(firstSearch).toBeLessThan(kinds.indexOf("tool-call"))
    expect(stored).toBe("Searching. None is connected.")
    // A tool call decides it: the verdict is not asked.
    expect(seen).toBeNull()
  })
})

// Live check 2026-10-27: text written before a call, contradicted by its result.
const TICKETS_PRE =
  "I have submitted a request to enable the Tickets app. Please approve the pending approval card in this conversation to complete it."
const CARD_AGAIN_PRE =
  "I have posted the connect card again above. Please click Connect on the card."
const NO_CHANGE = {
  tellThePerson: "Tickets is already enabled.",
  section: "apps",
  changed: false,
  plan: [],
}
const ALREADY_POSTED = {
  requestId: "2b6f0f0e-0000-4000-8000-000000000001",
  kind: "oauth_connect",
  target: {},
  card: "already_posted",
  note: "This card was already posted in this conversation and is still waiting.",
}
const PARKED = { blocked: true, status: "pending_approval", handle: "request-2" }

describe("text before a tool call that the call's result contradicts", () => {
  it("reads what a tool result did", () => {
    expect(toolOutcome(NO_CHANGE)).toBe("no_change")
    expect(toolOutcome(ALREADY_POSTED)).toBe("already_posted")
    expect(toolOutcome({ ...ALREADY_POSTED, card: "posted" })).toBe("acted")
    expect(toolOutcome(PARKED)).toBe("acted")
    expect(toolOutcome({ error: { code: "invalid_target", message: "no" } })).toBe("refused")
    expect(toolOutcome({ results: [{ name: "x" }] })).toBe("other")
    expect(toolOutcome("text")).toBe("other")
    // Some entries changed: not a no-op.
    expect(toolOutcome({ items: [{ changed: false }, { changed: true }] })).toBe("other")
  })

  it("a no-op enable under 'approve the pending card' is contradicted", () => {
    expect(preCallTextContradicted(TICKETS_PRE, [NO_CHANGE])).toBe("no_change")
  })

  it("'posted the card again' over an already_posted dedupe is contradicted", () => {
    expect(preCallTextContradicted(CARD_AGAIN_PRE, [ALREADY_POSTED])).toBe("already_posted")
  })

  it("a refused call contradicts a claim written before it", () => {
    expect(
      preCallTextContradicted(TICKETS_PRE, [{ error: { code: "forbidden", message: "no" } }]),
    ).toBe("refused")
  })

  it("a real approval or a posted card is never contradicted", () => {
    expect(preCallTextContradicted(TICKETS_PRE, [PARKED])).toBeNull()
    expect(preCallTextContradicted(TICKETS_PRE, [NO_CHANGE, PARKED])).toBeNull()
    expect(
      preCallTextContradicted(CARD_AGAIN_PRE, [{ ...ALREADY_POSTED, card: "posted" }]),
    ).toBeNull()
  })

  it("a later call that went through, or text that claims nothing, is left alone", () => {
    expect(preCallTextContradicted(TICKETS_PRE, [NO_CHANGE, { results: [] }])).toBeNull()
    expect(preCallTextContradicted("Let me check that for you.", [NO_CHANGE])).toBeNull()
    expect(preCallTextContradicted("", [NO_CHANGE])).toBeNull()
    expect(preCallTextContradicted(TICKETS_PRE, [])).toBeNull()
  })

  it("the claims themselves are read as claims", () => {
    expect([...claimedCards(TICKETS_PRE)]).toContain("approval")
    expect(claimedCards(CARD_AGAIN_PRE).size).toBeGreaterThan(0)
  })

  it("'precall' withholds the text before the last call and keeps the answer after it", async () => {
    const final = "Tickets is already enabled."
    const chunks: Chunk[] = [
      { type: "text-delta", text: TICKETS_PRE },
      { type: "tool-call", toolCallId: "c1", toolName: "kernel__config_apps" },
      { type: "tool-result", toolCallId: "c1", output: NO_CHANGE },
      { type: "finish-step", finishReason: "tool-calls" },
      { type: "text-delta", text: final },
      { type: "finish-step", finishReason: "stop" },
      { type: "finish", finishReason: "stop" },
    ]
    const cut: { retraction: Retraction | null } = { retraction: null }
    let continued = false
    const events: Chunk[] = []
    for await (const raw of withFalseApprovalGuard({
      first: run(chunks),
      shouldCorrect: async (r) =>
        preCallTextContradicted(
          r.allText.slice(0, r.allText.length - r.finalText.length),
          r.toolOutputs,
        )
          ? "precall"
          : false,
      continueWith: () => {
        continued = true
        return run(textRun("never"))
      },
      onRetract: (r) => {
        cut.retraction = r
      },
    })) {
      events.push(raw as Chunk)
    }
    const streamed = events
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text as string)
      .join("")
    expect(continued).toBe(false)
    if (!cut.retraction) throw new Error("expected the text before the call to be withheld")
    expect(retractFromText(streamed, cut.retraction)).toBe(final)
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1)
  })
})

describe("a card drawn under a tool call backs a card claim", () => {
  it("the Drive picker is a shown card; a read is not", () => {
    expect(containsShownCard({ accounts: [], card: "shown", nextStep: "…" })).toBe(true)
    expect(containsShownCard({ result: { card: "shown" } })).toBe(true)
    expect(containsShownCard({ card: "none" })).toBe(false)
    expect(containsShownCard({ rows: [] })).toBe(false)
    // "The card is waiting for you below" claims a card: the shown card backs it.
    expect(claimedCards("The card is waiting for you below.").has("any")).toBe(true)
  })
})
