// SPDX-License-Identifier: FSL-1.1-ALv2
// Phase 16 Task A5 — Editable-field validation for approval revisions.
//
// Pure validators (no DB / no IO) used by `edit.ts` to gate inbound revisions.
// Lives alongside the approval-edit route logic.

export type EditableWidget =
  | "text"
  | "richtext"
  | "checkbox"
  | "checkbox-per-line"
  | "key-value-list"
  // An editable RECIPIENT list (mail to/cc/bcc): an array whose items are either a bare email string
  // or a `{ email, name? }` object — matching the mail compose/reply param schema. Lets a human reviewer
  // adjust who an email goes to (incl. the BCC) before approving the gated send.
  | "email-list"

export interface EditableField {
  field: string
  label: string
  widget: EditableWidget
  /** Required for `checkbox-per-line` — dot-path into params to the list of items. */
  listSource?: string
}

const SUPPORTED_WIDGETS: ReadonlySet<EditableWidget> = new Set<EditableWidget>([
  "text",
  "richtext",
  "checkbox",
  "checkbox-per-line",
  "key-value-list",
  "email-list",
])

export function validateEditableFieldsSchema(fields: readonly EditableField[]): void {
  for (const f of fields) {
    if (!SUPPORTED_WIDGETS.has(f.widget)) {
      throw new Error(`unsupported widget '${f.widget}' on field '${f.field}'`)
    }
    if (f.widget === "checkbox-per-line" && !f.listSource) {
      throw new Error(`checkbox-per-line on field '${f.field}' requires listSource`)
    }
  }
}

export interface ValidateEditedParamsArgs {
  editableFields: readonly EditableField[]
  originalParams: Record<string, unknown>
  revision: Record<string, unknown>
}

export type ValidateResult = { ok: true } | { ok: false; error: string }

/**
 * Validates an inbound `revision` against the tool's declared `editableFields`.
 * Behaviour:
 *  - Every key in `revision` must be a declared field (exact match) OR a
 *    dot-path that has a declared field as its prefix-or-self.
 *  - `text` / `richtext` require string values.
 *  - `checkbox` requires boolean.
 *  - `checkbox-per-line` requires an object whose keys are a subset of the
 *    items in `originalParams[listSource]` (matched by `.id` for objects
 *    or by the item itself for primitives).
 *  - `key-value-list` requires `Record<string, string>`.
 */
export function validateEditedParams(args: ValidateEditedParamsArgs): ValidateResult {
  const declared = args.editableFields
  // Pre-validate the schema itself; declared with unsupported widget is a developer error.
  try {
    validateEditableFieldsSchema(declared)
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }

  for (const [revKey, revVal] of Object.entries(args.revision)) {
    const match = matchEditableField(declared, revKey)
    if (!match) {
      return { ok: false, error: `field '${revKey}' is not in editableFields` }
    }
    const typeError = checkWidgetValue(match, revKey, revVal, args.originalParams)
    if (typeError) return { ok: false, error: typeError }
  }
  return { ok: true }
}

function matchEditableField(
  declared: readonly EditableField[],
  revKey: string,
): EditableField | null {
  // Exact match wins.
  const exact = declared.find((f) => f.field === revKey)
  if (exact) return exact
  // Otherwise: revKey must be a dot-path whose prefix is a declared field
  // OR a declared field whose dot-path is a prefix of revKey.
  for (const f of declared) {
    if (revKey.startsWith(`${f.field}.`)) return f
    if (f.field.startsWith(`${revKey}.`)) return f
  }
  return null
}

function checkWidgetValue(
  field: EditableField,
  revKey: string,
  revVal: unknown,
  originalParams: Record<string, unknown>,
): string | null {
  switch (field.widget) {
    case "text":
    case "richtext":
      if (typeof revVal !== "string") {
        return `field '${revKey}' expected string for widget ${field.widget}`
      }
      return null
    case "checkbox":
      if (typeof revVal !== "boolean") {
        return `field '${revKey}' expected boolean for widget checkbox`
      }
      return null
    case "checkbox-per-line": {
      if (!revVal || typeof revVal !== "object" || Array.isArray(revVal)) {
        return `field '${revKey}' expected object for widget checkbox-per-line`
      }
      const listSource = field.listSource as string // schema-checked above
      const list = readDotPath(originalParams, listSource)
      if (!Array.isArray(list)) {
        return `listSource '${listSource}' did not resolve to an array`
      }
      const allowed = new Set(
        list.map((item) =>
          item && typeof item === "object" && "id" in (item as Record<string, unknown>)
            ? String((item as Record<string, unknown>).id)
            : String(item),
        ),
      )
      for (const key of Object.keys(revVal as Record<string, unknown>)) {
        if (!allowed.has(key)) {
          return `checkbox-per-line key '${key}' is not in listSource items`
        }
        const v = (revVal as Record<string, unknown>)[key]
        if (typeof v !== "boolean") {
          return `checkbox-per-line value for '${key}' must be boolean`
        }
      }
      return null
    }
    case "key-value-list": {
      if (!revVal || typeof revVal !== "object" || Array.isArray(revVal)) {
        return `field '${revKey}' expected object for widget key-value-list`
      }
      for (const [k, v] of Object.entries(revVal as Record<string, unknown>)) {
        if (typeof v !== "string") {
          return `key-value-list value for '${k}' must be string`
        }
      }
      return null
    }
    case "email-list": {
      if (!Array.isArray(revVal)) {
        return `field '${revKey}' expected an array for widget email-list`
      }
      for (const item of revVal) {
        const isBareEmail = typeof item === "string"
        const isEmailObject =
          !!item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          typeof (item as Record<string, unknown>).email === "string"
        if (!isBareEmail && !isEmailObject) {
          return `field '${revKey}' email-list items must be an email string or a { email, name? } object`
        }
      }
      return null
    }
  }
}

function readDotPath(obj: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
      obj,
    )
}
