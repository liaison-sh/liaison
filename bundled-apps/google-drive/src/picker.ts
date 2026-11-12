// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Picked mode: a Drive connected with `drive.file` only (a personal Google
// account on a client Google has not verified for restricted scopes) sees the
// files the person chose in Google's picker, and the files Liaison created.
//
// The picker is the platform's Google Picker widget on the app's page
// (`pages.picker.widget`): the platform runs it in the person's browser with a
// drive.file-only grant, and this app never sees the token; the widget calls the
// `savePicks` route, which records the picks on the account and syncs them into
// Knowledge (the account's `picked` source). `drive_picker` (a tool) answers the
// page handle the conversation shows as an Open button; the settings screen lists
// the picks (`picker_state`) and removes one (`picker_remove`).

import type { AppAccount } from "@liaison/app-sdk"
import { type AppSourceView, appSource, type DriveCtx } from "./ctx"
import {
  DRIVE_CONNECTION,
  DRIVE_FOLDER_MIME,
  driveHasText,
  driveModeOf,
  driveTypeLabel,
  mergePickedItems,
  type PickedItem,
  parsePickedItems,
  pickedItemsOf,
} from "./model"

/** The folder ref of the source that holds an account's picked items (kept from earlier releases). */
export const PICKED_ROOT_REF = "liaison-picked-items"
/** How often the picked items sync again on their own. */
const PICKED_SYNC_INTERVAL_SECONDS = 15 * 60

export interface PickerConfig {
  apiKey: string
  appId: string
}

/** The Google Picker's key and project number (`provision.picker`), or null when not set up. */
export async function pickerConfig(ctx: DriveCtx): Promise<PickerConfig | null> {
  const apiKey = await ctx.config.get("pickerApiKey")
  const appId = await ctx.config.get("pickerAppId")
  return typeof apiKey === "string" && apiKey && typeof appId === "string" && appId
    ? { apiKey, appId }
    : null
}

/** The accounts a person may pick on: their own, and the org's when they manage it. */
async function pickableAccounts(ctx: DriveCtx): Promise<AppAccount[]> {
  return (await ctx.accounts.list(DRIVE_CONNECTION)).filter(
    (a) => a.ownerType === "user" || a.canManage,
  )
}

async function pickedSource(ctx: DriveCtx, account: AppAccount): Promise<AppSourceView | null> {
  if (!ctx.knowledge_appSource) return null
  return appSource<AppSourceView | null>(ctx, {
    op: "get",
    kind: "picked",
    ref: PICKED_ROOT_REF,
    scope: account.ownerType === "org" ? "organization" : "personal",
    account: account.identifier,
  })
}

export function notImportedOf(picked: readonly PickedItem[]) {
  return picked
    .filter((p) => p.mimeType !== DRIVE_FOLDER_MIME && !driveHasText(p.mimeType))
    .map((p) => ({ id: p.id, name: p.name, type: driveTypeLabel(p.mimeType) }))
}

/** `picker_state`: the person's accounts, their mode, picks and the sync of the picks. */
export async function pickerState(_params: unknown, ctx: DriveCtx): Promise<unknown> {
  const accounts = []
  for (const a of await pickableAccounts(ctx)) {
    const picked = pickedItemsOf(a.metadata)
    const source = driveModeOf(a.metadata) === "picked" ? await pickedSource(ctx, a) : null
    accounts.push({
      id: a.id,
      identifier: a.identifier,
      ownerType: a.ownerType,
      mode: driveModeOf(a.metadata),
      picked,
      notImported: notImportedOf(picked),
      sync: source
        ? {
            status: source.lastSyncStatus,
            documents: source.documents,
            lastError: source.lastError,
          }
        : null,
    })
  }
  return { pickerConfigured: (await pickerConfig(ctx)) !== null, accounts }
}

function accountOf(accounts: AppAccount[], ref: unknown): AppAccount | null {
  if (typeof ref !== "string") return null
  return (
    accounts.find((a) => a.id === ref || a.identifier.toLowerCase() === ref.toLowerCase()) ?? null
  )
}

/** `drive_picker`: the Drive mode of the person's accounts, and a page handle to pick files. */
export async function drivePicker(params: { account?: string }, ctx: DriveCtx): Promise<unknown> {
  const accounts = await pickableAccounts(ctx)
  if (accounts.length === 0) {
    return {
      error: {
        code: "not_connected",
        message:
          "No Google Drive connection: connect Drive first (Settings > Connectors > Google Drive).",
      },
    }
  }
  const modes = accounts.map((a) => ({
    account: a.identifier,
    ownerType: a.ownerType,
    mode: driveModeOf(a.metadata),
    pickedFiles: pickedItemsOf(a.metadata).map((i) => ({
      driveFileId: i.id,
      name: i.name,
      mimeType: i.mimeType,
    })),
  }))
  const pickable = accounts.filter((a) => driveModeOf(a.metadata) === "picked")
  const target = params.account
    ? accountOf(pickable, params.account)
    : (pickable.find((a) => a.ownerType === "user") ?? pickable[0])
  if (!target) {
    return {
      accounts: modes,
      message:
        "This Drive reads the whole Drive (mode full): there is nothing to pick. Search and read the file directly.",
    }
  }
  const config = await pickerConfig(ctx)
  if (!config) {
    return {
      accounts: modes,
      error: {
        code: "picker_not_configured",
        message:
          "The Google Picker is not set up on this server: an admin sets provision.picker (apiKey, appId) for google-drive with `liaison config apply`. Until then Liaison sees only the files already picked and the files it created.",
      },
    }
  }
  const page = await ctx.pages.link("picker", {
    account: target.id,
    apiKey: config.apiKey,
    appId: config.appId,
  })
  return {
    accounts: modes,
    page,
    message: `Shown: an Open button where the person picks the files of ${target.identifier} Liaison may see. The picks sync into Knowledge.`,
  }
}

async function savePickChange(
  ctx: DriveCtx,
  accountRef: unknown,
  change: { add: PickedItem[]; remove: string[] },
): Promise<{ picked: PickedItem[]; sourceId: string | null }> {
  const account = accountOf(await pickableAccounts(ctx), accountRef)
  if (!account) throw new PickError("not_found", "No Drive account of yours with this id")
  if (driveModeOf(account.metadata) !== "picked") {
    throw new PickError(
      "not_picked_mode",
      "This Drive account reads the whole Drive: there are no files to pick",
    )
  }
  const picked = mergePickedItems(pickedItemsOf(account.metadata), change.add, change.remove)
  await ctx.accounts.setMetadata(account.id, { pickedItems: picked })
  let sourceId: string | null = null
  if (ctx.knowledge_appSource) {
    const source = await appSource<AppSourceView>(ctx, {
      op: "ensure",
      kind: "picked",
      ref: PICKED_ROOT_REF,
      config: { ref: PICKED_ROOT_REF, account: account.identifier },
      account: account.identifier,
      displayName: `Google Drive: ${account.identifier}`,
      scope: account.ownerType === "org" ? "organization" : "personal",
      syncIntervalSeconds: PICKED_SYNC_INTERVAL_SECONDS,
    })
    sourceId = source.id
    await appSource(ctx, { op: "sync", id: source.id })
  }
  return { picked, sourceId }
}

class PickError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** The page's route: what the person picked in Google's picker, for the link's account. */
export async function savePicks(
  p: { body: unknown; params: Record<string, unknown>; page: string },
  ctx: DriveCtx,
): Promise<unknown> {
  const body = (p.body && typeof p.body === "object" ? p.body : {}) as { add?: unknown }
  const add = parsePickedItems(body.add)
  if (!add)
    return {
      error: { code: "invalid_body", message: "add: 1 to 500 picked items {id, name, mimeType}" },
    }
  try {
    return await savePickChange(ctx, p.params.account, { add, remove: [] })
  } catch (err) {
    if (err instanceof PickError) return { error: { code: err.code, message: err.message } }
    throw err
  }
}

/** `picker_remove`: Liaison stops seeing one picked item (the next sync removes it from Knowledge). */
export async function pickerRemove(
  params: { account?: string; itemId?: string },
  ctx: DriveCtx,
): Promise<unknown> {
  if (typeof params.itemId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(params.itemId)) {
    return { error: { code: "invalid_params", message: "itemId is required" } }
  }
  try {
    return await savePickChange(ctx, params.account, { add: [], remove: [params.itemId] })
  } catch (err) {
    if (err instanceof PickError) return { error: { code: err.code, message: err.message } }
    throw err
  }
}
