// SPDX-License-Identifier: FSL-1.1-ALv2
// Routine flows (0303): the flow schema and the projects event filter, as authoring validates them.
import { describe, expect, test } from "bun:test"
import {
  createRoutineRequestSchema,
  resolveRoutineTemplatePlaceholders,
  routineEventFilterFitsEvent,
  routineFlowSchema,
  updateRoutineRequestSchema,
} from "./routines"

const U1 = "11111111-1111-4111-8111-111111111111"
const U2 = "22222222-2222-4222-8222-222222222222"
const S1 = "33333333-3333-4333-8333-333333333333"

const valid: Array<[string, unknown]> = [
  [
    "an action-only flow",
    {
      version: 1,
      steps: [
        { id: "assign", type: "action", action: "assign", args: { to: { leastLoaded: [U1, U2] } } },
        {
          id: "dm",
          type: "action",
          action: "message",
          args: { to: "{{task.assigneeId}}", text: "New: {{task.title}}" },
        },
        {
          id: "ping",
          type: "action",
          action: "notify",
          args: { to: ["{{owner}}"], text: "Assigned" },
        },
      ],
    },
  ],
  [
    "a wait with an until condition and a calendar",
    {
      version: 1,
      calendar: { timezone: "Europe/Paris", days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" },
      steps: [
        {
          id: "wait",
          type: "wait",
          for: { amount: 2, unit: "working_days" },
          until: {
            all: [{ op: "status_unchanged_since_trigger" }, { field: "fields.ref", op: "empty" }],
          },
        },
        { id: "remind", type: "action", action: "comment", args: { text: "Still waiting" } },
      ],
    },
  ],
  [
    "an agent step with outcomes and an if",
    {
      version: 1,
      steps: [
        {
          id: "draft",
          type: "agent",
          prompt: "Write to the customer",
          outcomes: [
            { kind: "message_posted", to: "{{task.assigneeId}}" },
            { kind: "field_set", field: "reply_sent" },
            { kind: "status_is", status: S1 },
            { kind: "tool_called", tool: "projects:comment" },
          ],
          maxBumps: 3,
          if: { field: "status", op: "in", value: [S1] },
        },
      ],
    },
  ],
]

const invalid: Array<[string, unknown]> = [
  ["no steps", { version: 1, steps: [] }],
  [
    "a wrong version",
    { version: 2, steps: [{ id: "a", type: "action", action: "comment", args: { text: "x" } }] },
  ],
  [
    "21 steps",
    {
      version: 1,
      steps: Array.from({ length: 21 }, (_, i) => ({
        id: `s${i}`,
        type: "action",
        action: "comment",
        args: { text: "x" },
      })),
    },
  ],
  [
    "duplicate step ids",
    {
      version: 1,
      steps: [
        { id: "a", type: "action", action: "comment", args: { text: "x" } },
        { id: "a", type: "action", action: "comment", args: { text: "y" } },
      ],
    },
  ],
  [
    "an unknown action",
    { version: 1, steps: [{ id: "a", type: "action", action: "delete", args: {} }] },
  ],
  [
    "args of another action",
    { version: 1, steps: [{ id: "a", type: "action", action: "assign", args: { text: "x" } }] },
  ],
  [
    "a person that is not a user id or placeholder",
    {
      version: 1,
      steps: [{ id: "a", type: "action", action: "message", args: { to: "alex", text: "x" } }],
    },
  ],
  [
    "a wait longer than 60 days",
    {
      version: 1,
      steps: [
        {
          id: "w",
          type: "wait",
          for: { amount: 61, unit: "days" },
          until: { field: "status", op: "eq", value: S1 },
        },
      ],
    },
  ],
  [
    "a wait without until",
    { version: 1, steps: [{ id: "w", type: "wait", for: { amount: 1, unit: "days" } }] },
  ],
  [
    "eq without a value",
    {
      version: 1,
      steps: [
        {
          id: "a",
          type: "action",
          action: "comment",
          args: { text: "x" },
          if: { field: "status", op: "eq" },
        },
      ],
    },
  ],
  [
    "in with a single value",
    {
      version: 1,
      steps: [
        {
          id: "a",
          type: "action",
          action: "comment",
          args: { text: "x" },
          if: { field: "status", op: "in", value: S1 },
        },
      ],
    },
  ],
  [
    "a condition on an unknown field",
    {
      version: 1,
      steps: [
        {
          id: "a",
          type: "action",
          action: "comment",
          args: { text: "x" },
          if: { field: "title", op: "empty" },
        },
      ],
    },
  ],
  [
    "conditions nested 4 deep",
    {
      version: 1,
      steps: [
        {
          id: "a",
          type: "action",
          action: "comment",
          args: { text: "x" },
          if: { all: [{ any: [{ all: [{ field: "status", op: "empty" }] }] }] },
        },
      ],
    },
  ],
  [
    "maxBumps above 3",
    { version: 1, steps: [{ id: "g", type: "agent", prompt: "p", maxBumps: 4 }] },
  ],
  [
    "an unknown step key",
    { version: 1, steps: [{ id: "g", type: "agent", prompt: "p", extra: 1 }] },
  ],
]

describe("routine flow schema", () => {
  for (const [name, flow] of valid) {
    test(`accepts ${name}`, () => {
      const r = routineFlowSchema.safeParse(flow)
      expect(r.error?.issues ?? []).toEqual([])
      expect(r.success).toBe(true)
    })
  }
  for (const [name, flow] of invalid) {
    test(`refuses ${name}`, () => {
      expect(routineFlowSchema.safeParse(flow).success).toBe(false)
    })
  }
})

describe("projects event filter", () => {
  const base = {
    name: "assign-on-status",
    description: "d",
    kind: "event" as const,
    prompt: "Assigns new tasks",
  }
  test("accepts project, from/to status and fields on task:status_changed", () => {
    const r = createRoutineRequestSchema.safeParse({
      ...base,
      event: "projects:task:status_changed",
      eventFilter: {
        projectId: U1,
        fromStatusId: null,
        toStatusId: S1,
        fields: { kind: ["a", "b"], urgent: true },
      },
      flow: valid[0]![1],
    })
    expect(r.error?.issues ?? []).toEqual([])
  })
  test("accepts project and fields on task:updated, refuses a status change there", () => {
    expect(
      createRoutineRequestSchema.safeParse({
        ...base,
        event: "projects:task:updated",
        eventFilter: { projectId: U1, fields: { kind: "a" } },
      }).success,
    ).toBe(true)
    expect(
      createRoutineRequestSchema.safeParse({
        ...base,
        event: "projects:task:updated",
        eventFilter: { toStatusId: S1 },
      }).success,
    ).toBe(false)
  })
  test("refuses projects keys on another event", () => {
    expect(
      createRoutineRequestSchema.safeParse({
        ...base,
        event: "mail:message:create",
        eventFilter: { projectId: U1 },
      }).success,
    ).toBe(false)
    expect(routineEventFilterFitsEvent("tickets:ticket:create", { projectId: U1 })).toBe(false)
    expect(routineEventFilterFitsEvent("mail:message:create", { fromContactIds: [U1] })).toBe(true)
  })
  test("refuses a non-uuid project and an unknown key", () => {
    for (const eventFilter of [
      { projectId: "p1" },
      { project: U1 },
      { fields: { "Bad Key": 1 } },
    ]) {
      expect(
        createRoutineRequestSchema.safeParse({
          ...base,
          event: "projects:task:created",
          eventFilter,
        }).success,
      ).toBe(false)
    }
  })
  test("update takes a flow and checks a filter against the event it carries", () => {
    expect(updateRoutineRequestSchema.safeParse({ flow: valid[1]![1] }).success).toBe(true)
    expect(updateRoutineRequestSchema.safeParse({ flow: { version: 1, steps: [] } }).success).toBe(
      false,
    )
    expect(
      updateRoutineRequestSchema.safeParse({
        event: "mail:message:create",
        eventFilter: { projectId: U1 },
      }).success,
    ).toBe(false)
  })
})

describe("template placeholders", () => {
  const project = {
    id: U1,
    statuses: [
      { id: S1, label: "In progress" },
      { id: U2, label: "Done" },
    ],
  }
  test("fills the project and status ids, deep", () => {
    const r = resolveRoutineTemplatePlaceholders(
      {
        filter: { projectId: "{{projectId}}", toStatusId: "{{status:in_progress}}" },
        steps: [{ until: { field: "status", op: "in", value: ["{{status:DONE}}"] } }],
      },
      project,
    )
    expect(r).toEqual({
      value: {
        filter: { projectId: U1, toStatusId: S1 },
        steps: [{ until: { field: "status", op: "in", value: [U2] } }],
      },
    })
  })
  test("names a status the project lacks", () => {
    expect(resolveRoutineTemplatePlaceholders({ s: "{{status:review}}" }, project)).toEqual({
      error: 'the project has no status "review"',
    })
  })
})
