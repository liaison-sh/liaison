// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure rules of the app page: which sections a viewer sees and in what order
// (A7, S13), the label a reader sees, and the save queue that keeps one
// section's writes in order (a tool-source field does get → set on the server,
// so two parallel saves of one section could overwrite each other, §R1 T3).
import {
  type AppSettingsPageEntry,
  DEFAULT_SECTION_ADMIN_SCOPE,
  type SettingsSection,
} from "./types"

/** The scope that administers a section: its own, the default for an org section, none for a user one. */
export function sectionAdminScope(section: SettingsSection): string | null {
  if (section.scope === "user") return null
  return section.adminScope ?? DEFAULT_SECTION_ADMIN_SCOPE
}

/**
 * The sections a viewer sees: every user section, then each org section whose
 * admin scope the viewer holds, each group in schema order. Hiding is not the
 * control (S17: the API refuses the write); it keeps a page to what one can change.
 */
export function visibleSections(
  sections: readonly SettingsSection[] | undefined,
  canAccess: (scope: string) => boolean,
): SettingsSection[] {
  const all = sections ?? []
  return [
    ...all.filter((s) => s.scope === "user"),
    ...all.filter((s) => {
      const scope = sectionAdminScope(s)
      return s.scope === "org" && scope !== null && canAccess(scope)
    }),
  ]
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/** The translated label behind `key`, else the manifest's English `fallback`. */
export function labelOf(t: Translate, key: string | undefined, fallback: string): string {
  if (!key) return fallback
  const v = t(key)
  return v && v !== key ? v : fallback
}

/** The name an app's page and card carry: its catalog label, else the given or manifest name. */
export function entryLabel(t: Translate, entry: AppSettingsPageEntry): string {
  return labelOf(
    t,
    entry.labelKey,
    entry.label ?? entry.manifest.displayName ?? entry.manifest.name,
  )
}

/**
 * The set tool a section saves as one unit through (M1), or null. When two or
 * more of its fields are backed by ONE tool setter, that tool receives the whole
 * object: saved field by field, a gated setter would park one approval per
 * field, each built from the stored object without the others' edits. So the
 * section's edits wait in a Save bar and go in one write.
 */
export function unitSetTool(section: SettingsSection): string | null {
  const sets: Array<string | null> = []
  for (const b of section.blocks) {
    if (b.block !== "field") continue
    const src = b.source
    sets.push(typeof src === "object" && src !== null && "tool" in src ? src.tool.set : null)
  }
  const [first] = sets
  if (sets.length < 2 || !first) return null
  return sets.every((s) => s === first) ? first : null
}

/** Runs tasks one after another; a failed task never blocks the next. */
export function createSaveQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

/** Options out of an options tool's answer: `[{value,label}]`, `[string]`, or `{ options }`. */
export function optionsOf(data: unknown): Array<{ value: string | number; label: string }> {
  const list = Array.isArray(data)
    ? data
    : typeof data === "object" &&
        data !== null &&
        Array.isArray((data as { options?: unknown }).options)
      ? (data as { options: unknown[] }).options
      : []
  const out: Array<{ value: string | number; label: string }> = []
  for (const o of list) {
    if (typeof o === "string" || typeof o === "number") out.push({ value: o, label: String(o) })
    else if (typeof o === "object" && o !== null) {
      const r = o as Record<string, unknown>
      const value = r.value ?? r.id
      if (typeof value !== "string" && typeof value !== "number") continue
      const label = r.label ?? r.name ?? value
      out.push({ value, label: String(label) })
    }
  }
  return out
}
