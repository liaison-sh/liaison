// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A Drive connection's access mode, read from what Google granted:
 *
 * - `full`: the grant holds `drive.readonly`: Liaison reads the whole Drive.
 * - `picked`: `drive.file` only (a personal Google account on a client Google has
 *   not verified for restricted scopes, connections/restricted-scopes.ts):
 *   Liaison sees the files the person chose in the Google Picker, and the files it
 *   created itself.
 *
 * The chosen items live on the connected account (`metadata.pickedItems`), beside
 * the recorded grant; a reconnect carries them over (connections/service.ts).
 * A grant never recorded (an account older than grant tracking) is `full`.
 */
import { z } from "zod"

export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
export const DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive"

export type DriveMode = "full" | "picked"

/** The folder ref of the Knowledge synced source that holds a person's picked items. */
export const PICKED_ROOT_REF = "liaison-picked-items"

/** The most items one account keeps picked. */
export const MAX_PICKED_ITEMS = 500

export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"

export const pickedItemSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
  name: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
})
export type PickedItem = z.infer<typeof pickedItemSchema>

function metadataObject(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {}
}

/** The mode of a Drive account from its connected-account metadata. */
export function driveModeOf(metadata: unknown): DriveMode {
  const granted = metadataObject(metadata).grantedOAuthScopes
  if (!Array.isArray(granted) || granted.length === 0) return "full"
  return granted.includes(DRIVE_READONLY_SCOPE) || granted.includes(DRIVE_FULL_SCOPE)
    ? "full"
    : "picked"
}

/** The items picked on a Drive account (malformed entries dropped). */
export function pickedItemsOf(metadata: unknown): PickedItem[] {
  const raw = metadataObject(metadata).pickedItems
  if (!Array.isArray(raw)) return []
  const out: PickedItem[] = []
  for (const entry of raw) {
    const parsed = pickedItemSchema.safeParse(entry)
    if (parsed.success && !out.some((i) => i.id === parsed.data.id)) out.push(parsed.data)
  }
  return out
}

/** The picked list after adding `add` (newest last, deduplicated) and removing `remove`. */
export function mergePickedItems(
  current: readonly PickedItem[],
  add: readonly PickedItem[],
  remove: readonly string[],
): PickedItem[] {
  const removed = new Set(remove)
  const out = current.filter((i) => !removed.has(i.id))
  for (const item of add) {
    if (removed.has(item.id)) continue
    const at = out.findIndex((i) => i.id === item.id)
    if (at >= 0) out[at] = item
    else out.push(item)
  }
  return out.slice(-MAX_PICKED_ITEMS)
}

/** Whether the deployment configured the Google Picker. */
export function pickerConfigured(source: {
  GOOGLE_PICKER_API_KEY?: string
  GOOGLE_CLOUD_PROJECT_NUMBER?: string
}): boolean {
  return Boolean(source.GOOGLE_PICKER_API_KEY && source.GOOGLE_CLOUD_PROJECT_NUMBER)
}
