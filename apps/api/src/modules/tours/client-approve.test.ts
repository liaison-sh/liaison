// SPDX-License-Identifier: FSL-1.1-ALv2
// The client scenario's approve step: the one card the world seeded, approved,
// completes it; a rejected card leaves the scenario on that step, and another
// change request's card never completes it.
import { describe, expect, it } from "bun:test"
import { CLIENT_CARD_TOOL, findTour, STUDIO_CLIENT_CFG } from "@liaison/shared"
import type { AppEvent } from "~/infra/events/event-bus"
import { bindingMatches } from "~/modules/tours/consumer"

const approve = findTour("kernel.scenario-studio-client")?.beats.find((b) => b.id === "approve-cr")
const binding = approve?.event
if (!binding) throw new Error("the client scenario has no approve step")

function decided(entityId: string, status: string, title = STUDIO_CLIENT_CFG.cardTitle): AppEvent {
  return {
    app: "kernel",
    entity: "approval_request",
    action: "update",
    entityId,
    orgId: "org",
    actorId: "owner",
    actorType: "user",
    timestamp: new Date().toISOString(),
    data: { status, toolName: CLIENT_CARD_TOOL, currentPayload: { title } },
  } as unknown as AppEvent
}

describe("the client scenario's approve step", () => {
  it("a rejected card leaves the tour on the approve step; the card approved completes it", () => {
    if (!binding) return
    expect(bindingMatches(binding, decided("card", "denied"))).toBe(false)
    expect(bindingMatches(binding, decided("card", "rejected"))).toBe(false)
    expect(bindingMatches(binding, decided("card", "approved"))).toBe(true)
  })

  it("another change request's card does not complete it", () => {
    if (!binding) return
    expect(bindingMatches(binding, decided("other", "approved", "Something else"))).toBe(false)
  })
})
