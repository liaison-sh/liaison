// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Sub-agent smoke stub — loaded by the spawned server when
 * `AGENT_STREAM_STUB` env var points at this file.
 *
 * Dispatches by inspecting the run's system prompt:
 *   - When the system prompt contains the sub-agent role marker
 *     (`SMOKE_ROLE_MARKER`), the call is the SUB-RUN's loop — emit a single
 *     `finalize` tool call with the canned payload.
 *   - Otherwise it's the PARENT chat agent loop — emit a single
 *     `kernel__spawn_agent` tool call to dispatch the sub-run, then once
 *     the tool result lands, finalize the parent turn with a short text
 *     summary.
 *
 * This stub is intentionally minimal: it covers the S1/S2 smoke path. Other
 * scenarios that need different shapes (continueOnError fan-out, schema retry,
 * etc.) get their own per-scenario stub files.
 */
import { streamText } from "ai"

const SMOKE_ROLE_MARKER = "SUB_AGENT_E2E_SMOKE_ROLE"

function stringify(c: unknown): string {
  return typeof c === "string" ? c : (JSON.stringify(c) ?? "")
}

function isSubRunInvocation(opts: {
  system?: unknown
  messages?: Array<{ content?: unknown }>
}): boolean {
  const sys = stringify(opts.system ?? "")
  if (sys.includes(SMOKE_ROLE_MARKER)) return true
  // The sub-run's first user message is the caller's prompt; inspect just in
  // case the role marker happens to live in the prompt instead.
  const head = stringify(opts.messages?.[0]?.content ?? "")
  return head.includes(SMOKE_ROLE_MARKER)
}

// Match on the LAST user message only — earlier turns may contain markers
// from prior scenarios in the same shared thread.
/** The platform's ephemeral tail (context.ts): a user-role message no one typed. */
const RUNTIME_CONTEXT_OPEN = "<runtime-context"

function lastUserMessage(messages?: Array<{ role?: string; content?: unknown }>): string {
  if (!messages) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && (m.role === "user" || m.role === undefined)) {
      const s = stringify(m.content)
      // The runtime-context tail rides AFTER the user's message: skip it, or the
      // turn's own prompt is never seen and every driven turn falls through to
      // the real provider.
      if (s.trimStart().startsWith(RUNTIME_CONTEXT_OPEN)) continue
      if (s.trim()) return s
    }
  }
  return ""
}

function shouldSpawn(opts: { messages?: Array<{ content?: unknown }> }): boolean {
  return lastUserMessage(opts.messages).includes("Dispatch sub-agent smoke now")
}

function shouldFanOut(opts: { messages?: Array<{ content?: unknown }> }): boolean {
  return lastUserMessage(opts.messages).includes("Fan out three children now")
}

function shouldNestSpawn(opts: { messages?: Array<{ content?: unknown }> }): boolean {
  return lastUserMessage(opts.messages).includes("Spawn nested investigator")
}

const NESTED_ROLE_MARKER = "SUB_AGENT_E2E_NESTED_ROLE"
const FANOUT_OK_MARKER = "SUB_AGENT_E2E_FANOUT_OK"
const FANOUT_TIMEOUT_MARKER = "SUB_AGENT_E2E_FANOUT_TIMEOUT"

interface StubParams {
  system?: unknown
  messages?: Array<{ content?: unknown }>
  tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }>
  onStepFinish?: (step: { toolCalls: unknown[]; usage: unknown }) => Promise<void> | void
  abortSignal?: AbortSignal
}

function makeFinishStream(
  usage: { inputTokens: number; outputTokens: number },
  finishReason = "stop",
) {
  return {
    fullStream: (async function* () {
      yield { type: "finish-step", usage, finishReason }
      yield { type: "finish", finishReason }
    })(),
  }
}

export default function streamTextStub(opts: StubParams) {
  const sys = stringify(opts.system ?? "")
  const firstMsg = stringify(opts.messages?.[0]?.content ?? "")

  // --- Nested sub-run path: sub-run that itself calls spawn_agent ---
  // When the role marker says "nested", the sub-run spawns a child IF a
  // depth ceiling hasn't been reached. The child eventually finalizes.
  if (sys.includes(NESTED_ROLE_MARKER) || firstMsg.includes(NESTED_ROLE_MARKER)) {
    // Inspect the input payload (first user message) for a depth hint.
    // Pattern: "{MARKER} depth=N target=M" — depth N spawns to N+1 until N+1 > target.
    const m = firstMsg.match(/depth=(\d+)\s+target=(\d+)/)
    const depth = m ? Number(m[1]) : 1
    const target = m ? Number(m[2]) : 2
    if (depth < target) {
      const spawn = opts.tools?.kernel__spawn_agent
      const spawnExecute = spawn?.execute
      if (spawnExecute) {
        const args = {
          subagent_type: "nested-investigator",
          description: `nested-d${depth + 1}`,
          prompt: `${NESTED_ROLE_MARKER} depth=${depth + 1} target=${target}`,
        }
        return {
          fullStream: (async function* () {
            yield {
              type: "tool-call",
              toolCallId: `nested-spawn-${depth}`,
              toolName: "kernel__spawn_agent",
              input: args,
            }
            let output: unknown
            try {
              output = await spawnExecute(args)
            } catch (err) {
              output = { error: err instanceof Error ? err.message : String(err) }
            }
            yield {
              type: "tool-result",
              toolCallId: `nested-spawn-${depth}`,
              output,
            }
            // Now finalize via onStepFinish (the sub-run's required exit).
            const toolCalls = [
              {
                toolCallId: `nested-finalize-${depth}`,
                toolName: "finalize",
                input: { depth, childResult: output },
              },
            ]
            const usage = { inputTokens: 20, outputTokens: 5 }
            Promise.resolve().then(async () => {
              try {
                await opts.onStepFinish?.({ toolCalls, usage })
              } catch {
                /* worker aborts on valid finalize */
              }
            })
            // A nested run has no output schema, so no finalize tool: its
            // answer is its text. A sub-run that ends with no text and no
            // draft is failed as a degenerate no-op (empty_output). The text
            // carries what its spawn returned, so the scenario can read what
            // the model saw (a refused spawn's error included).
            yield {
              type: "text-delta",
              text: `Nested depth ${depth} done. Spawn result: ${JSON.stringify(output)}`,
            }
            yield { type: "finish-step", usage, finishReason: "tool-calls" }
            yield { type: "finish", finishReason: "stop" }
          })(),
        } as any
      }
    }
    // Depth ceiling reached OR spawn tool not available — finalize without spawning.
    const toolCalls = [
      {
        toolCallId: `nested-finalize-${depth}-leaf`,
        toolName: "finalize",
        input: { depth, leaf: true },
      },
    ]
    const usage = { inputTokens: 20, outputTokens: 5 }
    Promise.resolve().then(async () => {
      try {
        await opts.onStepFinish?.({ toolCalls, usage })
      } catch {
        /* worker aborts on valid finalize */
      }
    })
    // The leaf answers with text too (no output schema, so no finalize).
    return {
      fullStream: (async function* () {
        yield { type: "text-delta", text: `Nested depth ${depth} reached the leaf.` }
        yield { type: "finish-step", usage, finishReason: "tool-calls" }
        yield { type: "finish", finishReason: "stop" }
      })(),
    } as any
  }

  // --- Fan-out timeout-victim path ---
  // The middle child in S5's fan-out gets this prompt marker — it stalls until
  // the timeout aborts it, exercising `error_code='timeout'`.
  if (sys.includes(FANOUT_TIMEOUT_MARKER) || firstMsg.includes(FANOUT_TIMEOUT_MARKER)) {
    return {
      fullStream: (async function* () {
        if (opts.abortSignal && !opts.abortSignal.aborted) {
          await new Promise<void>((resolve) => {
            opts.abortSignal!.addEventListener("abort", () => resolve(), { once: true })
          })
        }
        yield { type: "finish-step", usage: { inputTokens: 0, outputTokens: 0 } }
        yield { type: "finish", finishReason: "stop" }
      })(),
    } as any
  }

  // --- Fan-out ok-success path ---
  if (sys.includes(FANOUT_OK_MARKER) || firstMsg.includes(FANOUT_OK_MARKER)) {
    const m = firstMsg.match(/index=(\d+)/)
    const idx = m ? Number(m[1]) : 0
    const toolCalls = [
      {
        toolCallId: `fanout-finalize-${idx}`,
        toolName: "finalize",
        input: { ok: true, index: idx },
      },
    ]
    const usage = { inputTokens: 15, outputTokens: 3 }
    Promise.resolve().then(async () => {
      try {
        await opts.onStepFinish?.({ toolCalls, usage })
      } catch {
        /* worker aborts */
      }
    })
    return makeFinishStream(usage, "tool-calls") as any
  }

  // --- Sub-run loop: emit a single `finalize` tool-call via onStepFinish ---
  // The subrun-worker's `onStepFinish` callback intercepts `finalize` calls
  // out-of-band, validates the payload, and aborts the stream when valid.
  // The stream itself only needs to yield finish-step + finish chunks.
  if (isSubRunInvocation(opts)) {
    const toolCalls = [
      {
        toolCallId: "sub-finalize-1",
        toolName: "finalize",
        input: { ok: true, smoke: "passed" },
      },
    ]
    const usage = { inputTokens: 30, outputTokens: 5 }
    // Fire onStepFinish on next microtask so the worker can intercept before
    // the stream drains.
    Promise.resolve().then(async () => {
      try {
        await opts.onStepFinish?.({ toolCalls, usage })
      } catch {
        // The worker may abort the stream after intercepting `finalize` —
        // swallow that abort here; the stream's finish chunks still emit.
      }
    })
    return makeFinishStream(usage, "tool-calls") as any
  }

  // --- Parent: fan-out three children (continueOnError true) ---
  if (shouldFanOut(opts)) {
    const spawn = opts.tools?.kernel__spawn_agent
    if (!spawn?.execute) {
      return makeFinishStream({ inputTokens: 0, outputTokens: 0 }) as any
    }
    const spawnExecute = spawn.execute
    return {
      fullStream: (async function* () {
        // Three spawns: 0 ok, 1 timeout, 2 ok.
        // `output_schema` is required for the worker to honor the timeout abort
        // (see subrun-worker.ts:333 — terminal-state classification only
        // applies when a schema is set; without one the worker uses hybrid
        // mode and marks the run done regardless of abort reason).
        const okSchema = {
          type: "object",
          required: ["ok", "index"],
          properties: { ok: { type: "boolean" }, index: { type: "number" } },
        }
        const specs = [
          {
            i: 0,
            prompt: `${FANOUT_OK_MARKER} index=0`,
            extra: { continue_on_error: true, output_schema: okSchema },
          },
          {
            i: 1,
            prompt: `${FANOUT_TIMEOUT_MARKER} index=1`,
            extra: { continue_on_error: true, timeout_ms: 2_000, output_schema: okSchema },
          },
          {
            i: 2,
            prompt: `${FANOUT_OK_MARKER} index=2`,
            extra: { continue_on_error: true, output_schema: okSchema },
          },
        ]
        const results: unknown[] = []
        for (const spec of specs) {
          const args = {
            subagent_type: "fanout-investigator",
            description: `fan-${spec.i}`,
            prompt: spec.prompt,
            ...spec.extra,
          }
          yield {
            type: "tool-call",
            toolCallId: `fanout-spawn-${spec.i}`,
            toolName: "kernel__spawn_agent",
            input: args,
          }
          let out: unknown
          try {
            out = await spawnExecute(args)
          } catch (err) {
            out = { error: err instanceof Error ? err.message : String(err) }
          }
          results.push(out)
          yield {
            type: "tool-result",
            toolCallId: `fanout-spawn-${spec.i}`,
            output: out,
          }
        }
        yield { type: "text-delta", text: `Fan-out done: ${JSON.stringify(results)}` }
        yield {
          type: "finish-step",
          usage: { inputTokens: 150, outputTokens: 30 },
          finishReason: "stop",
        }
        yield { type: "finish", finishReason: "stop" }
      })(),
    } as any
  }

  // --- Parent: spawn one nested investigator (depth=1 → target from the
  // user message, "target=N", default 2) ---
  if (shouldNestSpawn(opts)) {
    const spawn = opts.tools?.kernel__spawn_agent
    if (!spawn?.execute) {
      return makeFinishStream({ inputTokens: 0, outputTokens: 0 }) as any
    }
    const target = Number(/target=(\d+)/.exec(lastUserMessage(opts.messages))?.[1] ?? 2)
    const args = {
      subagent_type: "nested-investigator",
      description: "nested-root",
      prompt: `${NESTED_ROLE_MARKER} depth=1 target=${target}`,
    }
    const toolCallPromise = spawn
      .execute(args)
      .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
    return {
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "nested-root-spawn",
          toolName: "kernel__spawn_agent",
          input: args,
        }
        yield { type: "tool-result", toolCallId: "nested-root-spawn", output: { dispatched: true } }
        yield { type: "text-delta", text: "Nested dispatched." }
        yield {
          type: "finish-step",
          usage: { inputTokens: 50, outputTokens: 10 },
          finishReason: "stop",
        }
        yield { type: "finish", finishReason: "stop" }
        void toolCallPromise.catch(() => undefined)
      })(),
    } as any
  }

  // --- Parent chat loop: dispatch sub-agent (when prompted) or pass through ---
  if (!shouldSpawn(opts)) {
    // Not a spawn-driving turn — fall back to the real LLM so unrelated tests
    // in the same scenario file keep their natural behavior.
    return streamText(opts as any) as any
  }

  const tools = opts.tools
  const spawn = tools?.kernel__spawn_agent
  if (!spawn?.execute) {
    // Capability gate filtered out spawn_agent — emit an empty step and stop.
    const usage = { inputTokens: 0, outputTokens: 0 }
    Promise.resolve().then(() => opts.onStepFinish?.({ toolCalls: [], usage }))
    return makeFinishStream(usage) as any
  }

  const args = {
    subagent_type: "smoke-investigator",
    description: "smoke",
    prompt: `${SMOKE_ROLE_MARKER} — Investigate the smoke target and call finalize with { ok: true, smoke: "passed" }.`,
    output_schema: {
      type: "object",
      required: ["ok"],
      properties: {
        ok: { type: "boolean" },
        smoke: { type: "string" },
      },
      additionalProperties: false,
    },
  }

  // Parent chat loop: emit tool-call + tool-result for `kernel__spawn_agent`
  // synchronously. We KICK OFF spawn.execute() (which enqueues the BullMQ
  // job + awaits the sub-run result) but DON'T block the stream on it — the
  // test asserts sub-run completion via DB polling, not via the SSE stream.
  //
  // Why not await: the parent SSE stream is consumed by `consumeSse` (a
  // fetch + text-read) which Bun.serve closes after `idleTimeout: 10s` if no
  // bytes are written. Awaiting `spawn.execute()` inside the generator means
  // no chunks emit until the sub-run completes, racing the 10s window when
  // the worker is under any load. Decoupling makes the parent stream finish
  // fast and deterministically; the sub-run's terminal state is the actual
  // observable the test cares about.
  const toolCallPromise = spawn
    .execute(args)
    .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
  return {
    fullStream: (async function* () {
      const toolCallId = "parent-spawn-1"
      yield { type: "tool-call", toolCallId, toolName: "kernel__spawn_agent", input: args }
      // Surface a stand-in tool-result immediately so the chat agent's persisted
      // step has both call+result and finishes cleanly. The actual structured
      // result is polled from `kernel.agent_runs` by the test assertions.
      yield {
        type: "tool-result",
        toolCallId,
        output: { dispatched: true, awaiting: "background" },
      }
      yield { type: "text-delta", text: "Sub-agent dispatched." }
      yield {
        type: "finish-step",
        usage: { inputTokens: 50, outputTokens: 10 },
        finishReason: "stop",
      }
      yield { type: "finish", finishReason: "stop" }
      // Detach: spawn.execute resolves whenever the sub-run finishes; the test
      // observes that via DB poll on `kernel.agent_runs`.
      void toolCallPromise.catch(() => undefined)
    })(),
  } as any
}
