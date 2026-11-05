// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Google Drive RPC bridge extension.
//
// The Drive connector's host-side operations (`drive_search`, `drive_import`,
// `drive_export`) used to live inline in the generic sandbox bridge behind
// `requireApp("google-drive", …)` guards. They are app-specific — they call the
// Drive REST API with the connection's OAuth token — so they belong with the
// app, registered as a bridge extension that `createRpcBridge` merges into the
// Drive app's sandbox only. No app-name literal is needed in the kernel: the
// registry keys the factory by app at install time.

import type { DriveAccess } from "~/apps/google-drive/drive-scope"
import { appsLogger as log } from "~/lib/logger"
import type {
  BridgeExtensionContext,
  BridgeExtensionMethod,
} from "~/modules/apps/sandbox/bridge-extensions"

export function createGoogleDriveBridgeExtension(
  ctx: BridgeExtensionContext,
): Record<string, BridgeExtensionMethod> {
  const { txDb, orgId, userId } = ctx

  /** The caller's Drive connection: its token and read scope (drive-access.ts). */
  async function resolveDrive(): Promise<DriveAccess | null> {
    try {
      const { resolveDriveAccess } = await import("~/apps/google-drive/drive-access")
      const { token, readScope } = await resolveDriveAccess(txDb, orgId, userId)
      return { token, readScope }
    } catch (err) {
      // Log before returning null so infrastructure failures (DB errors, bugs in
      // the connections service) appear in the log stream even though callers
      // surface a "Drive not connected" response. Without this, a broken DB
      // connection is silently swallowed and looks identical to "user hasn't
      // connected Drive".
      log.warn({ err, orgId, userId }, "resolveDrive: failed to fetch the Drive connection")
      return null
    }
  }

  return {
    /**
     * `kernel/connected_account:disconnect` — delete the synced Drive content the
     * connection held (disconnect.ts). Runs privileged: the rows belong to the
     * disconnected user, not to whoever triggered the event. Only the connection
     * id is taken from the sandbox; owner, account and the disconnected state are
     * verified on the kernel row before anything is deleted. Refused on a
     * read-only run (rpc-bridge.ts READ_ONLY_REFUSED_BRIDGE_METHODS).
     */
    drive_onAccountDisconnected: async (eventJson: string): Promise<string> => {
      const { onDriveAccountDisconnected } = await import("~/apps/google-drive/disconnect")
      return JSON.stringify(await onDriveAccountDisconnected(orgId, JSON.parse(eventJson)))
    },

    /**
     * Google Drive connector — search the connected account. Resolves the OAuth
     * token + calls the Drive REST API.
     */
    drive_search: async (paramsJson: string): Promise<string> => {
      const { driveSearch } = await import("~/apps/google-drive/tools")
      const params = JSON.parse(paramsJson) as { query: string; limit?: number }
      const drive = await resolveDrive()
      // Picked mode: the picked items answer the search (tools.ts pickedSearch).
      const { pickedFilesForUser } = await import("~/apps/google-drive/picker")
      const mode = await pickedFilesForUser(orgId, userId)
      const result = await driveSearch(
        { tx: txDb, orgId, userId, drive, ...(mode.picked ? { picked: mode } : {}) },
        params,
      )
      return JSON.stringify(result)
    },

    /**
     * Google Drive connector — download a Drive file and materialise it into a
     * `kernel.files` row. Returns `{ fileId, filename, mimeType, sizeBytes }`;
     * the `fileId` is feedable straight into any send tool's `attachments`.
     */
    drive_import: async (paramsJson: string): Promise<string> => {
      const { driveImport } = await import("~/apps/google-drive/tools")
      const params = JSON.parse(paramsJson) as { driveFileId: string }
      const drive = await resolveDrive()
      const result = await driveImport({ tx: txDb, orgId, userId, drive }, params)
      return JSON.stringify(result)
    },

    /**
     * Google Drive connector — read a Drive file's TEXT content. Returns
     * `{ driveFileId, name, mimeType, content, contentMimeType, ... }`; a native
     * Google Sheet is exported as CSV (rows), a Doc/Slides as plain text, a
     * downloadable text file as its text. Binary files are not readable here —
     * use `drive_import` for those.
     */
    drive_read: async (paramsJson: string): Promise<string> => {
      const { driveRead } = await import("~/apps/google-drive/tools")
      const params = JSON.parse(paramsJson) as { driveFileId: string }
      const drive = await resolveDrive()
      const result = await driveRead({ tx: txDb, orgId, userId, drive }, params)
      return JSON.stringify(result)
    },

    /**
     * Google Drive connector — upload a NEW file (files.create multipart) into
     * the app-owned "Liaison Reports" folder. Bytes come from `sourceFileId`
     * (a kernel.files id — preferred, nothing travels through the caller) or
     * `contentBase64`; either way ≤ 5 MB decoded. Returns
     * `{ fileId, name, webViewLink, folderId }`, or a named error
     * (`drive_scope_missing`, `file_too_large`, `source_not_found`,
     * `not_connected`).
     */
    drive_upload: async (paramsJson: string): Promise<string> => {
      const { driveUpload } = await import("~/apps/google-drive/tools")
      const params = JSON.parse(paramsJson) as {
        name: string
        mimeType?: string
        contentBase64?: string
        sourceFileId?: string
      }
      const drive = await resolveDrive()
      const result = await driveUpload({ tx: txDb, orgId, userId, drive }, params)
      return JSON.stringify(result)
    },

    /**
     * Google Drive connector — the organization's Drive connections and the
     * shared drives each shares (shared-drives.ts); for an admin also the shared
     * drives the connecting account is a member of. Refused without the
     * connection's admin scope.
     */
    drive_sharedDrives: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson) as { account?: string }
      const shared = await import("~/apps/google-drive/shared-drives")
      const caller = { orgId, userId, scopes: ctx.callerScopes ?? [] }
      try {
        const state = await shared.sharedDrivesState(caller)
        if (!state.canManage || state.accounts.length === 0) return JSON.stringify(state)
        const pick = params.account ? { identifier: params.account } : {}
        const available = await shared.availableSharedDrives(caller, pick)
        return JSON.stringify({ ...state, available })
      } catch (err) {
        if (err instanceof shared.SharedDrivesError) {
          return JSON.stringify({ error: { code: err.code, message: err.message } })
        }
        throw err
      }
    },

    /**
     * Google Drive connector — replace the shared drives the organization's
     * Drive connection shares (gated: a person approves first).
     */
    drive_chooseSharedDrives: async (paramsJson: string): Promise<string> => {
      const params = JSON.parse(paramsJson) as { drives?: unknown; account?: string }
      const drives = Array.isArray(params.drives)
        ? params.drives.filter((d): d is string => typeof d === "string")
        : null
      if (!drives) {
        return JSON.stringify({
          error: {
            code: "invalid_params",
            message: "drives (an array of ids or names) is required.",
          },
        })
      }
      const shared = await import("~/apps/google-drive/shared-drives")
      const caller = { orgId, userId, scopes: ctx.callerScopes ?? [] }
      try {
        const pick = params.account ? { identifier: params.account } : {}
        return JSON.stringify(await shared.chooseSharedDrives(caller, pick, drives))
      } catch (err) {
        if (err instanceof shared.SharedDrivesError) {
          return JSON.stringify({ error: { code: err.code, message: err.message } })
        }
        throw err
      }
    },

    /**
     * Google Drive connector — export the connected Drive accounts. Backs the
     * manifest `export` slot; runs under the caller's RLS context.
     */
    drive_export: async (paramsJson: string): Promise<string> => {
      const { driveExport } = await import("~/apps/google-drive/tools")
      const params = JSON.parse(paramsJson) as {
        format?: string
        dateRange?: { from?: string; to?: string }
      }
      // Export reads connected_accounts directly — no Drive token needed.
      const result = await driveExport({ tx: txDb, orgId, userId, drive: null }, params)
      return JSON.stringify(result)
    },
  }
}
