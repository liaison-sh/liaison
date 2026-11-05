// SPDX-License-Identifier: FSL-1.1-ALv2
// Tour moves (pure), the catalogue's scope rule and the world-beat guard.
import { describe, expect, it } from "bun:test"
import {
  beatArrives,
  defineTour,
  type EffectiveBeat,
  effectiveBeats,
  findTour,
  SCENARIO_TOURS,
  TOUR_FEATURES,
  type Tour,
} from "@liaison/shared"
import { sql } from "~/db"
import { markOrgAsDemo } from "~/modules/demo/demo-org"
import {
  applyTourMove,
  assertWorldBeatAllowed,
  availableTours,
  completeDoBeat,
  completeWorldBeat,
  currentIndex,
  skippedCount,
  type TourState,
  TourWorldBeatRefusedError,
} from "~/modules/tours/service"
import { createTestOrg } from "~/tests/helpers/org"

const kernelSampleTour = findTour("kernel.sample", { includeTestTours: true }) as Tour

const beats: EffectiveBeat[] = effectiveBeats(kernelSampleTour, {
  installedApps: ["tickets"],
  isDemo: false,
})
const ids = beats.map((b) => b.id)

const at = (beatId: string | null, status: TourState["status"] = "active"): TourState => ({
  status,
  beatId,
  beatIndex: beatId ? ids.indexOf(beatId) : 0,
  beatStates: {},
})

describe("effective beats of the sample tour", () => {
  it("drop the world beat outside a demo org", () => {
    expect(ids).toEqual(["welcome", "post-message", "tickets-inbox"])
  })
})

describe("applyTourMove", () => {
  it("Next on a show beat marks it done and moves on", () => {
    const m = applyTourMove(beats, at("welcome"), { advance: true })
    expect(m).toMatchObject({
      ok: true,
      next: {
        status: "active",
        beatId: "post-message",
        beatIndex: 1,
        beatStates: { welcome: "done" },
      },
    })
  })

  it("Next on a do beat is refused: do beats complete on their event", () => {
    expect(applyTourMove(beats, at("post-message"), { advance: true })).toEqual({
      ok: false,
      code: "tour_event_beat",
    })
  })

  it("Next on a world beat is refused too (demo org)", () => {
    const demoBeats = effectiveBeats(kernelSampleTour, { installedApps: [], isDemo: true })
    const state: TourState = {
      status: "active",
      beatId: "live-ticket",
      beatIndex: 2,
      beatStates: {},
    }
    expect(applyTourMove(demoBeats, state, { advance: true })).toEqual({
      ok: false,
      code: "tour_event_beat",
    })
  })

  it("Skip records the beat as skipped; past the last beat the tour completes", () => {
    const m = applyTourMove(beats, at("tickets-inbox"), { skip: true })
    expect(m).toMatchObject({
      ok: true,
      next: {
        status: "completed",
        beatId: null,
        beatIndex: 3,
        beatStates: { "tickets-inbox": "skipped" },
      },
      target: null,
    })
    if (m.ok) expect(skippedCount(m.next)).toBe(1)
  })

  it("moves only while active; pause, resume and abandon change the status only", () => {
    expect(applyTourMove(beats, at("welcome", "paused"), { skip: true })).toEqual({
      ok: false,
      code: "tour_not_active",
    })
    expect(applyTourMove(beats, at("welcome"), { status: "paused" })).toMatchObject({
      ok: true,
      next: { status: "paused", beatId: "welcome" },
    })
    expect(applyTourMove(beats, at("welcome", "paused"), { status: "active" })).toMatchObject({
      ok: true,
      next: { status: "active", beatId: "welcome" },
    })
    expect(applyTourMove(beats, at(null, "completed"), { status: "active" })).toEqual({
      ok: false,
      code: "tour_finished",
    })
  })

  it("goes back, never forward, and clamps to the list", () => {
    expect(applyTourMove(beats, at("tickets-inbox"), { beatIndex: 0 })).toMatchObject({
      ok: true,
      next: { beatId: "welcome", beatIndex: 0 },
    })
    expect(applyTourMove(beats, at("welcome"), { beatIndex: 2 })).toEqual({
      ok: false,
      code: "tour_forward_move",
    })
  })

  it("a beat that left the list is replaced by the beat at its stored index", () => {
    expect(currentIndex(beats, { ...at("gone"), beatIndex: 7 })).toBe(2)
    expect(currentIndex(beats, { ...at("gone"), beatIndex: 1 })).toBe(1)
  })
})

describe("read steps wait for the visitor", () => {
  const demoBeats = effectiveBeats(kernelSampleTour, { installedApps: ["tickets"], isDemo: true })
  const onLive: TourState = {
    status: "active",
    beatId: "live-ticket",
    beatIndex: 2,
    beatStates: { welcome: "done", "post-message": "done" },
  }

  it("a world beat's live event records the arrival and stays on the beat", () => {
    const m = completeWorldBeat(demoBeats, onLive, "t-1")
    expect(m).toMatchObject({
      ok: true,
      next: {
        status: "active",
        beatId: "live-ticket",
        beatStates: { "live-ticket": { state: "done", entityId: "t-1" } },
      },
    })
    // A second delivery changes nothing.
    if (m) expect(completeWorldBeat(demoBeats, m.next, "t-1")).toBeNull()
  })

  it("Next moves on from an arrived world beat, keeping what it recorded", () => {
    const arrived = completeWorldBeat(demoBeats, onLive, "t-1")
    if (!arrived) throw new Error("no arrival")
    const m = applyTourMove(demoBeats, arrived.next, { advance: true })
    expect(m).toMatchObject({
      ok: true,
      next: { beatId: "tickets-inbox", beatStates: { "live-ticket": { entityId: "t-1" } } },
    })
  })

  // Every scenario: a step that explains something or announces what someone
  // else did (a live event, the agent's or a routine's work) never moves on by
  // itself; only Next (or Skip) from the visitor leaves it. Only a step that
  // asks the visitor to act moves on when they did.
  for (const tour of SCENARIO_TOURS) {
    it(`${tour.id}: no read step completes without the visitor`, () => {
      const apps = [
        ...(tour.requires?.apps ?? []),
        ...tour.beats.flatMap((b) => (b.optional?.whenApp ? [b.optional.whenApp] : [])),
      ]
      const list = effectiveBeats(tour, {
        installedApps: apps,
        isDemo: true,
        features: TOUR_FEATURES,
      })
      list.forEach((beat, index) => {
        const state: TourState = {
          status: "active",
          beatId: beat.id,
          beatIndex: index,
          beatStates: {},
        }
        const byEvent = completeDoBeat(list, state, "e-1") ?? completeWorldBeat(list, state, "e-1")
        if (beat.kind === "show" || beatArrives(beat)) {
          // Nothing but the visitor's own Next moves them off it.
          expect(byEvent === null || byEvent.next.beatId === beat.id).toBe(true)
        }
        // Reaching a beat never passes it, whatever the run recorded ahead.
        const before = list[index - 1]
        if (before && beat.whenHeld === undefined) {
          const prev: TourState = {
            status: "active",
            beatId: before.id,
            beatIndex: index - 1,
            beatStates: { [beat.id]: { state: "done", entityId: "e-0" } },
          }
          const reached = applyTourMove(list, prev, { skip: true })
          expect(reached.ok && reached.next.beatId).toBe(beat.id)
        }
      })
    })
  }
})

describe("availableTours", () => {
  const scoped = defineTour({
    ...kernelSampleTour,
    id: "kernel.scoped",
    requires: { scopes: ["projects:tasks:read"] },
  })
  const appTour = defineTour({ ...kernelSampleTour, id: "projects.board", app: "projects" })

  it("a held parent scope covers a required child scope", () => {
    expect(
      availableTours([scoped], { installedApps: [], scopes: ["projects:tasks"] }),
    ).toHaveLength(1)
    expect(
      availableTours([scoped], { installedApps: [], scopes: ["tickets:tickets:read"] }),
    ).toHaveLength(0)
  })

  it("a tour of an app the org does not have is not offered", () => {
    expect(availableTours([appTour], { installedApps: ["tickets"], scopes: ["*"] })).toHaveLength(0)
    expect(availableTours([appTour], { installedApps: ["projects"], scopes: ["*"] })).toHaveLength(
      1,
    )
  })
})

describe("assertWorldBeatAllowed", () => {
  it("refuses a real org and lets a demo org through (database marker)", async () => {
    const real = await createTestOrg()
    await expect(assertWorldBeatAllowed(real.id)).rejects.toBeInstanceOf(TourWorldBeatRefusedError)
    const demo = await createTestOrg()
    await markOrgAsDemo(demo.id, {
      variant: "visitor",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })
    await expect(assertWorldBeatAllowed(demo.id)).resolves.toBeUndefined()
    await sql`UPDATE kernel.organizations SET settings = settings - 'demo' WHERE id = ${demo.id}`
  })
})
