// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT THIS BUILD CAN DRAW OF A DECLARATIVE SETTINGS PAGE.
//
// A server newer than this build can hand it a manifest whose settings use a
// block or a field type added later. Such a part is never guessed at (a field
// type drawn as a text box would save a value of the wrong shape). When the
// block carries a `fallback` ({ text, href? }), its text is drawn with an
// "Open in browser" link (SettingsFallbackPart). Without one it is drawn as a
// placeholder that says to update Liaison (UnsupportedSettingsPart), and only
// then does the bootstrap note the app as running in compatibility mode
// (framework/compat-mode.ts).

import { SETTINGS_FIELD_TYPES } from "@liaison/app-sdk"

/** The block types SectionView draws. */
export const SUPPORTED_SETTINGS_BLOCKS: readonly string[] = [
  "field",
  "connections",
  "list",
  "tree",
  "custom",
  "appSecrets",
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

export interface SettingsBlockFallback {
  text: string
  href?: string
}

const FALLBACK_TEXT_MAX = 280

/**
 * A block's fallback, read defensively from raw manifest JSON (the block is one
 * this build does not know, so no schema vouches for it): text of 1 to 280
 * characters, and an href that is a server path (`/...`, not `//`) or an anchor
 * (`#...`). Anything else counts as no fallback.
 */
export function settingsBlockFallback(block: unknown): SettingsBlockFallback | null {
  if (typeof block !== "object" || block === null) return null
  const fallback: unknown = (block as { fallback?: unknown }).fallback
  if (typeof fallback !== "object" || fallback === null) return null
  const { text, href } = fallback as { text?: unknown; href?: unknown }
  if (typeof text !== "string" || text.length < 1 || text.length > FALLBACK_TEXT_MAX) return null
  if (href === undefined) return { text }
  if (typeof href !== "string") return null
  const relative = href.startsWith("#") || (href.startsWith("/") && !href.startsWith("//"))
  return relative ? { text, href } : null
}

/**
 * Whether a manifest's settings page has a part this build can neither draw
 * nor stand in for: a block it cannot draw that carries no valid fallback.
 */
export function hasUnusableSettings(manifest: unknown): boolean {
  const sections = (manifest as { settings?: { sections?: unknown } } | null)?.settings?.sections
  if (!Array.isArray(sections)) return false
  return sections.some((section) => {
    const blocks = (section as { blocks?: unknown } | null)?.blocks
    return (
      Array.isArray(blocks) &&
      blocks.some((b) => !isSupportedSettingsBlock(b) && settingsBlockFallback(b) === null)
    )
  })
}
