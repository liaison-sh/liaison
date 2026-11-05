// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a Drive connection may read.
 *
 * - A person's own (personal) connection reads what its grant lets it read:
 *   their whole Drive (`drive.readonly`) or their picked files (`drive.file`,
 *   drive-mode.ts).
 * - An ORGANIZATION connection shares the organization's drive, never one
 *   person's: it reads only files that live in the Shared Drives an admin chose
 *   (`metadata.sharedDrives` on the connected account). The connecting
 *   account's My Drive, and any shared drive nobody chose, stay out. An org
 *   connection with no shared drive chosen reads nothing at all (fail closed):
 *   an org connection made before this rule never widens to the connecting
 *   person's Drive while waiting for an admin to choose.
 *
 * Every read path (agent tools, federated Knowledge search, folder sync, file
 * reads by id) goes through `makeDriveFetchers` (drive-rest.ts), which enforces
 * the scope; this module only says what the scope is.
 */
import { z } from "zod"

export const sharedDriveSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{4,128}$/),
  name: z.string().min(1).max(500),
})
export type SharedDrive = z.infer<typeof sharedDriveSchema>

/** The most shared drives one org connection shares. */
export const MAX_SHARED_DRIVES = 100

export type DriveScope = { kind: "all" } | { kind: "sharedDrives"; drives: readonly SharedDrive[] }

/** A Drive connection's token and what it may read with it. */
export interface DriveAccess {
  token: string
  readScope: DriveScope
}

/** The scope of a personal connection: whatever its grant reads. */
export const PERSONAL_DRIVE_SCOPE: DriveScope = { kind: "all" }

function metadataObject(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {}
}

/** The shared drives chosen on a Drive account (malformed entries dropped). */
export function sharedDrivesOf(metadata: unknown): SharedDrive[] {
  const raw = metadataObject(metadata).sharedDrives
  if (!Array.isArray(raw)) return []
  const out: SharedDrive[] = []
  for (const entry of raw) {
    const parsed = sharedDriveSchema.safeParse(entry)
    if (parsed.success && !out.some((d) => d.id === parsed.data.id)) out.push(parsed.data)
  }
  return out.slice(0, MAX_SHARED_DRIVES)
}

/** What a Drive connected account may read, from its owner and metadata. */
export function driveScopeOf(account: { ownerType: string; metadata: unknown }): DriveScope {
  if (account.ownerType !== "org") return PERSONAL_DRIVE_SCOPE
  return { kind: "sharedDrives", drives: sharedDrivesOf(account.metadata) }
}

/** An org connection that has no shared drive chosen yet: it reads nothing. */
export function awaitsSharedDrives(scope: DriveScope): boolean {
  return scope.kind === "sharedDrives" && scope.drives.length === 0
}

export const SHARED_DRIVES_NOT_CHOSEN_MESSAGE =
  "This organization's Google Drive connection shares no shared drive yet, so Liaison reads none of its files. An admin picks the shared drives the team should see (Settings > Connectors > Google Drive, `liaison config apply`, or the google-drive shared_drives tool)."

export const OUTSIDE_SHARED_DRIVES_MESSAGE =
  "This file is not in a shared drive this organization's Drive connection shares. Files in someone's My Drive are read only through that person's own Drive connection."

export const ORG_UPLOAD_UNSUPPORTED_MESSAGE =
  "The organization's Google Drive connection only reads its chosen shared drives: Liaison does not save files through it (they would land in the connecting account's own My Drive). Save to your own Drive with a personal Drive connection."
