// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The signed envelope transcript adapters POST to the `segment` webhook.
// Two shapes, discriminated by `kind`:
//
//   segment (the default — `kind` may be omitted, per the spec's literal
//   envelope `(call-ref, segment-id, ts, speaker, text)`):
//     { callRef, [kind:"segment"], segmentId, ts, speaker, text }
//
//   summary (rolling or final — computed SENDER-side by the meet-bot's own
//   model and posted alongside segments; Liaison never runs inference here):
//     { callRef, kind:"summary", ts, text, isFinal? }
//
// Kept provider-agnostic: any transcript source (a meet-bot, a post-call
// batch importer, the send-segment e2e harness) maps onto these fields.
import { z } from "zod"

/** Shared ts field — ISO-8601 string or epoch ms, parsed to a Date. */
const tsSchema = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: "custom", message: "ts is not a parseable timestamp" })
    return z.NEVER
  }
  return d
})

// Marker-field safety: segmentId and speaker are embedded in the per-segment
// HTML-comment marker line of the knowledge doc (doc-format.ts). A value
// containing `-->` would terminate the comment early and corrupt the document;
// newlines would break the one-marker-per-line parse. Reject both at the
// envelope boundary (the sender's bug — 400, not a retry).
const markerSafe = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !s.includes("-->") && !/[\r\n]/.test(s), {
      message: "must not contain '-->' or newlines (doc marker fields)",
    })

export const segmentEnvelopeSchema = z.object({
  callRef: markerSafe(200),
  kind: z.literal("segment").default("segment"),
  segmentId: markerSafe(200),
  ts: tsSchema,
  speaker: markerSafe(200),
  text: z.string().min(1).max(20_000),
})

export const summaryEnvelopeSchema = z.object({
  callRef: markerSafe(200),
  kind: z.literal("summary"),
  ts: tsSchema,
  text: z.string().min(1).max(50_000),
  isFinal: z.boolean().default(false),
})

export type SegmentEnvelope = z.infer<typeof segmentEnvelopeSchema>
export type SummaryEnvelope = z.infer<typeof summaryEnvelopeSchema>
export type CallsEnvelope = SegmentEnvelope | SummaryEnvelope

export type ParseEnvelopeResult =
  | { ok: true; envelope: CallsEnvelope }
  | { ok: false; reason: string }

/**
 * Validate a webhook payload into a typed envelope. Dispatches on
 * `payload.kind` (absent ⇒ segment) so error messages come from the ONE
 * schema the sender was aiming for, not a union blur.
 */
export function parseCallsEnvelope(payload: unknown): ParseEnvelopeResult {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "payload must be a JSON object" }
  }
  const kind = (payload as Record<string, unknown>).kind
  if (kind !== undefined && kind !== "segment" && kind !== "summary") {
    return { ok: false, reason: `unknown kind ${JSON.stringify(kind)} (expected segment|summary)` }
  }
  const schema = kind === "summary" ? summaryEnvelopeSchema : segmentEnvelopeSchema
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
    return { ok: false, reason: detail }
  }
  return { ok: true, envelope: parsed.data }
}
