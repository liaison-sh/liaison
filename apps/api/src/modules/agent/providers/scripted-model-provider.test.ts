// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T21b — the scripted turn seam. The browser scenarios that used to stub
// `**/api/agent/chat` SSE now script the SERVER's turn; this pins the two
// properties they depend on: steps replay IN ORDER, and a scripted tool call is
// a REAL tool call (the agent loop executes the tool and the script's next step
// only runs once that result is back).

import { afterEach, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { stepCountIs, streamText, tool } from "ai"
import { z } from "zod"
import { redis } from "~/lib/redis"
import { convertToCoreMessages, RUNTIME_TAIL_OPEN } from "~/modules/agent/context/context"
import {
  clearScriptedTurns,
  createScriptedModel,
  ECHO_MISS,
  hasScriptedTurn,
  remainingScriptedSteps,
  resolveStepText,
  SCRIPT_TTL_S,
  SCRIPTED_CALL_PREFIX,
  scriptedModelEnabled,
  scriptedStepPosition,
  scriptKeyFor,
  setScriptedRoutine,
  setScriptedTurn,
  UNSCRIPTED_REPLY,
} from "./scripted-model-provider"

afterEach(async () => {
  await clearScriptedTurns()
  process.env.LIAISON_MODEL_PROVIDER = undefined as unknown as string
  // biome-ignore lint/performance/noDelete: env var must be absent, not "undefined"
  delete process.env.LIAISON_MODEL_PROVIDER
})

describe("scripted model provider", () => {
  it("replays steps in order and executes tool calls through the bridge", async () => {
    const threadId = "thread-replay"
    const executed: Array<{ name: string; args: unknown }> = []

    await setScriptedTurn(threadId, [
      {
        reasoning: "First I look the contact up.",
        toolCalls: [{ name: "kernel__contacts_search", args: { query: "Sofia" } }],
      },
      {
        reasoning: "Found it, now I read it.",
        toolCalls: [{ name: "kernel__contacts_read", args: { contactId: "c-1" } }],
      },
      { text: "Sofia Rossi is in the registry." },
    ])

    const result = streamText({
      model: createScriptedModel(threadId) as never,
      prompt: "who is Sofia?",
      stopWhen: stepCountIs(6),
      tools: {
        kernel__contacts_search: tool({
          description: "search contacts",
          inputSchema: z.object({ query: z.string() }),
          execute: async (args) => {
            executed.push({ name: "kernel__contacts_search", args })
            return { contacts: [{ id: "c-1", name: "Sofia Rossi" }] }
          },
        }),
        kernel__contacts_read: tool({
          description: "read a contact",
          inputSchema: z.object({ contactId: z.string() }),
          execute: async (args) => {
            executed.push({ name: "kernel__contacts_read", args })
            return { id: "c-1", name: "Sofia Rossi", email: "sofia@studio.test" }
          },
        }),
      },
    })

    const text = await result.text
    const steps = await result.steps

    // The tools RAN, in the script's order, with the script's arguments — the
    // bridge executed them, the script did not fabricate their results.
    expect(executed.map((e) => e.name)).toEqual([
      "kernel__contacts_search",
      "kernel__contacts_read",
    ])
    expect(executed[0]?.args).toEqual({ query: "Sofia" })
    expect(executed[1]?.args).toEqual({ contactId: "c-1" })

    // One model round trip per scripted step, in order.
    expect(steps.length).toBe(3)
    expect(steps[0]?.toolCalls.map((c) => c.toolName)).toEqual(["kernel__contacts_search"])
    expect(steps[1]?.toolCalls.map((c) => c.toolName)).toEqual(["kernel__contacts_read"])
    expect(steps[2]?.toolCalls.length).toBe(0)

    // Reasoning is carried on the steps that declared it, before their tool call.
    expect(steps[0]?.reasoningText).toContain("First I look the contact up.")
    expect(steps[1]?.reasoningText).toContain("Found it")

    // The final text is the script's last step, and the real tool RESULTS were
    // fed back to the model between steps.
    expect(text).toBe("Sofia Rossi is in the registry.")
    expect(steps[0]?.toolResults?.[0]?.output).toEqual({
      contacts: [{ id: "c-1", name: "Sofia Rossi" }],
    })
    expect(await remainingScriptedSteps(threadId)).toBe(0)
  })

  it("answers a scripted thread with a fixed line once its steps run out, so no turn hangs", async () => {
    const threadId = "thread-exhausted"
    await setScriptedTurn(threadId, [])
    const result = streamText({
      model: createScriptedModel(threadId) as never,
      prompt: "anything",
      stopWhen: stepCountIs(3),
    })
    expect(await result.text).toBe(UNSCRIPTED_REPLY)
  })

  it("only claims threads a test scripted, and only when the lane flag is armed", async () => {
    expect(scriptedModelEnabled()).toBe(false)
    process.env.LIAISON_MODEL_PROVIDER = "scripted"
    expect(scriptedModelEnabled()).toBe(true)

    expect(await hasScriptedTurn("never-scripted")).toBe(false)
    await setScriptedTurn("scripted-thread", [{ text: "hi" }])
    expect(await hasScriptedTurn("scripted-thread")).toBe(true)
    // A registered thread stays registered after its last step is read — that
    // is what makes the fixed fallback line reachable instead of a real call.
    await clearScriptedTurns("scripted-thread")
    expect(await hasScriptedTurn("scripted-thread")).toBe(false)
  })

  // ── `echo`: answer out of the prompt the step was given ────────────────────
  //
  // The case it exists for is `mailbox-encryption-local` L5: the two-phase
  // broker injects decrypted mail as an EPHEMERAL context block that never
  // reaches `metadata.toolCalls` (Invariant K), so the prompt is the only place
  // the plaintext is observable and "did it reach the model" is the claim.
  it("echo answers with the matched text from the prompt it was given", () => {
    const options = { prompt: [{ role: "user", content: "the body says PHRASE-ALPHA-9 here" }] }
    expect(resolveStepText({ echo: "PHRASE-ALPHA-9" }, options)).toBe("PHRASE-ALPHA-9")
  })

  it("echo reports a miss rather than inventing the text it was asked for", () => {
    const options = { prompt: [{ role: "user", content: "no secret in here" }] }
    expect(resolveStepText({ echo: "PHRASE-ALPHA-9" }, options)).toBe(ECHO_MISS)
    // A text fallback must NOT rescue a miss: that is the whole failure mode
    // this guards, since a scripted line would look exactly like a real answer.
    expect(resolveStepText({ echo: "PHRASE-ALPHA-9", text: "PHRASE-ALPHA-9" }, options)).toBe(
      ECHO_MISS,
    )
  })

  it("a step with no echo keeps answering with its own text", () => {
    expect(resolveStepText({ text: "plain" }, { prompt: [] })).toBe("plain")
  })

  it("an unparseable echo pattern misses instead of throwing inside a turn", () => {
    expect(resolveStepText({ echo: "([" }, { prompt: [] })).toBe(ECHO_MISS)
  })

  // A routine run's thread is created by the worker after `run-now`, so the
  // scenario can only name the routine (network-blip-recovery, S26).
  it("a routine-keyed script drives that routine's run", async () => {
    await setScriptedRoutine("routine-1", [{ text: "Routine wrote the note." }])
    const key = await scriptKeyFor("run-thread-created-later", "routine-1")
    expect(key).not.toBeNull()
    // Another routine, or a turn with no routine, stays on the normal path.
    expect(await scriptKeyFor("run-thread-created-later", "routine-2")).toBeNull()
    expect(await scriptKeyFor("run-thread-created-later", null)).toBeNull()

    const result = streamText({ model: createScriptedModel(key) as never, prompt: "run" })
    expect(await result.text).toBe("Routine wrote the note.")
    expect(await remainingScriptedSteps(key)).toBe(0)

    // The run thread's own script wins over the routine's.
    await setScriptedTurn("run-thread-created-later", [{ text: "thread script" }])
    expect(await scriptKeyFor("run-thread-created-later", "routine-1")).toBe(
      "run-thread-created-later",
    )

    await clearScriptedTurns(null, "routine-1")
    expect(await scriptKeyFor("other-thread", "routine-1")).toBeNull()
    // Clearing one routine leaves the thread scripts alone.
    expect(await scriptKeyFor("run-thread-created-later", null)).toBe("run-thread-created-later")
  })

  // ── Cross-process and resume-safe (P3 T9) ──────────────────────────────────
  //
  // A turn may run, or resume after a crash, in another process of the cell
  // than the one the test scripted: the script lives in Redis, and the step a
  // call plays is read off the prompt it received, never a process cursor.
  it("a script set on process A is played by a model created on B", async () => {
    const threadId = `thread-cross-${crypto.randomUUID()}`
    // Process A wrote this, in the documented layout; this process never set it.
    await redis.hset(`agent:script:${threadId}`, {
      steps: JSON.stringify([{ text: "played on B" }]),
      len: "1",
      next: "0",
    })
    await redis.expire(`agent:script:${threadId}`, SCRIPT_TTL_S)
    expect(await hasScriptedTurn(threadId)).toBe(true)
    expect(await scriptKeyFor(threadId)).toBe(threadId)
    const result = streamText({ model: createScriptedModel(threadId) as never, prompt: "hi" })
    expect(await result.text).toBe("played on B")
    await redis.del(`agent:script:${threadId}`)
  })

  it("the step index follows the prompt: 2 assistant steps after the user message play step 3", async () => {
    const threadId = `thread-resume-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: "kernel__one", args: {} }] },
      { toolCalls: [{ name: "kernel__two", args: {} }] },
      { text: "third step" },
    ])
    const toolPair = (id: string, name: string) => [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: id, toolName: name, input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: id,
            toolName: name,
            output: { type: "json", value: {} },
          },
        ],
      },
    ]
    const resumedPrompt = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "do it" }] },
      ...toolPair("scripted-call.90-0", "kernel__one"),
      // A note the loop injects between steps is not a new turn.
      { role: "user", content: [{ type: "text", text: "step budget note" }] },
      ...toolPair("scripted-call.91-0", "kernel__two"),
    ]
    expect(scriptedStepPosition({ prompt: resumedPrompt }).stepsSoFar).toBe(2)
    // A fresh model (another process, a resumed turn) on that prompt plays step 3.
    const { stream } = await createScriptedModel(threadId).doStream({ prompt: resumedPrompt })
    const parts: Array<Record<string, unknown>> = []
    for await (const part of stream) parts.push(part)
    const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta)
    expect(text).toEqual(["third step"])
    expect(parts.some((p) => p.type === "tool-call")).toBe(false)
  })

  it("a follow-up sent while the first turn still answers is a turn of its own; the tail moving keeps a turn's key", () => {
    const text = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] })
    const tail = text(`${RUNTIME_TAIL_OPEN}">now</runtime-context>`)
    const step = {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: `${SCRIPTED_CALL_PREFIX}1-0`, toolName: "x", input: "{}" },
      ],
    }
    const result = { role: "tool", content: [] }
    const firstCall = scriptedStepPosition({ prompt: [text("research it"), tail, text("a note")] })
    const laterCall = scriptedStepPosition({
      prompt: [text("research it"), step, result, tail, text("a note")],
    })
    expect(laterCall.turn).toBe(firstCall.turn)
    expect(laterCall.stepsSoFar).toBe(1)
    const followUp = scriptedStepPosition({
      prompt: [text("research it"), text("now a task"), tail],
    })
    expect(followUp.turn).not.toBe(firstCall.turn)
    expect(followUp.stepsSoFar).toBe(0)
  })

  it("an earlier turn replayed from the thread history is not counted as a step of the next turn", () => {
    // The previous turn's calls as the history replays them, ids kept when portable
    // (the prompt-cache replay, #499) and its closing words in the same message.
    const history = convertToCoreMessages(
      [
        { id: "u1", authorType: "user", content: "read it for me", metadata: {} },
        {
          id: "a1",
          authorType: "agent",
          content: "read it",
          metadata: {
            toolCalls: [
              {
                toolCallId: `${SCRIPTED_CALL_PREFIX}5-0`,
                toolName: "kernel__read",
                args: {},
                result: {},
              },
            ],
          },
        },
      ],
      undefined,
      { keepToolCallIds: true },
    )
    const prompt = [...history, { role: "user", content: [{ type: "text", text: "thanks" }] }]
    expect(scriptedStepPosition({ prompt }).stepsSoFar).toBe(0)
  })

  it("the same call replayed (a cut step re-issued) plays the same step; the next turn moves on", async () => {
    const threadId = `thread-reissue-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      { toolCalls: [{ name: "kernel__one", args: {} }] },
      { text: "turn one done" },
      { text: "turn two" },
    ])
    const firstCall = { prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }] }
    const play = async (options: unknown) => {
      const { stream } = await createScriptedModel(threadId).doStream(options)
      const out: unknown[] = []
      for await (const part of stream) {
        if (part.type === "tool-call") out.push(part.toolName)
        if (part.type === "text-delta") out.push(part.delta)
      }
      return out
    }
    expect(await play(firstCall)).toEqual(["kernel__one"])
    // The runner died mid-step-1: the resume re-issues the same call.
    expect(await play(firstCall)).toEqual(["kernel__one"])
    const afterTool = [
      ...firstCall.prompt,
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "a", toolName: "kernel__one", input: {} }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "a",
            toolName: "kernel__one",
            output: { type: "json", value: {} },
          },
        ],
      },
    ]
    expect(await play({ prompt: afterTool })).toEqual(["turn one done"])
    // The same words again open a NEW turn (its ordinal differs): step 3.
    const secondTurn = {
      prompt: [
        ...afterTool,
        { role: "assistant", content: [{ type: "text", text: "turn one done" }] },
        { role: "user", content: [{ type: "text", text: "go" }] },
      ],
    }
    const text = await play(secondTurn)
    expect(text).toEqual(["turn two"])
  })

  it("toolDelayMs reaches the test effect tools as waitMs, and no other tool", async () => {
    const threadId = `thread-delay-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [
      {
        toolDelayMs: 1500,
        toolCalls: [
          { name: "kernel__test_effect_then_wait", args: { key: "k1" } },
          { name: "kernel__contacts_search", args: { query: "x" } },
        ],
      },
    ])
    const { stream } = await createScriptedModel(threadId).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    })
    const inputs: unknown[] = []
    for await (const part of stream) if (part.type === "tool-call") inputs.push(part.input)
    expect(inputs.map((i) => JSON.parse(String(i)))).toEqual([
      { waitMs: 1500, key: "k1" },
      { query: "x" },
    ])
  })

  // Two turns of one agent asked moments apart read the same history: the
  // newer ask is already in the older turn's prompt when it is assembled. Keyed
  // on the prompt alone they took one base and both played the first step
  // (agent-overlapping-turns, once its follow-up was sent at once).
  it("two turns whose prompts are the same take steps of their own", async () => {
    const threadId = `thread-same-prompt-${crypto.randomUUID()}`
    await setScriptedTurn(threadId, [{ text: "first answer" }, { text: "second answer" }])
    const prompt = [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "research it" }] },
      { role: "user", content: [{ type: "text", text: "now make a task" }] },
    ]
    const play = async (turnId: string) => {
      const { stream } = await createScriptedModel(threadId, turnId).doStream({ prompt })
      const parts: Array<Record<string, unknown>> = []
      for await (const part of stream) parts.push(part)
      return parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.delta)
        .join("")
    }
    expect(await play("ask-1")).toBe("first answer")
    expect(await play("ask-2")).toBe("second answer")
    // The same turn calling again (a resume) keeps its base.
    expect(await play("ask-1")).toBe("first answer")
  })
})
