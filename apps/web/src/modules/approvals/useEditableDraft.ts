// SPDX-License-Identifier: FSL-1.1-ALv2
import { htmlToText } from "@liaison/shared"
import { createSignal } from "solid-js"

interface EditableField {
  field: string
  /** Payload keys this field replaces once edited (a body's `htmlBody`). */
  invalidates?: string[]
}

/**
 * A field the payload left empty opens on the content of a field it replaces:
 * a reply drafted as HTML only (`htmlBody`, no `textBody`) still opens its
 * Body editor on the proposed text instead of an empty box. Seeded into the
 * entry snapshot too, so opening Edit alone changes nothing.
 */
export function seedFromInvalidated(
  initial: Record<string, unknown>,
  fields: EditableField[],
): Record<string, unknown> {
  const out = { ...initial }
  for (const f of fields) {
    const cur = out[f.field]
    if (cur !== undefined && cur !== null && (typeof cur !== "string" || cur.trim())) continue
    for (const key of f.invalidates ?? []) {
      const source = out[key]
      if (typeof source !== "string" || !source.trim()) continue
      out[f.field] = /<[a-z][^>]*>/i.test(source)
        ? htmlToText(source).split(/\n+/).join("\n\n")
        : source.trim()
      break
    }
  }
  return out
}

/** Editing-state machine for an approval payload — enter, draft, cancel,
 *  compute the changed fields, close. The actual save (and its error
 *  handling) lives with the caller; this primitive owns only the local
 *  draft/snapshot tracking, which is otherwise identical in `BundleStepRow`
 *  and `ApprovalCard`'s outer surface. */
export function useEditableDraft<F extends EditableField = EditableField>(opts: {
  initial: () => Record<string, unknown>
  editableFields: () => F[]
}) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal<Record<string, unknown>>({})
  const [snapshot, setSnapshot] = createSignal<Record<string, unknown>>({})

  function enter() {
    const initial = seedFromInvalidated(opts.initial(), opts.editableFields())
    setDraft(initial)
    setSnapshot(initial)
    setEditing(true)
  }

  function cancel() {
    setDraft(snapshot())
    setEditing(false)
  }

  function close() {
    setEditing(false)
  }

  function changedFields(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const d = draft()
    const s = snapshot()
    for (const f of opts.editableFields()) {
      if (d[f.field] !== s[f.field]) out[f.field] = d[f.field]
    }
    return out
  }

  const isDirty = () => Object.keys(changedFields()).length > 0

  return { editing, draft, setDraft, enter, cancel, close, changedFields, isDirty }
}
