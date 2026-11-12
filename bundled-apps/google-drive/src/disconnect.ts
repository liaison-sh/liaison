// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel/connected_account:disconnect`: the Knowledge content the app synced
// through the disconnected account goes with it (its folders and picked files,
// their documents and links). Only the connection id is passed on: the platform
// reads owner, account and state from the kernel row, and keeps everything when
// the same person still holds an active connection of that Google account.

import { appSource, type DriveCtx } from "./ctx"

interface DisconnectEvent {
  data?: { id?: string; appName?: string }
}

export async function onAccountDisconnected(event: DisconnectEvent, ctx: DriveCtx): Promise<void> {
  if (event.data?.appName !== "google-drive" || typeof event.data.id !== "string") return
  const result = await appSource<Record<string, unknown>>(ctx, {
    op: "purgeAccount",
    connectionId: event.data.id,
  })
  ctx.logger.info("drive disconnect: synced content of the account deleted", result)
}
