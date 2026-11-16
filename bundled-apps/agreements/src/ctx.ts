// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The context every agreements handler receives: the generic CRUD bridge, who the run
// acts for, the turn (which agent acts, if any), and the approval it runs under.

import type { DbClient, KernelCaller } from "@liaison/app-sdk"

export interface ApprovalRequest {
  tool_name: string
  summary: string
  summary_detail?: { subtitle?: string; lines?: string[] }
  current_payload: unknown
  editable_fields: string[]
  noAutoApprove?: boolean
}

export interface AgreementsCtx {
  orgId: string
  userId: string
  db: DbClient
  kernel?: { caller(scopes?: string[]): Promise<KernelCaller> }
  turn?: { get(): Promise<unknown> }
  /** Set when the call runs under a decided approval. */
  approval?: unknown
  requestApproval?: (req: ApprovalRequest) => Promise<{
    approval_id: string
    auto_approved?: boolean
  }>
  /** Today's date in the org (YYYY-MM-DD); tests pass one, the host's clock otherwise. */
  today?: string
}

export interface ErrorEnvelope {
  status: "error"
  error: { code: string; message: string }
}

export const refusal = (code: string, message: string): ErrorEnvelope => ({
  status: "error",
  error: { code, message },
})

/** The agent acting in this turn, null for a person's own call; "unknown" when it cannot be read. */
export async function actingAgentId(ctx: AgreementsCtx): Promise<string | null> {
  if (!ctx.turn) return null
  try {
    const raw: unknown = await ctx.turn.get()
    const t = (typeof raw === "string" ? JSON.parse(raw) : raw) as { agentId?: string | null }
    return t?.agentId ?? null
  } catch {
    return "unknown"
  }
}

/** The person the run acts for, or null (system work). */
export async function callerUserId(ctx: AgreementsCtx): Promise<string | null> {
  if (ctx.kernel) {
    const c = await ctx.kernel.caller()
    return c.kind === "person" ? c.userId : null
  }
  return ctx.userId || null
}

export function todayOf(ctx: AgreementsCtx): string {
  return ctx.today ?? new Date().toISOString().slice(0, 10)
}
