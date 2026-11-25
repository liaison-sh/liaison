// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Agreement numbers for tab names. The kernel's tab strip re-reads a tab type's
// `resolveLabel(entityId)` reactively, so a tab opened from a mention or the list renames
// itself to the agreement's number (DOC-2026-004) as soon as any screen has read it.
import { createSignal } from "solid-js"

const [labels, setLabels] = createSignal<Record<string, string>>({})

export function rememberAgreementLabel(id: string, number: string): void {
  if (!id || !number || labels()[id] === number) return
  setLabels((prev) => ({ ...prev, [id]: number }))
}

/** Manifest-referenced (`views.tabTypes.*.resolveLabel`): the number when known. */
export function resolveAgreementTabLabel(entityId: string): string | undefined {
  return labels()[entityId]
}
