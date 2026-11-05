// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The create_routine approval card is the user's one confirmation of the routine's scopes, so the
// card must show every scope it grants. Card lines are capped at 200 characters (a longer line is
// cut and ends on "…") and a card keeps 8 lines: a routine with many scopes had its "It will read"
// line cut, hiding granted scopes behind the ellipsis.
import { describe, expect, it } from "bun:test"
import {
  type ApprovalSummary,
  approvalSummarySchema,
  truncateApprovalSummary,
} from "@liaison/shared"
import {
  routineScopeLines,
  summarizeCreateRoutine,
} from "~/modules/agent/tools/skills-routines-tools"

const READ_APPS = ["mail", "tickets", "contacts", "calendar", "knowledge", "shopify", "boxtal"]

function manyScopes(perApp: number): string[] {
  const out: string[] = []
  for (const app of READ_APPS) {
    for (let i = 0; i < perApp; i++) {
      out.push(`${app}:records${i}:read`, `${app}:records${i}:write`)
    }
  }
  return out
}

async function cardLines(scopes: string[]): Promise<string[]> {
  const raw = (await summarizeCreateRoutine({
    name: "big",
    description: "A routine that touches everything",
    cron: "0 9 * * 1",
    timezone: "Europe/Paris",
    prompt: "p",
    scopes,
    enabled: true,
  })) as ApprovalSummary
  // What the card stores: the summarizer output bounded the way the gate bounds it
  // (generateApprovalSummary), then valid against the stored shape.
  const summary = approvalSummarySchema.parse(truncateApprovalSummary(raw))
  return summary.lines
}

describe("routine scope lines on the approval card", () => {
  it("a short list stays one line per category", () => {
    const lines = routineScopeLines([
      "kernel:contacts:read",
      "kernel:agent:web",
      "mail:messages:write",
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]?.startsWith("It will read:")).toBe(true)
    expect(lines[1]?.startsWith("It will change:")).toBe(true)
  })

  for (const perApp of [2, 6]) {
    it(`no granted scope is hidden behind a cut (${READ_APPS.length * perApp * 2} scopes)`, async () => {
      const scopes = manyScopes(perApp)
      const scopeLines = routineScopeLines(scopes)
      for (const line of scopeLines) expect(line.length).toBeLessThanOrEqual(200)
      const lines = await cardLines(scopes)
      const shown = lines.filter((l) => /^It will (also )?(read|change)/.test(l))
      expect(shown).toEqual(scopeLines)
      for (const line of lines) expect(line.endsWith("…")).toBe(false)
      // The counts add up to every scope requested, reads and changes alike.
      const counted = shown
        .map((l) => /^It will (?:read|change) \((\d+)\)/.exec(l)?.[1])
        .filter((n): n is string => n !== undefined)
        .reduce((a, n) => a + Number(n), 0)
      expect(counted).toBe(scopes.length)
      // Every app the routine reaches is named on the card.
      const text = shown.join("\n").toLowerCase()
      for (const app of READ_APPS) expect(text).toContain(app)
    })
  }
})
