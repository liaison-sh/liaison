// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  validateEditableFieldsSchema,
  validateEditedParams,
} from "~/modules/approvals/edit-validation"

describe("validateEditableFieldsSchema", () => {
  it("accepts the six supported widgets", () => {
    expect(() =>
      validateEditableFieldsSchema([
        { field: "a", label: "A", widget: "text" },
        { field: "b", label: "B", widget: "richtext" },
        { field: "c", label: "C", widget: "checkbox" },
        { field: "d", label: "D", widget: "checkbox-per-line", listSource: "items" },
        { field: "e", label: "E", widget: "key-value-list" },
        { field: "f", label: "F", widget: "email-list" },
      ]),
    ).not.toThrow()
  })

  it("rejects unknown widget kind", () => {
    expect(() =>
      validateEditableFieldsSchema([{ field: "x", label: "y", widget: "buzzer" as never }]),
    ).toThrow(/widget/i)
  })

  it("rejects checkbox-per-line without listSource", () => {
    expect(() =>
      validateEditableFieldsSchema([
        { field: "x", label: "y", widget: "checkbox-per-line" } as never,
      ]),
    ).toThrow(/listSource/i)
  })
})

describe("validateEditedParams", () => {
  it("validates checkbox-per-line edits against params shape", () => {
    const result = validateEditedParams({
      editableFields: [
        {
          field: "restock",
          label: "Restock",
          widget: "checkbox-per-line",
          listSource: "lineItems",
        },
      ],
      originalParams: { lineItems: [{ id: "a" }, { id: "b" }] },
      revision: { restock: { a: true, b: false } },
    })
    expect(result.ok).toBe(true)
  })

  it("rejects checkbox-per-line edit with keys not in listSource items", () => {
    const result = validateEditedParams({
      editableFields: [
        {
          field: "restock",
          label: "Restock",
          widget: "checkbox-per-line",
          listSource: "lineItems",
        },
      ],
      originalParams: { lineItems: [{ id: "a" }] },
      revision: { restock: { a: true, c: true } },
    })
    expect(result.ok).toBe(false)
  })

  it("accepts richtext edit on email body field (dot-path)", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "customerEmail.body", label: "Email body", widget: "richtext" }],
      originalParams: { customerEmail: { body: "hi" } },
      revision: { "customerEmail.body": "<p>updated</p>" },
    })
    expect(result.ok).toBe(true)
  })

  it("rejects revision containing any field NOT listed in editableFields", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "reason", label: "Reason", widget: "text" }],
      originalParams: { reason: "x" },
      revision: { reason: "y", adminBypass: true },
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/adminBypass/i)
  })

  it("rejects revision whose dot-path is outside any declared editable field path", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "customerEmail.body", label: "Body", widget: "richtext" }],
      originalParams: { customerEmail: { body: "x" } },
      revision: { "customerEmail.subject": "INJECTED" },
    })
    expect(result.ok).toBe(false)
  })

  it("checkbox widget accepts boolean revision", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "notify", label: "Notify", widget: "checkbox" }],
      originalParams: { notify: false },
      revision: { notify: true },
    })
    expect(result.ok).toBe(true)
  })

  it("key-value-list rejects non-string values", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "headers", label: "Headers", widget: "key-value-list" }],
      originalParams: { headers: { a: "b" } },
      revision: { headers: { a: 1 as unknown as string } },
    })
    expect(result.ok).toBe(false)
  })

  it("text widget rejects non-string revision", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "reason", label: "Reason", widget: "text" }],
      originalParams: { reason: "x" },
      revision: { reason: 42 as unknown as string },
    })
    expect(result.ok).toBe(false)
  })

  // Regression (compose-modular-expo-followups-bcc): a reviewer adjusting the BCC (or To/Cc) before
  // approving a gated mail send edits a recipient ARRAY. Pre-fix, `bcc` was not an editableField at all,
  // so the persona-sim's `POST /:id/payload { bcc:[…] }` returned 400 invalid_edit (unknownField "bcc")
  // and forced the run non-green even though the agent composed everything correctly. The `email-list`
  // widget makes to/cc/bcc editable and accepts an array of email strings or { email, name? } objects.
  it("email-list widget accepts an array of bare email strings", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "bcc", label: "Bcc", widget: "email-list" }],
      originalParams: { bcc: ["old@x.com"] },
      revision: { bcc: ["theo@resonant.example", "ops@resonant.example"] },
    })
    expect(result.ok).toBe(true)
  })

  it("email-list widget accepts an array of { email, name } objects", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "to", label: "To", widget: "email-list" }],
      originalParams: { to: [] },
      revision: { to: [{ email: "dealer@tonwerk.example", name: "Tonwerk Audio" }] },
    })
    expect(result.ok).toBe(true)
  })

  it("email-list widget rejects a non-array revision", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "bcc", label: "Bcc", widget: "email-list" }],
      originalParams: { bcc: [] },
      revision: { bcc: "theo@resonant.example" as unknown as string[] },
    })
    expect(result.ok).toBe(false)
  })

  it("email-list widget rejects array items that are neither a string nor an { email } object", () => {
    const result = validateEditedParams({
      editableFields: [{ field: "bcc", label: "Bcc", widget: "email-list" }],
      originalParams: { bcc: [] },
      revision: { bcc: [{ name: "no email here" }] as unknown as string[] },
    })
    expect(result.ok).toBe(false)
  })
})
