// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Test stubs for the AI SDK's `streamText` swap point used by the agent
// runtime. The chat agent and sub-run worker both call `runAgentStream` which
// delegates to the swapped `streamTextForAgent`; setting one of these stubs
// via `AgentServiceTestAccess.setStreamText()` lets a test drive the agent loop without
// hitting a real model.
//
// All stubs return a fake stream object with the AI SDK v5 shape:
//   { fullStream: AsyncIterable<chunk> }
// where chunk is one of:
//   { type: "text-delta", text }
//   { type: "tool-call", toolCallId, toolName, input }
//   { type: "finish-step", usage: { inputTokens, outputTokens } }
//   { type: "finish", finishReason }
//
// `onStepFinish` is called between steps with `{ toolCalls: [...], usage }`
// so the worker's finalize interception works.

interface StubParams {
  onStepFinish?: (step: { toolCalls: unknown[]; usage: unknown }) => Promise<void> | void
  abortSignal?: AbortSignal
}

function makeStream(
  chunks: unknown[],
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>,
): { fullStream: AsyncIterable<unknown> } {
  return {
    fullStream: (async function* () {
      for (const c of chunks) yield c
      // emit tool-call chunks so callers iterating fullStream can also see them
      for (const tc of toolCalls) {
        yield { type: "tool-call", ...tc }
      }
    })(),
  }
}

export const stubStreamText = {
  /**
   * Single-step run that calls `finalize` exactly once with the given payload
   * and a clean stop. Use for happy-path sub-run tests.
   */
  respondWithFinalize(payload: unknown) {
    return function stubbed(params: StubParams) {
      const toolCalls = [{ toolCallId: "tc-1", toolName: "finalize", input: payload }]
      const stream = makeStream(
        [
          { type: "finish-step", usage: { inputTokens: 10, outputTokens: 5 } },
          { type: "finish", finishReason: "stop" },
        ],
        toolCalls,
      )
      // Trigger onStepFinish synchronously so the worker observes the
      // finalize tool call before draining the stream.
      Promise.resolve().then(async () => {
        try {
          await params.onStepFinish?.({
            toolCalls,
            usage: { inputTokens: 10, outputTokens: 5 },
          })
        } catch {
          // swallow — abort signal triggered by worker's finalize handler
        }
      })
      return stream as never
    }
  },

  /**
   * Sequence of finalize attempts. The stub fires `onStepFinish` once per
   * entry in the sequence; the worker validates each, reports tool errors
   * via `onToolError`, and the last valid call terminates the run.
   */
  respondWithSequence(opts: {
    sequence: Array<{ type: "finalize"; payload: unknown }>
    onToolError?: (err: string) => void
  }) {
    return function stubbed(params: StubParams) {
      const stream = makeStream(
        [
          { type: "finish-step", usage: { inputTokens: 10, outputTokens: 5 } },
          { type: "finish", finishReason: "stop" },
        ],
        [],
      )
      // Drive the sequence asynchronously so the worker's `onStepFinish`
      // intercepts each finalize attempt in order. Stop once the abortSignal
      // has been raised by the worker.
      Promise.resolve().then(async () => {
        for (const entry of opts.sequence) {
          if (entry.type !== "finalize") continue
          const toolCalls = [
            {
              toolCallId: `tc-${Math.random().toString(36).slice(2, 8)}`,
              toolName: "finalize",
              input: entry.payload,
            },
          ]
          try {
            const before = opts.onToolError ? collectErrors(opts.onToolError) : null
            await params.onStepFinish?.({
              toolCalls,
              usage: { inputTokens: 10, outputTokens: 5 },
            })
            // If validation failed, the worker incremented schemaRetryCount.
            // We can't directly observe that here, so the test asserts on the
            // collected onToolError list. The onStepFinish path doesn't yet
            // surface validation errors back to this stub; the worker
            // simulates feedback by aborting on terminal failure.
            void before
          } catch {
            break
          }
        }
      })
      return stream as never
    }
  },

  /**
   * Clean voluntary stop (finishReason "stop") that emits NON-EMPTY assistant
   * text and never calls finalize — a legitimate hybrid (no-schema) completion
   * (e.g. a summarizer/formatter sub-agent). Used to prove the hybrid success
   * path still works after the empty-output no-op guard: a sub-run that actually
   * produced text returns ok:true, only the empty/whitespace no-op fails.
   */
  cleanStopWithText(text = "Here is the requested summary.") {
    return function stubbed(params: StubParams) {
      Promise.resolve().then(async () => {
        try {
          await params.onStepFinish?.({
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 4 },
          })
        } catch {
          // ignore
        }
      })
      return makeStream(
        [
          { type: "text-delta", text },
          { type: "finish-step", usage: { inputTokens: 5, outputTokens: 4 } },
          { type: "finish", finishReason: "stop" },
        ],
        [],
      ) as never
    }
  },

  /** Returns a stream that ends without ever calling finalize (and emits no text
   *  — an EMPTY clean stop, the degenerate "spawned, did nothing" no-op). */
  neverFinalize() {
    return function stubbed(params: StubParams) {
      // Fire onStepFinish so the worker counts this as a real step.
      Promise.resolve().then(async () => {
        try {
          await params.onStepFinish?.({
            toolCalls: [],
            usage: { inputTokens: 5, outputTokens: 2 },
          })
        } catch {
          // ignore
        }
      })
      return makeStream(
        [
          { type: "finish-step", usage: { inputTokens: 5, outputTokens: 2 } },
          { type: "finish", finishReason: "stop" },
        ],
        [],
      ) as never
    }
  },

  /**
   * Emits exactly `steps` "step" cycles via onStepFinish without ever calling
   * finalize. Used to drive the worker to its step_limit boundary.
   */
  neverFinalizeWithSteps(steps: number) {
    return function stubbed(params: StubParams) {
      Promise.resolve().then(async () => {
        for (let i = 0; i < steps; i++) {
          try {
            await params.onStepFinish?.({
              toolCalls: [],
              usage: { inputTokens: 5, outputTokens: 2 },
            })
          } catch {
            return
          }
        }
      })
      // Stream chunks mirror the step cycles so the worker's drain loop
      // accumulates usage at the same cadence.
      const chunks: unknown[] = []
      for (let i = 0; i < steps; i++) {
        chunks.push({ type: "finish-step", usage: { inputTokens: 5, outputTokens: 2 } })
      }
      chunks.push({ type: "finish", finishReason: "tool-calls" })
      return makeStream(chunks, []) as never
    }
  },

  /**
   * Emits `steps` step cycles WITHOUT finalize and ends with the AI SDK's
   * `length` finish reason — the "max tokens / steps reached" budget-exhaustion
   * signal. Used to drive a HYBRID (no-schema) sub-run to its step_limit branch,
   * which must surface `ok:false` (not a `ok:true` empty-output stub). Some text
   * is emitted so the hybrid finalOutput would be non-empty if the success path
   * were wrongly taken — proving the failure path fires on budget, not on emptiness.
   */
  lengthFinishNoFinalize(steps: number) {
    return function stubbed(params: StubParams) {
      Promise.resolve().then(async () => {
        for (let i = 0; i < steps; i++) {
          try {
            await params.onStepFinish?.({
              toolCalls: [],
              usage: { inputTokens: 5, outputTokens: 2 },
            })
          } catch {
            return
          }
        }
      })
      const chunks: unknown[] = [{ type: "text-delta", text: "Working on it…" }]
      for (let i = 0; i < steps; i++) {
        chunks.push({ type: "finish-step", usage: { inputTokens: 5, outputTokens: 2 } })
      }
      chunks.push({ type: "finish", finishReason: "length" })
      return makeStream(chunks, []) as never
    }
  },

  /**
   * Stream that "stalls" until the worker's `abortSignal` fires (timeout). The
   * stub honors the AI SDK contract that aborted streams throw — when the
   * signal fires, the async iterator yields a `finish-step` to record the
   * (empty) step, then a `finish` chunk with `error` reason so the worker's
   * drain loop completes naturally and falls through to the timeout branch.
   */
  stallUntilAbort() {
    return function stubbed(params: StubParams) {
      return {
        fullStream: (async function* () {
          // Wait until the abort signal fires.
          if (params.abortSignal && !params.abortSignal.aborted) {
            await new Promise<void>((resolve) => {
              const sig = params.abortSignal
              if (!sig) {
                resolve()
                return
              }
              sig.addEventListener("abort", () => resolve(), { once: true })
            })
          }
          // Emit one finish-step + finish so the worker's drain loop ends
          // cleanly; the worker reads abortController.signal.reason to
          // classify timeout vs others.
          yield { type: "finish-step", usage: { inputTokens: 0, outputTokens: 0 } }
          yield { type: "finish", finishReason: "stop" }
        })(),
      } as never
    }
  },
}

// Helper kept for future expansion — currently a no-op marker.
function collectErrors(_cb: (err: string) => void): null {
  return null
}
