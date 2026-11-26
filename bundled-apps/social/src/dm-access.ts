// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Instagram direct messages switched off by the account owner. Graph answers the
// conversations read with HTTP 403, error code 200, "The account owner has
// disabled access to Instagram Direct Messaging Outside of Instagram App" until
// someone turns on "Allow access to messages" in the Instagram app. It is off by
// default on new professional accounts, and no reconnect fixes it.
//
// The DM sync stamps it on the account's own sync_state row
// (`metadata.dmAccessDisabledSince`, the same place as `noTokenSince`), says it
// once at warn, and clears it on the first sync that lands. `connections_status`
// (an issue on the connection) and `dm_list` (a notice the Messages view shows)
// read the stamp, so the person sees why no DMs arrive and what to do.
import type { SocialToolCtx } from "./ctx"
import { metadataObject } from "./quota"

export const DM_ACCESS_DISABLED_METADATA_KEY = "dmAccessDisabledSince"

export const DM_ACCESS_DISABLED_MESSAGE =
  'Instagram direct messages are turned off for this account. In the Instagram app, open Settings and activity → Messages and story replies → Message requests → Connected tools, and turn on "Allow access to messages". Messages arrive on the next sync.'

/** Graph's answer when the owner has not allowed access to messages. */
export function isDmAccessDisabled(res: { status: number; body: string }): boolean {
  if (res.status < 400) return false
  try {
    const parsed = JSON.parse(res.body) as { error?: { code?: unknown; message?: unknown } }
    return (
      parsed.error?.code === 200 &&
      typeof parsed.error.message === "string" &&
      /disabled access to instagram direct messaging/i.test(parsed.error.message)
    )
  } catch {
    return false
  }
}

export interface DmAccessNotice {
  code: "dm_access_disabled"
  platform: "instagram"
  accountExternalId: string
  since: string
  message: string
}

interface StampableRow {
  id: string
  metadata?: unknown
}

/** Stamp the state; true the first time (the caller says it once at warn). */
export async function noteDmAccessDisabled(
  ctx: SocialToolCtx,
  row: StampableRow,
): Promise<boolean> {
  const meta = metadataObject(row.metadata)
  if (typeof meta[DM_ACCESS_DISABLED_METADATA_KEY] === "string") return false
  const metadata = { ...meta, [DM_ACCESS_DISABLED_METADATA_KEY]: new Date().toISOString() }
  await ctx.db.update("sync_state", row.id, { metadata })
  row.metadata = metadata
  return true
}

/** A sync landed: drop the stamp, so a later switch-off is said again. */
export async function clearDmAccessDisabled(ctx: SocialToolCtx, row: StampableRow): Promise<void> {
  const meta = metadataObject(row.metadata)
  if (!(DM_ACCESS_DISABLED_METADATA_KEY in meta)) return
  const { [DM_ACCESS_DISABLED_METADATA_KEY]: _dropped, ...rest } = meta
  await ctx.db.update("sync_state", row.id, { metadata: rest })
  row.metadata = rest
}

/** Every Instagram DM account currently stamped as switched off. */
export async function dmAccessNotices(ctx: SocialToolCtx): Promise<DmAccessNotice[]> {
  const rows = (await ctx.db.findMany("sync_state", {
    where: { platform: "instagram", source_type: "dm", active: true },
    limit: 200,
  })) as Array<{ account_external_id: string; metadata?: unknown }>
  const out: DmAccessNotice[] = []
  for (const r of rows) {
    const since = metadataObject(r.metadata)[DM_ACCESS_DISABLED_METADATA_KEY]
    if (typeof since !== "string") continue
    out.push({
      code: "dm_access_disabled",
      platform: "instagram",
      accountExternalId: r.account_external_id,
      since,
      message: DM_ACCESS_DISABLED_MESSAGE,
    })
  }
  return out
}
