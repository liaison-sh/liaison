// SPDX-License-Identifier: FSL-1.1-ALv2
// Google Drive connector — sandboxed manifest handler bundle.
//
// Drive is the reference HEADLESS app: a backend-only connector with no
// frontend. Its agent tools are thin sandboxed handlers that delegate to
// host-side rpc-bridge methods (`drive_*`), where OAuth-token resolution, the
// Drive REST calls, and `kernel.files` materialisation happen with host
// privileges. This mirrors the tickets handler ↔ bridge split.
//
// biome-ignore-all lint/correctness/noUnusedVariables: handlers resolved by manifest export name

// Type-only import forces TypeScript to treat this file as a module so its
// top-level function names don't collide with another app's handlers in the
// shared global type scope. Bun strips it at bundle time; the QuickJS runtime
// still sees script-mode source where the declarations auto-promote to global.
import type {} from "node:buffer"

interface DriveSandboxCtx {
  drive_search: (paramsJson: string) => Promise<string>
  drive_import: (paramsJson: string) => Promise<string>
  drive_read: (paramsJson: string) => Promise<string>
  drive_upload: (paramsJson: string) => Promise<string>
  drive_export: (paramsJson: string) => Promise<string>
  drive_sharedDrives: (paramsJson: string) => Promise<string>
  drive_chooseSharedDrives: (paramsJson: string) => Promise<string>
  drive_onAccountDisconnected: (eventJson: string) => Promise<string>
}

interface DriveDisconnectEvent {
  data?: { id?: string; appName?: string; ownerType?: string; ownerId?: string | null }
}

/** `kernel/connected_account:disconnect` — the synced Drive content goes with the connection. */
async function onAccountDisconnected(
  event: DriveDisconnectEvent,
  ctx: DriveSandboxCtx,
): Promise<void> {
  if (event.data?.appName !== "google-drive") return
  await ctx.drive_onAccountDisconnected(JSON.stringify(event))
}

/** `google-drive:search` — find files in the connected Drive. */
async function driveSearch(params: unknown, ctx: DriveSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.drive_search(JSON.stringify(params ?? {})))
}

/** `google-drive:import` — pull a Drive file in as an attachable `kernel.files` row. */
async function driveImport(params: unknown, ctx: DriveSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.drive_import(JSON.stringify(params ?? {})))
}

/** `google-drive:read` — read a Drive file's TEXT content (Sheet → CSV, Doc → text). */
async function driveRead(params: unknown, ctx: DriveSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.drive_read(JSON.stringify(params ?? {})))
}

/** `google-drive:upload` — write a NEW file into the app-owned Drive folder. */
async function driveUpload(params: unknown, ctx: DriveSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.drive_upload(JSON.stringify(params ?? {})))
}

/** Manifest `export` slot — export the connected Drive accounts. */
async function exportGoogleDrive(params: unknown, ctx: DriveSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.drive_export(JSON.stringify(params ?? {})))
}

/** `google-drive:shared_drives` — the org connection's shared drives, chosen and available. */
async function driveSharedDrives(params: unknown, ctx: DriveSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.drive_sharedDrives(JSON.stringify(params ?? {})))
}

/** `google-drive:choose_shared_drives` — replace the shared drives the org connection shares. */
async function driveChooseSharedDrives(params: unknown, ctx: DriveSandboxCtx): Promise<unknown> {
  return JSON.parse(await ctx.drive_chooseSharedDrives(JSON.stringify(params ?? {})))
}

// Approval summarizer of `choose_shared_drives`, resolved by the manifest's
// `summarizer` name. It lives in this bundle because Drive is sandboxed: the
// sandbox evaluates only this file, so a summarizer kept in another module is
// never found and the approval card falls back to raw params. Pure (no bridge).
interface ApprovalSummaryShape {
  kind: string
  title: string
  subtitle?: string
  lines: string[]
}

/**
 * `choose_shared_drives`: the reviewer sees exactly which shared drives the
 * organization's Drive connection will share with every member who uses it.
 */
function summarizeChooseSharedDrives(params: unknown): Promise<ApprovalSummaryShape> {
  const p = params && typeof params === "object" && !Array.isArray(params) ? params : {}
  const raw = "drives" in p && Array.isArray(p.drives) ? p.drives : []
  const drives = raw.filter((d): d is string => typeof d === "string" && d.trim() !== "")
  const account = "account" in p && typeof p.account === "string" ? p.account : null
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
