// SPDX-License-Identifier: FSL-1.1-ALv2
// The services world's client scenario: six beats played once, agreements, mail
// and projects required, the first two beats worded as the door's first beat,
// the client's answer a world beat, and the last beat's hours read from the
// project's budget rather than written into its copy.
import { describe, expect, it } from "bun:test"
import en from "../../../../i18n/locales/en/tours.json"
import fr from "../../../../i18n/locales/fr/tours.json"
import { findTour } from "../../../index"
import { effectiveBeats, isTourAvailable, pickTourFigures, tourCopyKeys } from "../../../schema"
import { CLIENT_CARD_ROW, CLIENT_FIGURES_TOOL } from "../../client"
import { RUN_COMPOSER_ANCHOR } from "../../shared"
import { STUDIO_CLIENT_CFG, STUDIO_CR_ACCEPTED_INJECTOR, scenarioStudioClientTour } from "./client"

const tour = scenarioStudioClientTour

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

const beat = (id: string) => {
  const found = tour.beats.find((b) => b.id === id)
  if (!found) throw new Error(`no beat ${id}`)
  return found
}
const copy = (key: string) => lookup(en, key)

describe("the client scenario", () => {
  it("the passage step promises only what is on screen: no page to open, no quote it cannot hold", () => {
    // A show step has no action the tour can wait on, and the signed version is a frozen file
    // with no section to open: the step points at the answer, which quotes the passage.
    expect(beat("open-agreement").kind).toBe("show")
    for (const dict of [en, fr]) {
      const text = ["title", "role", "body", "way3"]
        .map((k) => String(lookup(dict, `tours.scenarios.studioClient.openAgreement.${k}`)))
        .join(" ")
        .toLowerCase()
      for (const word of ["open", "ouvr", "word for word", "mot pour mot"])
        expect(text).not.toContain(word)
    }
  })

  it("the passage step knows a person already in the conversation is there (walk 2026-11-25)", () => {
    // The answer streams into the open conversation: its composer on screen puts Chats and the
    // conversation's row behind the person, so the card never sends them back to Chats.
    const path = beat("open-agreement").path ?? []
    expect(path.map((h) => h.anchor ?? null)).toEqual([
      "dock-chats",
      "chats-personal-agent-row[data-in-dock=true]",
      null,
    ])
    expect(path[2]?.at).toBe(RUN_COMPOSER_ANCHOR)
    const effective = effectiveBeats(tour, {
      installedApps: ["agreements", "mail", "projects"],
      isDemo: true,
      worldId: "studio",
      features: [],
      phone: false,
    }).find((b) => b.id === "open-agreement")
    expect(effective?.path?.[2]?.at).toBe(RUN_COMPOSER_ANCHOR)
  })

  it("the moved contract total is claimed on the step whose page shows the agreement's amount", () => {
    // The agreements list shows a contract's total with its accepted change requests; the
    // project's page shows its own price. Each claim sits where its figure is on screen.
    expect(beat("client-decides").anchor).toBe("agreements-list")
    expect(String(copy("tours.scenarios.studioClient.clientDecides.body"))).toContain("amount")
    expect(String(copy("tours.scenarios.studioClient.whatMoved.role"))).not.toContain("total")
    expect(String(lookup(fr, "tours.scenarios.studioClient.whatMoved.role"))).not.toContain("total")
  })

  it("the client tour has six beats, plays once and needs agreements, mail and projects", () => {
    expect(tour.id).toBe("kernel.scenario-studio-client")
    expect(findTour(tour.id)).toBe(tour)
    expect(tour.world).toBe("studio")
    expect(tour.singleRun).toBe(true)
    expect(tour.requires?.apps).toEqual(["agreements", "mail", "projects"])
    expect(tour.beats.map((b) => [b.id, b.kind])).toEqual([
      ["more-than-signed", "show"],
      ["read-scope", "do"],
      ["open-agreement", "show"],
      ["approve-cr", "do"],
      ["client-decides", "world"],
      ["what-moved", "show"],
    ])
    // Beat 1's spotlight is the card's row on Home.
    expect(beat("more-than-signed").anchor).toBe(CLIENT_CARD_ROW)
    expect(beat("more-than-signed").route).toBe("/")
    // The world beat is the client's answer, which spends nothing.
    expect(beat("client-decides").injector).toBe(STUDIO_CR_ACCEPTED_INJECTOR)
    // Offered only in a demo workspace of its own world, with its apps.
    const apps = ["agreements", "mail", "projects"]
    expect(
      isTourAvailable(tour, {
        scopes: ["*"],
        installedApps: apps,
        isDemo: true,
        worldId: "studio",
      }),
    ).toBe(true)
    expect(
      isTourAvailable(tour, { scopes: ["*"], installedApps: apps, isDemo: true, worldId: "saas" }),
    ).toBe(false)
    expect(
      isTourAvailable(tour, {
        scopes: ["*"],
        installedApps: apps,
        isDemo: false,
        worldId: "studio",
      }),
    ).toBe(false)
    expect(
      effectiveBeats(tour, { installedApps: apps, isDemo: true, worldId: "studio" }),
    ).toHaveLength(6)
  })

  it("the first two beats read as the door's first beat, word for word", () => {
    expect(copy(beat("more-than-signed").title)).toBe("Pauline asked for more than you signed")
    expect(copy(beat("more-than-signed").role ?? "")).toBe(
      "You run Halden Studio. Pauline Gros wants single sign-on added to the partner portal. Your agent read the signed agreement: section 3 leaves it out.",
    )
    expect(copy(beat("more-than-signed").body)).toBe(
      "It drafted a reply and Change request 1, for €6,600. Nothing has gone out. Read the row, then press Next.",
    )
    expect(copy(beat("read-scope").title)).toBe("See what the agreement says")
    expect(copy(beat("read-scope").role ?? "")).toBe(
      "Before you approve, you want to read the passage yourself, and see the reply Pauline would get.",
    )
    expect(copy(beat("read-scope").body)).toBe(
      "Ask your agent from Chats. It answers with the passage, the reply and Change request 1 on one approval card.",
    )
    expect(copy(beat("read-scope").say?.text ?? "")).toBe("Is single sign-on in Marlin's scope?")
    expect(copy(tour.title)).toBe("Client work")
  })

  it("every copy key exists in English and French", () => {
    for (const key of tourCopyKeys(tour)) {
      expect({ key, en: typeof lookup(en, key) }).toEqual({ key, en: "string" })
      expect({ key, fr: typeof lookup(fr, key) }).toEqual({ key, fr: "string" })
    }
  })

  it("the last beat's figures are variables read from the budget", () => {
    const last = beat("what-moved")
    expect(last.figures?.tool).toBe(CLIENT_FIGURES_TOOL)
    expect(last.figures?.params).toEqual({ projectName: STUDIO_CLIENT_CFG.projectName })
    // The copy names the variables, never the figure itself.
    for (const dict of [en, fr]) {
      const body = String(lookup(dict, last.body))
      expect(body).toContain("{{timebox}}")
      expect(body).toContain("{{left}}")
      expect(body).not.toMatch(/\b480\b|\b134\b/)
    }
    // Read as the budget answers: minutes, shown in hours.
    const figures = last.figures
    if (!figures) throw new Error("no figures")
    expect(pickTourFigures(figures, { timebox: 28_800, left: 8_040 })).toEqual({
      timebox: { kind: "hours", minutes: 28_800 },
      left: { kind: "hours", minutes: 8_040 },
    })
    // A budget with nothing planned shows no figure rather than a wrong one.
    expect(pickTourFigures(figures, { real: 100 })).toBeNull()
  })
})
