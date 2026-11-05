// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE TEST CALL an admin's "add model" runs before the model is saved: one
// short completion that is asked to call a stub `ping` tool. It proves the key,
// the routing (OpenRouter refuses a model no provider serves under the data
// policy) and tool calling, with the provider's own reason when it fails.
import { APICallError, generateText, isStepCount, type LanguageModel, tool } from "ai"
import { z } from "zod"
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "model-test-call" })

const TEST_CALL_TIMEOUT_MS = 30_000
const TEST_CALL_MAX_OUTPUT_TOKENS = 64
const REASON_CAP = 200

export type ModelTestCallResult =
  | { ok: true; toolCalled: boolean; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; reason: string }

/**
 * The provider's own message, capped. Never the response body: a server's
 * error page may echo anything, including what it was sent.
 */
export function plainProviderReason(err: unknown): string {
  let message: string
  if (APICallError.isInstance(err)) {
    message = err.message || `HTTP ${err.statusCode ?? "error"}`
  } else if (err instanceof Error) {
    message = err.message
  } else {
    message = String(err)
  }
  const flat = message.replace(/\s+/g, " ").trim() || "The model did not answer"
  return flat.length > REASON_CAP ? `${flat.slice(0, REASON_CAP - 1)}…` : flat
}

export async function runModelTestCall(
  model: LanguageModel,
  context: { orgId: string; key: string },
): Promise<ModelTestCallResult> {
  let pinged = false
  try {
    const result = await generateText({
      model,
      system: "You are testing a connection. Use the ping tool when asked to.",
      prompt: "Call the ping tool once, then reply with the single word it returned.",
      tools: {
        ping: tool({
          description: "Answers pong. Call it to test the connection.",
          inputSchema: z.object({}),
          execute: async () => {
            pinged = true
            return "pong"
          },
        }),
      },
      stopWhen: isStepCount(2),
      maxOutputTokens: TEST_CALL_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(TEST_CALL_TIMEOUT_MS),
    })
    const toolCalled =
      pinged || result.steps.some((s) => s.toolCalls.some((c) => c.toolName === "ping"))
    const usage = result.totalUsage
    return {
      ok: true,
      toolCalled,
      usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
    }
  } catch (err) {
    const reason = plainProviderReason(err)
    log.warn(
      {
        err,
        orgId: context.orgId,
        modelKey: context.key,
        status: APICallError.isInstance(err) ? err.statusCode : undefined,
      },
      "model test call failed",
    )
    return { ok: false, reason }
  }
}
