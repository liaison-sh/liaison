// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `liaison config apply` for google-drive (`apps[].provision`): the shared drives
// each organization Drive connection shares. Run after the connection; a dry run
// (`config verify`, `--dry-run`) reports what would change and writes nothing.
// The Google Picker's key and project number are plain config keys
// (`apps[].config.pickerApiKey` / `pickerAppId`).

import type { ProvisionParams, ProvisionResult } from "@liaison/app-sdk"
import type { DriveCtx } from "./ctx"
import { chooseSharedDrives, SharedDrivesError } from "./shared-drives"

interface DriveProvision {
  sharedDrives?: Array<{ account?: string; drives: string[] }>
}

export async function provisionDrive(
  p: ProvisionParams<DriveProvision>,
  ctx: DriveCtx,
): Promise<ProvisionResult> {
  const changed: string[] = []
  for (const entry of p.config.sharedDrives ?? []) {
    try {
      const out = await chooseSharedDrives(ctx, entry.account, entry.drives, { dryRun: p.dryRun })
      if (out.changed) {
        changed.push(
          `sharedDrives ${out.account.identifier}: ${out.account.sharedDrives.map((d) => d.name).join(", ") || "none"}`,
        )
      }
    } catch (err) {
      if (err instanceof SharedDrivesError)
        throw new Error(`provision.sharedDrives: ${err.message}`)
      throw err
    }
  }
  return { changed }
}
