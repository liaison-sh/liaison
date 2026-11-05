// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoicing mutations: documents.send_to_customer.

import { findDocumentSummary, findIssuerProfile } from "./db-helpers"
import { closeAutoEmailParks } from "../deferred"
import { deliveryFileId } from "../legal-originals/delivery"
import { ensureDocumentPdf } from "./pdf"
import {
  type MutationsCtx,
  type DocumentRowSummary,
  type ErrorEnvelope,
  type PreflightResult,
  type MutationResult,
  toPreflightResult,
} from "./shared"

// ── documents.send_to_customer ────────────────────────────────────────────

/**
 * Read-only resolution shared by `documentsSendToCustomer` and its stage-time preflight export:
 * the document resolves, the issuer profile carries a send-from mail account, and a recipient
 * address can be found (explicit override, then the linked contact, then the contact registry by
 * counterparty name). Lookups only, no writes and no send. ONE copy, called from both sides, so
 * the staged refusal and the executed refusal can never drift apart.
 */
async function preflightSendToCustomerParams(
  ctx: MutationsCtx,
  input: { document_id: string; to?: string },
): Promise<
  | { ok: true; doc: DocumentRowSummary; mailAccountId: string; recipient: string }
  | { ok: false; error: ErrorEnvelope }
> {
  const doc = await findDocumentSummary(ctx.db, input.document_id)
  if (!doc) {
    return {
      ok: false,
      error: {
        status: "error",
        error: { code: "not_found", message: `document ${input.document_id} not found` },
      },
    }
  }
  // Resolve the org's send-from mail account. mail:compose REQUIRES an accountId (its handler does a
  // findOne on accounts) — send_to_customer historically passed none, so the send silently failed at
  // account resolution. The account is configured on the issuer profile (settings.mail_account_id).
  const issuer = await findIssuerProfile(ctx.db, doc.issuer_profile_id)
  const mailAccountId = issuer?.mail_account_id ?? null
  if (!mailAccountId) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "no_mail_account",
          // USER-FACING: a human clicking Send sees this. It is a configuration
          // precondition, not a server fault, so it stays a typed envelope (never a
          // throw, which would be an error-level log plus HTTP 500) and it says what
          // to do about it. No dash punctuation.
          message:
            "No send-from mailbox is set on this issuer profile, so the document cannot be emailed. " +
            "Set the send-from mailbox on the issuer profile in invoicing settings (mail_account_id), then send again.",
        },
      },
    }
  }
  // Resolve the recipient. The tool's contract is "email the document to its counterparty", and its
  // manifest declares NO `to` param — so the agent cannot (and should not) supply a recipient. Default
  // to the counterparty contact's email, read via the kernel contacts tool (the invoicing app cannot
  // read kernel.contacts directly). `input.to` is an explicit override (used by tests / a caller that
  // already has the address).
  let recipient = (input.to ?? "").trim()
  // The address recorded on the document itself (required at issue) is the customer the document
  // names, and the approval card shows it (summarizeDocumentSend), so it wins over a lookup.
  if (!recipient) recipient = (doc.counterparty_email ?? "").trim()
  if (!recipient && doc.counterparty_contact_id) {
    const contactResult = await ctx.executeTool("kernel:contacts_read", {
      contactId: doc.counterparty_contact_id,
    })
    if (contactResult.status === "completed") {
      const email = (contactResult.result as { contact?: { email?: string | null } } | undefined)?.contact?.email
      recipient = (email ?? "").trim()
    }
  }
  // FALLBACK: the contact registry by counterparty NAME, accepted only on a UNIQUE exact name match
  // that has an email. A name search must never let a same-name contact with a different address
  // win a document that went to somebody else.
  if (!recipient && doc.counterparty_name) {
    const searchResult = await ctx.executeTool("kernel:contacts_search", {
      query: doc.counterparty_name,
      limit: 20,
    })
    if (searchResult.status === "completed") {
      const items =
        (searchResult.result as { items?: Array<{ name?: string | null; primaryEmail?: string | null }> } | undefined)
          ?.items ?? []
      const wanted = doc.counterparty_name.trim().toLowerCase()
      const exact = items.filter(
        (c) =>
          (c.name ?? "").trim().toLowerCase() === wanted && (c.primaryEmail ?? "").trim().length > 0,
      )
      if (exact.length === 1) recipient = (exact[0]?.primaryEmail ?? "").trim()
    }
  }
  if (!recipient) {
    return {
      ok: false,
      error: {
        status: "error",
        error: {
          code: "no_recipient",
          message: "no recipient: the counterparty contact has no email on file (and no `to` override was given)",
        },
      },
    }
  }
  return { ok: true, doc, mailAccountId, recipient }
}

/**
 * STAGE-TIME preflight for the gated `documents_send_to_customer` tool (manifest `preflight`).
 * A gated call must not be parked for a human when the data it needs is missing: an unknown
 * document, an issuer with no send-from mail account, or a counterparty with no email anywhere
 * is refused here, before the approval request exists. Read-only: it resolves, it never sends.
 */
export async function documentsSendToCustomerPreflight(
  ctx: MutationsCtx,
  input: { document_id: string; to?: string },
): Promise<PreflightResult> {
  return toPreflightResult(await preflightSendToCustomerParams(ctx, input))
}

export async function documentsSendToCustomer(
  ctx: MutationsCtx,
  input: {
    document_id: string
    to?: string
    subject?: string
    body?: string
  },
): Promise<MutationResult<{ dispatched: true }>> {
  // Recipient resolution ALSO runs at stage time (the preflight export above shares this exact
  // code), but it stays here: a contact's email can be edited or removed between staging and
  // approval, so the executed send re-resolves rather than trusts.
  const pre = await preflightSendToCustomerParams(ctx, input)
  if (!pre.ok) return pre.error
  const { doc, mailAccountId, recipient } = pre

  // Self-heal a missing PDF instead of refusing to send: an issued document whose issue-time render
  // never ran or failed (pdf_status null/pending/failed) is rendered on-demand here, then attached.
  // A ready PDF is reused as-is. Only a genuine render failure blocks the send (with that error).
  const pdf = await ensureDocumentPdf(ctx, doc.id)
  if (!pdf.ok) {
    return { status: "error", error: pdf.error }
  }
  // The customer receives the LEGAL ORIGINAL (fixed at issue), never a later management copy.
  const fresh = ((await ctx.db.findMany("documents", { where: { id: doc.id }, limit: 1 })) as Array<Record<string, unknown>>)[0] ?? {}
  const delivery = await deliveryFileId(ctx.db, { ...fresh, pdf_file_id: pdf.pdf_file_id })
  const attachment = delivery.file_id ?? pdf.pdf_file_id
  // Use mail:composeForApp — the INTERNAL cross-app variant — NOT the agent-facing gated mail:compose.
  // documents_send_to_customer is ALREADY gated at its own surface (this handler only runs post-approval),
  // so the send must EXECUTE here, not gate again. mail:compose is gated; invoked cross-app from this
  // already-approved handler it tries to create a SECOND approval and fails with
  // "Tool is gated — threadId required to create an approval request" (no thread in the post-approval
  // execution context) → send_dispatch_failed → EXECUTED-FAIL on every documents_send_to_customer
  // (chaos: proforma-for-jp-distributor-prepay, [[BL-186]]). composeForApp shares the EXACT same
  // _doCompose pipeline (account resolution + PDF attachment staging) but skips the per-call approval
  // card and threads originating_approval_id for the cross-app audit chain — it is the declared
  // "auto-flow email of issued document PDFs" path in this app's cross_app_calls.
  // composeForApp REQUIRES `textBody` (required set: [accountId, to, subject, textBody,
  // originating_approval_id]); map our `body` input to `textBody` (the l314 fix, preserved).
  const composeResult = await ctx.executeTool("mail:composeForApp", {
    accountId: mailAccountId,
    to: [recipient],
    subject: input.subject ?? `Document ${doc.number ?? doc.id}`,
    textBody: input.body ?? "Please find the attached document.",
    attachments: [attachment],
    originating_approval_id: ctx.approval?.approvalRequestId ?? "",
  })
  if (composeResult.status === "completed") {
    // The document went out: its automatic mail, parked or unknown, must not go as well.
    await closeAutoEmailParks(ctx, doc.id)
    return { status: "completed", dispatched: true }
  }
  if (composeResult.status === "pending_approval") {
    return {
      status: "pending_approval",
      approval_id: composeResult.approval_id,
    }
  }
  // Never propagate a DETAIL-LESS error (see sendErrorFromEnvelope): a bare `{status:"error"}` from
  // the cross-app mail:compose dispatch (observed under BL-23 severe memory pressure as the gated-send
  // execution dies under swap) gets a synthesized reason so the agent/judge see WHY the send failed.
  return { status: "error", error: sendErrorFromEnvelope(composeResult) }
}

/**
 * Map a cross-app send envelope to a NON-empty error reason. The declared `CrossAppEnvelope` error
 * variant promises an `error` field, but the QuickJS marshaller can under-deliver a bare
 * `{status:"error"}` under severe memory pressure (BL-23/BL-31) — so a gated send must never dead-end
 * with no reason. Typed against the wire reality (optional `error`), not the optimistic contract.
 */
export function sendErrorFromEnvelope(envelope: {
  error?: { code?: string; message?: string; retryable?: boolean }
}): { code: string; message: string } {
  if (envelope.error?.code || envelope.error?.message) {
    return { code: envelope.error.code ?? "send_failed", message: envelope.error.message ?? "send failed" }
  }
  return {
    code: "send_dispatch_failed",
    message: `mail:compose returned an error envelope without detail: ${JSON.stringify(envelope).slice(0, 200)}`,
  }
}
