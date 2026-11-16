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
  /** The host renders a filled source to PDF bytes, its hash and its text (read-only). */
  rich_text_render?: (p: RichTextRenderParams) => Promise<unknown>
  /** The host checks an uploaded PDF in the render service; stores nothing. */
  pdf_upload_check?: (p: { fileId: string; deadlineMs?: number }) => Promise<unknown>
  /** The host scans a frozen uploaded version's file again; answers the scan's state. */
  pdf_upload_rescan?: (p: { versionId: string }) => Promise<unknown>
  /** The host stores an uploaded PDF, untouched, and its page pictures on a version. */
  pdf_upload_freeze?: (p: {
    fileId: string
    versionId: string
    sha256: string
    pagesSha256: string
    filename: string
  }) => Promise<unknown>
  /** Copies a file the caller can read onto one of this app's rows; answers the copy. */
  files_attachToParent?: (p: {
    sourceFileId: string
    targetApp: string
    targetEntityType: string
    targetEntityId: string
  }) => Promise<unknown>
  /** Stores bytes as a file of one of this app's rows. */
  files_importAttachment?: (p: {
    targetApp: string
    targetEntityType: string
    targetEntityId: string
    filename: string
    mimeType: string
    bytesBase64: string
  }) => Promise<unknown>
  /** Client action links: mint a send's links, or the next signer's turn. */
  client_actions_mint?: (p: unknown) => Promise<unknown>
  /** What one client action recorded, or every link of one target. */
  client_actions_record?: (
    p: { id: string } | { target_type: string; target_id: string },
  ) => Promise<unknown>
  /** Withdraw every open link of one target. */
  client_actions_revoke?: (p: {
    target_type: string
    target_id: string
    reason: string
  }) => Promise<unknown>
  /** Emits one of the app's declared events. */
  emit?: (e: {
    entity: string
    action: string
    entityId: string
    data?: unknown
  }) => Promise<unknown>
}

export interface RichTextRenderParams {
  body: unknown
  data: Record<string, unknown>
  title?: string
}

/** A bridge answer: JSON text or already-parsed data, depending on the executor's wrap. */
export function bridgeAnswer<T>(raw: unknown): T {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T
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
