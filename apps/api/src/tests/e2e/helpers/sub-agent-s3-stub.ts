// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Stub bundle for S3 (live WS status transitions). The sub-run intentionally
// pauses ~700ms between `running` and the `finalize` call so the UI has a
// stable window to observe `data-status="running"` before the row transitions
// to `done`. Without this, the smoke stub's instant-finalize path lands the
// row at `done` before the WS event for `running` reaches the client.

const SMOKE_ROLE_MARKER = "SUB_AGENT_E2E_SMOKE_ROLE"
const RUNNING_DELAY_MS = 700

function stringify(c: unknown): string {
  return typeof c === "string" ? c : (JSON.stringify(c) ?? "")
}

const RUNTIME_CONTEXT_OPEN = "<runtime-context"

function lastUserMessage(messages?: Array<{ role?: string; content?: unknown }>): string {
  if (!messages) return ""
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && (m.role === "user" || m.role === undefined)) {
      const s = stringify(m.content)
      // The runtime-context tail rides AFTER the user's message (as the smoke
      // stub already knows): skip it, or the turn's own prompt is never seen and
      // the parent ends without spawning (Playwright S3: no sub-run card).
      if (s.trimStart().startsWith(RUNTIME_CONTEXT_OPEN)) continue
      if (s.trim()) return s
    }
  }
  return ""
}

function isSubRunInvocation(opts: {
  system?: unknown
  messages?: Array<{ content?: unknown }>
}): boolean {
  const sys = stringify(opts.system ?? "")
  if (sys.includes(SMOKE_ROLE_MARKER)) return true
  const head = stringify(opts.messages?.[0]?.content ?? "")
  return head.includes(SMOKE_ROLE_MARKER)
}

function shouldSpawn(opts: { messages?: Array<{ content?: unknown }> }): boolean {
  return lastUserMessage(opts.messages).includes("Dispatch sub-agent for S3")
}

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
  // --- Sub-run path: delay then finalize ---
  if (isSubRunInvocation(opts)) {
    const toolCalls = [
      {
        toolCallId: "s3-sub-finalize",
        toolName: "finalize",
        input: { ok: true, scenario: "S3" },
      },
    ]
    const usage = { inputTokens: 20, outputTokens: 5 }
    // Schedule the finalize after RUNNING_DELAY_MS so the UI observes the
    // `running` status for a stable window.
    setTimeout(() => {
      Promise.resolve().then(async () => {
        try {
          await opts.onStepFinish?.({ toolCalls, usage })
        } catch {
          /* worker aborts after a valid finalize */
        }
      })
    }, RUNNING_DELAY_MS)
    return {
      fullStream: (async function* () {
        // Hold the stream open until either: the worker aborts (after our
        // onStepFinish fires) OR the abort signal trips.
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, RUNNING_DELAY_MS + 200)
          opts.abortSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t)
              resolve()
            },
            { once: true },
          )
        })
        // A sub-run with no output schema answers with its text: one that ends
        // with no text and no draft is failed as a degenerate no-op
        // (empty_output), and the card never reaches `done`.
        yield { type: "text-delta", text: "S3 investigation done." }
        yield { type: "finish-step", usage, finishReason: "tool-calls" }
        yield { type: "finish", finishReason: "stop" }
      })(),
    } as any
  }

  // --- Parent: spawn one sub-agent for S3 ---
  if (!shouldSpawn(opts)) {
    return makeFinishStream({ inputTokens: 0, outputTokens: 0 }) as any
  }
  const spawn = opts.tools?.kernel__spawn_agent
  if (!spawn?.execute) {
    return makeFinishStream({ inputTokens: 0, outputTokens: 0 }) as any
  }
  const args = {
    subagent_type: "s3-investigator",
    description: "S3 live-status",
    prompt: `${SMOKE_ROLE_MARKER} S3 live-status path.`,
  }
  const toolCallPromise = spawn
    .execute(args)
    .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
  return {
    fullStream: (async function* () {
      const toolCallId = "s3-parent-spawn"
      yield { type: "tool-call", toolCallId, toolName: "kernel__spawn_agent", input: args }
      yield {
        type: "tool-result",
        toolCallId,
        output: { dispatched: true },
      }
      yield { type: "text-delta", text: "Sub-agent dispatched for S3." }
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
