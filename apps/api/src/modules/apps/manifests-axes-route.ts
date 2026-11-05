// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16 Task A8a — `GET /api/apps/manifests/attention-axes`.
//
// Walks the installed-app registry for the calling org and returns one row
// per installed app:
//   { app: string; kinds: string[]; filterableAxes: string[] }
// where:
//   - `kinds` is the union of every `attention.translations[].kind` the app
//     declares (the Settings page surfaces this as a per-app `kinds` selector);
//   - `filterableAxes` is the manifest's declared axes (may be empty).
//
// Apps without an `attention` block are absent from the response.
import { Hono } from "hono"
import type { AppEnv } from "~/app"
import { success } from "~/lib/response"
import {
  manifestAttentionAxesRegistry,
  manifestAttentionRegistry,
} from "~/modules/apps/app-registries"

export const manifestsAxesRoutes = new Hono<AppEnv>()

interface AxesRow {
  app: string
  kinds: string[]
  filterableAxes: string[]
}

manifestsAxesRoutes.get("/attention-axes", async (c) => {
  const orgId = c.get("orgId")
  const byApp = new Map<string, AxesRow>()

  // Pass 1 — collect translations → kinds union per app.
  for (const [key, translations] of manifestAttentionRegistry.entriesOf(orgId)) {
    const appName = key[1]
    const kinds = new Set<string>()
    for (const t of translations) kinds.add(t.kind)
    byApp.set(appName, {
      app: appName,
      kinds: Array.from(kinds).sort(),
      filterableAxes: [],
    })
  }

  // Pass 2 — overlay declared filterableAxes. Apps with axes but no translations
  // are still included (axes-only declarations are legal in the schema, even if
  // they have no effect without a translation).
  for (const [key, axes] of manifestAttentionAxesRegistry.entriesOf(orgId)) {
    const appName = key[1]
    const existing = byApp.get(appName)
    if (existing) {
      existing.filterableAxes = [...axes]
    } else {
      byApp.set(appName, { app: appName, kinds: [], filterableAxes: [...axes] })
    }
  }

  const rows = Array.from(byApp.values()).sort((a, b) => a.app.localeCompare(b.app))
  return success(c, rows)
})
