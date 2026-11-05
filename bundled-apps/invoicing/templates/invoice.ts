// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invoice PDF template (kind: invoicing:invoice_v1).
//
// Authored against the sandboxed PDF DSL: exports `renderTemplate(data) =>
// DrawCommand[]`. The freeze step bundles this into a sandbox-executable
// artifact; the kernel runs it in QuickJS and replays the commands host-side.

import type { DrawCommand } from "@liaison/app-sdk"
import { type DocumentRenderInput, renderDocument } from "./shared"

export function renderTemplate(data: DocumentRenderInput): DrawCommand[] {
  return renderDocument({ ...data, document: { ...data.document, type: "invoice" } })
}
