// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The structured alert envelope external monitoring systems POST to the
// `alert` webhook. Kept deliberately provider-agnostic: any alert source
// (Grafana, UptimeRobot, a cron watchdog, an error tracker) maps its native
// payload onto these seven fields in its own outgoing-webhook template —
// nothing provider-specific lives in this app.
import { z } from "zod"
import { stripNul } from "./lib/values"

export const SEVERITIES = ["info", "warning", "critical"] as const
export type Severity = (typeof SEVERITIES)[number]

/** Severity rank for escalation comparisons (info < warning < critical). */
export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s)
}

/**
 * http(s) only: the url is rendered as a link in the app, so a `javascript:`
 * or `data:` value is refused at the door. A regex, not `new URL`, because the
 * handler runs inside the QuickJS sandbox.
 */
export const HTTP_URL_RE = /^https?:\/\/[^\s/?#]+[^\s]*$/i

/**
 * Free text with U+0000 removed before the length rules apply: Postgres refuses it in a text
 * column, so a NUL would turn the delivery into a SQL error the sender retries forever.
 */
const text = (schema: z.ZodString) => z.preprocess((v) => (typeof v === "string" ? stripNul(v) : v), schema)

const sourceField = text(z.string().min(1).max(200))
const severityField = z.enum(SEVERITIES)
const titleField = text(z.string().min(1).max(500))
const bodyField = text(z.string().max(10_000)).optional()
const dedupKeyField = text(z.string().min(1).max(500))
/** When the alert fired at the source — ISO-8601 string or epoch milliseconds. */
const tsField = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: "custom", message: "ts is not a parseable timestamp" })
    return z.NEVER
  }
  return d
})
/**
 * Deep link back to the alert in the source system (http or https only). An
 * empty or blank value (a sender template with no link to fill in) means no
 * url, not a bad one.
 */
const urlField = z
  .preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().max(2000).regex(HTTP_URL_RE, "url must be an http or https URL").optional(),
  )
  .optional()
/**
 * Resolve markers: `status: "resolved"` or `event: "resolve"` turns the
 * delivery into a resolve. Any other value is a sender bug (400), never an
 * alert silently ignored.
 */
const markerFields = {
  status: z.literal("resolved").optional(),
  event: z.literal("resolve").optional(),
}
const markersSchema = z.object(markerFields)

export const alertEnvelopeSchema = z.object({
  /** Which system sent the alert (e.g. "grafana-prod"). One half of the dedup identity. */
  source: sourceField,
  severity: severityField,
  title: titleField,
  body: bodyField,
  /**
   * Stable identity of the underlying condition within `source` (e.g. the
   * alert rule id). Deliveries sharing (source, dedupKey) fold into ONE
   * incident. Omit it and every delivery opens its own incident.
   */
  dedupKey: dedupKeyField.optional(),
  ts: tsField,
  url: urlField,
})

export type AlertEnvelope = z.infer<typeof alertEnvelopeSchema>

/**
 * The source clearing its own alert. `dedupKey` is required (it names the
 * incident to clear); severity and title are accepted but not needed.
 */
export const resolveEnvelopeSchema = z.object({
  source: sourceField,
  dedupKey: dedupKeyField,
  ts: tsField,
  severity: severityField.optional(),
  title: titleField.optional(),
  body: bodyField,
  url: urlField,
  ...markerFields,
})

export type ResolveEnvelope = z.infer<typeof resolveEnvelopeSchema>

export type ParsedEnvelope =
  | { kind: "alert"; alert: AlertEnvelope }
  | { kind: "resolve"; resolve: ResolveEnvelope }
  | { kind: "invalid"; detail: string }

function issues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
}

/** Classify and validate an inbound delivery: alert, resolve, or invalid (400). */
export function parseEnvelope(payload: unknown): ParsedEnvelope {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const markers = markersSchema.safeParse(payload)
    if (!markers.success) return { kind: "invalid", detail: issues(markers.error) }
    if (markers.data.status === "resolved" || markers.data.event === "resolve") {
      const r = resolveEnvelopeSchema.safeParse(payload)
      return r.success ? { kind: "resolve", resolve: r.data } : { kind: "invalid", detail: issues(r.error) }
    }
  }
  const a = alertEnvelopeSchema.safeParse(payload)
  return a.success ? { kind: "alert", alert: a.data } : { kind: "invalid", detail: issues(a.error) }
}
