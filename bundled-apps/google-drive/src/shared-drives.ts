// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shared drives an ORGANIZATION Drive connection shares with the team
// (model.ts): listed and chosen by an admin (the connection's admin scope), by
// the agent's gated tool, the settings screen or `config apply`
// (`provision.sharedDrives`). A change makes the folders that sync through the
// account sync again now, so what they hold follows the new choice.

import type { AppAccount } from "@liaison/app-sdk"
import { appSource, type AppSourceView, type DriveCtx } from "./ctx"
import { driveClient } from "./drive"
import { accessOf, DRIVE_CONNECTION, MAX_SHARED_DRIVES, type SharedDrive, sharedDrivesOf } from "./model"

export class SharedDrivesError extends Error {
  constructor(
    readonly code: "forbidden" | "not_found" | "not_a_member" | "too_many" | "invalid_params",
    message: string,
  ) {
    super(message)
  }
}

export interface OrgDriveAccountView {
  id: string
  identifier: string
  sharedDrives: SharedDrive[]
  needsSharedDrives: boolean
}

function viewOf(a: AppAccount): OrgDriveAccountView {
  const sharedDrives = sharedDrivesOf(a.metadata)
  return { id: a.id, identifier: a.identifier, sharedDrives, needsSharedDrives: sharedDrives.length === 0 }
}

async function orgAccounts(ctx: DriveCtx): Promise<AppAccount[]> {
  return (await ctx.accounts.list(DRIVE_CONNECTION)).filter((a) => a.ownerType === "org")
}

/** The org account a call is about: by its Google address, or the only one there is. */
function pickAccount(rows: AppAccount[], identifier?: string): AppAccount {
  const found = identifier
    ? rows.find((r) => r.identifier.toLowerCase() === identifier.toLowerCase() || r.id === identifier)
    : rows.length === 1
      ? rows[0]
      : undefined
  if (found) return found
  if (rows.length === 0) {
    throw new SharedDrivesError(
      "not_found",
      "This organization has no Google Drive connection of its own. Connect Drive for the organization first (Settings > Connectors > Google Drive).",
    )
  }
  throw new SharedDrivesError(
    "not_found",
    identifier
      ? "No organization Drive connection matches that account"
      : `This organization has several Drive connections (${rows.map((r) => r.identifier).join(", ")}): say which account`,
  )
}

function requireManage(account: AppAccount): void {
  if (!account.canManage) {
    throw new SharedDrivesError("forbidden", "Choosing the organization's shared drives needs google-drive:accounts:admin")
  }
}

function refusal(err: unknown): { error: { code: string; message: string } } {
  if (err instanceof SharedDrivesError) return { error: { code: err.code, message: err.message } }
  throw err
}

/** `shared_drives`: the org connections, their chosen drives, and (admin) what each can choose. */
export async function driveSharedDrives(params: { account?: string }, ctx: DriveCtx): Promise<unknown> {
  try {
    const rows = await orgAccounts(ctx)
    const canManage = rows.length > 0 && rows.every((r) => r.canManage)
    const state = { canManage, accounts: rows.map(viewOf) }
    if (!canManage || rows.length === 0) return state
    const row = pickAccount(rows, params.account)
    const chosen = new Set(sharedDrivesOf(row.metadata).map((d) => d.id))
    const member = await driveClient(ctx, accessOf(row)).sharedDrives()
    return {
      ...state,
      available: { account: viewOf(row), available: member.map((d) => ({ ...d, chosen: chosen.has(d.id) })) },
    }
  } catch (err) {
    return refusal(err)
  }
}

/**
 * Replace the shared drives an org Drive connection shares. `drives` names each
 * by id or by name (case-insensitive); each must be a shared drive the
 * connecting account is a member of. An empty list shares none (reads stop).
 */
export async function chooseSharedDrives(
  ctx: DriveCtx,
  identifier: string | undefined,
  drives: readonly string[],
  opts: { dryRun?: boolean } = {},
): Promise<{ account: OrgDriveAccountView; changed: boolean }> {
  if (drives.length > MAX_SHARED_DRIVES) {
    throw new SharedDrivesError("too_many", `At most ${MAX_SHARED_DRIVES} shared drives`)
  }
  const row = pickAccount(await orgAccounts(ctx), identifier)
  requireManage(row)
  const member = drives.length > 0 ? await driveClient(ctx, accessOf(row)).sharedDrives() : []
  const chosen: SharedDrive[] = []
  const unknown: string[] = []
  for (const wanted of drives) {
    const w = wanted.trim()
    const match = member.find((d) => d.id === w) ?? member.find((d) => d.name.toLowerCase() === w.toLowerCase())
    if (!match) unknown.push(w)
    else if (!chosen.some((d) => d.id === match.id)) chosen.push(match)
  }
  if (unknown.length > 0) {
    throw new SharedDrivesError(
      "not_a_member",
      `${row.identifier} is not a member of: ${unknown.join(", ")}. Add that Google account to each shared drive (any role) or connect with an account that is a member. Shared drives it can see: ${member.map((d) => d.name).join(", ") || "none"}.`,
    )
  }
  const before = sharedDrivesOf(row.metadata)
  const changed = before.length !== chosen.length || before.some((d, i) => d.id !== chosen[i]?.id)
  if (changed && !opts.dryRun) {
    // Audited by the platform with the keys changed.
    await ctx.accounts.setMetadata(row.id, { sharedDrives: chosen })
    ctx.logger.info("organization connection's shared drives changed", {
      account: row.id,
      sharedDrives: chosen.map((d) => d.id),
    })
    await resyncAccountSources(ctx, row.identifier)
  }
  return { account: viewOf({ ...row, metadata: { ...row.metadata, sharedDrives: chosen } }), changed }
}

/** The folders that sync through an org account sync again now, against its new choice. */
export async function resyncAccountSources(ctx: DriveCtx, identifier: string): Promise<void> {
  if (!ctx.knowledge_appSource) return
  const sources = await appSource<AppSourceView[]>(ctx, { op: "list" })
  for (const s of sources) {
    if (s.ownerUserId !== null) continue
    const via = typeof s.config.account === "string" ? s.config.account : s.sourceAccount
    if (via && via.toLowerCase() !== identifier.toLowerCase()) continue
    await appSource(ctx, { op: "sync", id: s.id })
  }
}

function drivesParam(raw: unknown): string[] | null {
  return Array.isArray(raw) ? raw.filter((d): d is string => typeof d === "string") : null
}

/** `choose_shared_drives` (gated: a person approves first). */
export async function driveChooseSharedDrives(
  params: { drives?: unknown; account?: string },
  ctx: DriveCtx,
): Promise<unknown> {
  const drives = drivesParam(params.drives)
  if (!drives) return { error: { code: "invalid_params", message: "drives (an array of ids or names) is required." } }
  try {
    return await chooseSharedDrives(ctx, params.account, drives)
  } catch (err) {
    return refusal(err)
  }
}

/** `shared_drives_save` (the settings screen of an admin: the person's own click, not gated). */
export async function driveSaveSharedDrives(
  params: { drives?: unknown; account?: string },
  ctx: DriveCtx,
): Promise<unknown> {
  return driveChooseSharedDrives(params, ctx)
}

interface ApprovalSummaryShape {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
}

/** Approval summary of `choose_shared_drives`: exactly which drives the team would see. */
export function summarizeChooseSharedDrives(params: unknown): Promise<ApprovalSummaryShape> {
  const p = params && typeof params === "object" && !Array.isArray(params) ? (params as Record<string, unknown>) : {}
  const drives = (Array.isArray(p.drives) ? p.drives : []).filter(
    (d): d is string => typeof d === "string" && d.trim() !== "",
  )
  const account = typeof p.account === "string" ? p.account : null
  return Promise.resolve({
    kind: "google_drive_shared_drives",
    title:
      drives.length === 0
        ? "Stop sharing every shared drive of the organization's Google Drive"
        : `Share ${drives.length} shared drive${drives.length === 1 ? "" : "s"} with the team`,
    ...(account ? { subtitle: `Drive connection: ${account}` } : {}),
    lines: [
      ...(drives.length > 0 ? [`Shared drives: ${drives.join(", ")}`] : []),
      "Replaces the shared drives this connection shares. Everyone who uses the organization's Drive connection sees the files in them; no one's My Drive is read.",
    ],
  })
}
