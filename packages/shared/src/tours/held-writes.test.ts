// SPDX-License-Identifier: FSL-1.1-ALv2
// A tour talks to the person's agent in their one conversation with it, which
// holds what earlier turns read (a web search, another app's data). Whether a
// write the agent makes then parks for approval depends on what that
// conversation read, which no tour can know in advance. So every beat bound to
// a write the agent makes says what the write may park as (`heldAs`), and a
// later beat approves it (`whenHeld`), passed when the write ran at once.
// The tours that ask the agent (`talksToAgent`) are the ones guarded: the
// others' writes are the person's own, made on a form.
import { describe, expect, it } from "bun:test"
import { SCENARIO_TOURS } from "./demo/index"
import { TOURS } from "./index"
import { heldTools, type Tour, type TourBeat } from "./schema"

/** A do beat completed by a write the person's agent makes (not its chat answer, not an approval). */
function isAgentWrite(beat: TourBeat): boolean {
  const e = beat.event
  if (beat.kind !== "do" || !e || e.actor !== "user-or-agent") return false
  // The approve beat itself (it may complete on the write its approval runs).
  if (beat.whenHeld !== undefined) return false
  if (e.entity === "approval_request") return false
  // The agent's answer in the conversation is a message it posts, not a write a tool makes.
  if (e.app === "kernel" && e.entity === "message" && e.match?.authorType === "agent") return false
  return e.action === "create" || e.action === "created" || e.action === "update"
}

const ALL: readonly Tour[] = [...TOURS, ...SCENARIO_TOURS].filter((t) => t.talksToAgent)

describe("writes the agent makes may park for approval", () => {
  it("finds the agent writes it guards", () => {
    const writes = ALL.flatMap((t) => t.beats.filter(isAgentWrite).map((b) => `${t.id}/${b.id}`))
    expect(writes).toEqual(
      expect.arrayContaining([
        "kernel.scenario-projects/subtasks",
        "kernel.scenario-projects/reply",
        "kernel.scenario-chat/task",
        "projects.basics/ask-plan",
        "tickets.basics/note",
      ]),
    )
  })

  for (const tour of ALL) {
    const writes = tour.beats.filter(isAgentWrite)
    if (writes.length === 0) continue
    it(`${tour.id}: each agent write names what it parks as, and a later beat approves it`, () => {
      const wrong: string[] = []
      for (const beat of writes) {
        if (!beat.event || heldTools(beat.event).length === 0) {
          wrong.push(`${beat.id}: no heldAs`)
          continue
        }
        const at = tour.beats.indexOf(beat)
        const approve = tour.beats.slice(at + 1).find((b) => b.whenHeld === beat.id)
        if (!approve) {
          wrong.push(`${beat.id}: no whenHeld beat after it`)
          continue
        }
        // It completes on the approval, or on the write that approval runs.
        const e = approve.event
        const onApproval = e?.entity === "approval_request" && e.action === "update"
        const onWrite = e?.app === beat.event.app && e?.entity === beat.event.entity
        if (approve.kind !== "do" || !(onApproval || onWrite)) {
          wrong.push(`${beat.id}: ${approve.id} completes on neither its approval nor its write`)
        }
      }
      expect(wrong).toEqual([])
    })
  }
})
