// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `apps[].connection.sharedDrives` (google-drive only): the Shared Drives the
 * organization's Drive connection shares with the team, by id or by name, set
 * through the same service as the Settings card and the agent's
 * `choose_shared_drives` tool (apps/google-drive/shared-drives.ts). An org Drive
 * connection reads nothing until they are chosen (apps/google-drive/drive-scope.ts).
 *
 * The connection itself is OAuth (`liaison connect google-drive/drive`): until it
 * exists the choice is reported pending, and the next apply sets it. A drive the
 * connecting account is not a member of fails the apply by name.
 */
import { ConfigError } from "~/cli/config/parse"
import type { PendingItem, ProvisionContext } from "~/cli/provisioners/types"

export async function applyDriveSharedDrives(
  ctx: ProvisionContext,
  drives: readonly string[],
): Promise<{ changed: string[]; unchanged: string[]; pending: PendingItem[] }> {
  const { chooseSharedDrives, SharedDrivesError, sharedDrivesState } = await import(
    "~/apps/google-drive/shared-drives"
  )
  const caller = { orgId: ctx.orgId, userId: ctx.actor.userId, scopes: ctx.actor.scopes }
  const state = await sharedDrivesState(caller)
  if (state.accounts.length === 0) {
    ctx.log(
      "app 'google-drive': shared drives are chosen once the organization's Drive is connected",
    )
    return {
      changed: [],
      unchanged: [],
      pending: [
        {
          kind: "oauth",
          app: "google-drive",
          connection: "drive",
          action: "liaison connect google-drive/drive, then re-run config apply",
          message:
            "The shared drives are set once the organization's Google Drive is connected (with an account that is a member of each).",
        },
      ],
    }
  }
  const changed: string[] = []
  const unchanged: string[] = []
  for (const account of state.accounts) {
    try {
      const r = await chooseSharedDrives(caller, { accountId: account.id }, drives)
      const names = r.account.sharedDrives.map((d) => d.name).join(", ") || "none"
      ctx.log(`app 'google-drive': ${account.identifier} shares ${names}`)
      ;(r.changed ? changed : unchanged).push(
        `apps.google-drive.drive.sharedDrives.${account.identifier}`,
      )
    } catch (err) {
      if (err instanceof SharedDrivesError) {
        throw new ConfigError(`apps: 'google-drive' sharedDrives: ${err.message}`)
      }
      throw err
    }
  }
  return { changed, unchanged, pending: [] }
}
