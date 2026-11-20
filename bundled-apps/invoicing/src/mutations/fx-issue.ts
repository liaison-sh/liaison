// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one place an issuing mutation fetches an ECB rate: just before `issueDocument`, which only
// reads the cache. The fetch happens once per currency and day (`warmFxRate` stops at a cached
// rate of that day), so every other document issued that day reuses it.
import { batchPreconditionFailure } from "@liaison/app-sdk"
import {
  type FxFetchCtx,
  FxRateUnavailableError,
  fxIssueDate,
  fxRateUnavailableEnvelope,
  warmFxRate,
} from "../einvoicing/fx"
import { SellerIncompleteRefusal } from "../einvoicing/seller"
import { issueDocument, issueTogether } from "../issue"
import type { ErrorEnvelope, MutationsCtx } from "./shared"

type IssueInput = Parameters<typeof issueDocument>[1]
type IssueResult = Awaited<ReturnType<typeof issueDocument>>

/**
 * Warm the document's rate, then issue it. A foreign-currency e-invoice the ECB could not price
 * comes back as the typed, retryable `fx_rate_unavailable` error, with nothing persisted and no
 * number used; any other failure is rethrown as is.
 */
export async function issueWithFxRate(
  ctx: MutationsCtx,
  input: IssueInput,
  opts: Parameters<typeof issueDocument>[2] = {},
): Promise<{ ok: true; result: IssueResult } | { ok: false; error: ErrorEnvelope }> {
  await warmFxRate(
    ctx as MutationsCtx & FxFetchCtx,
    input.draft.currency,
    fxIssueDate(input.draft.issued_at),
  )
  try {
    return { ok: true, result: await issueDocument(ctx, input, opts) }
  } catch (err) {
    if (err instanceof FxRateUnavailableError)
      return { ok: false, error: fxRateUnavailableEnvelope(err) }
    if (err instanceof SellerIncompleteRefusal)
      return { ok: false, error: { status: "error", error: err.error } }
    const gone = draftGoneEnvelope(err, input)
    if (gone) return { ok: false, error: gone }
    throw err
  }
}

/**
 * The issue commit requires the draft it replaces to still exist (`handOverDraft`): a draft
 * discarded or issued by someone else after the checks fails the commit, nothing persisted.
 */
function draftGoneEnvelope(err: unknown, input: IssueInput): ErrorEnvelope | null {
  const failed = batchPreconditionFailure(err)
  if (!failed || failed.entity !== "documents" || failed.matched !== 0) return null
  // The draft is the one row the hand-over deletes.
  const draftId = (input.commit_with ?? []).find(
    (op): op is { delete: string; id: string } =>
      "delete" in op && op.delete === "documents" && typeof op.id === "string",
  )?.id
  const named = typeof draftId === "string" && draftId !== "" ? `Draft ${draftId}` : "The draft"
  return {
    status: "error",
    error: {
      code: "not_found",
      message: `${named} was discarded or issued elsewhere while this issue ran. Nothing was issued and no invoice number was used. Look for its invoice with documents_search before issuing again.`,
    },
  }
}

/**
 * Warm each document's rate, then issue them all in one commit (`issueTogether`): a rate the ECB
 * could not price refuses them all, with nothing persisted and no number used.
 */
export async function issueTogetherWithFxRate<N extends string>(
  ctx: MutationsCtx,
  inputs: ReadonlyArray<readonly [N, IssueInput]>,
): Promise<{ ok: true; results: Record<N, IssueResult> } | { ok: false; error: ErrorEnvelope }> {
  for (const [, input] of inputs) {
    await warmFxRate(
      ctx as MutationsCtx & FxFetchCtx,
      input.draft.currency,
      fxIssueDate(input.draft.issued_at),
    )
  }
  try {
    return { ok: true, results: await issueTogether(ctx, inputs) }
  } catch (err) {
    if (err instanceof FxRateUnavailableError)
      return { ok: false, error: fxRateUnavailableEnvelope(err) }
    if (err instanceof SellerIncompleteRefusal)
      return { ok: false, error: { status: "error", error: err.error } }
    throw err
  }
}
