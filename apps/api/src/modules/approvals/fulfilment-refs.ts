// SPDX-License-Identifier: FSL-1.1-ALv2
//
// @ref tokens inside a SEALED mail draft. A sequenced step's @ref tokens are
// resolved by the cascade against the stored payload (cascade.ts), but a draft
// from an end-to-end encrypted mailbox is ciphertext there: a token the agent
// wrote into the body ("the proforma is number @ref:<step 1>:number") only
// becomes visible when the owner's browser hands the decrypted draft over with
// the approval. It is resolved HERE, in memory, against the decided results of
// the earlier steps of the same sequence, before the claim, and never stored.
//
// Fails closed: a token naming a request outside this sequence, or a step with
// no result, refuses the approval instead of sending the literal token.

import { findRefTokens, resolveRefTokens } from "@liaison/shared"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { MailboxFulfilment } from "~/modules/approvals/mailbox-fulfilment"
import { readDecidedResult } from "~/modules/approvals/read-decided-result"

const K = drizzleSql.raw(schemaRef("kernel"))

export class FulfilmentRefError extends Error {
  readonly code = "unresolvable_ref"
}

/** The fulfilment with its draft's @ref tokens filled in (unchanged when it has none). */
export async function resolveFulfilmentDraftRefs(args: {
  orgId: string
  approvalId: string
  bundleId: string | null
  fulfilment: MailboxFulfilment
}): Promise<MailboxFulfilment> {
  const draft = args.fulfilment.draft
  if (!draft) return args.fulfilment
  const ids = [...new Set(findRefTokens(draft).map((r) => r.approvalId))]
  if (ids.length === 0) return args.fulfilment
  if (!args.bundleId) {
    throw new FulfilmentRefError(
      "this draft refers to another request's result, but it is not part of a sequence",
    )
  }
  // Only the steps of THIS sequence, already approved, may fill a token: the
  // owner's browser must not be able to pull any other request's result into
  // an email.
  const allowed = await withPrivilegedDb(args.orgId, "fulfilment-ref-sources", async (tx) =>
    extractRows<{ id: string }>(
      await tx.execute(drizzleSql`
        SELECT id::text AS id FROM ${K}.approval_requests
        WHERE org_id = ${args.orgId}::uuid AND bundle_id = ${args.bundleId}
          AND id <> ${args.approvalId} AND status = 'approved'
          AND id IN (${drizzleSql.join(
            ids.map((id) => drizzleSql`${id}::uuid`),
            drizzleSql`, `,
          )})`),
    ),
  )
  const allowedIds = new Set(allowed.map((r) => r.id.toLowerCase()))
  const results: Record<string, Record<string, unknown>> = {}
  for (const id of ids) {
    if (!allowedIds.has(id)) {
      throw new FulfilmentRefError(
        `this draft refers to request ${id}, which is not an approved earlier step of this sequence`,
      )
    }
    const result = await readDecidedResult(args.orgId, id)
    if (result == null || typeof result !== "object") {
      throw new FulfilmentRefError(
        `the step this draft refers to (${id}) produced no result to fill in its @ref tokens`,
      )
    }
    results[id] = result as Record<string, unknown>
  }
  let resolved: unknown
  try {
    resolved = resolveRefTokens(draft, results)
  } catch (err) {
    throw new FulfilmentRefError(err instanceof Error ? err.message : String(err))
  }
  // A whole-field token resolves to the raw value (a number); the draft is text.
  const filled: NonNullable<MailboxFulfilment["draft"]> = {}
  for (const [key, value] of Object.entries(resolved as Record<string, unknown>)) {
    filled[key as keyof typeof filled] = typeof value === "string" ? value : String(value)
  }
  return { ...args.fulfilment, draft: filled }
}
