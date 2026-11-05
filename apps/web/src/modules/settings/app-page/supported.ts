// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT THIS BUILD CAN DRAW OF A DECLARATIVE SETTINGS PAGE.
//
// A server newer than this build can hand it a manifest whose settings use a
// block or a field type added later. Such a part is never guessed at (a field
// type drawn as a text box would save a value of the wrong shape): it is drawn
// as a placeholder that says to update Liaison (UnsupportedSettingsPart), and
// the bootstrap notes the app as running in compatibility mode
// (framework/compat-mode.ts).

import { SETTINGS_FIELD_TYPES } from "@liaison/app-sdk"

/** The block types SectionView draws. */
export const SUPPORTED_SETTINGS_BLOCKS: readonly string[] = [
  "field",
  "connections",
  "list",
  "tree",
  "custom",
]

const FIELD_TYPES: readonly string[] = SETTINGS_FIELD_TYPES

/** Whether this build can draw a block: a known block, and for a field a known type. */
export function isSupportedSettingsBlock(block: unknown): boolean {
  if (typeof block !== "object" || block === null) return false
  const b = block as { block?: unknown; type?: unknown }
  if (typeof b.block !== "string" || !SUPPORTED_SETTINGS_BLOCKS.includes(b.block)) return false
  if (b.block === "field") return typeof b.type === "string" && FIELD_TYPES.includes(b.type)
  return true
}

/** Whether a field type is one this build has a control for. */
export function isSupportedFieldType(type: unknown): boolean {
  return typeof type === "string" && FIELD_TYPES.includes(type)
}

/** Whether any block of a manifest's settings page is one this build cannot draw. */
export function hasUnsupportedSettings(manifest: unknown): boolean {
  const sections = (manifest as { settings?: { sections?: unknown } } | null)?.settings?.sections
  if (!Array.isArray(sections)) return false
  return sections.some((section) => {
    const blocks = (section as { blocks?: unknown } | null)?.blocks
    return Array.isArray(blocks) && blocks.some((b) => !isSupportedSettingsBlock(b))
  })
}
