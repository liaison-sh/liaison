// SPDX-License-Identifier: FSL-1.1-ALv2
// Walk D52: support's "The routine's internal note" read as if the visitor
// should act, without saying what to do: it is a step to watch, and the
// visitor acts two steps later. Every step of the demo scenarios and the
// agent-first tours says which it is, in English and in French:
//  - a step to WATCH (a live arrival, a step the agent or a routine
//    completes) names what happens and when the person acts, and calls them
//    to nothing but its own Next once that happened (it stays to be read);
//  - a step where the person ACTS names the exact control (Approve, Send,
//    Chats, Next...);
//  - no step tells the person to do something without naming the control.
import { describe, expect, it } from "bun:test"
import en from "../i18n/locales/en/tours.json"
import fr from "../i18n/locales/fr/tours.json"
import { SCENARIO_TOURS } from "./demo/index"
import { TOURS } from "./index"
import type { Tour, TourBeat } from "./schema"

const AGENT_FIRST = ["mail.basics", "tickets.basics", "projects.basics", "api-connector.settings"]
const audited: Tour[] = [...SCENARIO_TOURS, ...TOURS.filter((t) => AGENT_FIRST.includes(t.id))]

function copy(dict: unknown, key: string): string {
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
  if (typeof value !== "string") throw new Error(`no copy for ${key}`)
  return value
}

/** Completed by the world, the agent, a routine or a replay: the person watches. */
function isWatch(beat: TourBeat): boolean {
  if (beat.kind === "world") return true
  if (beat.kind !== "do") return false
  if (beat.event?.actor === "any") return true
  return (beat.autoplay ?? []).every((step) => "waitEvent" in step)
}

/** The person presses something: the script plays it for them on "Do it for me". */
function isAct(beat: TourBeat): boolean {
  return beat.kind === "do" && !isWatch(beat)
}

/** Says when the person acts, or that the step goes on by itself. */
const WHEN = {
  en: /[Yy]ou'll|[Yy]ou will|moves on (by itself|when)|Nothing to do|Press Next once/,
  fr: /[Vv]ous (?:l[ae] |l'|les )?\S+rez|avance toute seule|passe à la suite|Rien à faire|Appuyez sur Suivant (?:une fois|quand|dès)/,
}

/** The controls a step may name. */
const CONTROL = {
  en: /Approve|Send|Allow|Next|Chats|Take me there|Test|Add connection|switch|microphone|@/,
  fr: /Approuver|Envoyer|Autoriser|Suivant|Discussions|M'y emmener|Tester|Ajouter une connexion|interrupteur|micro|@/,
}

/** An English sentence opening with an order to the person. */
const IMPERATIVE =
  /^(Open|Click|Press|Read|Edit|Change|Check|Approve|Type|Ask|Turn|Switch|Pick|Write|Allow|Review|Move|Reply|Assign|Download|Use)\b/

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…:])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

describe("watch and act steps say which they are", () => {
  it("a watch step says when the person acts, and calls on them to do nothing", () => {
    const wrong: string[] = []
    for (const tour of audited) {
      for (const beat of tour.beats.filter(isWatch)) {
        for (const [lang, dict] of [
          ["en", en],
          ["fr", fr],
        ] as const) {
          const body = copy(dict, beat.body)
          if (!WHEN[lang].test(body)) wrong.push(`${lang} ${tour.id}/${beat.id}: no "when"`)
        }
        // Its only call is the step's own Next, once what it announced is there.
        for (const s of sentences(copy(en, beat.body))) {
          if (IMPERATIVE.test(s) && !/\bNext\b/.test(s))
            wrong.push(`en ${tour.id}/${beat.id}: "${s}"`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it("an act step names the control the person presses", () => {
    const wrong: string[] = []
    for (const tour of audited) {
      for (const beat of tour.beats.filter(isAct)) {
        for (const [lang, dict] of [
          ["en", en],
          ["fr", fr],
        ] as const) {
          if (!CONTROL[lang].test(copy(dict, beat.body)))
            wrong.push(`${lang} ${tour.id}/${beat.id}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  it("no step tells the person to do something without naming the control", () => {
    const wrong: string[] = []
    for (const tour of audited) {
      for (const beat of tour.beats) {
        for (const s of sentences(copy(en, beat.body))) {
          if (IMPERATIVE.test(s) && !CONTROL.en.test(s)) wrong.push(`${tour.id}/${beat.id}: "${s}"`)
        }
      }
    }
    expect(wrong).toEqual([])
  })
})
