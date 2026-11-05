// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHERE AN @ref TOKEN COMES FROM, IN WORDS.
//
// A sequenced step's arguments cite earlier steps' outputs with
// `@ref:<approval id>:<key>` tokens, resolved only when those steps run. Its
// summarizer saw the literal tokens, so its title and lines carry them. The
// person deciding the bundle reads each one as the earlier step it comes from
// ("the quote PDF from step 2", "[CRM record from step 1]"), never as a uuid
// nor as a bare key.
import {
  type ApprovalSummary,
  findRefTokens,
  humanizeRefTokens,
  type RefSource,
  type RefSourceLookup,
} from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
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
 * tool and their arguments. Only the requester's own requests in this org are
 * read (they are the only ones a token may cite). A source not yet in a bundle
 * becomes its head when this step is staged, so it reads as step 1.
 */
export async function loadRefSources(
  orgId: string,
  requestedBy: string,
  payload: unknown,
): Promise<RefSourceLookup> {
  const ids = [...new Set(findRefTokens(payload).map((r) => r.approvalId))]
  if (ids.length === 0) return () => undefined
  try {
    const rows = await withPrivilegedDb(orgId, "approval-ref-sources", async (tx) =>
      extractRows<{
        id: string
        tool_name: string
        bundle_id: string | null
        bundle_position: number | null
        current_payload: Record<string, unknown> | null
      }>(
        await tx.execute(drizzleSql`
          SELECT id, tool_name, bundle_id, bundle_position, current_payload
          FROM ${K}.approval_requests
          WHERE org_id = ${orgId}::uuid AND requested_by = ${requestedBy}
            AND id IN (${drizzleSql.join(
              ids.map((id) => drizzleSql`${id}::uuid`),
              drizzleSql`, `,
            )})`),
      ),
    )
    const byId = new Map<string, RefSource>(
      rows.map((r) => [
        r.id.toLowerCase(),
        {
          step: r.bundle_id ? Number(r.bundle_position ?? 0) + 1 : 1,
          toolName: r.tool_name,
          payload: r.current_payload,
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
