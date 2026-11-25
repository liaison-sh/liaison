// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool's times reach the model in the reader's zone, with the offset written out, live and when
// the turn is replayed. A person in Paris read "the request came at 06:05" while the screen said
// 07:05: the model had repeated a UTC instant as the time. What is stored stays in UTC.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import { convertToCoreMessages } from "~/modules/agent/context/context"
import type { RunContext } from "~/modules/agent/runtime/run-context"
import { instantInZone, timesForModel } from "~/modules/agent/tools/model-times"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as executeToolModule from "~/modules/apps/execute-tool"

const PARIS = "Europe/Paris"

describe("times for the model", () => {
  it("an instant in UTC becomes the same instant in the zone, its offset written out", () => {
    expect(timesForModel("2026-11-19T06:05:00.000Z", PARIS)).toBe("2026-11-19T07:05:00+01:00")
    // Summer time: two hours ahead.
    expect(timesForModel("2026-07-01T10:00:00Z", PARIS)).toBe("2026-07-01T12:00:00+02:00")
    // An instant with an offset is the same instant.
    expect(timesForModel("2026-11-19T12:00:00+05:00", PARIS)).toBe("2026-11-19T08:00:00+01:00")
  })

  it("walks objects, arrays and text, and leaves dates, numbers and other text alone", () => {
    const value = {
      createdAt: "2026-11-19T06:05:00.000Z",
      dueOn: "2026-12-19",
      n: 3,
      list: [{ at: "2026-11-19T23:30:00Z" }],
      note: "Sent at 2026-11-19T06:05:00Z by mail",
      id: "ticket-215",
    }
    expect(timesForModel(value, PARIS)).toEqual({
      createdAt: "2026-11-19T07:05:00+01:00",
      dueOn: "2026-12-19",
      n: 3,
      list: [{ at: "2026-11-20T00:30:00+01:00" }],
      note: "Sent at 2026-11-19T07:05:00+01:00 by mail",
      id: "ticket-215",
    })
  })

  it("in UTC, with no zone or with a zone it cannot read, the value is unchanged", () => {
    const value = { at: "2026-11-19T06:05:00.000Z" }
    expect(timesForModel(value, "UTC")).toEqual(value)
    expect(timesForModel(value, undefined)).toEqual(value)
    expect(timesForModel(value, "Mars/Olympus")).toEqual(value)
    expect(instantInZone(new Date("nope"), PARIS)).toBeNull()
  })

  it("a replayed tool result gives its times in the zone it is asked for", () => {
    const history = convertToCoreMessages(
      [
        { authorType: "user", content: "When did the client write?", metadata: null },
        {
          authorType: "agent",
          content: "",
          metadata: {
            toolCalls: [
              {
                toolCallId: "c-at",
                toolName: "tickets__get",
                args: {},
                result: { createdAt: "2026-11-19T06:05:00.000Z" },
                status: "completed",
              },
            ],
          },
        },
      ],
      undefined,
      { timeZone: PARIS },
    )
    const toolMsg = history.find((m) => (m as { role: string }).role === "tool") as {
      content: Array<{ output: { type: string; value: Record<string, unknown> } }>
    }
    expect(toolMsg.content[0]?.output).toEqual({
      type: "json",
      value: { createdAt: "2026-11-19T07:05:00+01:00" },
    })
  })
})

describe("tool-bridge: a live result's times are in the run's zone", () => {
  const ORG_ID = "00000000-0000-0000-0000-0000000cb0f2"
  const actor: ActorContext = {
    actorType: "user",
    userId: "user1",
    orgId: ORG_ID,
    scopes: ["test:items:read"],
    dimensionGrants: {},
  }
  let spy: ReturnType<typeof spyOn>

  beforeAll(() => {
    toolRegistry.set([ORG_ID, "test", "readThing"], {
      appName: "test",
      name: "readThing",
      description: "Reads a thing",
      requiredScopes: ["test:items:read"],
      handler: async () => ({}),
      params: z.object({ ref: z.string() }),
    })
    spy = spyOn(executeToolModule, "executeTool").mockImplementation((async () => ({
      data: { createdAt: "2026-11-19T06:05:00.000Z" },
    })) as never)
  })

  afterAll(() => {
    spy.mockRestore()
    toolRegistry.delete([ORG_ID, "test", "readThing"])
  })

  it("the model reads the time in the zone; the result itself stays in UTC", async () => {
    const frame = { modelTimeZone: PARIS } as unknown as RunContext
    const tools = buildToolSet(
      ORG_ID,
      actor,
      undefined,
      ALL_DEFERRED_TOOLS_UNLOCKED,
      "agent",
      frame,
    )
    const t = tools.test__readThing as {
      execute: (args: unknown, opts: unknown) => Promise<unknown>
      toModelOutput: (o: { toolCallId: string; input: unknown; output: unknown }) => unknown
    }
    const output = await t.execute({ ref: "x" }, { toolCallId: "c1", messages: [] })
    expect(JSON.stringify(output)).toContain("2026-11-19T06:05:00.000Z")
    const seen = t.toModelOutput({ toolCallId: "c1", input: { ref: "x" }, output })
    expect(JSON.stringify(seen)).toContain("2026-11-19T07:05:00+01:00")
    expect(JSON.stringify(seen)).not.toContain("06:05")
  })
})
