// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { ACTIVITY_DAYS, ACTIVITY_MIN_HOURS, type PlanInput, planActivity } from "./activity-plan"

const INPUT: PlanInput = {
  people: [
    { key: "elodie", role: "founder_admin" },
    { key: "tobias", role: "ops_lead" },
    { key: "amina", role: "support" },
    { key: "lucas", role: "support" },
    { key: "margot", role: "fulfillment" },
    { key: "henrik", role: "finance" },
    { key: "giulia", role: "sales" },
    { key: "noemie", role: "support" },
    { key: "joel", role: "ops_lead" },
    { key: "clara", role: "finance" },
  ],
  contactKeys: ["customer:a", "customer:b", "dealer:c"],
  products: ["Kestrel 6", "Merlin 2"],
  routines: [
    { name: "Morning", cadence: "daily" },
    { name: "Monday", cadence: "weekly" },
    { name: "New ticket", cadence: "event" },
  ],
  subAgentTypes: ["analyst"],
  roleAgents: ["@support", "@finance"],
}

const offsets = (p: ReturnType<typeof planActivity>) => [
  ...p.messages.map((m) => m.hoursAgo),
  ...p.tickets.map((t) => t.createdHoursAgo),
  ...p.routineRuns.map((r) => r.hoursAgo),
  ...p.subRuns.map((s) => s.hoursAgo),
  ...p.attention.map((a) => a.hoursAgo),
]

describe("the lively activity plan", () => {
  it("is the same plan for the same inputs", () => {
    expect(planActivity(INPUT)).toEqual(planActivity(INPUT))
  })

  it("spans fourteen days up to a few minutes ago, never the future", () => {
    const plan = planActivity(INPUT)
    const all = offsets(plan)
    expect(Math.min(...all)).toBeGreaterThanOrEqual(ACTIVITY_MIN_HOURS / 2)
    expect(Math.min(...all)).toBeLessThan(0.25)
    expect(Math.max(...all)).toBeLessThan(ACTIVITY_DAYS * 24)
    expect(Math.max(...all)).toBeGreaterThan((ACTIVITY_DAYS - 2) * 24)
  })

  it("puts the day's work in working hours, whatever time `now` is", () => {
    for (const nowHourUtc of [3, 10, 15.5, 22]) {
      const plan = planActivity({ ...INPUT, nowHourUtc })
      for (const t of plan.tickets.filter((x) => x.createdHoursAgo > 1)) {
        const hourUtc = (((nowHourUtc - t.createdHoursAgo) % 24) + 24) % 24
        expect(hourUtc).toBeGreaterThanOrEqual(7)
        expect(hourUtc).toBeLessThanOrEqual(17.6)
      }
    }
  })

  it("keeps one product per ticket and never repeats a room's last line", () => {
    const plan = planActivity({ ...INPUT, products: ["Kestrel 6", "Merlin 2", "Osprey"] })
    for (const t of plan.tickets) {
      const named = ["Kestrel 6", "Merlin 2", "Osprey"].filter(
        (p) => t.subject.includes(p) || t.body.includes(p),
      )
      expect(named.length).toBeLessThanOrEqual(1)
    }
    for (const p of INPUT.people) {
      const dm = plan.messages.filter((m) => m.room === `dm:${p.key}`)
      const asks = dm
        .filter((m) => m.author !== "agent")
        .map((m) => m.body.replace(/Kestrel 6|Merlin 2|Osprey/g, "{p}"))
      expect(new Set(asks).size).toBe(asks.length)
      for (const ask of dm.filter((m) => m.author !== "agent")) {
        const answer = dm.find((m) => m.key === ask.key.replace(/:ask$/, ":answer"))
        const inAsk = ["Kestrel 6", "Merlin 2", "Osprey"].filter((x) => ask.body.includes(x))
        const inAnswer = ["Kestrel 6", "Merlin 2", "Osprey"].filter((x) => answer?.body.includes(x))
        if (inAsk.length > 0 && inAnswer.length > 0) expect(inAnswer).toEqual(inAsk)
      }
    }
    const byRoom = new Map<string, string[]>()
    for (const m of [...plan.messages].sort((a, b) => b.hoursAgo - a.hoursAgo)) {
      if (m.room.startsWith("dm:")) continue
      const prev = byRoom.get(m.room)?.at(-1)
      expect(m.body === prev && m.body.length > 0).toBe(false)
      byRoom.set(m.room, [...(byRoom.get(m.room) ?? []), m.body])
    }
  })

  it("keeps a ticket's replies inside its life, before now", () => {
    for (const t of planActivity(INPUT).tickets) {
      for (const r of t.replies) expect(r.hoursAfter).toBeLessThanOrEqual(t.createdHoursAgo)
    }
  })

  it("has every person busy: chats with their agent, attention, three unread", () => {
    const plan = planActivity(INPUT)
    for (const p of INPUT.people) {
      expect(plan.messages.filter((m) => m.room === `dm:${p.key}`).length).toBe(10)
      const mine = plan.attention.filter((a) => a.person === p.key)
      expect(mine.length).toBe(8)
      const unread = mine.filter((a) => !a.read)
      expect(unread.length).toBeGreaterThanOrEqual(1)
      expect(unread.length).toBeLessThanOrEqual(3)
      // The unread index is unique per (kind, target) for thread rows.
      const keys = unread
        .filter((a) => a.kind !== "agent_notification")
        .map((a) => `${a.kind}:${a.target}`)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })

  it("runs daily routines daily, weekly ones twice, event ones per new ticket", () => {
    const runs = planActivity(INPUT).routineRuns
    expect(runs.filter((r) => r.routine === "Morning").length).toBe(ACTIVITY_DAYS)
    expect(runs.filter((r) => r.routine === "Monday").length).toBe(2)
    expect(runs.filter((r) => r.routine === "New ticket").length).toBe(12)
  })
})
