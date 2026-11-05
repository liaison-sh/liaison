// SPDX-License-Identifier: FSL-1.1-ALv2
// S26: the shipped tours. Each validates, stays short, binds every do beat to
// a product event the server emits, and plays on a real (non-demo) org: no
// world beats, and an app-gated optional beat drops when its app is missing.
import { describe, expect, it } from "bun:test"
import en from "../i18n/locales/en/tours.json"
import fr from "../i18n/locales/fr/tours.json"
import { SCENARIO_TOURS } from "./demo/index"
import { TOURS } from "./index"
import {
  effectiveBeats,
  RUN_CONVERSATION,
  refTestId,
  type Tour,
  type TourElementRef,
  TourSchema,
} from "./schema"

const SHIPPED = [
  "mail.basics",
  "tickets.basics",
  "knowledge.basics",
  "kernel.agents",
  "kernel.routines",
  "kernel.threads",
  "projects.basics",
  "kernel.sessions",
  "api-connector.settings",
]

/**
 * The product events a do beat may complete on (`app/entity:action`), as the
 * server emits them. A binding outside this list is a typo or a new event
 * that needs its emitter checked first.
 */
const KNOWN_EVENTS = new Set([
  "tickets/message:create",
  "tickets/note:create",
  "tickets/ticket:update",
  "mail/message:create",
  "mail/conversation:update",
  "kernel/message:create",
  "kernel/approval_request:create",
  "kernel/approval_request:update",
  "knowledge/document:create",
  "knowledge/document:update",
  "projects/project:created",
  "projects/task:created",
  "kernel/routine:create",
  "kernel/node_session:create",
  "kernel/connected_account:create",
])

const byId = (id: string): Tour => {
  const tour = TOURS.find((t) => t.id === id)
  if (!tour) throw new Error(`tour ${id} is not registered`)
  return tour
}

describe("shipped tours", () => {
  it("registers the nine tours", () => {
    expect(TOURS.map((t) => t.id).sort()).toEqual([...SHIPPED].sort())
  })

  for (const id of SHIPPED) {
    describe(id, () => {
      it("validates and has 4 to 9 beats, none of them world beats", () => {
        const tour = byId(id)
        expect(TourSchema.safeParse(tour).success).toBe(true)
        expect(tour.beats.length).toBeGreaterThanOrEqual(4)
        expect(tour.beats.length).toBeLessThanOrEqual(9)
        expect(tour.beats.some((b) => b.kind === "world")).toBe(false)
      })

      it("binds every do beat to a known product event, with an autoplay ending on it", () => {
        const doBeats = byId(id).beats.filter((b) => b.kind === "do")
        expect(doBeats.length).toBeGreaterThan(0)
        for (const beat of doBeats) {
          const event = beat.event
          if (!event) throw new Error(`${id}/${beat.id} has no event`)
          expect(KNOWN_EVENTS.has(`${event.app}/${event.entity}:${event.action}`)).toBe(true)
          for (const steps of [beat.autoplay, beat.autoplayPhone]) {
            if (!steps) continue
            expect(steps.at(-1)).toEqual({ waitEvent: true })
          }
        }
      })

      it("on a non-demo org with only kernel apps, drops the app- and feature-gated optional beats", () => {
        const tour = byId(id)
        const installedApps = tour.app === "kernel" ? [] : [tour.app]
        const played = effectiveBeats(tour, { installedApps, isDemo: false })
        const expected = tour.beats
          .filter((b) => !b.optional?.whenApp || installedApps.includes(b.optional.whenApp))
          .filter((b) => !b.optional?.whenFeature)
          .map((b) => b.id)
        expect(played.map((b) => b.id)).toEqual(expected)
        for (const b of played) {
          const source = tour.beats.find((s) => s.id === b.id)
          const gate = source?.optional?.whenApp
          if (gate) expect(installedApps).toContain(gate)
        }
        // The phone plays the same beats (only anchors and scripts change).
        const phone = effectiveBeats(tour, { installedApps, isDemo: false, phone: true })
        expect(phone.map((b) => b.id)).toEqual(played.map((b) => b.id))
      })
    })
  }

  it("tickets: the customer card beat plays only where a connection fills the customer lookup", () => {
    const tour = byId("tickets.basics")
    // The connector is installed in every org; installed alone shows no card.
    const without = effectiveBeats(tour, {
      installedApps: ["tickets", "api-connector"],
      isDemo: false,
    })
    const withIt = effectiveBeats(tour, {
      installedApps: ["tickets", "api-connector"],
      isDemo: false,
      features: ["customer-card"],
    })
    expect(without.some((b) => b.id === "customer-card")).toBe(false)
    expect(withIt.find((b) => b.id === "customer-card")?.anchor).toBe("customer-card")
    expect(withIt.length).toBe(without.length + 1)
  })

  it("tickets: the agent drafts the reply, the person approves it, the agent adds the note", () => {
    const beats = byId("tickets.basics").beats
    expect(beats.find((b) => b.id === "ask-draft")?.event).toEqual({
      app: "kernel",
      entity: "approval_request",
      action: "create",
      match: { toolName: "tickets:reply" },
      actor: "user-or-agent",
    })
    // The approval is the person's own decision (actor user), on that same tool.
    expect(beats.find((b) => b.id === "review")?.event).toEqual({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      match: { status: "approved", toolName: "tickets:reply" },
    })
    // A note is never a customer-thread message: routines bound to message:create ignore it.
    // It may ask first (it says what the agent read about the customer): its
    // approval completes the beat too, and approve-note approves that one.
    expect(beats.find((b) => b.id === "note")?.event).toEqual({
      app: "tickets",
      entity: "note",
      action: "create",
      actor: "user-or-agent",
      heldAs: "tickets:addNote",
    })
    const approveNote = beats.find((b) => b.id === "approve-note")
    expect(approveNote?.whenHeld).toBe("note")
    expect(approveNote?.event).toEqual({
      app: "kernel",
      entity: "approval_request",
      action: "update",
      match: { status: "approved", toolName: "tickets:addNote" },
      sameEntityAs: "note",
    })
  })

  // The person has one conversation with their agent: the tours ask there,
  // and a write it may park has its approve beat (held-writes.test.ts).
  it("the agent-first app tours ask the person's agent in their conversation with it, in the dock beside the screen", () => {
    for (const id of [
      "tickets.basics",
      "mail.basics",
      "projects.basics",
      "api-connector.settings",
    ]) {
      const tour = byId(id)
      expect(tour.talksToAgent, id).toBe(true)
      const asks = tour.beats.filter((b) =>
        JSON.stringify(b.autoplay ?? []).includes('"compose-send"'),
      )
      expect(asks.length, id).toBeGreaterThan(0)
      for (const beat of asks) {
        for (const steps of [beat.autoplay, beat.autoplayPhone]) {
          // (The phone note is written by hand in the ticket's composer.)
          if (!steps || !JSON.stringify(steps).includes('"compose-send"')) continue
          expect(steps, `${id}/${beat.id}`).toContainEqual({ openRunConversation: true })
          expect(JSON.stringify(steps)).not.toContain("chats-personal-agent-row")
        }
      }
    }
  })

  it("projects: a task comment is told apart from any other thread message", () => {
    const comment = byId("projects.basics").beats.find((b) => b.id === "comment")
    expect(comment?.event).toEqual({
      app: "kernel",
      entity: "message",
      action: "create",
      match: { threadOrigin: "projects:task" },
    })
  })

  it("threads: points at the dictation button; Do it for me writes in the open conversation, never sends", () => {
    const beats = byId("kernel.threads").beats
    expect(beats.some((b) => b.kind === "show" && b.anchor === "voice-dictation-button")).toBe(true)
    const post = beats.find((b) => b.id === "post")
    expect(post?.event).toEqual({ app: "kernel", entity: "message", action: "create" })
    // The conversation is someone's existing one: the person presses Send.
    for (const id of ["post", "mention-agent"]) {
      const beat = beats.find((b) => b.id === id)
      for (const steps of [beat?.autoplay, beat?.autoplayPhone]) {
        expect(steps?.some((s) => "click" in s && s.click === "compose-send") ?? false).toBe(false)
      }
    }
  })

  it("never autoplays an edit or a post onto existing content: later beats pin to what the tour created", () => {
    const pinsOf = (tourId: string, beatId: string) =>
      (byId(tourId).beats.find((b) => b.id === beatId)?.autoplay ?? []).flatMap((s) =>
        "click" in s
          ? [s.click, ...(s.unlessVisible ? [s.unlessVisible] : [])]
          : "waitFor" in s
            ? [s.waitFor]
            : [],
      )
    const pinned = (tourId: string, beatId: string, createdBy: string) => {
      const refs = pinsOf(tourId, beatId)
      // The step that opens the target is pinned, and nothing opens an unpinned row or document.
      expect(
        refs.some((r) => typeof r !== "string" && "created" in r && r.created.beat === createdBy),
      ).toBe(true)
      for (const r of refs) {
        const testid = typeof r === "string" ? r : r.testid
        if (/^(knowledge-recent-|projects-home-row-)/.test(testid)) {
          expect(typeof r).not.toBe("string")
        }
      }
    }
    pinned("knowledge.basics", "edit", "create")
    // The comment goes on a task inside the project the agent created for the tour.
    pinned("projects.basics", "comment", "ask-plan")
  })

  const AGENT_TOURS = ["tickets.basics", "mail.basics", "projects.basics", "api-connector.settings"]

  it("agent-first: each of these tours asks the agent and completes on what the agent did", () => {
    for (const id of AGENT_TOURS) {
      const asks = byId(id).beats.filter(
        (b) =>
          b.kind === "do" &&
          b.event?.actor === "user-or-agent" &&
          (b.autoplay ?? []).some((s) => "click" in s && refTestId(s.click) === "compose-send"),
      )
      expect(asks.length, id).toBeGreaterThan(0)
    }
  })

  it("Do it for me sends only into the person's own agent conversation, and approves only what the tour's agent drafted", () => {
    // The press itself is pinned to that conversation: the one the run
    // recorded, or the composer marked as the person's own agent's. A channel
    // or a task beside the dock has a Send of its own (walk, 2026-10-26).
    const ownSend = (click: TourElementRef) =>
      typeof click !== "string" &&
      (("created" in click &&
        click.created.beat === RUN_CONVERSATION &&
        click.created.attr === "data-thread-id") ||
        ("where" in click &&
          click.where.attr === "data-personal-agent" &&
          click.where.value === "true"))
    for (const tour of TOURS) {
      for (const beat of tour.beats) {
        for (const steps of [beat.autoplay, beat.autoplayPhone]) {
          for (const s of steps ?? []) {
            if (!("click" in s)) continue
            const testid = refTestId(s.click)
            // kernel.agents sends from the agent's own page, which is that conversation.
            if (testid === "compose-send" && tour.id !== "kernel.agents") {
              expect(ownSend(s.click), `${tour.id}/${beat.id}`).toBe(true)
            }
            if (testid === "approval-card-action-approve") {
              expect(typeof s.click, `${tour.id}/${beat.id}`).not.toBe("string")
            }
          }
          // Typing goes only into that same conversation's composer.
          for (const s of steps ?? []) {
            if (!("type" in s) || s.type.testid !== "compose-field") continue
            expect(
              Boolean(s.type.created) || s.type.where?.attr === "data-personal-agent",
              `${tour.id}/${beat.id}`,
            ).toBe(true)
          }
        }
      }
    }
  })

  it("never lets Do it for me send an email to a customer: only the approve beat the person chose sends", () => {
    for (const [id, send] of [
      ["mail.basics", "mail-reply-send"],
      ["tickets.basics", "tickets-composer-submit"],
    ] as const) {
      for (const beat of byId(id).beats) {
        for (const steps of [beat.autoplay, beat.autoplayPhone]) {
          for (const [i, s] of (steps ?? []).entries()) {
            if (!("click" in s) || s.click !== send) continue
            // The one submit a script presses is a note's, behind its guard.
            expect(steps?.[i - 1], `${id}/${beat.id}`).toEqual({
              require: {
                testid: "tickets-composer-submit",
                attr: "data-action",
                value: "add-note",
              },
            })
          }
        }
      }
    }
  })

  it("api-connector: admin only", () => {
    expect(byId("api-connector.settings").requires?.scopes).toEqual(["api-connector:admin"])
  })

  // The API connector is a card on Settings > Connectors (settings overhaul
  // P2): the tour opens that card, never the retired /settings/api-connector.
  it("api-connector: every routed beat opens the connector's card", () => {
    const routes = byId("api-connector.settings").beats.flatMap((b) =>
      "route" in b && b.route ? [b.route] : [],
    )
    expect(routes.length).toBeGreaterThan(0)
    for (const r of routes) expect(r).toBe("/settings/connectors?open=api-connector")
  })
  // Walk D46: an approve step looked for its card once, when the step started,
  // while the agent (or the routine) was still writing the message with it.
  it("every approve beat bound to the run's approval waits on the agent or routine writing it", () => {
    const scenarios = [...TOURS, ...SCENARIO_TOURS]
    let seen = 0
    for (const tour of scenarios) {
      for (const beat of tour.beats) {
        const e = beat.event
        if (beat.kind !== "do" || e?.entity !== "approval_request" || e.action !== "update")
          continue
        seen++
        expect({ beat: `${tour.id}/${beat.id}`, waitsOn: beat.waitsOn }).toEqual({
          beat: `${tour.id}/${beat.id}`,
          waitsOn: expect.stringMatching(/^(agent|routine)$/),
        })
      }
    }
    expect(seen).toBe(9)
  })
  // Walk D69: Mail's "Review and approve", resumed after a reload, stayed on
  // Home: the step named no page on a desktop, so "Do it for me" looked for
  // the draft's card where it was not, and said the agent had not done it.
  it("every approve step finds its card again after a reload, on both widths", () => {
    const approves = (steps: readonly unknown[] | undefined) =>
      JSON.stringify(steps ?? []).includes('"approval-card-action-approve"')
    let seen = 0
    for (const tour of [...TOURS, ...SCENARIO_TOURS]) {
      for (const phone of [false, true]) {
        const beats = effectiveBeats(tour, {
          installedApps: tour.beats.flatMap((b) =>
            b.optional?.whenApp ? [b.optional.whenApp] : [],
          ),
          isDemo: true,
          features: ["customer-card", "connector-add"],
          phone,
        })
        for (const beat of beats) {
          if (beat.kind !== "do" || !approves(beat.autoplay)) continue
          seen++
          // A page to go back to, or a script that opens the run's conversation first.
          const opensConversation =
            beat.autoplay?.[0] !== undefined && "openRunConversation" in beat.autoplay[0]
          expect({
            beat: `${tour.id}/${beat.id}`,
            phone,
            back: !!beat.route || opensConversation,
          }).toEqual({ beat: `${tour.id}/${beat.id}`, phone, back: true })
        }
      }
    }
    expect(seen).toBeGreaterThan(0)
  })
  // Demo walk: the invoice beat came up seconds before the live order's
  // invoice existed, and the desk, asked next, found none. The beat rings that
  // order's own invoice row, so Next waits until it is there.
  it("commerce: the invoice beat rings the live order's invoice row, pinned to that order", () => {
    const tour = SCENARIO_TOURS.find((t) => t.id === "kernel.scenario-commerce")!
    const beat = tour.beats.find((b) => b.id === "invoice")
    expect(beat?.anchor).toBe("invoicing-documents-row[data-shopify-order-id={live-order}]")
    const played = effectiveBeats(tour, {
      installedApps: ["shopify", "invoicing", "boxtal"],
      isDemo: true,
    }).find((b) => b.id === "invoice")
    expect(played?.anchorPinned).toBe(true)
  })

  it("mail and tickets: the approve step rings the draft's card wherever it is, and Do it for me opens the run's conversation first", () => {
    for (const [id, beatId, ask] of [
      ["mail.basics", "approve", "summarise-draft"],
      ["tickets.basics", "review", "ask-draft"],
    ] as const) {
      const approve = byId(id).beats.find((b) => b.id === beatId)!
      expect(approve.anchor).toBe(`approval-card[data-request-id={${ask}}]`)
      expect(approve.autoplay?.[0]).toEqual({ openRunConversation: true })
    }
  })
  // Walk D68 at 390: the comment step never opened the planned project. A
  // phone lists projects as cards, which the desktop row's testid missed.
  it("projects: on a phone the comment step opens the planned project from its card", () => {
    const comment = byId("projects.basics").beats.find((b) => b.id === "comment")!
    expect(comment.autoplayPhone?.[0]).toEqual({
      click: {
        testid: "projects-home-card-*",
        created: { beat: "ask-plan", attr: "data-project-id" },
      },
      unlessVisible: {
        testid: "project-workspace",
        created: { beat: "ask-plan", attr: "data-project-id" },
      },
    })
  })
  // Walk D67: on a visit with a shop, the question was answered from the shop's
  // orders and the connected system was never read.
  it("api-connector: the question names the API connector and the CRM or ERP it reaches", () => {
    for (const copy of [en, fr]) {
      const text = copy["api-connector"].settings.ask.text
      expect(text).toMatch(/API connector|connecteur API/)
      expect(text).toMatch(/CRM/)
      expect(text).toMatch(/ERP/)
    }
  })
  // Walk D50: Mail's ask, played on Home after the Tickets tour, stopped at
  // once: the beat named no page, and its script starts from the mail list.
  it("an ask beat whose script starts from a list names the page with that list", () => {
    expect(byId("mail.basics").beats.find((b) => b.id === "summarise-draft")?.route).toBe("/mail")
    expect(byId("tickets.basics").beats.find((b) => b.id === "ask-draft")?.route).toBe("/tickets")
  })
  // Walk D49: on a visit that had played Sales, the Mail tour opened the
  // prospect's email the routine had already answered; the agent asked
  // instead of drafting, and a second reply went to the same prospect.
  it("mail: the ask opens an unread conversation when there is one, on both widths", () => {
    const beat = byId("mail.basics").beats.find((b) => b.id === "summarise-draft")!
    for (const steps of [beat.autoplay, beat.autoplayPhone]) {
      expect(steps?.[0]).toMatchObject({
        click: "conversation-row",
        prefer: { attr: "data-unread", value: "true" },
      })
    }
  })
})
