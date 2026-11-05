// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A routine tick that could not do its job is a failure, judged from what it
// did. The fixtures are the support routine's real prod transcripts of
// 2026-10-16 (a tickets tool missing, the run reporting itself blocked), next
// to runs that did their job and must stay succeeded.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { agentNoticeStoredText } from "@liaison/shared"
import {
  classifyTickOutcome,
  isOutcomeWriteTool,
  judgeLastTurn,
  judgeTickOutcome,
  registeredWriteTool,
  TURN_STOPPED_EARLY,
} from "~/modules/agent/routines/routine-tick-outcome"
import { toolRegistry } from "~/modules/apps/app-registries"

const missing = (name: string) => ({
  toolName: name,
  error: {
    message: `AI_ToolCallRepairError: Error repairing tool call: Error: No tool named "${name}" is available to you. Closest tools you hold: knowledge__get. Tool names are app__tool, with two underscores.`,
  },
})
const ok = (name: string) => ({ toolName: name, status: "completed" })

describe("routine tick outcome", () => {
  it("a job tool that was unavailable fails the tick, naming the tool", () => {
    const reason = classifyTickOutcome({
      toolCalls: [
        missing("kernel__tool_search"),
        ok("kernel__skill_read"),
        missing("tickets__get"),
      ],
      finalText: "Ticket message event received, triage could not proceed.",
    })
    expect(reason).toContain("tickets__get")
  })

  it("the SDK's unavailable-tool refusal counts too", () => {
    const reason = classifyTickOutcome({
      toolCalls: [
        {
          toolName: "tickets__reply",
          error: "Model tried to call unavailable tool 'tickets__reply'",
        },
      ],
      finalText: "done",
    })
    expect(reason).toContain("tickets__reply")
  })

  it("a misspelt tool the run then called correctly is not a failure", () => {
    expect(
      classifyTickOutcome({
        toolCalls: [missing("tickets__get"), ok("tickets__get"), ok("tickets__reply")],
        finalText: "Drafted a reply, pending approval.",
      }),
    ).toBeNull()
  })

  it("calling the discovery helper where it does not exist is not a failure by itself", () => {
    expect(
      classifyTickOutcome({
        toolCalls: [missing("kernel__tool_search"), ok("tickets__get"), ok("tickets__addNote")],
        finalText: "**Classification:** RMA request. Note added.",
      }),
    ).toBeNull()
  })

  it("an output that declares itself blocked fails the tick, whatever its markdown", () => {
    for (const finalText of [
      "**Classification:** Blocked (unable to classify ticket due to missing ticket tools).",
      "- **Classification**: Blocked (Ticket `f3d1`), unable to read ticket contents",
      "Classification: Blocked: ticket d40d cannot be evaluated",
      "Blocked: ticket tools are not granted in this routine's scope.",
    ]) {
      expect(classifyTickOutcome({ toolCalls: [], finalText })).toContain("blocked")
    }
  })

  it("a stand-down, a normal report and blocked mid-sentence stay succeeded", () => {
    for (const finalText of [
      "outbound/note, stood down",
      "**Classification:** Pre-sale question. The customer is blocked by a firewall at work; drafted a reply.",
      "",
    ]) {
      expect(classifyTickOutcome({ toolCalls: [ok("tickets__get")], finalText })).toBeNull()
    }
  })
})

describe("a refused call the run got past", () => {
  const writes = (name: string) => name === "tickets__reply" || name === "tickets__addNote"

  it("an unheld lookup the run carried on from, ending with output, succeeds with a warning", () => {
    // The live run: a skill read refused, then the run read the ticket and drafted the reply.
    const outcome = judgeTickOutcome({
      toolCalls: [
        ok("tickets__get"),
        missing("kernel__skill_read"),
        ok("tickets__search"),
        ok("tickets__reply"),
      ],
      finalText: "Drafted a reply, pending approval.",
      isWriteTool: writes,
    })
    expect(outcome.failure).toBeNull()
    expect(outcome.warnings).toEqual([
      "A tool the routine called was unavailable: kernel__skill_read",
    ])
  })

  it("an input the tool's schema refused is a warning, never the run's error", () => {
    const outcome = judgeTickOutcome({
      toolCalls: [
        {
          toolName: "tickets__search",
          error: {
            message:
              "AI_InvalidToolInputError: Invalid input for tool tickets__search: Type validation failed",
          },
        },
        ok("tickets__search"),
        ok("tickets__reply"),
      ],
      finalText: "Drafted.",
      isWriteTool: writes,
    })
    expect(outcome.failure).toBeNull()
    expect(outcome.warnings).toHaveLength(1)
  })

  it("a refused WRITE tool fails the run even when it carried on and ended with output", () => {
    const outcome = judgeTickOutcome({
      toolCalls: [missing("tickets__reply"), ok("tickets__addNote")],
      finalText: "Note added.",
      isWriteTool: writes,
    })
    expect(outcome.failure).toContain("tickets__reply")
  })

  it("a refusal followed by nothing, or by no output, still fails", () => {
    expect(
      judgeTickOutcome({
        toolCalls: [ok("tickets__get"), missing("kernel__skill_read")],
        finalText: "Drafted.",
        isWriteTool: writes,
      }).failure,
    ).toContain("kernel__skill_read")
    expect(
      judgeTickOutcome({
        toolCalls: [missing("kernel__skill_read"), ok("tickets__get")],
        finalText: "  ",
        isWriteTool: writes,
      }).failure,
    ).toContain("kernel__skill_read")
  })

  it("a run that got past a refusal but declares itself blocked still fails", () => {
    expect(
      judgeTickOutcome({
        toolCalls: [missing("kernel__skill_read"), ok("tickets__get")],
        finalText: "Blocked: the knowledge base is empty.",
        isWriteTool: writes,
      }).failure,
    ).toContain("blocked")
  })
})

describe("which refused tool is the job's own write", () => {
  // Each declaration mirrors the tool's real registration (kernel-tools.ts, the tickets
  // and api-connector manifests). web_fetch is NOT readOnly, on purpose: a read-only run
  // must not reach the internet. It still writes nothing.
  const orgId = "00000000-0000-4000-8000-0000000c0a7e"
  const handler = async () => null
  const tools: [string, string, Record<string, unknown>][] = [
    ["kernel", "web_fetch", { taintSource: true, externalEffect: true }],
    ["kernel", "web_search", { taintSource: true }],
    ["kernel", "web_watch", { taintSource: true, writesToTable: "kernel.routine_state" }],
    ["kernel", "import_start", { gated: true }],
    ["kernel", "thread_post", {}],
    ["tickets", "reply", { gated: true, externalEffect: true }],
    ["tickets", "addNote", {}],
    ["api-connector", "connector_read", { readOnly: true, taintSource: true }],
    ["mcp_example", "lookup", { taintSource: true, externalEffect: true }],
    ["mail", "reply", { conditionalGate: true }],
  ]
  beforeAll(() => {
    for (const [app, name, def] of tools) {
      toolRegistry.set([orgId, app, name], {
        appName: app,
        name,
        description: name,
        requiredScopes: [`${app}:test`],
        handler,
        ...def,
      })
    }
  })
  afterAll(() => {
    for (const [app, name] of tools) toolRegistry.delete([orgId, app, name])
  })
  const writes = (name: string) => registeredWriteTool(orgId, name)

  it("the kernel web tools are reads; a write table, a gate or an unmarked tool is a write", () => {
    expect(writes("kernel__web_fetch")).toBe(false)
    expect(writes("kernel__web_search")).toBe(false)
    expect(writes("api-connector__connector_read")).toBe(false)
    expect(writes("kernel__web_watch")).toBe(true)
    expect(writes("kernel__import_start")).toBe(true)
    expect(writes("kernel__thread_post")).toBe(true)
    expect(writes("tickets__reply")).toBe(true)
    expect(writes("tickets__addNote")).toBe(true)
    expect(writes("mail__reply")).toBe(true)
    // Only kernel code earns the taint-source read: an app's or MCP server's claim does not.
    expect(writes("mcp_example__lookup")).toBe(true)
    expect(isOutcomeWriteTool("tickets", { taintSource: true })).toBe(true)
    expect(isOutcomeWriteTool("kernel", { readOnly: true, gated: true })).toBe(true)
    // Not registered: not a write, as before.
    expect(writes("kernel__no_such_tool")).toBe(false)
    expect(writes("nounderscore")).toBe(false)
  })

  it("a refused web_fetch, then reads, a parked write and a brief: succeeded, with a warning", () => {
    // The live run: kernel__web_fetch refused with suggestions, then four connector reads,
    // a mail reply parked as an approval, and a 1,734-character brief.
    const outcome = judgeTickOutcome({
      toolCalls: [
        missing("kernel__web_fetch"),
        ok("api-connector__connector_read"),
        ok("api-connector__connector_read"),
        ok("api-connector__connector_read"),
        ok("api-connector__connector_read"),
        { toolName: "mail__reply", status: "pending_approval" },
      ],
      finalText: "Brief: three prospects replied with interest. ".repeat(38),
      isWriteTool: writes,
    })
    expect(outcome.failure).toBeNull()
    expect(outcome.warnings).toEqual([
      "A tool the routine called was unavailable: kernel__web_fetch",
    ])
  })

  it("a refused app write tool still fails the run however it ends", () => {
    for (const refused of ["tickets__reply", "mail__reply"]) {
      const outcome = judgeTickOutcome({
        toolCalls: [missing(refused), ok("api-connector__connector_read"), ok("tickets__addNote")],
        finalText: "Note added instead.",
        isWriteTool: writes,
      })
      expect(outcome.failure).toBe(`A tool the routine called was unavailable: ${refused}`)
    }
  })

  it("a refused unknown name is judged as before: forgiven when the run carried on", () => {
    const carried = judgeTickOutcome({
      toolCalls: [missing("kernel__made_up"), ok("api-connector__connector_read")],
      finalText: "Brief.",
      isWriteTool: writes,
    })
    expect(carried.failure).toBeNull()
    expect(carried.warnings).toEqual(["A tool the routine called was unavailable: kernel__made_up"])
    expect(
      judgeTickOutcome({
        toolCalls: [ok("api-connector__connector_read"), missing("kernel__made_up")],
        finalText: "Brief.",
        isWriteTool: writes,
      }).failure,
    ).toContain("kernel__made_up")
  })
})

// A tick whose turn ended in an error posted nothing the job asked for. It used
// to read "succeeded": no refused tool, no "Blocked" line. The run's error now
// carries the failure's own detail and code (a budget refusal of 2026-10-29).
describe("routine tick outcome: the last turn's own end", () => {
  const refusal = "You have used this sandbox's AI budget for today. It resets at midnight UTC."

  it("an in-band refusal with no text fails the run, naming its detail and code", () => {
    const reason = judgeLastTurn({
      content: agentNoticeStoredText(refusal),
      metadata: {
        finishReason: "error",
        error: refusal,
        errorCode: "demo_budget_exhausted",
        agentNotice: "provider_error",
        stepCount: 3,
      },
    })
    expect(reason).toBe(
      `The run's turn failed with an error: ${refusal} (code: demo_budget_exhausted)`,
    )
  })

  it("a turn that wrote some text then errored fails too, with the provider's detail", () => {
    const detail = "Upstream returned 500: model overloaded"
    const reason = judgeLastTurn({
      content: `Looking at ticket 42 now.\n\n${agentNoticeStoredText(detail)}`,
      metadata: { finishReason: "error", error: detail },
    })
    expect(reason).toContain("The run's turn failed")
    expect(reason).toContain(detail)
  })

  it("a spending-cap failure says so and quotes the provider", () => {
    const detail = "Your project has exceeded its monthly spending cap."
    const reason = judgeLastTurn({
      content: agentNoticeStoredText(detail),
      metadata: { finishReason: "error", error: detail, agentNotice: "provider_quota" },
    })
    expect(reason).toBe(`The run's turn failed: the AI service reached its spending cap: ${detail}`)
  })

  it("an older row without metadata is still recognised by its stored line", () => {
    const reason = judgeLastTurn({ content: agentNoticeStoredText("boom"), metadata: null })
    expect(reason).toContain("boom")
  })

  it("a turn that stopped before its answer fails with the stop reason (and may still wait)", () => {
    const reason = judgeLastTurn({
      content:
        "⚠️ I stopped before writing a final answer (stop reason: max steps). I completed 3 tool calls before stopping; that work is preserved above.",
      metadata: { finishReason: "tool-calls", agentNotice: "stopped_early" },
    })
    expect(reason?.startsWith(TURN_STOPPED_EARLY)).toBe(true)
    // routine-worker.ts keys its pause on this exact wording.
    expect(TURN_STOPPED_EARLY).toBe("The run's turn stopped before writing a final answer")
    expect(reason).toContain("stop reason: max steps")
  })

  it("a turn that answered is not a failure", () => {
    expect(
      judgeLastTurn({
        content: "Drafted a reply on ticket 42; it waits for approval.",
        metadata: { finishReason: "stop" },
      }),
    ).toBeNull()
  })
})
