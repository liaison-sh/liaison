// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  createRoutineRequestSchema,
  cronExpressionSchema,
  timezoneSchema,
  updateRoutineRequestSchema,
} from "./routines"

describe("createRoutineRequestSchema", () => {
  it("accepts a valid 5-field cron + IANA tz", () => {
    const parsed = createRoutineRequestSchema.parse({
      name: "morning-summary",
      description: "Summarise overnight email at 9am",
      cron: "0 9 * * *",
      timezone: "Europe/Paris",
      prompt: "Summarise the overnight inbox.",
      scopes: ["kernel:threads:write"],
    })
    expect(parsed.enabled).toBe(true)
  })

  it("rejects 6-field cron (seconds field) per BullMQ tz constraint", () => {
    // cron-parser accepts `0 0 0 8 * * *` (6 fields with seconds), but BullMQ
    // schedulers with `tz` expect 5-field cron. Validator must enforce 5.
    expect(() => cronExpressionSchema.parse("0 0 8 * * *")).toThrow()
    expect(() =>
      createRoutineRequestSchema.parse({
        name: "x",
        description: "y",
        cron: "0 0 8 * * *",
        timezone: "UTC",
        prompt: "p",
      }),
    ).toThrow()
  })

  it("rejects 'foo bar baz' as cron", () => {
    expect(() =>
      createRoutineRequestSchema.parse({
        name: "x",
        description: "y",
        cron: "foo bar baz",
        timezone: "UTC",
        prompt: "p",
      }),
    ).toThrow()
  })

  it("rejects 'Europe/Notathing' as tz", () => {
    expect(() =>
      createRoutineRequestSchema.parse({
        name: "x",
        description: "y",
        cron: "* * * * *",
        timezone: "Europe/Notathing",
        prompt: "p",
      }),
    ).toThrow()
  })

  it("rejects description >200 chars", () => {
    expect(() =>
      createRoutineRequestSchema.parse({
        name: "x",
        description: "x".repeat(201),
        cron: "* * * * *",
        timezone: "UTC",
        prompt: "p",
      }),
    ).toThrow()
  })

  it("rejects empty prompt", () => {
    expect(() =>
      createRoutineRequestSchema.parse({
        name: "x",
        description: "y",
        cron: "* * * * *",
        timezone: "UTC",
        prompt: "",
      }),
    ).toThrow()
  })

  it("rejects name with spaces", () => {
    expect(() =>
      createRoutineRequestSchema.parse({
        name: "bad name",
        description: "y",
        cron: "* * * * *",
        timezone: "UTC",
        prompt: "p",
      }),
    ).toThrow()
  })

  it("accepts an optional ownerUserId (run-as delegation) as a UUID", () => {
    // A real RFC-9562 UUID: zod v4 validates the version/variant nibbles, so a
    // fixture like …-4444-… (invalid variant) is rejected. This test never ran
    // before the `shared` suite was wired into test-run.ts (2026-08-06).
    const ownerUserId = "11111111-2222-3333-8444-555555555555"
    const parsed = createRoutineRequestSchema.parse({
      name: "liam-rma-triage",
      description: "draft EU RMA replies for Liam to approve",
      cron: "0 8 * * 1-5",
      timezone: "Europe/Paris",
      prompt: "find Liam's SLA-approaching RMA tickets and draft replies",
      scopes: ["tickets:tickets:read", "tickets:tickets:reply"],
      ownerUserId,
    })
    expect(parsed.ownerUserId).toBe(ownerUserId)
  })

  it("omits ownerUserId by default (a routine runs as its creator)", () => {
    const parsed = createRoutineRequestSchema.parse({
      name: "x",
      description: "y",
      cron: "0 9 * * *",
      timezone: "UTC",
      prompt: "p",
    })
    expect(parsed.ownerUserId).toBeUndefined()
  })

  it("rejects a non-UUID ownerUserId (must be a resolved id, never a name)", () => {
    expect(() =>
      createRoutineRequestSchema.parse({
        name: "x",
        description: "y",
        cron: "0 9 * * *",
        timezone: "UTC",
        prompt: "p",
        ownerUserId: "Liam",
      }),
    ).toThrow()
  })
})

describe("updateRoutineRequestSchema", () => {
  it("allows updating just cron + timezone", () => {
    const parsed = updateRoutineRequestSchema.parse({
      cron: "*/15 * * * *",
      timezone: "America/New_York",
    })
    expect(parsed.cron).toBe("*/15 * * * *")
    expect(parsed.timezone).toBe("America/New_York")
  })

  it("validates partial cron even on update", () => {
    expect(() => updateRoutineRequestSchema.parse({ cron: "not a cron" })).toThrow()
  })
})

describe("cronExpressionSchema", () => {
  it("accepts standard cron", () => {
    expect(() => cronExpressionSchema.parse("0 9 * * MON-FRI")).not.toThrow()
  })

  it("rejects junk", () => {
    expect(() => cronExpressionSchema.parse("hello world")).toThrow()
  })
})

describe("timezoneSchema", () => {
  it("accepts UTC and IANA names", () => {
    expect(() => timezoneSchema.parse("UTC")).not.toThrow()
    expect(() => timezoneSchema.parse("Asia/Tokyo")).not.toThrow()
  })

  it("rejects unknown tz", () => {
    expect(() => timezoneSchema.parse("Atlantis/Lost")).toThrow()
  })
})

// One "where it posts" field: the run thread is internal, never set by an edit.
describe("updateRoutineRequestSchema: where a routine posts", () => {
  it("drops an outputThreadId: the routine's run thread is always its own", () => {
    const parsed = updateRoutineRequestSchema.parse({
      outputThreadId: "11111111-2222-4333-8444-555555555555",
    }) as Record<string, unknown>
    expect(parsed.outputThreadId).toBeUndefined()
  })

  it("takes a conversation id, a channel handle, or null as reportThreadId", () => {
    const id = "11111111-2222-4333-8444-555555555555"
    expect(updateRoutineRequestSchema.parse({ reportThreadId: id }).reportThreadId).toBe(id)
    expect(updateRoutineRequestSchema.parse({ reportThreadId: "#marketing" }).reportThreadId).toBe(
      "#marketing",
    )
    expect(updateRoutineRequestSchema.parse({ reportThreadId: null }).reportThreadId).toBe(null)
  })
})

describe("routine token budget + hard limit (S17)", () => {
  const base = {
    name: "budgeted",
    description: "a budgeted routine",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "p",
  }

  it("create accepts both fields, and leaves them absent when omitted", () => {
    const parsed = createRoutineRequestSchema.parse({
      ...base,
      tokenBudget: 20000,
      hardTokenLimit: 50000,
    })
    expect(parsed.tokenBudget).toBe(20000)
    expect(parsed.hardTokenLimit).toBe(50000)
    const plain = createRoutineRequestSchema.parse(base)
    expect(plain.tokenBudget).toBeUndefined()
    expect(plain.hardTokenLimit).toBeUndefined()
  })

  it("rejects zero, negatives and fractions", () => {
    for (const bad of [0, -1, 1.5]) {
      expect(() => createRoutineRequestSchema.parse({ ...base, tokenBudget: bad })).toThrow()
      expect(() => updateRoutineRequestSchema.parse({ hardTokenLimit: bad })).toThrow()
    }
  })

  it("update accepts null, which clears the field", () => {
    expect(updateRoutineRequestSchema.parse({ tokenBudget: null, hardTokenLimit: null })).toEqual({
      tokenBudget: null,
      hardTokenLimit: null,
    })
  })
})

describe("routine runsOn (S21, P4 T3)", () => {
  const base = {
    name: "on-node",
    description: "a routine that runs on the owner's node",
    cron: "0 9 * * *",
    timezone: "UTC",
    prompt: "p",
  }

  it("create accepts cloud, node and node_else_cloud, and leaves it absent when omitted", () => {
    for (const runsOn of ["cloud", "node", "node_else_cloud"] as const) {
      expect(createRoutineRequestSchema.parse({ ...base, runsOn }).runsOn).toBe(runsOn)
    }
    expect(createRoutineRequestSchema.parse(base).runsOn).toBeUndefined()
  })

  it("rejects any other place, and update takes it too", () => {
    expect(() => createRoutineRequestSchema.parse({ ...base, runsOn: "my-mac" })).toThrow()
    expect(updateRoutineRequestSchema.parse({ runsOn: "node" })).toEqual({ runsOn: "node" })
  })
})

describe("routine eventFilter and approver (S26, S29)", () => {
  const base = {
    name: "prospect-mail",
    description: "d",
    kind: "event" as const,
    event: "mail:message:create",
    prompt: "p",
  }
  it("accepts contact and group ids, and the two approvers", () => {
    const id = "00000000-0000-4000-8000-000000000001"
    const parsed = createRoutineRequestSchema.parse({
      ...base,
      eventFilter: { fromContactIds: [id], fromGroupIds: [id] },
      approver: "owner",
    })
    expect(parsed.eventFilter).toEqual({ fromContactIds: [id], fromGroupIds: [id] })
    expect(parsed.approver).toBe("owner")
    expect(updateRoutineRequestSchema.parse({ eventFilter: null }).eventFilter).toBeNull()
  })
  it("refuses a non-uuid id, an unknown filter key and an unknown approver", () => {
    expect(
      createRoutineRequestSchema.safeParse({ ...base, eventFilter: { fromGroupIds: ["vip"] } })
        .success,
    ).toBe(false)
    expect(
      createRoutineRequestSchema.safeParse({ ...base, eventFilter: { fromDomains: ["a.b"] } })
        .success,
    ).toBe(false)
    expect(createRoutineRequestSchema.safeParse({ ...base, approver: "admin" }).success).toBe(false)
  })
})
