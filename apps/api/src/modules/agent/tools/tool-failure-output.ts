// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The model-facing output of a FAILED tool call.
 *
 * The bridge turns every failure into a result object carrying `error` (the tool, the HTTP status,
 * the code, the reason), and the AI SDK used to send that to the model as an ordinary JSON result:
 * nothing told the model the call had failed except its own reading of the text. Walk 2026-10-19:
 * a refused create_routine whose reason talked about proposing scopes and an approval was read by
 * a small model as "an approval card is waiting", and the user was told so.
 *
 * A failure now goes out as `error-json` (providers that have a failure flag set it, such as the
 * Anthropic `is_error`) with `status: "failed"` in the value itself, for providers that only see the
 * content. The same output is used live (the bridge's `toModelOutput`) and when a stored turn is
 * replayed, so the history never turns a failure back into a plain result. Returns null for
 * anything that is not a failure: a success, and a call parked for approval.
 *
 * The failed output is the whole result plus `status: "failed"`: a structured error keeps its
 * fields (EMAIL_IN_USE carries `existingContactId`, which the model needs to update that contact
 * instead of creating a duplicate) and a partial result keeps its data.
 *
 * What counts as failed: tools signal failure with an `error` field (a string, or an object with a
 * `code` or `message`, the kernel's `{ error: { code, message } }` shape). An empty one (`""`,
 * `false`, `{}`) is not a failure, and neither is a result that says it succeeded (`ok: true` or
 * `success: true`) while reporting an informational error beside its data.
 */
import type { JSONValue } from "ai"

export type ToolFailureOutput = {
  type: "error-json"
  value: { status: "failed"; error: JSONValue; [field: string]: JSONValue }
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; code?: unknown }
    if (typeof e.message === "string" && e.message.length > 0) {
      return typeof e.code === "string" ? `${e.code}: ${e.message}` : e.message
    }
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** A tool result's `error` field that reports a real failure (see the module comment). */
function signalsFailure(error: unknown): boolean {
  if (typeof error === "string") return error.trim().length > 0
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const e = error as { code?: unknown; message?: unknown }
    return (
      (typeof e.code === "string" && e.code.length > 0) ||
      (typeof e.message === "string" && e.message.length > 0)
    )
  }
  return false
}

export function toolFailureModelOutput(
  result: unknown,
  stored?: { status?: unknown; error?: unknown },
): ToolFailureOutput | null {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const r = result as { error?: unknown; blocked?: unknown; ok?: unknown; success?: unknown }
    if (r.blocked) return null
    if (r.ok === true || r.success === true) return null
    if (!signalsFailure(r.error)) return null
    const json = toJsonValue(result) as { [field: string]: JSONValue }
    return {
      type: "error-json",
      value: { ...json, status: "failed", error: json.error ?? errorText(r.error) },
    }
  }
  // A call that produced no result at all (an SDK tool-error: unknown tool, invalid input, a
  // throw past the bridge) is stored as `status: "error"` with the reason beside it.
  if ((result === null || result === undefined) && stored?.status === "error") {
    return {
      type: "error-json",
      value: {
        status: "failed",
        error: stored.error !== undefined ? errorText(stored.error) : "the tool call failed",
      },
    }
  }
  return null
}

/** A tool's output as the plain JSON value the SDK would send (undefined dropped, Dates as strings). */
export function toJsonValue(output: unknown): JSONValue {
  if (output === undefined) return null
  try {
    return JSON.parse(JSON.stringify(output)) as JSONValue
  } catch {
    return String(output)
  }
}
