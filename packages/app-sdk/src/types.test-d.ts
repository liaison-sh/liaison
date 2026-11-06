// SPDX-License-Identifier: FSL-1.1-ALv2
// Type-only assertions. Runs through `bun run typecheck` — no runtime test framework.
// Each `_check` is a structural assignment that fails to compile if the AppContext
// surface drifts from the expected shape.
import type { AppContext } from "./types"

// K1 — messages.post
type _MessagesPost = AppContext["messages"]["post"]
const _checkMessagesPost: (p: {
  thread_id?: string
  contact_id?: string
  body: string
  attachment_file_ids?: string[]
  metadata?: Record<string, unknown>
}) => Promise<{ message_id: string; thread_id: string }> = null as unknown as _MessagesPost
void _checkMessagesPost

// K2 — pdf.render
type _PdfRender = AppContext["pdf"]["render"]
const _checkPdfRender: (p: {
  template_kind: string
  data: Record<string, unknown>
  pdf_a3?: boolean
}) => Promise<{
  file_id: string
  byte_size: number
  page_count: number
  pdf_a3_normalized?: boolean
}> = null as unknown as _PdfRender
void _checkPdfRender

// ctx.time.civil
type _TimeCivil = AppContext["time"]["civil"]
const _checkTimeCivil: (params: { timezone: string; at?: string | number }) => Promise<{
  date: string
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
  zone: string
}> = null as unknown as _TimeCivil
void _checkTimeCivil

// K3 — sequences.allocate
type _SeqAllocate = AppContext["sequences"]["allocate"]
const _checkSeqAllocate: (p: { key: string }) => Promise<{ value: number }> =
  null as unknown as _SeqAllocate
void _checkSeqAllocate

// K6 — approval (optional, shape pinned)
type _Approval = AppContext["approval"]
const _checkApprovalUndefined: _Approval = undefined
void _checkApprovalUndefined
const _checkApprovalShape: _Approval = {
  approvalRequestId: "x",
  approvalDeciderId: "y",
  toolName: "z",
}
void _checkApprovalShape
