// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a Drive connection may read, and which account a call goes through.
//
// - A person's own (personal) connection reads what its grant lets it read: the
//   whole Drive (`drive.readonly`, mode full) or the files the person picked in
//   Google's picker (`drive.file` only, mode picked).
// - An ORGANIZATION connection shares the organization's drive, never one
//   person's: it reads only files in the shared drives an admin chose
//   (`metadata.sharedDrives`). With none chosen it reads nothing (fail closed).
//
// The chosen drives and the picked items live on the connected account's
// metadata (`ctx.accounts`), so a reconnect of the same account keeps them.

import type { AppAccount, AppContext } from "@liaison/app-sdk"

export const DRIVE_CONNECTION = "drive"
export const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
export const GOOGLE_DOC_MIME = "application/vnd.google-apps.document"
export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet"
export const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation"
export const GOOGLE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut"
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
export const DRIVE_READONLY_SCOPE = "https://www.googleapis.com/auth/drive.readonly"
export const DRIVE_FULL_SCOPE = "https://www.googleapis.com/auth/drive"

/** The most items one account keeps picked. */
export const MAX_PICKED_ITEMS = 500
/** The most shared drives one org connection shares. */
export const MAX_SHARED_DRIVES = 100

export interface SharedDrive {
  id: string
  name: string
}
export interface PickedItem {
  id: string
  name: string
  mimeType: string
}
export type DriveScope = { kind: "all" } | { kind: "sharedDrives"; drives: readonly SharedDrive[] }
export type DriveMode = "full" | "picked"

/** One account a call goes through: which, and what it may read. */
export interface DriveAccess {
  accountId: string
  identifier: string
  ownerType: "org" | "user"
  readScope: DriveScope
}

export const SHARED_DRIVES_NOT_CHOSEN_MESSAGE =
  "This organization's Google Drive connection shares no shared drive yet, so Liaison reads none of its files. An admin picks the shared drives the team should see (Settings > Connectors > Google Drive, `liaison config apply` with provision.sharedDrives, or the google-drive shared_drives tool)."
export const OUTSIDE_SHARED_DRIVES_MESSAGE =
  "This file is not in a shared drive this organization's Drive connection shares. Files in someone's My Drive are read only through that person's own Drive connection."
export const ORG_UPLOAD_UNSUPPORTED_MESSAGE =
  "The organization's Google Drive connection only reads its chosen shared drives: Liaison does not save files through it (they would land in the connecting account's own My Drive). Save to your own Drive with a personal Drive connection."

const ID_RE = /^[A-Za-z0-9_-]{4,128}$/
const PICK_ID_RE = /^[A-Za-z0-9_-]{8,128}$/

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null
}

/** The shared drives chosen on an account (malformed entries dropped). */
export function sharedDrivesOf(metadata: Record<string, unknown>): SharedDrive[] {
  const raw = metadata.sharedDrives
  if (!Array.isArray(raw)) return []
  const out: SharedDrive[] = []
  for (const e of raw) {
    const id = str((e as { id?: unknown })?.id, 128)
    const name = str((e as { name?: unknown })?.name, 500)
    if (id && ID_RE.test(id) && name && !out.some((d) => d.id === id)) out.push({ id, name })
  }
  return out.slice(0, MAX_SHARED_DRIVES)
}

/** The items picked on an account (malformed entries dropped). */
export function pickedItemsOf(metadata: Record<string, unknown>): PickedItem[] {
  const raw = metadata.pickedItems
  if (!Array.isArray(raw)) return []
  const out: PickedItem[] = []
  for (const e of raw) {
    const id = str((e as { id?: unknown })?.id, 128)
    const name = str((e as { name?: unknown })?.name, 500)
    const mimeType = str((e as { mimeType?: unknown })?.mimeType, 200)
    if (id && PICK_ID_RE.test(id) && name && mimeType && !out.some((i) => i.id === id)) {
      out.push({ id, name, mimeType })
    }
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

/** A list of picked items as the picker page sent it, validated; null when malformed. */
export function parsePickedItems(raw: unknown, max = MAX_PICKED_ITEMS): PickedItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) return null
  const items = pickedItemsOf({ pickedItems: raw })
  return items.length === raw.length ? items : null
}

/** The mode of a Drive account from what Google granted (none recorded: full). */
export function driveModeOf(metadata: Record<string, unknown>): DriveMode {
  const granted = metadata.grantedOAuthScopes
  if (!Array.isArray(granted) || granted.length === 0) return "full"
  // Exact scope strings of the recorded grant (an array), never a substring.
  return granted.some((s) => s === DRIVE_READONLY_SCOPE || s === DRIVE_FULL_SCOPE)
    ? "full"
    : "picked"
}

/** What an account may read. */
export function scopeOf(account: Pick<AppAccount, "ownerType" | "metadata">): DriveScope {
  if (account.ownerType !== "org") return { kind: "all" }
  return { kind: "sharedDrives", drives: sharedDrivesOf(account.metadata) }
}

export function accessOf(account: AppAccount): DriveAccess {
  return {
    accountId: account.id,
    identifier: account.identifier,
    ownerType: account.ownerType,
    readScope: scopeOf(account),
  }
}

const newest = (a: AppAccount, b: AppAccount) =>
  b.updatedAt > a.updatedAt ? 1 : b.updatedAt < a.updatedAt ? -1 : 0

/**
 * The account a person's call goes through: their own newest Drive account,
 * else the organization's newest (as the kernel's lookup always resolved it).
 * `identifier` narrows to that Google account.
 */
export async function personAccount(
  ctx: Pick<AppContext, "accounts">,
  identifier?: string,
): Promise<AppAccount | null> {
  const all = await ctx.accounts.list(DRIVE_CONNECTION, identifier ? { identifier } : undefined)
  const own = all.filter((a) => a.ownerType === "user").sort(newest)
  const org = all.filter((a) => a.ownerType === "org").sort(newest)
  return own[0] ?? org[0] ?? null
}

/**
 * The account a synced source reads through. An organization source reads
 * through the org's account, a member's personal source through that member's
 * own; each falls back to the other kind only when its own kind is not
 * connected. `identifier` (the account the source recorded) narrows the choice.
 */
export async function sourceAccount(
  ctx: Pick<AppContext, "accounts">,
  personal: boolean,
  identifier?: string,
): Promise<AppAccount | null> {
  const all = await ctx.accounts.list(DRIVE_CONNECTION)
  const match = (a: AppAccount) =>
    !identifier || a.identifier.toLowerCase() === identifier.toLowerCase()
  const own = all.filter((a) => a.ownerType === "user" && match(a)).sort(newest)
  const org = all.filter((a) => a.ownerType === "org" && match(a)).sort(newest)
  return (personal ? (own[0] ?? org[0]) : (org[0] ?? own[0])) ?? null
}

/** The export type that gives a native Google file's text, or null (drawings, forms…). */
export function googleExportMimeFor(mimeType: string): string | null {
  switch (mimeType) {
    case GOOGLE_SHEET_MIME:
      return "text/csv"
    case GOOGLE_DOC_MIME:
    case GOOGLE_SLIDES_MIME:
      return "text/plain"
    default:
      return null
  }
}

const TEXT_MIMES = new Set([
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/markdown",
  "application/x-markdown",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
])

export function isTextMime(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  return TEXT_MIMES.has((mimeType.split(";", 1)[0] ?? "").trim().toLowerCase())
}

/** Whether a file of this type has a text form the Knowledge sync imports. */
export function driveHasText(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  return googleExportMimeFor(mimeType) !== null || mimeType === XLSX_MIME || isTextMime(mimeType)
}

/** A short name for a type that has no text form. */
export function driveTypeLabel(mimeType: string): string {
  if (mimeType === "application/pdf") return "PDF"
  if (mimeType.startsWith("image/")) return "image"
  if (mimeType.startsWith("video/")) return "video"
  if (mimeType.startsWith("audio/")) return "audio"
  if (mimeType.includes("wordprocessingml") || mimeType === "application/msword") return "Word"
  if (mimeType.includes("presentationml") || mimeType === "application/vnd.ms-powerpoint")
    return "PowerPoint"
  if (mimeType === "application/vnd.ms-excel") return "Excel 97-2003 (.xls)"
  if (mimeType.startsWith("application/vnd.google-apps.")) {
    return `Google ${mimeType.slice("application/vnd.google-apps.".length)}`
  }
  return mimeType
}

/**
 * Strip quotes, backslashes and control characters before a query goes into
 * Drive's `fullText contains '…'` literal, so it can never break out of it.
 */
export function sanitizeDriveQuery(query: string): string {
  let out = ""
  for (const ch of query) {
    const code = ch.charCodeAt(0)
    if (ch === "\\" || ch === "'" || code < 0x20 || code === 0x7f) continue
    out += ch
  }
  return out.trim().slice(0, 1000)
}
