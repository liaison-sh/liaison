// SPDX-License-Identifier: FSL-1.1-ALv2
// Handler bundle for __APP_NAME__.
//
// Each tool declared in app.manifest.json maps to a named export here by its
// `handler` string. Handlers receive `(params, ctx)` where `ctx` is the
// AppContext (db, emit, enqueueJob, fetch, connections, logger).
import type { AppContext } from "@liaison/app-sdk"

/** List items. Wire this up to `ctx.db` once you add an `items` entity. */
export async function items_list(
  _params: Record<string, unknown>,
  _ctx: AppContext,
): Promise<{ data: Array<{ id: string; text: string }> }> {
  return { data: [] }
}
