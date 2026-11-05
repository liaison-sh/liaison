// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Agent-facing texts for `@ref` sequencing: the gated result's hint and every
 * refusal a model can hit while chaining calls into one approval request.
 *
 * Each message says what to do next — which tool, which field, which token
 * form — because the reader is often a small model that only retries what the
 * error tells it to (apps/api/CLAUDE.md: no generic errors).
 */
import { buildRefToken } from "@liaison/shared"

const FORM = "@ref:<approvalRequestId>:<output_key>"

/** The `hint` that rides beside `outputs` on a gated result. Uses the call's
 *  own tokens as examples so a model can paste them straight. */
export function sequencingHint(approvalRequestId: string, outputKeys: readonly string[]): string {
  const first = outputKeys[0] ?? "value"
  const example = buildRefToken(approvalRequestId, first)
  return (
    "This action is queued for human approval: it has NOT run yet, so its real values do not exist yet. " +
    "To make a later step of this same request that needs one of its values, call the next tool now and " +
    "pass the @ref token string from `outputs` exactly as given, as the value of the field that needs it, " +
    `e.g. some_id: "${example}" or a list field: ["${example}"] (inside text, write the token where the value goes). ` +
    "The later call is then added to this request and runs after this one once the person approves. " +
    "Do not wait for the approval, do not call this tool again, and never shorten, rename or invent a token."
  )
}

/** Some referenced approval ids were not found for this requester and conversation. */
export function refNotFoundMessage(missingIds: readonly string[]): string {
  const ids = missingIds.join(", ")
  return (
    `Referenced approval ${ids} not found in this conversation. A token ${FORM} can only point at a gated ` +
    "call YOU made earlier in THIS conversation or routine run: <approvalRequestId> is the uuid that call's " +
    "result returned as `approvalRequestId`, and the whole token is listed in that result's `outputs`. " +
    "Copy the token from those `outputs` exactly; never type an id yourself or reuse one from another " +
    "conversation. If no earlier gated call in this conversation returned `outputs`, make that call first, " +
    "then use the tokens it returns."
  )
}

/** The referenced approval is decided or otherwise out of the pending sequence. */
export function refNotChainableMessage(id: string, toolName: string, status: string): string {
  const head = `Referenced approval ${id} (${toolName}) is ${status} and can no longer take later steps.`
  if (status === "approved" || status === "executing") {
    return (
      `${head} It was already approved and has run (or is running), so its result is real now: do not use ` +
      "an @ref token for it. Read its actual result values (for example the id or number it produced, " +
      "shown in this conversation once it ran) and pass those values directly in your call."
    )
  }
  const why =
    status === "rejected"
      ? "A person rejected it, so nothing was created and nothing can follow it."
      : `It ended as ${status}, so it did not run and nothing can follow it.`
  return (
    `${head} ${why} Do not reference it again. If the work is still wanted, propose the whole sequence ` +
    "again as new calls, first step first, and chain the later steps with the tokens from the new first " +
    "call's `outputs`."
  )
}

/** The token's key is not one the referenced tool declares. */
export function refUnknownOutputMessage(
  id: string,
  toolName: string,
  outputKey: string,
  declared: readonly string[],
): string {
  if (declared.length === 0) {
    return (
      `Referenced approval ${id} (${toolName}) has no referenceable output "${outputKey}": ${toolName} ` +
      "declares no outputs, so a later call cannot reference its result. Make the later call without any " +
      "@ref token, with real values (as a separate request), or reference a different earlier step whose " +
      "gated result listed `outputs`."
    )
  }
  const tokens = declared.map((k) => `"${buildRefToken(id, k)}"`).join(", ")
  return (
    `Referenced approval ${id} (${toolName}) has no referenceable output "${outputKey}". Its outputs are ` +
    `${tokens}: paste the one whose value the field needs, exactly as written (lowercase key), and call again.`
  )
}

/** One call referenced more than one earlier step (or steps of different requests). */
export function refSpanMessage(ids: readonly string[]): string {
  return (
    `One call may reference only ONE earlier step: every @ref token in it must carry the same ` +
    `approvalRequestId, but this call mixes ${ids.join(", ")}. Chain in order instead: step 2 references ` +
    "step 1's `outputs`, step 3 references step 2's `outputs` (the tokens returned by step 2's own gated " +
    "result), and so on. Remove the tokens of the other step and call again."
  )
}

/** A person (not an agent) called a tool with @ref placeholders. */
export function personSequencedMessage(toolName: string): string {
  return (
    `You cannot run ${toolName} yourself with ${FORM} placeholders: they only resolve inside an agent's ` +
    "approval sequence, after the earlier step runs. Replace each @ref token with the real value (for " +
    "example the id or file the earlier step produced, once it has run) and run it again."
  )
}

// Near-miss reference forms: something that is clearly meant as a reference to
// an earlier step but is not a parseable `@ref:<uuid>:<key>` token. Passed
// through, the literal text would be written to a customer (or stored) as is.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
const VALID_AT_START = new RegExp(`^@ref:${UUID}:[a-z][a-z0-9_]*`, "i")
// `@ref:` (or `@ref(`) followed by anything up to whitespace or a closing quote/bracket. Not inside an
// address or a word (`anna@ref.io`, `x@ref:`): the token always stands on its own.
const AT_REF_CANDIDATE = /(?<![\w.+-])@ref[:(][^\s"'`,;)\]}]*/gi
// Template placeholders that name a ref, an approval, an output or a numbered step
// (`{{step1.record_id}}`, `{{approval_1.outputs.number}}`, `${ref.pdf_file_id}`).
// Plain mail-merge slots like `{{firstName}}` are not matched here.
const REF_WORDS = "(?:\\bref\\b|\\bapprovals?(?:_?\\d+)?\\b|\\boutputs?\\b|\\bstep[\\s._-]?\\d+)"
const MUSTACHE = new RegExp(`\\{\\{[^{}]*?${REF_WORDS}[^{}]*\\}\\}`, "gi")
const DOLLAR_BRACE = new RegExp(`\\$\\{[^{}]*?${REF_WORDS}[^{}]*\\}`, "gi")
// `$ref:<id>:<key>` / `$ref(...)`; a JSON-Schema `"$ref": "#/..."` is not matched.
const DOLLAR_REF = /\$ref[:(.][^\s"'`,;)\]}]+/gi

export interface MalformedRef {
  path: string
  text: string
}

function nearMissesIn(s: string): string[] {
  const out: string[] = []
  for (const m of s.matchAll(AT_REF_CANDIDATE)) {
    if (!VALID_AT_START.test(m[0])) out.push(m[0])
  }
  for (const re of [MUSTACHE, DOLLAR_BRACE, DOLLAR_REF]) {
    for (const m of s.matchAll(re)) out.push(m[0])
  }
  return out
}

/** Every string in `value` holding a near-miss reference (first one per string). */
export function findMalformedRefs(value: unknown, path = "", depth = 0): MalformedRef[] {
  if (depth > 12) return []
  if (typeof value === "string") {
    const hits = nearMissesIn(value)
    return hits.length > 0 ? [{ path: path || "(value)", text: hits[0].slice(0, 80) }] : []
  }
  const out: MalformedRef[] = []
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      out.push(...findMalformedRefs(v, path ? `${path}.${i}` : String(i), depth + 1))
    })
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.push(...findMalformedRefs(v, path ? `${path}.${k}` : k, depth + 1))
    }
  }
  return out
}

/** The refusal for a call whose params carry a near-miss reference. */
export function malformedRefMessage(toolName: string, hits: readonly MalformedRef[]): string {
  const where = hits
    .slice(0, 3)
    .map((h) => `${h.path} holds "${h.text}"`)
    .join("; ")
  return (
    `${toolName} was not run: ${where}, which is not a valid reference. A reference is exactly the string ` +
    `${FORM}, for example "@ref:3f2b6c1e-8a4d-4f0e-9b7a-2c5d8e1f0a93:pdf_file_id": the full uuid ` +
    "`approvalRequestId` of an earlier gated result in this conversation, then a lowercase key from that " +
    "result's `outputs`. Copy the token from `outputs` verbatim (no {{ }}, $ref, angle brackets or " +
    'made-up ids) and pass it as the whole value, e.g. attachments: ["@ref:<uuid>:pdf_file_id"], or inside ' +
    "text where the value goes. If no earlier gated call returned `outputs`, pass the real value instead."
  )
}
