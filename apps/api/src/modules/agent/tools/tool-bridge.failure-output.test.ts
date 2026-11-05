// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A tool call that failed must reach the model as a failure it cannot read as success or as
// "pending". Walk 2026-10-19: create_routine was refused (the refusal text talked about
// proposing scopes and an approval), the result reached the model as an ordinary JSON object,
// and a small model told the user an approval card was waiting when none existed. The bridge
// now hands the model an error output (`error-json`, which providers mark as a failed call)
// carrying `status: "failed"`, live and when the turn is replayed from the store. Successful
// and parked (pending approval) results keep their plain JSON output.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import { convertToCoreMessages } from "~/modules/agent/context/context"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolFailureModelOutput } from "~/modules/agent/tools/tool-failure-output"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as executeToolModule from "~/modules/apps/execute-tool"

const ORG_ID = "00000000-0000-0000-0000-0000000cb0f1"

const actor: ActorContext = {
  actorType: "user",
  userId: "user1",
  orgId: ORG_ID,
  scopes: ["test:items:write"],
  dimensionGrants: {},
}

type ModelOutputTool = {
  execute: (args: unknown, opts: unknown) => Promise<unknown>
  toModelOutput?: (o: { toolCallId: string; input: unknown; output: unknown }) => unknown
}

describe("tool-bridge: a failed call reaches the model as a failure", () => {
  let respond: () => Promise<unknown> = async () => ({ data: { ok: true } })
  let spy: ReturnType<typeof spyOn>

  beforeAll(() => {
    toolRegistry.set([ORG_ID, "test", "doThing"], {
      appName: "test",
      name: "doThing",
      description: "Does a thing",
      requiredScopes: ["test:items:write"],
      handler: async () => ({ ok: true }),
      params: z.object({ ref: z.string() }),
    })
    spy = spyOn(executeToolModule, "executeTool").mockImplementation((async () =>
      respond()) as never)
  })

  afterAll(() => {
    spy.mockRestore()
    toolRegistry.delete([ORG_ID, "test", "doThing"])
  })

  const run = async () => {
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const t = tools.test__doThing as unknown as ModelOutputTool
    const output = await t.execute({ ref: "x" }, { toolCallId: "c1", messages: [] })
    expect(typeof t.toModelOutput).toBe("function")
    return t.toModelOutput?.({ toolCallId: "c1", input: { ref: "x" }, output })
  }

  it("a thrown refusal becomes an error output with status failed", async () => {
    respond = async () => {
      const err = new Error("NOT CREATED: refused") as Error & { status: number; code: string }
      err.status = 422
      err.code = "refused"
      throw err
    }
    const out = (await run()) as { type: string; value: { status?: string; error?: string } }
    expect(out.type).toBe("error-json")
    expect(out.value.status).toBe("failed")
    expect(out.value.error).toContain("NOT CREATED: refused")
  })

  it("a success keeps its plain JSON output", async () => {
    respond = async () => ({ data: { ok: true } })
    const out = (await run()) as { type: string }
    expect(out.type).toBe("json")
  })

  it("a call parked for approval is not a failure", async () => {
    respond = async () => ({
      blocked: { reason: "gated", summary: {}, requesterCanApprove: true },
    })
    const out = (await run()) as { type: string; value: { status?: string } }
    expect(out.type).toBe("json")
    expect(out.value.status).toBe("pending_approval")
  })

  it("a stored failed call replays as the same error output", () => {
    // A bridge error result as persisted, and an SDK tool-error row (no result, status error).
    expect(toolFailureModelOutput({ error: "Tool x failed (HTTP 422)" })).toEqual({
      type: "error-json",
      value: { status: "failed", error: "Tool x failed (HTTP 422)" },
    })
    expect(
      toolFailureModelOutput(null, { status: "error", error: { message: "Invalid input" } }),
    ).toEqual({ type: "error-json", value: { status: "failed", error: "Invalid input" } })
    expect(toolFailureModelOutput({ ok: true })).toBeNull()
    expect(toolFailureModelOutput({ blocked: true, status: "pending_approval" })).toBeNull()
  })

  it("a failure keeps its structured fields and any partial result", () => {
    // EMAIL_IN_USE carries the clashing contact's id: the model needs it to update that contact
    // instead of creating a duplicate. A partial result (rows read before the failure) stays too.
    const out = toolFailureModelOutput({
      error: { code: "EMAIL_IN_USE", message: "Email already in use", existingContactId: "c-42" },
      partial: [{ id: "r1" }],
    })
    expect(out?.type).toBe("error-json")
    expect(out?.value).toEqual({
      status: "failed",
      error: { code: "EMAIL_IN_USE", message: "Email already in use", existingContactId: "c-42" },
      partial: [{ id: "r1" }],
    })
  })

  it("an empty or explicitly successful error field is not a failure", () => {
    expect(toolFailureModelOutput({ rows: [], error: "" })).toBeNull()
    expect(toolFailureModelOutput({ rows: [], error: false })).toBeNull()
    expect(toolFailureModelOutput({ rows: [], error: {} })).toBeNull()
    // A success that reports an informational error beside its data (a skipped item, a warning).
    expect(toolFailureModelOutput({ ok: true, sent: 3, error: "1 address skipped" })).toBeNull()
    expect(toolFailureModelOutput({ success: true, error: { message: "partial" } })).toBeNull()
    // A failure flagged as such stays a failure.
    expect(toolFailureModelOutput({ ok: false, error: "refused" })?.value.status).toBe("failed")
  })

  it("a replayed failure keeps its fields under the replay cap", () => {
    const history = convertToCoreMessages([
      { authorType: "user", content: "Add the contact", metadata: null },
      {
        authorType: "agent",
        content: "",
        metadata: {
          toolCalls: [
            {
              toolCallId: "c-clash",
              toolName: "kernel__upsert_contact",
              args: {},
              result: {
                error: {
                  code: "EMAIL_IN_USE",
                  message: "Email already in use",
                  existingContactId: "c-42",
                },
                partial: "x".repeat(50_000),
              },
              status: "completed",
            },
          ],
        },
      },
    ])
    const toolMsg = history.find((m) => (m as { role: string }).role === "tool") as {
      content: Array<{ output: { type: string; value: Record<string, unknown> } }>
    }
    const out = toolMsg.content[0]?.output
    expect(out?.type).toBe("error-json")
    expect(out?.value.status).toBe("failed")
    expect(
      (out?.value.error as { existingContactId?: string } | undefined)?.existingContactId,
    ).toBe("c-42")
    expect(String(out?.value.partial).length).toBeLessThan(5_000)
  })

  it("convertToCoreMessages replays a stored failure as an error output and a success as JSON", () => {
    const history = convertToCoreMessages([
      { authorType: "user", content: "Send me a message in one minute", metadata: null },
      {
        authorType: "agent",
        content: "",
        metadata: {
          toolCalls: [
            {
              toolCallId: "c-fail",
              toolName: "kernel__create_routine",
              args: {},
              result: { error: "Tool kernel__create_routine failed (HTTP 422)" },
              status: "completed",
            },
            {
              toolCallId: "c-ok",
              toolName: "kernel__list_routines",
              args: {},
              result: { routines: [] },
              status: "completed",
            },
          ],
        },
      },
    ])
    const toolMsg = history.find((m) => (m as { role: string }).role === "tool") as {
      content: Array<{ output: { type: string; value: { status?: string } } }>
    }
    expect(toolMsg.content[0]?.output.type).toBe("error-json")
    expect(toolMsg.content[0]?.output.value.status).toBe("failed")
    expect(toolMsg.content[1]?.output.type).toBe("json")
  })
})
