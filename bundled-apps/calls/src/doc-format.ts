// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Per-call knowledge-document format — the connector's ONLY persistence
// surface (spec §2 "no custom entity model": zero tables, all state in the
// document body). The body is machine-parseable by construction:
//
//   ## Liens
//
//   <!-- links {"contactId":"contact-123","dealTaskId":"task-456"} -->
//
//   ## Résumé
//
//   <!-- resume {"ts":"2026-07-06T10:10:00.000Z","final":false} -->
//   <rolling or final summary text — replaced WHOLESALE on each delivery>
//
//   ## Transcription
//
//   <!-- seg {"id":"s1","ts":"2026-07-06T10:00:00.000Z","speaker":"Alice"} -->
//   <segment text — may span lines, until the next marker>
//
// The `## Liens` block (metadata linking the doc to a contact and a deal
// task) is a self-contained marker with no trailing text — it is
// written by the calls_set_links tool (agent-facing, not the webhook) and
// replaced WHOLESALE on each write, same convention as the résumé section.
// Its absence (CallDoc.links === null) means no link has been recorded yet —
// readers report that plainly rather than inferring one.
//
// Marker fields are JSON (speaker names with accents/quotes survive); the
// envelope schema already rejects `-->` and newlines inside marker fields so a
// marker line can never be truncated. Segment ordering is BY `ts` (ties broken
// by segmentId) — an out-of-order arrival re-sorts on the same
// read-modify-write. Dedup identity is the `segmentId` marker: parse → check →
// insert happens inside the caller's revision-retry loop, so knowledge's
// optimistic-concurrency revision (service.ts REVISION_CONFLICT) is the
// serialization point that makes it race-safe.
//
// parse(render(doc)) === doc is the load-bearing property — the read tools
// (`calls_segments_since`) parse exactly what the webhook rendered.

export interface CallSegment {
  segmentId: string
  ts: Date
  speaker: string
  text: string
}

export interface CallSummary {
  ts: Date
  text: string
  isFinal: boolean
}

/** Metadata linking the doc to a contact and a deal task: a wholesale-replaced
 *  links block, same convention family as the résumé section. Either field may be null (linked to a contact before any
 *  deal task exists, or vice versa). Absence of the whole block (no links
 *  write has ever happened) is represented by `CallDoc.links === null`, never
 *  by inventing empty-string ids — the connector reports "no links" plainly
 *  rather than fabricating one. */
export interface CallLinks {
  contactId: string | null
  dealTaskId: string | null
}

export interface CallDoc {
  summary: CallSummary | null
  segments: CallSegment[]
  links: CallLinks | null
}

const SUMMARY_HEADING = "## Résumé"
const LINKS_HEADING = "## Liens"
const TRANSCRIPT_HEADING = "## Transcription"
const SEG_MARKER = /^<!-- seg (\{.*\}) -->$/
const RESUME_MARKER = /^<!-- resume (\{.*\}) -->$/
const LINKS_MARKER = /^<!-- links (\{.*\}) -->$/

/** Deterministic per-call document title — the callRef→doc identity the
 *  webhook resolves by (knowledge_create's exact-title upsert guard makes a
 *  same-title org create return the existing doc instead of duplicating). */
export function callTitleFor(callRef: string): string {
  return `${CALL_TITLE_PREFIX}${callRef}`
}

export const CALL_TITLE_PREFIX = "Appel : "
/** Title prefix of call documents created before the title lost its dash
 *  punctuation. Deployments still hold documents under it, so it is accepted on
 *  every READ and lookup, never used to create. */
// copy-lint: exempt legacy stored document-title prefix, matched literally against existing titles
export const LEGACY_CALL_TITLE_PREFIX = "Appel \u2014 "

/** Every title an existing call document may carry, current first then
 *  legacy. Every callRef -> document lookup walks this list, so a call already
 *  stored under the legacy title is found instead of duplicated. */
export function callTitleCandidates(callRef: string): string[] {
  return [callTitleFor(callRef), `${LEGACY_CALL_TITLE_PREFIX}${callRef}`]
}

export function emptyCallDoc(): CallDoc {
  return { summary: null, segments: [], links: null }
}

/** Insert a segment in ts order (ties by segmentId). No-op when the
 *  segmentId is already present — `inserted:false` tells the caller to skip
 *  the knowledge update entirely. */
export function applySegment(
  doc: CallDoc,
  seg: CallSegment,
): { doc: CallDoc; inserted: boolean } {
  if (doc.segments.some((s) => s.segmentId === seg.segmentId)) {
    return { doc, inserted: false }
  }
  const segments = [...doc.segments, seg].sort(
    (a, b) => a.ts.getTime() - b.ts.getTime() || (a.segmentId < b.segmentId ? -1 : 1),
  )
  return { doc: { ...doc, segments }, inserted: true }
}

/** Replace the summary section wholesale (rolling and final deliveries both
 *  overwrite — never append). */
export function applySummary(doc: CallDoc, summary: CallSummary): CallDoc {
  return { ...doc, summary }
}

/** Replace the links block wholesale: a repeat
 *  write REPLACES, never merges/accumulates, matching the résumé section's
 *  own wholesale-replace convention. The writer (calls_set_links tool) reads
 *  the current links first and passes forward any field it does not intend
 *  to change, so a partial update never silently drops the other link. */
export function applyLinks(doc: CallDoc, links: CallLinks): CallDoc {
  return { ...doc, links }
}

/** Segments STRICTLY after `since` (document boundary semantics: pass the
 *  previous read's `lastSegmentTs` back to get only what's new). */
export function segmentsSince(doc: CallDoc, since: Date | undefined): CallSegment[] {
  if (!since) return doc.segments
  return doc.segments.filter((s) => s.ts.getTime() > since.getTime())
}

/** A text line that would parse as one of OUR marker lines gets a leading
 *  space on render (parser matches line-start only) — transcript text can
 *  never inject a phantom segment or summary. */
function neutralizeMarkerLines(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      SEG_MARKER.test(line) || RESUME_MARKER.test(line) || LINKS_MARKER.test(line) ? ` ${line}` : line,
    )
    .join("\n")
}

export function renderCallDoc(doc: CallDoc): string {
  const lines: string[] = []
  if (doc.links) {
    lines.push(LINKS_HEADING, "")
    lines.push(
      `<!-- links ${JSON.stringify({ contactId: doc.links.contactId, dealTaskId: doc.links.dealTaskId })} -->`,
      "",
    )
  }
  lines.push(SUMMARY_HEADING, "")
  if (doc.summary) {
    lines.push(
      `<!-- resume ${JSON.stringify({ ts: doc.summary.ts.toISOString(), final: doc.summary.isFinal })} -->`,
    )
    lines.push(neutralizeMarkerLines(doc.summary.text), "")
  } else {
    lines.push("_(en attente)_", "")
  }
  lines.push(TRANSCRIPT_HEADING, "")
  for (const seg of doc.segments) {
    lines.push(
      `<!-- seg ${JSON.stringify({ id: seg.segmentId, ts: seg.ts.toISOString(), speaker: seg.speaker })} -->`,
    )
    lines.push(neutralizeMarkerLines(seg.text), "")
  }
  return lines.join("\n")
}

/** Parse a rendered body back into segments + summary. Tolerant of an empty
 *  or foreign body (returns an empty doc) — the webhook's first update starts
 *  from whatever the just-created document holds. */
export function parseCallDoc(body: string): CallDoc {
  const doc = emptyCallDoc()
  if (!body) return doc

  type Pending =
    | { kind: "seg"; meta: { id: string; ts: string; speaker: string }; lines: string[] }
    | { kind: "resume"; meta: { ts: string; final: boolean }; lines: string[] }
  let pending: Pending | null = null

  const flush = () => {
    if (!pending) return
    const text = pending.lines.join("\n").trim()
    if (pending.kind === "seg") {
      const ts = new Date(pending.meta.ts)
      if (pending.meta.id && !Number.isNaN(ts.getTime())) {
        doc.segments.push({
          segmentId: pending.meta.id,
          ts,
          speaker: pending.meta.speaker ?? "",
          text,
        })
      }
    } else {
      const ts = new Date(pending.meta.ts)
      if (!Number.isNaN(ts.getTime())) {
        doc.summary = { ts, text, isFinal: pending.meta.final === true }
      }
    }
    pending = null
  }

  for (const line of body.split("\n")) {
    const links = line.match(LINKS_MARKER)
    if (links) {
      // Self-contained marker — no trailing text block (unlike seg/resume),
      // so it does not go through the pending/flush accumulator.
      try {
        const meta = JSON.parse(links[1]!) as { contactId?: unknown; dealTaskId?: unknown }
        doc.links = {
          contactId: typeof meta.contactId === "string" ? meta.contactId : null,
          dealTaskId: typeof meta.dealTaskId === "string" ? meta.dealTaskId : null,
        }
      } catch {
        // malformed marker — leave doc.links as-is (never fabricate a link)
      }
      continue
    }
    const seg = line.match(SEG_MARKER)
    const resume = line.match(RESUME_MARKER)
    if (seg || resume) {
      flush()
      try {
        pending = seg
          ? { kind: "seg", meta: JSON.parse(seg[1]!), lines: [] }
          : { kind: "resume", meta: JSON.parse(resume![1]!), lines: [] }
      } catch {
        pending = null // malformed marker — skip its block
      }
      continue
    }
    if (line.startsWith("## ")) {
      flush()
      continue
    }
    if (pending) pending.lines.push(line)
  }
  flush()

  doc.segments.sort(
    (a, b) => a.ts.getTime() - b.ts.getTime() || (a.segmentId < b.segmentId ? -1 : 1),
  )
  return doc
}
