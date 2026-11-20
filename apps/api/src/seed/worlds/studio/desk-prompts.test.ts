// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The services world's desks speak with the products world's prompts, the
// company's facts swapped: each prompt is within 0 to +5 tokens of its
// counterpart, on the same chars/4 ruler production compaction uses, so a
// bench or a walk compares the worlds on the same amount of instruction.
import { describe, expect, it } from "bun:test"
import { estimateTokens } from "~/modules/agent/context/compaction"
import { DEMO_ROLE_AGENTS } from "~/seed/world/fiction"
import { foreignLiterals } from "../literals"
import { STUDIO_ROLE_AGENTS } from "./desk-prompts"

/** Each desk and the products desk whose prompt it is built from. */
const COUNTERPARTS: ReadonlyArray<[studio: string, products: string]> = [
  ["@support", "@support"],
  ["@delivery", "@operations"],
  ["@sales", "@operations"],
  ["@finance", "@finance"],
]

const promptOf = (
  agents: ReadonlyArray<{ handle: string; systemPrompt: string }>,
  handle: string,
) => {
  const agent = agents.find((a) => a.handle === handle)
  if (!agent) throw new Error(`no desk ${handle}`)
  return agent.systemPrompt
}

describe("services world desk prompts", () => {
  for (const [studio, products] of COUNTERPARTS) {
    it(`the ${studio} desk's prompt is within 0 to +5 tokens of the products ${products} desk's`, () => {
      const delta =
        estimateTokens(promptOf(STUDIO_ROLE_AGENTS, studio)) -
        estimateTokens(promptOf(DEMO_ROLE_AGENTS, products))
      expect(delta).toBeGreaterThanOrEqual(0)
      expect(delta).toBeLessThanOrEqual(5)
    })
  }

  it("the delivery, finance, sales and support desks each have a counterpart, and no prompt names another world", () => {
    expect(STUDIO_ROLE_AGENTS.map((a) => a.displayName).sort()).toEqual([
      "Delivery Desk",
      "Finance Desk",
      "Sales Desk",
      "Support Desk",
    ])
    expect(STUDIO_ROLE_AGENTS.map((a) => a.handle).sort()).toEqual(
      COUNTERPARTS.map(([studio]) => studio).sort(),
    )
    for (const agent of STUDIO_ROLE_AGENTS) {
      const text = `${agent.purpose}\n${agent.systemPrompt}`
      expect(foreignLiterals("studio", text)).toEqual([])
      expect(agent.systemPrompt).toContain("Halden Studio")
    }
  })
})
