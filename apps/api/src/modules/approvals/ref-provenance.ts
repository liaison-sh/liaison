// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE AN @ref TOKEN COMES FROM, IN WORDS.
//
// A sequenced step's arguments cite earlier steps' outputs with
// `@ref:<approval id>:<key>` tokens, resolved only when those steps run. Its
// summarizer saw the literal tokens, so its title and lines carry them. The
// person deciding the bundle reads each one as the earlier step it comes from
// ("the quote PDF from step 2 (request-12, filled in when that step runs)"),
// never as a uuid nor as a bare key. A token on a step that already ran reads
// as the value that step returned, which is what the call will carry: the
// person decides on the real value, not on a stand-in for it.
import {
  type ApprovalSummary,
  findRefTokens,
  humanizeRefTokens,
  pendingRef,
  type RefSource,
  type RefSourceLookup,
  resolvedText,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type PrivilegedDb } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { appsLogger as log } from "~/lib/logger"

const K = drizzleSql.raw(schemaRef("kernel"))

/** Humanize every token in a summary's title, subtitle and lines. */
export function humanizeSummaryRefs(
  summary: ApprovalSummary,
  sources?: RefSourceLookup,
): ApprovalSummary {
  return {
    ...summary,
    title: humanizeRefTokens(summary.title, sources),
    ...(typeof summary.subtitle === "string"
      ? { subtitle: humanizeRefTokens(summary.subtitle, sources) }
      : {}),
    lines: summary.lines.map((l) => humanizeRefTokens(l, sources)),
  }
}

/**
 * The steps the tokens in `payload` cite: their place in the sequence, their
 * tool, their arguments, their `request-N` label and, once they ran, their
 * result. Only the requester's own requests in this org are
 * read (they are the only ones a token may cite). A source not yet in a bundle
 * becomes its head when this step is staged, so it reads as step 1.
 */
export async function loadRefSources(
  orgId: string,
  requestedBy: string,
  payload: unknown,
  /** The caller's privileged transaction, when it holds one (no nested slot). */
  on?: PrivilegedDb,
): Promise<RefSourceLookup> {
  const ids = [...new Set(findRefTokens(payload).map((r) => r.approvalId))]
  if (ids.length === 0) return () => undefined
  try {
    const read = async (tx: PrivilegedDb) =>
      extractRows<{
        id: string
        tool_name: string
        bundle_id: string | null
        bundle_position: number | null
        current_payload: Record<string, unknown> | null
        handle: string | null
        result: unknown
      }>(
        await tx.execute(drizzleSql`
          SELECT a.id, a.tool_name, a.bundle_id, a.bundle_position, a.current_payload, a.handle,
                 (SELECT e.result FROM ${K}.approved_handler_executions e
                   WHERE e.approval_request_id = a.id AND e.status = 'succeeded'
                   LIMIT 1) AS result
          FROM ${K}.approval_requests a
          WHERE a.org_id = ${orgId}::uuid AND a.requested_by = ${requestedBy}
            AND a.id IN (${drizzleSql.join(
              ids.map((id) => drizzleSql`${id}::uuid`),
              drizzleSql`, `,
            )})`),
      )
    const rows = on ? await read(on) : await withPrivilegedDb(orgId, "approval-ref-sources", read)
    const byId = new Map<string, RefSource>(
      rows.map((r) => [
        r.id.toLowerCase(),
        {
          step: r.bundle_id ? Number(r.bundle_position ?? 0) + 1 : 1,
          toolName: r.tool_name,
          payload: r.current_payload,
          handle: r.handle,
          result:
            r.result && typeof r.result === "object" && !Array.isArray(r.result)
              ? (r.result as Record<string, unknown>)
              : null,
        },
      ]),
    )
    return (id) => byId.get(id.toLowerCase())
  } catch (err) {
    // Words only: a failed lookup leaves the bare key words, never the token.
    log.warn({ err, orgId }, "approval ref sources could not be read")
    return () => undefined
  }
}

/** A sequenced step's summary with its tokens read as the steps they come from. */
export async function humanizeStepSummary(
  orgId: string,
  requestedBy: string,
  payload: unknown,
  summary: ApprovalSummary,
): Promise<ApprovalSummary> {
  return humanizeSummaryRefs(summary, await loadRefSources(orgId, requestedBy, payload))
}

/**
 * A step about to run, its earlier steps done: each "filled in when that step
 * runs" phrase its summary carries becomes the value that step returned, so a
 * card shown from now on (the step's record, or the owner's own decision of a
 * sealed send) reads what the call carries. `payload` is the step's payload
 * still holding its tokens; `results` the earlier steps' results by id.
 */
export async function fillStepSummaryRefs(
  orgId: string,
  requestedBy: string,
  payload: unknown,
  summary: ApprovalSummary,
  results: Record<string, Record<string, unknown>>,
  on?: PrivilegedDb,
): Promise<ApprovalSummary> {
  const sources = await loadRefSources(orgId, requestedBy, payload, on)
  const swaps: Array<[string, string]> = []
  for (const ref of findRefTokens(payload)) {
    const source = sources(ref.approvalId)
    if (!source) continue
    const value = resolvedText(ref.outputKey, {
      ...source,
      result: results[ref.approvalId.toLowerCase()] ?? null,
    })
    if (value !== undefined) swaps.push([pendingRef(ref.outputKey, source), value])
  }
  if (swaps.length === 0) return summary
  const fill = (text: string) =>
    swaps.reduce((t, [phrase, value]) => t.split(phrase).join(value), text)
  return {
    ...summary,
    title: fill(summary.title),
    ...(typeof summary.subtitle === "string" ? { subtitle: fill(summary.subtitle) } : {}),
    lines: summary.lines.map(fill),
  }
}
