// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Quote PDF template (kind: invoicing:quote_v1).
//
// Authored against the sandboxed PDF DSL: exports `renderTemplate(data) =>
// DrawCommand[]`.

import type { DrawCommand } from "@liaison/app-sdk"
import { type DocumentRenderInput, renderDocument } from "./shared"

export function renderTemplate(data: DocumentRenderInput): DrawCommand[] {
  return renderDocument({ ...data, document: { ...data.document, type: "quote" } })
}
