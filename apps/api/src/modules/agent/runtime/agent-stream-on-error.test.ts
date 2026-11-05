// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A provider stream error is one structured log line, and the turn still sees it.
// Production, OpenRouter stream timeout: with no `onError`, the AI SDK printed the
// whole APICallError (a code frame, the request body, the headers) as plain text,
// and every line became its own watchdog signature.
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { APICallError, RetryError, stepCountIs } from "ai"
import { MockLanguageModelV4 } from "ai/test"
import { sandboxCancelledError } from "~/lib/failure-severity"
import {
  logProviderStreamError,
  providerStreamErrorFields,
  runAgentStream,
} from "~/modules/agent/runtime/agent-service"

const URL_ = "https://openrouter.ai/api/v1/chat/completions"

// The production shape, built the way @ai-sdk/provider-utils raises it: the turn's
// own deadline aborted the body read (`abortController.abort("timeout")`, so the
// read rejected with the string "timeout"), and postToApi wrapped it as
// "Failed to process successful response" with the response's status, 200. No
// isRetryable is passed, so the SDK computes it from the status: false.
function timeoutError(): APICallError {
  return new APICallError({
    message: "Failed to process successful response",
    cause: "timeout",
    statusCode: 200,
    url: URL_,
    responseHeaders: { "content-type": "text/event-stream" },
    requestBodyValues: { model: "x", messages: [{ role: "user", content: "secret question" }] },
  })
}

function statusError(statusCode: number, message: string): APICallError {
  return new APICallError({
    message,
    url: URL_,
    requestBodyValues: { model: "x" },
    statusCode,
    responseHeaders: {},
    responseBody: "{}",
  })
}

// How the AI SDK's retry wrapper gives up (ai/dist createRetryError).
function retryError(
  reason: "maxRetriesExceeded" | "errorNotRetryable",
  errors: unknown[],
): RetryError {
  const last = errors[errors.length - 1] as { message?: string } | undefined
  return new RetryError({
    message: `Failed after ${errors.length} attempts. Last error: ${last?.message ?? ""}`,
    reason,
    errors,
  })
}

function failingModel(error: unknown) {
  return new MockLanguageModelV4({
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4.1-flash",
    doStream: async () => {
      throw error
    },
  })
}

function fakeLogger() {
  const warn: Array<[Record<string, unknown>, string]> = []
  const error: Array<[Record<string, unknown>, string]> = []
  return {
    warn,
    error,
    logger: {
      warn: (o: object, m: string) => warn.push([o as Record<string, unknown>, m]),
      error: (o: object, m: string) => error.push([o as Record<string, unknown>, m]),
    },
  }
}

let consoleError: ReturnType<typeof spyOn> | undefined
afterEach(() => consoleError?.mockRestore())

describe("agent stream onError", () => {
  it("the stream reports the error to the turn and nothing is printed raw", async () => {
    consoleError = spyOn(console, "error").mockImplementation(() => {})
    const result = runAgentStream({
      model: failingModel(timeoutError()),
      stepTokenCap: null,
      system: "sys",
      messages: [{ role: "user", content: "hello" }],
      tools: {},
      stopWhen: stepCountIs(1),
      maxRetries: 0,
    })
    const errors: unknown[] = []
    for await (const part of result.fullStream) {
      if (part.type === "error") errors.push(part.error)
    }
    // The turn still sees the failure (it ends with its visible error notice).
    expect(errors.length).toBe(1)
    expect(APICallError.isInstance(errors[0])).toBe(true)
    // And the AI SDK default print (console.error of the whole object) is gone.
    expect(consoleError.mock.calls.length).toBe(0)
  })

  it("the production timeout shape is a 200, not retryable by the SDK's own rule", () => {
    const e = timeoutError()
    expect(e.statusCode).toBe(200)
    expect(e.isRetryable).toBe(false)
  })

  it("logs one structured line: provider, model, error name, status, retryable", () => {
    const { warn, error, logger } = fakeLogger()
    logProviderStreamError(timeoutError(), failingModel(null), logger)
    expect(error).toEqual([])
    expect(warn.length).toBe(1)
    const [fields, msg] = warn[0]!
    expect(msg).toBe("Agent stream error")
    expect(fields).toMatchObject({
      provider: "openrouter",
      modelId: "deepseek/deepseek-v4.1-flash",
      errorName: "AI_APICallError",
      message: "Failed to process successful response",
      statusCode: 200,
      retryable: false,
      cause: "timeout",
      host: "openrouter.ai",
      reason: "upstream_unavailable",
    })
    // One line: nothing multi-line, no request body.
    const line = JSON.stringify(fields)
    expect(line).not.toContain("\\n")
    expect(line).not.toContain("secret question")
  })

  it("a provider refusing a malformed request (not retryable) is ours to fix: error", () => {
    const { warn, error, logger } = fakeLogger()
    const bad = statusError(400, "Invalid request: tools[3].name")
    logProviderStreamError(bad, failingModel(null), logger)
    expect(warn).toEqual([])
    expect(error.length).toBe(1)
    expect(error[0]![0]).toMatchObject({ statusCode: 400, retryable: false })
  })

  it("a 2xx whose body failed to arrive (not a timeout) is upstream_unavailable", () => {
    const { warn, error, logger } = fakeLogger()
    const broken = new APICallError({
      message: "Failed to process successful response",
      cause: new TypeError("terminated"),
      statusCode: 200,
      url: URL_,
      requestBodyValues: {},
    })
    logProviderStreamError(broken, failingModel(null), logger)
    expect(error).toEqual([])
    expect(warn[0]![0]).toMatchObject({ reason: "upstream_unavailable", statusCode: 200 })
  })

  it("a socket timeout under a non-2xx status is still upstream_unavailable", () => {
    const { warn, logger } = fakeLogger()
    const e = new APICallError({
      message: "Cannot connect to API: Connect Timeout Error",
      cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
      url: URL_,
      requestBodyValues: {},
      isRetryable: true,
    })
    logProviderStreamError(e, failingModel(null), logger)
    expect(warn[0]![0]).toMatchObject({ reason: "upstream_unavailable" })
  })

  it("a RetryError (every retry spent) reads the status of its last error", () => {
    const { warn, error, logger } = fakeLogger()
    const e = retryError("maxRetriesExceeded", [
      statusError(503, "Service Unavailable"),
      statusError(503, "Service Unavailable"),
      statusError(503, "Service Unavailable"),
    ])
    expect((e as { isRetryable?: unknown }).isRetryable).toBeUndefined()
    logProviderStreamError(e, failingModel(null), logger)
    expect(error).toEqual([])
    expect(warn[0]![0]).toMatchObject({
      errorName: "AI_RetryError",
      lastErrorName: "AI_APICallError",
      retryReason: "maxRetriesExceeded",
      attempts: 3,
      statusCode: 503,
      retryable: true,
      host: "openrouter.ai",
      reason: "upstream_unavailable",
    })
  })

  it("a RetryError ending on a 429 is rate_limited; on our malformed request, error", () => {
    const limited = fakeLogger()
    logProviderStreamError(
      retryError("maxRetriesExceeded", [statusError(429, "Too Many Requests")]),
      failingModel(null),
      limited.logger,
    )
    expect(limited.warn[0]![0]).toMatchObject({ reason: "rate_limited", statusCode: 429 })

    const refused = fakeLogger()
    logProviderStreamError(
      retryError("errorNotRetryable", [
        statusError(503, "Service Unavailable"),
        statusError(400, "Invalid request: messages[2]"),
      ]),
      failingModel(null),
      refused.logger,
    )
    expect(refused.warn).toEqual([])
    expect(refused.error[0]![0]).toMatchObject({ statusCode: 400, retryable: false })
  })

  it("a caller that went away is a warn with its reason", () => {
    const { warn, logger } = fakeLogger()
    logProviderStreamError(sandboxCancelledError(), failingModel(null), logger)
    expect(warn[0]![0]).toMatchObject({ reason: "caller_cancelled" })
  })

  it("an abort that does not say why is a warn, not claimed as the caller's", () => {
    const { warn, logger } = fakeLogger()
    logProviderStreamError(new DOMException("aborted", "AbortError"), failingModel(null), logger)
    expect(warn[0]![0]).toMatchObject({ reason: "aborted", errorName: "AbortError" })
  })

  it("a plain string model id is kept", () => {
    expect(providerStreamErrorFields(new Error("x"), "some-model")).toMatchObject({
      modelId: "some-model",
      errorName: "Error",
      message: "x",
    })
  })
})
