// SPDX-License-Identifier: FSL-1.1-ALv2
// dispatchWsEventMessage feeds the entity-change hook, after the registered
// entity handlers ran (so stores are patched before views refetch).
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { dispatchWsEventMessage, registerWsEntityHandler, resetRegistry } from "./app-registry"
import { type EntityChangeEvent, EntityChangesTestAccess, onEntityChange } from "./entity-changes"

const ctx = { currentUserId: "u1", activeTabId: null, isDocumentVisible: true, isOwnAction: false }

describe("dispatchWsEventMessage → onEntityChange", () => {
  beforeEach(() => {
    resetRegistry()
    EntityChangesTestAccess.reset()
  })
  afterEach(() => EntityChangesTestAccess.reset())

  it("notifies after the entity handlers, with the event's key and payload", () => {
    const order: string[] = []
    const got: EntityChangeEvent[] = []
    registerWsEntityHandler("tickets:ticket", "tickets", () => {
      order.push("handler")
    })
    onEntityChange(
      "tickets:ticket",
      (events) => {
        order.push("change")
        got.push(...events)
      },
      { debounceMs: 0 },
    )
    dispatchWsEventMessage(
      {
        type: "event",
        payload: {
          app: "tickets",
          entity: "ticket",
          action: "created",
          actorId: "u2",
          data: { id: "t1" },
        },
      },
      ctx,
    )
    expect(order).toEqual(["handler", "change"])
    expect(got).toEqual([
      {
        key: "tickets:ticket",
        app: "tickets",
        entity: "ticket",
        action: "created",
        data: { id: "t1" },
        actorId: "u2",
      },
    ])
  })

  it("an app-less event is keyed under kernel", () => {
    const got: EntityChangeEvent[] = []
    onEntityChange("kernel:*", (events) => got.push(...events), { debounceMs: 0 })
    dispatchWsEventMessage(
      { type: "event", payload: { entity: "node", action: "updated", data: { id: "n1" } } },
      ctx,
    )
    expect(got.map((e) => [e.key, e.app, e.actorId])).toEqual([["kernel:node", "kernel", null]])
  })
})
