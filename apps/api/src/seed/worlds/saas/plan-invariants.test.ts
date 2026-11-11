// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The software world's plan held to its invariants with no database: the
// pipeline's sums, the deal values as plan prices, the company breakdown, the
// owner's Home counts and the team the door names, at the board date and at
// anchors across a year (month starts and ends included).
import { describe, expect, it } from "bun:test"
import { scanWorldPackDir } from "~/seed/worlds/prose-guard"
import { SAAS_PLANS, SAAS_TEAM } from "./fiction"
import { SAAS_COMPANY_COUNTS, saasPlan } from "./plan"

const BOARD_DATE = new Date("2026-11-09T08:30:00Z")

function anchors(): Date[] {
  const out = [BOARD_DATE]
  for (let m = 0; m < 13; m++) {
    for (const day of [1, 2, 15, 28, 31]) {
      const at = new Date(Date.UTC(2026, 10 + m, day, 7, 15))
      if (at.getUTCDate() === day) out.push(at)
    }
  }
  return out
}

const monthOf = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit" })
    .format(d)
    .slice(0, 7)

describe("software world plan", () => {
  for (const anchor of anchors()) {
    const at = anchor.toISOString()
    const plan = saasPlan(anchor)
    const open = plan.deals.filter((d) => d.stage !== "Won" && d.stage !== "Lost")
    const sum = (stage: string) =>
      open.filter((d) => d.stage === stage).reduce((n, d) => n + d.amountMinor, 0) / 100

    it(`the pipeline sums by stage and the open total hold at ${at}`, () => {
      expect(sum("Lead")).toBe(12_300)
      expect(sum("Qualified")).toBe(9_800)
      expect(sum("Demo")).toBe(23_280)
      expect(sum("Proposal")).toBe(23_280)
      expect(open).toHaveLength(9)
      expect(open.reduce((n, d) => n + d.amountMinor, 0) / 100).toBe(68_660)
      const month = monthOf(anchor)
      const closedThisMonth = (stage: string) =>
        plan.deals.filter((d) => d.stage === stage && d.closedAt && monthOf(d.closedAt) === month)
      expect(closedThisMonth("Won").map((d) => d.key)).toEqual(["vauban-team"])
      expect(closedThisMonth("Lost").map((d) => d.key)).toEqual(["trois-ormes"])
      for (const d of plan.deals) {
        expect(d.createdAt.getTime()).toBeLessThanOrEqual(anchor.getTime())
        if (d.closedAt) expect(d.closedAt.getTime()).toBeLessThanOrEqual(anchor.getTime())
      }
    })

    it(`every deal number up to the last exists once at ${at}`, () => {
      const numbers = [...plan.deals.map((d) => d.number), ...plan.subtasks.map((s) => s.number)]
      expect(numbers.sort((a, b) => a - b)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1))
    })
  }

  it("deal values are plan prices: a year of Group, a year of Team, eight months of Team", () => {
    const plan = saasPlan(BOARD_DATE)
    const year = (p: keyof typeof SAAS_PLANS) => 12 * SAAS_PLANS[p].monthlyMinor
    expect(year("group")).toBe(1_740_000)
    expect(year("team")).toBe(588_000)
    expect(8 * SAAS_PLANS.team.monthlyMinor).toBe(392_000)
    const byNumber = (n: number) => plan.deals.find((d) => d.number === n)?.amountMinor
    expect(byNumber(14)).toBe(year("group"))
    expect(byNumber(17)).toBe(year("group"))
    expect(byNumber(12)).toBe(year("team"))
    expect(byNumber(24)).toBe(8 * SAAS_PLANS.team.monthlyMinor)
  })

  it("214 companies in the breakdown the board states, unique by name, Kora's pair on one domain", () => {
    const plan = saasPlan(BOARD_DATE)
    expect(plan.companies).toHaveLength(214)
    for (const [kind, n] of Object.entries(SAAS_COMPANY_COUNTS)) {
      expect(plan.companies.filter((c) => c.kind === kind)).toHaveLength(n)
    }
    expect(new Set(plan.companies.map((c) => c.name.toLowerCase())).size).toBe(214)
    const paying = plan.companies.filter((c) => c.kind === "paying")
    expect(paying.filter((c) => c.plan === "starter")).toHaveLength(62)
    expect(paying.filter((c) => c.plan === "team")).toHaveLength(83)
    expect(paying.filter((c) => c.plan === "group")).toHaveLength(24)
    const kora = plan.companies.filter((c) => c.name.toLowerCase().startsWith("kora"))
    expect(kora).toHaveLength(2)
    expect(new Set(kora.map((c) => c.domain)).size).toBe(1)
    for (const c of plan.companies) expect(c.domain.endsWith(".example")).toBe(true)
  })

  it("the owner's Home holds 3 approvals and 1 attention row, and the queues 12 items", () => {
    const plan = saasPlan(BOARD_DATE)
    expect(plan.needsYou.filter((r) => r.kind === "approval")).toHaveLength(3)
    expect(plan.needsYou.filter((r) => r.kind === "attention")).toHaveLength(1)
    const q = plan.queues
    expect([q.support, q.deals, q.tasks, q.knowledge]).toEqual([6, 3, 2, 1])
    expect(q.support + q.deals + q.tasks + q.knowledge).toBe(12)
  })

  it("the team is 13 named people and the owner's seat, 14 in all", () => {
    const plan = saasPlan(BOARD_DATE)
    expect(SAAS_TEAM).toHaveLength(plan.team.named)
    expect(plan.team.named + plan.team.ownerSeat).toBe(14)
    expect(new Set(SAAS_TEAM.map((p) => p.key)).size).toBe(13)
    expect(SAAS_TEAM.filter((p) => p.role === "founder_admin")).toHaveLength(1)
  })

  it("two plans at one anchor are equal", () => {
    expect(saasPlan(BOARD_DATE)).toEqual(saasPlan(new Date(BOARD_DATE)))
  })

  it("no pack string holds a literal date, a year, a weekday or a relative day word", async () => {
    const hits = await scanWorldPackDir(import.meta.dir)
    expect(hits).toEqual([])
  })
})
