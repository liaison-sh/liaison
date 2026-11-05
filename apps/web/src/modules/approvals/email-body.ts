// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A gated send whose body reaches a customer as email is edited on its card
// with the editor of the surface it writes to.
import type { RichEditorProps } from "~/modules/editor"

const EMAIL_BODY_PRESET: Record<string, RichEditorProps["preset"]> = {
  "tickets:reply": "minimal",
  "tickets:nudge": "minimal",
  "tickets:close": "minimal",
  "mail:reply": "full",
  "mail:compose": "full",
}

/** The editor preset for this field, when it is a customer email's body. */
export function emailBodyPreset(
  toolName: string,
  field: string,
): RichEditorProps["preset"] | undefined {
  return field === "textBody" ? EMAIL_BODY_PRESET[toolName] : undefined
}
