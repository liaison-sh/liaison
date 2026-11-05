// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Credit note PDF template (kind: invoicing:credit_note_v1).
//
// Authored against the sandboxed PDF DSL: exports `renderTemplate(data) =>
// DrawCommand[]`. The freeze step bundles this into a sandbox-executable
// artifact; the kernel runs it in QuickJS and replays the commands host-side.
//
// A credit note is a first-class legal document — same content requirements
// as an invoice (issuer/counterparty/lines/totals/legal mention), but its
// totals commonly render NEGATIVE (formatMoney renders the sign naturally)
// and, when it references an original invoice, the header carries a
// "Credit note for invoice <n>" reference line (see shared.ts drawHeader).

import type { DrawCommand } from "@liaison/app-sdk"
import { type DocumentRenderInput, renderDocument } from "./shared"

export function renderTemplate(data: DocumentRenderInput): DrawCommand[] {
  return renderDocument({ ...data, document: { ...data.document, type: "credit_note" } })
}
