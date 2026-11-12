// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `ctx` the Drive app's handlers receive: the SDK's AppContext plus the
// flat bridge methods it uses that the SDK types as optional extras.

import type { AppContext } from "@liaison/app-sdk"

/** One of the app's own knowledge sources, as `knowledge_appSource` answers it. */
export interface AppSourceView {
  id: string
  kind: string
  ref: string
  config: Record<string, unknown>
  ownerUserId: string | null
  sourceAccount: string | null
  lastSyncStatus: string
  lastSyncAt: string | null
  lastError: string | null
  documents: number
}

export interface DriveCtx extends AppContext {
  /** The person the run acts for. */
  getUserId(): Promise<string>
  /** Download a file onto one of the app's own parents, host-side (bytes never cross). */
  files_importFromUrl?: (argsJson: string) => Promise<string>
  /** The app's own knowledge sources: `get` one by kind and ref, `list` them. */
  knowledge_appSource?: (paramsJson: string) => Promise<string>
  /**
   * `ensure` a source, `sync` one now, `purgeAccount` the content of the sources a
   * disconnected account synced (the kernel row decides).
   */
  knowledge_appSourceWrite?: (paramsJson: string) => Promise<string>
}

const WRITES = new Set(["ensure", "sync", "purgeAccount"])

export async function appSource<T>(ctx: DriveCtx, params: Record<string, unknown>): Promise<T> {
  const method = WRITES.has(String(params.op)) ? ctx.knowledge_appSourceWrite : ctx.knowledge_appSource
  if (!method) throw new Error("This server cannot manage an app's knowledge sources.")
  return JSON.parse(await method(JSON.stringify(params))) as T
}
