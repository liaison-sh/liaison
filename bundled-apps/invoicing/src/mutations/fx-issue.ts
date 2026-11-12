// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The one place an issuing mutation fetches an ECB rate: just before `issueDocument`, which only
// reads the cache. The fetch happens once per currency and day (`warmFxRate` stops at a cached
// rate of that day), so every other document issued that day reuses it.
import {
  type FxFetchCtx,
  FxRateUnavailableError,
  fxIssueDate,
  fxRateUnavailableEnvelope,
  warmFxRate,
} from "../einvoicing/fx"
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
): Promise<{ ok: true; result: IssueResult } | { ok: false; error: ErrorEnvelope }> {
  await warmFxRate(
    ctx as MutationsCtx & FxFetchCtx,
    input.draft.currency,
    fxIssueDate(input.draft.issued_at),
  )
  try {
    return { ok: true, result: await issueDocument(ctx, input) }
  } catch (err) {
    if (err instanceof FxRateUnavailableError)
      return { ok: false, error: fxRateUnavailableEnvelope(err) }
    throw err
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
    throw err
  }
}
