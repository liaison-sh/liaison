// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `finalize` tool injection for structured-output sub-runs.
//
// When a sub-agent run carries an `outputSchema`, the worker injects a single
// virtual tool named `finalize` into the model's tool set. The model is
// expected to call `finalize(payload)` exactly once with a value that matches
// the schema. The worker intercepts these calls in `onStepFinish` rather than
// letting them run through `executeWrapper` — finalize doesn't talk to apps,
// it's the terminator for the run loop.
//
// `validateFinalizePayload` is exported separately so the worker can run
// validation against retries without bouncing through the AI SDK seam.

import { tool } from "ai"
import Ajv, { type Options, type ValidateFunction } from "ajv"
import { withFormats } from "~/lib/ajv-formats"
import { manifestAjvRegExp } from "~/lib/manifest-regex"
import { jsonSchemaToZod } from "~/modules/mcp-client/json-schema-to-zod"

const AJV_OPTIONS: Options = { allErrors: true }
// Checks a schema against the meta-schema as data, so it keeps no reference to
// it. Each schema then compiles on its own Ajv (the param-validator.ts pattern):
// a shared instance would hold every schema it ever compiled, and output
// schemas are written by the model, so their number has no bound.
const metaSchemaAjv = withFormats(new Ajv(AJV_OPTIONS))
// Cache compiled validators by a stable JSON hash of the schema. A previous
// implementation keyed on the schema object's identity via WeakMap, which
// never hit because Drizzle returns a freshly-allocated jsonb object on every
// SELECT — every sub-run recompiled the schema for nothing. Hash-keying lets
// us amortize the compile across the (org-wide) population of identical
// output_schema values an app declares. Least recently used entries go past
// VALIDATOR_CACHE_MAX.
const VALIDATOR_CACHE_MAX = 256
const validatorCache = new Map<string, ValidateFunction>()

/** Test seam: the number of cached validators. */
export function _validatorCacheSize(): number {
  return validatorCache.size
}

function schemaKey(schema: Record<string, unknown>): string {
  try {
    return JSON.stringify(schema)
  } catch {
    // Cyclic / unstringifiable: skip caching, key on a sentinel so the
    // compile happens but the cache stays small.
    return "__unstringifiable__"
  }
}

function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = schemaKey(schema)
  const hit = validatorCache.get(key)
  if (hit) {
    // Re-insert so the Map's insertion order is the recency order.
    validatorCache.delete(key)
    validatorCache.set(key, hit)
    return hit
  }
  metaSchemaAjv.validateSchema(schema, true)
  // The model writes this schema, so its `pattern` / `patternProperties` keys
  // compile through the same linear-time guard as app manifest patterns: a
  // backtracking-prone or over-long one fails the compile instead of running
  // on the event loop.
  const v = withFormats(
    new Ajv({ ...AJV_OPTIONS, validateSchema: false, code: { regExp: manifestAjvRegExp } }),
  ).compile(schema)
  if (key !== "__unstringifiable__") {
    validatorCache.set(key, v)
    if (validatorCache.size > VALIDATOR_CACHE_MAX) {
      const oldest = validatorCache.keys().next().value
      if (oldest !== undefined) validatorCache.delete(oldest)
    }
  }
  return v
}

/**
 * Compiles an output schema without validating anything, so a spawn can refuse
 * a schema that is invalid or carries an unsafe pattern before the sub-run starts.
 * Throws Ajv's error or {@link UnsafeManifestPatternError}.
 */
export function assertOutputSchemaCompiles(schema: Record<string, unknown>): void {
  compile(schema)
}

export type FinalizeValidationResult = { ok: true } | { ok: false; error: string }

export function validateFinalizePayload(
  payload: unknown,
  schema: Record<string, unknown>,
): FinalizeValidationResult {
  const v = compile(schema)
  const ok = v(payload)
  if (ok) return { ok: true }
  const msg = (v.errors ?? [])
    .map((e) => {
      const path = e.instancePath || "(root)"
      const keyword = e.keyword
      // Surface the failing property in the message text — for required-field
      // errors AJV reports the path of the containing object and puts the
      // missing field in `params.missingProperty`. Build the message so the
      // failing field name always appears at least once.
      const missing = (e.params as { missingProperty?: string } | undefined)?.missingProperty
      const subject = missing ? `${path}/${missing}` : path
      return `${subject} ${e.message ?? "invalid"} [${keyword}]`
    })
    .join("; ")
  return { ok: false, error: msg || "Payload failed schema validation" }
}

/**
 * Inject the `finalize` virtual tool into a tool set. The tool's schema mirrors
 * the run's `outputSchema` so the model gets type-checked input from the SDK
 * side as well; the authoritative check happens in `validateFinalizePayload`
 * because Ajv reports richer errors than the AI SDK Zod conversion.
 */
export function injectFinalizeTool(
  tools: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const inputSchema = jsonSchemaToZod(outputSchema)
  const finalize = tool({
    description:
      "Terminate this sub-run by returning a structured payload matching the schema below. " +
      "This is the ONLY way to end your turn successfully — free-form text endings are rejected.",
    inputSchema,
    execute: async (input: unknown) => ({ accepted: true, payload: input }),
  })
  return { ...tools, finalize }
}
