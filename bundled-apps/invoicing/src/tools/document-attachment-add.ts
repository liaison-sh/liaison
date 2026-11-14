// SPDX-License-Identifier: FSL-1.1-ALv2
//
// document_attachment_add: file an annex (an activity report or a timesheet) on an invoice draft,
// or on an issued invoice before it is sent. The file is copied onto the annex, read under the
// caller's own access: a file the caller cannot read is refused and nothing is filed. A sent,
// paid or otherwise settled invoice takes no new annex (send a credit note and a new invoice).

import type { MutationsDb } from "../mutations/shared"

export interface DocumentAttachmentAddInput {
  documentId?: string
  fileId?: string
  kind?: string
  partial?: boolean
}

export interface DocumentAttachmentAddCtx {
  db: MutationsDb
  hasScope?(scope: string): Promise<boolean>
  files?: {
    attachToParent?(args: {
      sourceFileId: string
      targetApp: string
      targetEntityType: string
      targetEntityId: string
    }): Promise<unknown>
  }
}

export type DocumentAttachmentAddResult =
  | {
      status: "completed"
      attachmentId: string
      documentId: string
      fileId: string
      kind: "activity_report" | "timesheet"
      partial: boolean
      message: string
    }
  | { status: "error"; error: { code: string; message: string; retryable: false } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS = new Set(["activity_report", "timesheet"])
/** An invoice still open to an annex: a draft, one waiting for approval, issued and not sent. */
const OPEN = new Set(["draft", "pending_approval", "issued"])

const refuse = (code: string, message: string): DocumentAttachmentAddResult => ({
  status: "error",
  error: { code, message, retryable: false },
})

export async function documentAttachmentAdd(
  ctx: DocumentAttachmentAddCtx,
  input: DocumentAttachmentAddInput,
): Promise<DocumentAttachmentAddResult> {
  const documentId = typeof input.documentId === "string" ? input.documentId : ""
  const fileId = typeof input.fileId === "string" ? input.fileId : ""
  const kind = typeof input.kind === "string" ? input.kind : ""
  if (!UUID.test(documentId) || !UUID.test(fileId)) {
    return refuse("invalid_input", "documentId and fileId must be ids. Nothing was filed.")
  }
  if (!KINDS.has(kind)) {
    return refuse(
      "invalid_kind",
      `kind must be activity_report or timesheet, not ${kind || "(none)"}. Nothing was filed.`,
    )
  }
  // The person's own scope, not the scopes a call from another app widens the data access with.
  if (!ctx.hasScope || !(await ctx.hasScope("invoicing:documents:write"))) {
    return refuse(
      "forbidden",
      "Filing an annex on an invoice needs invoicing:documents:write. Nothing was filed.",
    )
  }
  const doc = (await ctx.db.findOne("documents", documentId)) as Record<string, unknown> | null
  if (!doc || doc.type !== "invoice") {
    return refuse("not_found", `No invoice ${documentId} you can read. Nothing was filed.`)
  }
  const status = String(doc.status ?? "draft")
  if (!OPEN.has(status)) {
    const label = doc.number ? `Invoice ${String(doc.number)}` : `Invoice ${documentId}`
    return refuse(
      "document_sent",
      `${label} is ${status}, so nothing was filed on it. An annex goes on an invoice before it is sent; correct a sent one with a credit note.`,
    )
  }
  if (!ctx.files?.attachToParent) {
    return refuse("files_unavailable", "Files cannot be attached here. Nothing was filed.")
  }
  const partial = input.partial === true
  const row = (await ctx.db.insert("document_attachments", {
    document_id: documentId,
    file_id: fileId,
    kind,
    partial,
  })) as { id: string }
  let copied: string | null = null
  try {
    const res = (await ctx.files.attachToParent({
      sourceFileId: fileId,
      targetApp: "invoicing",
      targetEntityType: "document_attachment",
      targetEntityId: row.id,
    })) as { id?: unknown } | string | null
    const parsed = typeof res === "string" ? (JSON.parse(res) as { id?: unknown }) : res
    copied = typeof parsed?.id === "string" ? parsed.id : null
  } catch {
    copied = null
  }
  if (!copied) {
    await ctx.db.delete("document_attachments", row.id)
    return refuse(
      "file_not_readable",
      `File ${fileId} is not one you can read, so nothing was filed on the invoice.`,
    )
  }
  await ctx.db.update("document_attachments", row.id, { file_id: copied })
  const what = kind === "timesheet" ? "timesheet" : "activity report"
  return {
    status: "completed",
    attachmentId: row.id,
    documentId,
    fileId: copied,
    kind: kind as "activity_report" | "timesheet",
    partial,
    message: `Filed the ${partial ? "partial " : ""}${what} on ${doc.number ? `invoice ${String(doc.number)}` : `draft ${documentId}`}. It goes out with the invoice when it is sent.`,
  }
}
