// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { createRoutineRequestSchema, routineKindSchema } from "./routines"

describe("event routine authoring validation", () => {
  test("routineKindSchema now includes 'event'", () => {
    expect(routineKindSchema.safeParse("event").success).toBe(true)
  })
  test("accepts kind='event' with an event string and no cron/runAt", () => {
    const r = createRoutineRequestSchema.safeParse({
      name: "autoship",
      description: "d",
      kind: "event",
      event: "shopify:order:fulfilled",
      prompt: "ship",
      scopes: ["boxtal:shipments:write"],
    })
    expect(r.success).toBe(true)
  })
  test("rejects kind='event' without an event string", () => {
    const r = createRoutineRequestSchema.safeParse({
      name: "x",
      description: "d",
      kind: "event",
      prompt: "p",
    })
    expect(r.success).toBe(false)
  })
  test("rejects kind='event' with a cron (schedule + event are mutually exclusive)", () => {
    const r = createRoutineRequestSchema.safeParse({
      name: "x",
      description: "d",
      kind: "event",
      event: "kernel:ticket:create",
      cron: "0 9 * * *",
      timezone: "Europe/Paris",
      prompt: "p",
    })
    expect(r.success).toBe(false)
  })
  test("the event string must be app:entity:action (three colon-separated segments)", () => {
    expect(
      createRoutineRequestSchema.safeParse({
        name: "x",
        description: "d",
        kind: "event",
        event: "order:fulfilled",
        prompt: "p",
      }).success,
    ).toBe(false) // only two segments — the subscriber splits on ':' into [app,entity,action]
  })
  test("recurring still requires cron+timezone and forbids an event string", () => {
    expect(
      createRoutineRequestSchema.safeParse({
        name: "x",
        description: "d",
        kind: "recurring",
        cron: "0 9 * * *",
        timezone: "Europe/Paris",
        event: "shopify:order:fulfilled",
        prompt: "p",
      }).success,
    ).toBe(false) // event can't ride along on a clock routine
  })
})
