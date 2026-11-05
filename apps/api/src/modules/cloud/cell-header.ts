// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `x-liaison-cell` (managed edition only): every response names the instance
// that served it, by its registered instance id (modules/liaison-team/
// identity.ts), so a client measuring an org's move between two instances can
// tell which one answered each request. Checked per request: a self-hosted
// instance never sends it. The id is read at most every 30 s.

import { createMiddleware } from "hono/factory"
import type { AppEnv } from "~/app"
import { withSystemDb } from "~/db/privileged"
import { isManagedEdition } from "~/lib/edition"
import { rootLogger } from "~/lib/logger"
import { readIdentity } from "~/modules/liaison-team/identity"

export const CELL_HEADER = "x-liaison-cell"
const CACHE_MS = 30_000

let cached: { at: number; id: string | null } | null = null
let loading: Promise<string | null> | null = null

async function servingInstanceId(): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.id
  if (!loading) {
    loading = withSystemDb("cell-header-identity", (db) => readIdentity(db))
      .then((identity) => {
        const id = identity?.state === "registered" ? identity.instanceId : null
        cached = { at: Date.now(), id }
        return id
      })
      .catch((err) => {
        rootLogger.warn({ err }, "cell header: identity unreadable; header omitted")
        return cached?.id ?? null
      })
      .finally(() => {
        loading = null
      })
  }
  return loading
}

/** Forget the cached id (tests, a new registration). */
export function clearCellHeaderCache(): void {
  cached = null
}

export const cellHeaderMiddleware = createMiddleware<AppEnv>(async (c, next) => {
  await next()
  if (!isManagedEdition()) return
  const id = await servingInstanceId()
  if (id) c.header(CELL_HEADER, id)
})
