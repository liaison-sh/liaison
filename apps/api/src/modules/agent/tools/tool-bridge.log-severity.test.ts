// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The bridge logs a failed agent tool call at the level its class gives it
// (lib/failure-severity.ts). Production paged on outcomes the agent was simply
// told about: "Unsupported media type (unknown)" from analyze_media (a 501, 38
// times in a week), an upstream's 503 page, a guard that held the call. A real
// fault (a statusless throw, a 500) still logs at error.
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import pino from "pino"
import { z } from "zod"
import type { ActorContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import { markPlatformTaintRefusal } from "~/modules/agent/scopes/scope-taint"
import { ALL_DEFERRED_TOOLS_UNLOCKED, buildToolSet } from "~/modules/agent/tools/tool-bridge"
import { toolRegistry } from "~/modules/apps/app-registries"
import * as executeToolModule from "~/modules/apps/execute-tool"

const ORG_ID = "00000000-0000-0000-0000-0000000cb0f7"

const actor: ActorContext = {
  actorType: "user",
  userId: "user1",
  orgId: ORG_ID,
  scopes: ["test:items:write"],
  dimensionGrants: {},
}

type ExecTool = { execute: (args: unknown, opts: unknown) => Promise<unknown> }

function typedError(message: string, status?: number, code?: string): Error {
  return Object.assign(new Error(message), {
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
  })
}

describe("tool-bridge: failure log severity", () => {
  let respond: () => Promise<unknown> = async () => ({ data: { ok: true } })
  let spy: ReturnType<typeof spyOn>
  const lines: string[] = []
  let restore: () => void = () => {}

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
    const stream: unknown = Reflect.get(rootLogger, pino.symbols.streamSym)
    if (!stream || typeof stream !== "object" || !("write" in stream)) {
      throw new Error("the root logger has no stream to capture")
    }
    const original = stream.write
    if (typeof original !== "function") throw new Error("the root logger stream cannot write")
    Reflect.set(stream, "write", (chunk: unknown) => {
      lines.push(String(chunk))
      return Reflect.apply(original, stream, [chunk])
    })
    restore = () => Reflect.set(stream, "write", original)
  })

  afterEach(() => {
    lines.length = 0
  })

  afterAll(() => {
    restore()
    spy.mockRestore()
    toolRegistry.delete([ORG_ID, "test", "doThing"])
  })

  async function logged(err: Error): Promise<{ level: number; reason?: string }> {
    respond = async () => {
      throw err
    }
    const tools = buildToolSet(ORG_ID, actor, undefined, ALL_DEFERRED_TOOLS_UNLOCKED)
    const out = (await (tools.test__doThing as unknown as ExecTool).execute(
      { ref: "x" },
      { toolCallId: "c1", messages: [] },
    )) as { error?: string }
    // The agent is told either way.
    expect(out.error).toContain(err.message)
    const line = lines
      .map((l) => JSON.parse(l) as { msg?: string; level: number; reason?: string })
      .find((l) => l.msg === "Agent tool execution error")
    if (!line) throw new Error("no 'Agent tool execution error' line was written")
    return { level: line.level, reason: line.reason }
  }

  it("an unsupported media type (501) is a warn, reason unsupported", async () => {
    expect(
      await logged(typedError("Unsupported media type (unknown).", 501, "unsupported")),
    ).toEqual({ level: 40, reason: "unsupported" })
  })

  it("an upstream 503 is a warn, reason upstream_unavailable", async () => {
    expect(await logged(typedError("Shopify HTTP 503: upstream connect error", 503))).toEqual({
      level: 40,
      reason: "upstream_unavailable",
    })
  })

  it("a not-found is a warn, reason not_found", async () => {
    expect(
      await logged(typedError("Thread not found or not a participant", 404, "not_found")),
    ).toEqual({ level: 40, reason: "not_found" })
  })

  it("an app's deliberate refusal (refuseTool, answered 422) is a warn with its guidance intact", async () => {
    expect(
      await logged(
        typedError(
          "This buyer looks like a business but has no VAT number. Nothing was created. Next step: find it.",
          422,
          "buyer_vat_id_required",
        ),
      ),
    ).toEqual({ level: 40, reason: "invalid_request" })
  })

  it("a guard that held the call is a warn, reason guard_held", async () => {
    const held = markPlatformTaintRefusal(
      typedError("tool test:doThing: NOT EXECUTED: this conversation has read data", 403, "x"),
    )
    expect(await logged(held)).toEqual({ level: 40, reason: "guard_held" })
  })

  it("a genuine unknown error still logs at error", async () => {
    expect(await logged(new Error("Cannot read properties of undefined"))).toEqual({
      level: 50,
      reason: undefined,
    })
    expect(await logged(typedError("Tool returned an error", 500, "tool_error"))).toEqual({
      level: 50,
      reason: undefined,
    })
  })
})
