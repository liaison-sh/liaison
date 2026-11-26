/**
 * The kernel's handler protocol for an approved run that commits more than once.
 *
 * A tool declaring `ownsTransactions` runs its approved execution on a session: each write is
 * its own commit, so a failure after one of them leaves it behind. The kernel cannot tell that
 * from "nothing happened" on its own, so such a tool says what happened:
 *
 *   - `started` before anything is written;
 *   - the effect, as soon as its commit returns (`landed`): a later failure then reads as done
 *     (the approval is executed, a lost follow-up is healed by its sweep), never as unknown;
 *   - `failed_no_effect` when it failed, or refused, before that commit: the approval goes back
 *     to pending with the reason, and can be approved again once fixed;
 *   - `succeeded` when it finished.
 *
 * Outside this tool's own approval (`ctx.approval` null, or another tool's approval the call runs
 * inside) nothing is recorded and `run` is called as is.
 * The handler calls `landed` right after its first commit, and commits nothing before it.
 */

export interface ApprovalProtocolCtx {
  approval: { approvalRequestId: string; approvalDeciderId: string; toolName: string } | null
  approval_recordStarted?: (toolName: string) => Promise<void>
  approval_recordEffectLanded?: (toolName: string, externalRefJson: string) => Promise<void>
  approval_recordSucceeded?: (toolName: string, externalRefJson?: string) => Promise<void>
  approval_recordFailedNoEffect?: (toolName: string, errJson: string) => Promise<void>
}

/** Records the committed effect (what was written, e.g. the document and its number). */
export type RecordLanded = (ref: Record<string, unknown>) => Promise<void>

export async function underApprovalProtocol<T>(
  ctx: ApprovalProtocolCtx,
  tool: string,
  run: (landed: RecordLanded) => Promise<T>,
): Promise<T> {
  const started = ctx.approval_recordStarted
  if (ctx.approval?.toolName !== tool || !started) return run(async () => {})
  await started(tool)
  let hasLanded = false
  const landed: RecordLanded = async (ref) => {
    if (hasLanded) return
    hasLanded = true
    await ctx.approval_recordEffectLanded?.(tool, JSON.stringify(ref))
  }
  let result: T
  try {
    result = await run(landed)
  } catch (err) {
    if (!hasLanded) {
      await ctx.approval_recordFailedNoEffect?.(tool, JSON.stringify(thrownError(err)))
    }
    throw err
  }
  const refused = softErrorOf(result)
  if (refused) {
    // Refused before its commit: nothing written. After it, the landed effect stands and the
    // kernel records the run as done from it.
    if (!hasLanded) await ctx.approval_recordFailedNoEffect?.(tool, JSON.stringify(refused))
    return result
  }
  await ctx.approval_recordSucceeded?.(tool)
  return result
}

function softErrorOf(result: unknown): { code: string; message: string } | null {
  if (!result || typeof result !== "object") return null
  const error = (result as { error?: unknown }).error
  if (typeof error === "string") return { code: "tool_error", message: error }
  if (!error || typeof error !== "object") return null
  const e = error as { code?: unknown; message?: unknown }
  return {
    code: typeof e.code === "string" ? e.code : "tool_error",
    message: typeof e.message === "string" ? e.message : "the call returned an error",
  }
}

function thrownError(err: unknown): { code: string; message: string } {
  const e = err as { code?: unknown; message?: unknown } | null
  const message = typeof e?.message === "string" ? e.message : String(err)
  return {
    code: typeof e?.code === "string" ? e.code : "handler_threw_no_effect",
    // A database error's text carries the query and its values: the card gets the plain fact.
    message: /failed query/i.test(message)
      ? "It failed on a database error and nothing was changed."
      : message.slice(0, 500),
  }
}
