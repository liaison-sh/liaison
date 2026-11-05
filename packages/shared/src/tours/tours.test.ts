// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { dictionariesFor, type NamespaceDicts } from "../i18n/dictionaries"
import { isTourFrameFresh, TOUR_FRAME_TTL_MS, UpdateTourRequestSchema } from "./api"
import { findTour, TEST_TOURS, TOURS, tourCatalogue } from "./index"
import { kernelSampleTour } from "./kernel/sample"
import {
  beatIndexOf,
  defineTour,
  effectiveBeats,
  isTourAvailable,
  TourSchema,
  tourCopyKeys,
  tourTestIds,
} from "./schema"

function flattenKeys(dicts: NamespaceDicts): string[] {
  const out: string[] = []
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") out.push(path)
    else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`)
    }
  }
  for (const [ns, dict] of Object.entries(dicts)) walk(dict, ns)
  return out
}

const base = {
  id: "kernel.x",
  app: "kernel",
  title: "tours.kernel.x.title",
  summary: "tours.kernel.x.summary",
}
const show = { id: "a", kind: "show", title: "tours.kernel.x.a", body: "tours.kernel.x.a" }

describe("tour schema", () => {
  it("accepts the sample tour", () => {
    expect(TourSchema.safeParse(kernelSampleTour).success).toBe(true)
  })

  it("refuses a do beat without an event or an autoplay script", () => {
    const noEvent = { ...show, id: "d", kind: "do", autoplay: [{ click: "x" }] }
    const noAutoplay = {
      ...show,
      id: "d",
      kind: "do",
      event: { app: "kernel", entity: "message", action: "create" },
    }
    expect(() => defineTour({ ...base, beats: [noEvent] } as never)).toThrow(/needs an event/)
    expect(() => defineTour({ ...base, beats: [noAutoplay] } as never)).toThrow(/needs an autoplay/)
  })

  it("a binding that waits for the turns to end is scoped to its run", () => {
    const doBeat = (event: Record<string, unknown>) => ({
      ...show,
      id: "d",
      kind: "do",
      event: { app: "kernel", entity: "message", action: "create", ...event },
      autoplay: [{ click: "x" }],
    })
    const world = { ...show, id: "w", kind: "world", injector: "x" }
    // Unscoped: nothing would look for the event again once the turns end.
    expect(() => defineTour({ ...base, beats: [doBeat({ turnsEnded: true })] } as never)).toThrow(
      /turnsEnded/,
    )
    expect(() =>
      defineTour({
        ...base,
        beats: [world, doBeat({ match: { threadId: "{w}" }, actor: "any", turnsEnded: true })],
      } as never),
    ).not.toThrow()
  })

  it("refuses a world beat without an injector, and an injector on a show beat", () => {
    expect(() => defineTour({ ...base, beats: [{ ...show, kind: "world" }] } as never)).toThrow(
      /needs an injector/,
    )
    expect(() => defineTour({ ...base, beats: [{ ...show, injector: "x" }] } as never)).toThrow(
      /only a world beat/,
    )
  })

  it("refuses duplicate beat ids, a foreign id prefix, inline copy and unknown keys", () => {
    expect(() => defineTour({ ...base, beats: [show, show] } as never)).toThrow(/duplicate beat/)
    expect(() => defineTour({ ...base, id: "tickets.x", beats: [show] } as never)).toThrow(
      /must start with/,
    )
    expect(() =>
      defineTour({ ...base, beats: [{ ...show, title: "Click here" }] } as never),
    ).toThrow(/tours\.\* key/)
    expect(() => defineTour({ ...base, beats: [{ ...show, anchr: "x" }] } as never)).toThrow()
  })

  it("refuses a phone override without the desktop value", () => {
    expect(() => defineTour({ ...base, beats: [{ ...show, anchorPhone: "x" }] } as never)).toThrow(
      /anchorPhone/,
    )
  })

  it("rejects malformed autoplay steps", () => {
    const bad = {
      ...show,
      id: "d",
      kind: "do",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [{ click: "x", type: { testid: "y", text: "tours.kernel.sample.title" } }],
    }
    expect(() => defineTour({ ...base, beats: [bad] } as never)).toThrow()
  })

  it("a created-entity pin must name an earlier do or world beat; guards take a data-* or aria-* attribute", () => {
    const event = { app: "kernel", entity: "message", action: "create" }
    const make = { ...show, id: "make", kind: "do", event, autoplay: [{ waitEvent: true }] }
    const use = (beat: string) => ({
      ...show,
      id: "use",
      kind: "do",
      event,
      autoplay: [
        { click: { testid: "row", created: { beat, attr: "data-id" } } },
        { waitEvent: true },
      ],
    })
    expect(() => defineTour({ ...base, beats: [make, use("make")] } as never)).not.toThrow()
    expect(() => defineTour({ ...base, beats: [use("make"), make] } as never)).toThrow(
      /not an earlier do or world beat/,
    )
    expect(() => defineTour({ ...base, beats: [show, use("a")] } as never)).toThrow(
      /not an earlier do or world beat/,
    )
    // What a world beat brought in (the session it dispatched) pins a step too.
    const world = { ...show, id: "live", kind: "world", injector: "x" }
    expect(() => defineTour({ ...base, beats: [world, use("live")] } as never)).not.toThrow()
    const guard = (attr: string) => ({
      ...make,
      autoplay: [{ require: { testid: "send", attr, value: "x" } }, { waitEvent: true }],
    })
    expect(() => defineTour({ ...base, beats: [guard("data-action")] } as never)).not.toThrow()
    expect(() => defineTour({ ...base, beats: [guard("onclick")] } as never)).toThrow()
  })
})

describe("effectiveBeats", () => {
  it("drops world beats outside demo orgs and optional beats whose app is missing", () => {
    const ids = (b: { id: string }[]) => b.map((x) => x.id)
    expect(ids(effectiveBeats(kernelSampleTour, { installedApps: [], isDemo: false }))).toEqual([
      "welcome",
      "post-message",
    ])
    expect(
      ids(effectiveBeats(kernelSampleTour, { installedApps: new Set(["tickets"]), isDemo: true })),
    ).toEqual(["welcome", "post-message", "live-ticket", "tickets-inbox"])
  })

  it("phone swaps the anchor but never the beat list", () => {
    const ctx = { installedApps: ["tickets"], isDemo: false }
    const desktop = effectiveBeats(kernelSampleTour, ctx)
    const phone = effectiveBeats(kernelSampleTour, { ...ctx, phone: true })
    expect(phone.map((b) => b.id)).toEqual(desktop.map((b) => b.id))
    expect(desktop[0]?.anchor).toBe("activity-bar")
    expect(phone[0]?.anchor).toBe("phone-tab-bar")
    // No override: the desktop anchor stays.
    expect(phone[1]?.anchor).toBe("compose-editor")
    expect("anchorPhone" in (phone[0] ?? {})).toBe(false)
  })

  it("re-derives a beat index from its id", () => {
    const beats = effectiveBeats(kernelSampleTour, { installedApps: [], isDemo: false })
    expect(beatIndexOf(beats, "post-message")).toBe(1)
    expect(beatIndexOf(beats, "live-ticket")).toBe(-1)
    expect(beatIndexOf(beats, null)).toBe(-1)
  })
})

describe("availability", () => {
  const t = defineTour({
    ...base,
    id: "tickets.y",
    app: "tickets",
    requires: { scopes: ["tickets:read"] },
    beats: [show],
  } as never)
  it("needs the owning app installed and the required scopes", () => {
    expect(isTourAvailable(t, { installedApps: [], scopes: ["*"] })).toBe(false)
    expect(isTourAvailable(t, { installedApps: ["tickets"], scopes: [] })).toBe(false)
    expect(isTourAvailable(t, { installedApps: ["tickets"], scopes: ["tickets:read"] })).toBe(true)
    expect(isTourAvailable(t, { installedApps: ["tickets"], scopes: ["*"] })).toBe(true)
  })
})

describe("registry", () => {
  it("validates every tour and keeps ids unique", () => {
    const all = tourCatalogue({ includeTestTours: true })
    for (const tour of all) expect(TourSchema.safeParse(tour).success).toBe(true)
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length)
  })

  it("serves test tours only when asked", () => {
    expect(findTour("kernel.sample")).toBeUndefined()
    expect(findTour("kernel.sample", { includeTestTours: true })?.id).toBe("kernel.sample")
    expect(TOURS.some((t) => TEST_TOURS.includes(t))).toBe(false)
  })

  it("lists the anchors and autoplay testids of a tour", () => {
    expect(tourTestIds(kernelSampleTour).sort()).toEqual(
      ["activity-bar", "compose-editor", "compose-send", "phone-tab-bar"].sort(),
    )
  })

  it("what a tour types is copy too: a tours.* key, never inline English", () => {
    const typing = (text: string) => ({
      ...show,
      id: "d",
      kind: "do",
      event: { app: "kernel", entity: "message", action: "create" },
      autoplay: [{ type: { testid: "y", text } }],
    })
    expect(() => defineTour({ ...base, beats: [typing("My first project")] } as never)).toThrow(
      /tours\.\* key/,
    )
    expect(() =>
      defineTour({ ...base, beats: [typing("tours.kernel.sample.postMessage.text")] } as never),
    ).not.toThrow()
    // The typed copy is checked with the rest of the tour's copy.
    expect(tourCopyKeys(kernelSampleTour)).toContain("tours.kernel.sample.postMessage.text")
  })

  it("has every tour's copy in English and French", () => {
    const en = new Set(flattenKeys(dictionariesFor("en")))
    const fr = new Set(flattenKeys(dictionariesFor("fr")))
    const missing: string[] = []
    for (const tour of tourCatalogue({ includeTestTours: true })) {
      for (const key of tourCopyKeys(tour)) {
        if (!en.has(key)) missing.push(`en ${key}`)
        if (!fr.has(key)) missing.push(`fr ${key}`)
      }
    }
    expect(missing).toEqual([])
  })
})

describe("wire contract", () => {
  it("an update carries exactly one intent", () => {
    expect(UpdateTourRequestSchema.safeParse({ status: "paused" }).success).toBe(true)
    expect(UpdateTourRequestSchema.safeParse({ advance: true, fromBeatId: "a" }).success).toBe(true)
    expect(UpdateTourRequestSchema.safeParse({}).success).toBe(false)
    expect(UpdateTourRequestSchema.safeParse({ skip: true, advance: true }).success).toBe(false)
    expect(UpdateTourRequestSchema.safeParse({ status: "completed" }).success).toBe(false)
  })

  it("ignores stale frames", () => {
    const now = Date.parse("2026-10-23T12:00:00Z")
    const frame = {
      ownerUserId: "u",
      tourId: "kernel.sample",
      status: "active" as const,
      beatId: "welcome",
      beatIndex: 0,
      emittedAt: new Date(now - TOUR_FRAME_TTL_MS - 1).toISOString(),
    }
    expect(isTourFrameFresh(frame, now)).toBe(false)
    expect(isTourFrameFresh({ ...frame, emittedAt: new Date(now).toISOString() }, now)).toBe(true)
    expect(isTourFrameFresh({ ...frame, emittedAt: "nope" }, now)).toBe(false)
  })
})
