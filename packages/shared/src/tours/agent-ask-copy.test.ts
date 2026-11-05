// SPDX-License-Identifier: FSL-1.1-ALv2
// Every request a tour or scenario sends to the person's agent says where to
// answer from, and rules out a web search, except the chat scenario's, which
// is a search by design. A search after the turn read workspace data waits for
// a person (the query could carry that data out), so an unasked search left a
// held request on Home that no step approves (walk D70 for chat, D75 for the
// Tickets draft).
import { describe, expect, it } from "bun:test"
import en from "../i18n/locales/en/tours.json"
import fr from "../i18n/locales/fr/tours.json"
import { SCENARIO_TOURS, TOURS } from "./index"
import type { TourStep } from "./schema"

/** The composers a request to the person's agent goes through. */
const AGENT_COMPOSERS = new Set(["compose-field", "compose-editor", "task-discussion.composer"])

/** Searches by design: the chat scenario's question, and its follow-up on that answer. */
const SEARCHES = new Set([
  "tours.scenarios.chat.askAgent.text",
  "tours.scenarios.chat.followUp.text",
])

function lookup(locale: unknown, key: string): string {
  let node: unknown = locale
  for (const part of key.replace(/^tours\./, "").split(".")) {
    node = (node as Record<string, unknown> | undefined)?.[part]
  }
  if (typeof node !== "string") throw new Error(`no copy for ${key}`)
  return node
}

function agentAsks(): string[] {
  const keys = new Set<string>()
  for (const tour of [...TOURS, ...SCENARIO_TOURS]) {
    for (const beat of tour.beats) {
      const steps: TourStep[] = [...(beat.autoplay ?? []), ...(beat.autoplayPhone ?? [])]
      steps.forEach((step, i) => {
        if (!("type" in step) || !AGENT_COMPOSERS.has(step.type.testid)) return
        // Only the person's own agent: the run's conversation (pinned to it),
        // a composer guarded as theirs, or a discussion the request is appended
        // to after the agent's mention. A post to colleagues is not an ask.
        const prev = steps[i - 1]
        const toAgent =
          step.type.created !== undefined ||
          step.type.append === true ||
          (prev !== undefined && "require" in prev && prev.require.attr === "data-personal-agent")
        if (!toAgent) return
        if (!step.type.text.startsWith("tours.")) return
        keys.add(step.type.text)
      })
    }
  }
  return [...keys]
}

describe("what the tours ask the agent", () => {
  it("finds the asks (the walk's Tickets, Mail, Projects, connector and scenario requests)", () => {
    const asks = agentAsks()
    expect(asks).toContain("tours.tickets.basics.askDraft.text")
    expect(asks).toContain("tours.mail.basics.summariseDraft.text")
    expect(asks).toContain("tours.scenarios.commerce.askAgent.text")
  })

  // Owner (walk 2026-10-27): a person never tells their agent to skip the web,
  // so no ask does (but the chat scenario's, which asks for one). An agent that reaches for it needlessly is a product bug.
  it("no ask tells the agent to skip a web search, in English or French", () => {
    for (const key of agentAsks()) {
      if (SEARCHES.has(key)) continue
      expect({ key, text: lookup(en, key) }).not.toEqual({
        key,
        text: expect.stringMatching(/web search/i),
      })
      expect({ key, text: lookup(fr, key) }).not.toEqual({
        key,
        text: expect.stringMatching(/recherche web/i),
      })
    }
  })

  // Walk D74: the agent tidied the shipment draft's customs description before
  // booking, a second held write that nothing approved. The ask books the
  // draft as it is.
  it("the commerce ask books the prep list row as it is, with no other change", () => {
    expect(en.scenarios.commerce.askAgent.text).toMatch(/as it is/)
    expect(en.scenarios.commerce.askAgent.text).toMatch(/no other change/)
    expect(fr.scenarios.commerce.askAgent.text).toMatch(/telle quelle/)
    expect(fr.scenarios.commerce.askAgent.text).toMatch(/sans autre modification/)
  })

  // Walk 2026-10-26: the Operations Desk read "no other change" as "do not buy
  // the label" and stopped after picking the offer. The ask names buying the
  // label as the change it wants.
  it("the commerce ask names buying the label as the one change", () => {
    expect(en.scenarios.commerce.askAgent.text).toMatch(/buy the label/)
    expect(fr.scenarios.commerce.askAgent.text).toMatch(/achetez l'étiquette/)
  })

  // Walk 2026-10-26: "from its prepared draft" sent the agent to the shop's
  // draft ORDERS, found none, and it refused to book. The ask names the
  // shipping prep list, where the order's shipment draft and quotes are.
  it("the commerce ask names the shipping prep list, not a draft", () => {
    expect(en.scenarios.commerce.askAgent.text).toMatch(/shipping prep list/)
    expect(en.scenarios.commerce.askAgent.text).not.toMatch(/draft/)
    expect(fr.scenarios.commerce.askAgent.text).toMatch(/liste des expéditions à préparer/)
    expect(fr.scenarios.commerce.askAgent.text).not.toMatch(/brouillon/)
  })

  // Walk 2026-10-26: the draft fixes no carrier, so "as it is" alone left the
  // agent asking which one to book. The ask names the choice.
  it("the commerce ask names the carrier to book: the cheapest offer", () => {
    expect(en.scenarios.commerce.askAgent.text).toMatch(/cheapest carrier offer/)
    expect(fr.scenarios.commerce.askAgent.text).toMatch(/offre de transporteur la moins chère/)
  })
})
