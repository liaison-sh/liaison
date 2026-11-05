// SPDX-License-Identifier: FSL-1.1-ALv2
//
// An account with no OAuth token is an EXPECTED state: never connected, a
// disconnect, a token the host refused. The sync skips it every tick, and it
// used to say so at error level every tick, which on a demo instance (seeded
// accounts, no real connections) was ~100 error lines per 15 minutes burying
// the real errors. The account's connection status is what tells a person; the
// log says it once, at info, when the account is first seen without a token,
// and at debug on every later skip until a token comes back.
//
// "Once" survives ticks because it is stamped on the account's own sync_state
// row (`metadata.noTokenSince`), cleared the first time a token resolves again.
import type { SocialToolCtx } from "./ctx"
import { metadataObject } from "./quota"

export const NO_TOKEN_METADATA_KEY = "noTokenSince"

interface StampableRow {
  id: string
  metadata?: unknown
}

/** Log a skip for want of a token: info the first time for this row, debug after. */
export async function noteMissingToken(
  ctx: SocialToolCtx,
  row: StampableRow | null | undefined,
  message: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const meta = row ? metadataObject(row.metadata) : null
  if (meta && typeof meta[NO_TOKEN_METADATA_KEY] === "string") {
    ctx.logger?.debug?.(message, fields)
    return
  }
  ctx.logger?.info?.(message, fields)
  if (!row || !meta) return
  const since = new Date().toISOString()
  const metadata = { ...meta, [NO_TOKEN_METADATA_KEY]: since }
  await ctx.db.update("sync_state", row.id, { metadata })
  row.metadata = metadata
}

/** A token resolved: forget the stamp, so a later loss is said again. */
export async function clearMissingToken(
  ctx: SocialToolCtx,
  row: StampableRow | null | undefined,
): Promise<void> {
  if (!row) return
  const meta = metadataObject(row.metadata)
  if (!(NO_TOKEN_METADATA_KEY in meta)) return
  const { [NO_TOKEN_METADATA_KEY]: _dropped, ...rest } = meta
  await ctx.db.update("sync_state", row.id, { metadata: rest })
  row.metadata = rest
}
