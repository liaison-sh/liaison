// SPDX-License-Identifier: FSL-1.1-ALv2
// The guide card every scenario step shows: who the visitor is in the story
// and why the step matters (its role line), the way to what it points at,
// one hop per place to open, each ringed in turn (`path`), and the exact
// words Do it for me types (`say`). Visitors on the live demo could not tell
// which project to open, which agent to pick or what to ask.
import { describe, expect, it } from "bun:test"
import en from "../../i18n/locales/en/tours.json"
import fr from "../../i18n/locales/fr/tours.json"
import { type EffectiveBeat, effectiveBeats, TOUR_FEATURES, type Tour } from "../schema"
import { SCENARIO_TOURS } from "./index"

function copy(dict: unknown, key: string): string | undefined {
  const value = key
    .replace(/^tours\./, "")
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      dict,
    )
  return typeof value === "string" ? value : undefined
}

function played(tour: Tour): EffectiveBeat[] {
  const apps = [
    ...(tour.requires?.apps ?? []),
    ...tour.beats.flatMap((b) => (b.optional?.whenApp ? [b.optional.whenApp] : [])),
  ]
  return effectiveBeats(tour, { installedApps: apps, isDemo: true, features: TOUR_FEATURES })
}

/** Script steps that open something the step's element sits behind (the chats list, the picker). */
const OPENERS = new Set(["dock-chats", "phone-tab-chats", "chats-personal-agent-row"])

/**
 * The step's element is not on screen when the step comes up: it is on
 * another screen than the step before (its route differs), or behind
 * something the script opens first (the chats beside a ticket, the mention
 * picker, the person's conversation with their agent).
 */
function offScreenOnArrival(beat: EffectiveBeat, before: EffectiveBeat | undefined): boolean {
  if (!beat.anchor || !beat.route) return false
  if (beat.route !== before?.route) return true
  return (beat.autoplay ?? []).some(
    (step) =>
      ("click" in step && typeof step.click === "string" && OPENERS.has(step.click)) ||
      ("click" in step && typeof step.click === "string" && step.click.startsWith("mention-")) ||
      "openRunConversation" in step,
  )
}

describe("guide cards", () => {
  for (const tour of SCENARIO_TOURS) {
    describe(tour.id, () => {
      const beats = played(tour)

      it("every step says who the visitor is and why it matters, in English and French", () => {
        const missing = beats
          .filter((b) => !b.role || !copy(en, b.role) || !copy(fr, b.role))
          .map((b) => b.id)
        expect(missing).toEqual([])
      })

      it("every step whose element is off screen on arrival declares the way there", () => {
        const missing = beats
          .filter((b, i) => offScreenOnArrival(b, beats[i - 1]) && !b.path?.length)
          .map((b) => b.id)
        expect(missing).toEqual([])
      })

      it("every hop and every exact request has its copy, and the words are what Do it for me types", () => {
        const wrong: string[] = []
        for (const beat of beats) {
          for (const hop of beat.path ?? []) {
            if (!copy(en, hop.label) || !copy(fr, hop.label)) wrong.push(`${beat.id}: ${hop.label}`)
          }
          if (beat.say) {
            for (const key of [beat.say.lead, beat.say.text]) {
              if (!copy(en, key) || !copy(fr, key)) wrong.push(`${beat.id}: ${key}`)
            }
            const typed = (beat.autoplay ?? []).flatMap((s) => ("type" in s ? [s.type.text] : []))
            if (!typed.includes(beat.say.text)) wrong.push(`${beat.id}: say is not typed`)
          }
        }
        expect(wrong).toEqual([])
      })

      // Walk 2026-10-26: "Open Personal agent, then its Routines tab" and "Open
      // Invoices" rang nothing. A hop that moves the visitor somewhere rings
      // where to press; only the last words about the step's own element may
      // stand alone.
      it("every hop that opens something rings what to press", () => {
        const unringed = beats.flatMap((b) =>
          (b.path ?? [])
            .filter((hop) => !hop.anchor && !hop.rail && /^Open /.test(copy(en, hop.label) ?? ""))
            .map((hop) => `${b.id}: ${copy(en, hop.label)}`),
        )
        expect(unringed).toEqual([])
      })

      it("a step that asks the visitor to send something shows the exact words", () => {
        const missing = beats
          .filter(
            (b) =>
              b.kind === "do" &&
              (b.autoplay ?? []).some(
                (s) => "type" in s && s.type.text !== "tours.scenarios.common.mentionTrigger",
              ) &&
              !b.say,
          )
          .map((b) => b.id)
        expect(missing).toEqual([])
      })

      it("every approve step says what its undo window is, while the toast offers Undo", () => {
        const missing = beats
          .filter(
            (b) =>
              b.kind === "do" &&
              b.event?.entity === "approval_request" &&
              b.event.action === "update" &&
              !b.undo,
          )
          .map((b) => b.id)
        expect(missing).toEqual([])
        for (const beat of beats.filter((b) => b.undo)) {
          for (const key of Object.values(beat.undo ?? {})) {
            expect(copy(en, key)).toBeTruthy()
            expect(copy(fr, key)).toBeTruthy()
          }
        }
      })
    })
  }
})
