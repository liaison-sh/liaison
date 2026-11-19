// SPDX-License-Identifier: FSL-1.1-ALv2
// The services world's six guided tours besides the client one: each in its own
// world, every copy key in English and French, no literal of another world in
// their copy, the projects tour ending on the client report as the client reads
// it, the sales tour leaving the price to the person, the developer tour ending
// with a reply draft behind an approval, and the tiles' minutes as the board says.
import { describe, expect, it } from "bun:test"
import { DEMO_WORLD_NEEDS, demoScenarioTourId } from "../../../../demo/worlds"
import en from "../../../../i18n/locales/en/tours.json"
import fr from "../../../../i18n/locales/fr/tours.json"
import { findTour } from "../../../index"
import { effectiveBeats, isTourAvailable, type Tour, tourCopyKeys } from "../../../schema"
import { STUDIO_SCENARIO_MINUTES } from "../../index"
import { scenarioStudioChatTour } from "./chat"
import { STUDIO_DEV_CFG, STUDIO_TELL_TOOL, scenarioStudioDevTour } from "./dev"
import { STUDIO_KNOWLEDGE_DOC_TITLE, scenarioStudioKnowledgeTour } from "./knowledge"
import {
  STUDIO_REPORT_HOURS_SECTION,
  STUDIO_REPORT_PROJECT_NAME,
  scenarioStudioProjectsTour,
} from "./projects"
import {
  STUDIO_COMPANY_WRITE_TOOL,
  STUDIO_PRICE_SET,
  STUDIO_SALES_CFG,
  scenarioStudioSalesTour,
} from "./sales"
import { scenarioStudioSupportTour } from "./support"

const TOURS: Record<string, Tour> = {
  support: scenarioStudioSupportTour,
  projects: scenarioStudioProjectsTour,
  chat: scenarioStudioChatTour,
  sales: scenarioStudioSalesTour,
  dev: scenarioStudioDevTour,
  knowledge: scenarioStudioKnowledgeTour,
}

function lookup(dict: unknown, key: string): unknown {
  return key
    .replace(/^tours\./, "")
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      dict,
    )
}

/** What the product and software worlds' copy names: nothing of it may stand in a services tour. */
const FOREIGN = [
  /Resonant/i,
  /Kestrel/i,
  /RAL-/,
  /Tobias/,
  /Lena Hart/,
  /Northwind/i,
  /Inês/,
  /Lucas/,
  /Shopify/i,
  /Boxtal/i,
  /battery/i,
  /dealer/i,
  /Firmware/i,
  /Tideform/i,
  /Arlon/i,
  /Julie/,
  /Lucie/,
  /Baptiste/,
  /Clémence/,
  /Olympe/i,
  /hotel/i,
  /hôtel/i,
  /\brota/i,
  /venue/i,
  /payroll/i,
]

const BEATS = (tour: Tour) => tour.beats.map((b) => b.id)

describe("the services world's tours", () => {
  it("each services tour is its world's scenario for its need, played in a demo org of that world only", () => {
    for (const [need, tour] of Object.entries(TOURS)) {
      expect(tour.id).toBe(demoScenarioTourId("studio", need as never))
      expect(DEMO_WORLD_NEEDS.studio).toContain(need as never)
      expect(findTour(tour.id)).toBe(tour)
      expect(tour.world).toBe("studio")
      expect(tour.demoOnly).toBe(true)
      const base = { installedApps: tour.requires?.apps ?? [], scopes: ["*"], isDemo: true }
      expect(isTourAvailable(tour, { ...base, worldId: "studio" })).toBe(true)
      expect(isTourAvailable(tour, { ...base, worldId: "saas" })).toBe(false)
      expect(isTourAvailable(tour, { ...base, worldId: "products" })).toBe(false)
      expect(effectiveBeats(tour, { ...base, worldId: "studio" }).length).toBeGreaterThan(0)
    }
  })

  it("every services tour key exists in English and French and holds no product or software world literal", () => {
    for (const [need, tour] of Object.entries(TOURS)) {
      for (const key of tourCopyKeys(tour)) {
        // The tour's own copy namespace, never another world's.
        if (!key.startsWith("tours.scenarios.common.")) {
          expect(
            key.startsWith(`tours.scenarios.studio${need[0]?.toUpperCase()}${need.slice(1)}.`),
          ).toBe(true)
        }
        for (const [lang, dict] of [
          ["en", en],
          ["fr", fr],
        ] as const) {
          const text = lookup(dict, key)
          expect({ key, lang, type: typeof text }).toEqual({ key, lang, type: "string" })
          for (const literal of FOREIGN) {
            expect({ key, lang, hit: literal.test(text as string) }).toEqual({
              key,
              lang,
              hit: false,
            })
          }
        }
      }
    }
  })

  it("the projects tour ends on the client report preview with hours used and no internal note", () => {
    const ids = BEATS(scenarioStudioProjectsTour)
    // The task beats first, unchanged, then the report: drafted, sent, read as the client reads it.
    expect(ids.slice(ids.indexOf("board") + 1)).toEqual([
      "report-draft",
      "send-report",
      "report-preview",
      "done",
    ])
    const send = scenarioStudioProjectsTour.beats.find((b) => b.id === "send-report")
    // The person's own send, never an agent's.
    expect(send?.event).toEqual({
      app: "projects",
      entity: "client_report",
      action: "sent",
      actor: "user",
    })
    const preview = scenarioStudioProjectsTour.beats.find((b) => b.id === "report-preview")
    expect(preview?.anchor).toBe(STUDIO_REPORT_HOURS_SECTION)
    expect(JSON.stringify(preview?.path)).toContain(STUDIO_REPORT_PROJECT_NAME)
    for (const dict of [en, fr]) {
      const body = lookup(dict, preview?.body ?? "") as string
      // Hours are the report's own, never a figure in the copy.
      expect(body).not.toMatch(/\d/)
      expect(lookup(dict, "tours.scenarios.studioProjects.reportPreview.title")).toBeTruthy()
    }
    expect(lookup(en, preview?.body ?? "")).toContain("No internal note")
    expect(lookup(fr, preview?.body ?? "")).toContain("Aucune note interne")
  })

  it("the sales tour drafts a proposal and a quote whose price is left for the person", () => {
    expect(STUDIO_SALES_CFG.bundleHeadTools).toEqual([STUDIO_COMPANY_WRITE_TOOL])
    expect(JSON.stringify(scenarioStudioSalesTour)).not.toMatch(/connector/)
    const ids = BEATS(scenarioStudioSalesTour)
    // One request approved once, then the price, which the person sets themselves.
    expect(ids.filter((id) => id === "approve")).toHaveLength(1)
    expect(ids.slice(ids.indexOf("card") + 1)).toEqual(["set-price", "done"])
    const price = scenarioStudioSalesTour.beats.find((b) => b.id === "set-price")
    expect(price?.anchor).toBe(STUDIO_PRICE_SET)
    expect(price?.event).toMatchObject({ app: "agreements", actor: "user" })
    // "Do it for me" does not set a price: it only waits for the person's own.
    expect(price?.autoplay?.some((s) => "click" in s || "type" in s)).toBe(false)
    // No beat ever completes on a price an agent set.
    for (const beat of scenarioStudioSalesTour.beats) {
      expect(JSON.stringify(beat.event ?? {})).not.toMatch(/price_set/)
    }
  })

  it("the dev tour plays the recorded node, says recorded, and ends with a reply draft behind an approval", () => {
    const beats = BEATS(scenarioStudioDevTour)
    expect(beats.slice(beats.indexOf("dispatch"), beats.indexOf("report") + 1)).toEqual([
      "dispatch",
      "approve-dispatch",
      "stream",
      "permission",
      "result",
      "report",
    ])
    expect(beats.slice(beats.indexOf("report") + 1, beats.indexOf("report") + 4)).toEqual([
      "ask-tell",
      "reply-draft",
      "approve-reply",
    ])
    expect(STUDIO_DEV_CFG.world).toBe("studio")
    const draft = scenarioStudioDevTour.beats.find((b) => b.id === "reply-draft")
    expect(draft?.event).toMatchObject({
      entity: "approval_request",
      match: { toolName: STUDIO_TELL_TOOL },
    })
    expect(scenarioStudioDevTour.beats.find((b) => b.id === "approve-reply")?.event).toMatchObject({
      sameEntityAs: "reply-draft",
    })
    for (const dict of [en, fr]) {
      expect(JSON.stringify(lookup(dict, "tours.scenarios.studioDev.computers"))).toContain(
        "recorded",
      )
    }
  })

  it("the knowledge tour opens the restricted costs and the chat tour sends to a fictional page", () => {
    const open = scenarioStudioKnowledgeTour.beats.find((b) => b.id === "open-pl")
    expect(JSON.stringify(open)).toContain(STUDIO_KNOWLEDGE_DOC_TITLE)
    for (const dict of [en, fr]) {
      expect(JSON.stringify(lookup(dict, "tours.scenarios.studioChat.askAgent"))).toMatch(
        /fictional|fictive/,
      )
    }
  })

  it("tile minutes match the board with projects at four minutes", () => {
    expect(
      DEMO_WORLD_NEEDS.studio.map((need) => [need, STUDIO_SCENARIO_MINUTES[need as never]]),
    ).toEqual([
      ["support", 3],
      ["projects", 4],
      ["chat", 3],
      ["sales", 4],
      ["client", 4],
      ["dev", 3],
      ["knowledge", 3],
    ])
    expect(Object.values(STUDIO_SCENARIO_MINUTES).reduce((a, b) => a + (b ?? 0), 0)).toBe(24)
  })
})
