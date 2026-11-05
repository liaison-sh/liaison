// SPDX-License-Identifier: FSL-1.1-ALv2
import { createStore, produce } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"

export interface PreviewCacheEntry {
  loading: boolean
  error: string | null
  deleted: boolean
  entity: any | null
  timeline: PreviewTimelineEntry[] | null
}

export interface PreviewTimelineEntry {
  /** Who did it, by name; null for a system change (the view shows the action alone). */
  actor: string | null
  action: string
  occurredAt: string
}

/** One row of `GET /timeline/:app/:entityType/:id`, as far as the preview reads it. */
interface TimelineRow {
  actorName: string | null
  action: string
  createdAt: string
}

interface PreviewStoreState {
  byKey: Record<string, PreviewCacheEntry>
}

export interface PreviewApi {
  getEnvelope: <T>(path: string) => Promise<{ data: T }>
}

const [previewStore, setPreviewStore] = createStore<PreviewStoreState>({ byKey: {} })

function key(app: string, entityType: string, id: string): string {
  return `${app}:${entityType}:${id}`
}

export function getCached(
  app: string,
  entityType: string,
  id: string,
): PreviewCacheEntry | undefined {
  return previewStore.byKey[key(app, entityType, id)]
}

export async function loadPreview(
  api: PreviewApi,
  app: string,
  entityType: string,
  id: string,
  fetcher: (id: string, api: PreviewApi) => Promise<any>,
): Promise<void> {
  const cacheKey = key(app, entityType, id)
  const existing = previewStore.byKey[cacheKey]
  if (existing && !existing.error && existing.entity) return

  setPreviewStore("byKey", cacheKey, {
    loading: true,
    error: null,
    deleted: false,
    entity: null,
    timeline: null,
  })

  try {
    const [entityResult, timelineResult] = await Promise.all([
      fetcher(id, api)
        .then((entity) => ({ entity, deleted: false }))
        .catch((err: any) => {
          if (err?.status === 404 || err?.message === "404") return { entity: null, deleted: true }
          throw err
        }),
      api
        .getEnvelope<TimelineRow[]>(`/timeline/${app}/${entityType}/${id}?limit=5`)
        .catch(() => ({ data: [] })),
    ])

    setPreviewStore("byKey", cacheKey, {
      loading: false,
      error: null,
      deleted: entityResult.deleted,
      entity: entityResult.entity,
      timeline: (timelineResult.data ?? []).slice(0, 5).map((entry) => ({
        actor: entry.actorName ?? null,
        action: entry.action,
        occurredAt: entry.createdAt,
      })),
    })
  } catch (err: any) {
    setPreviewStore("byKey", cacheKey, {
      loading: false,
      error: err?.message ?? "Failed to load",
      deleted: false,
      entity: null,
      timeline: null,
    })
  }
}

export function invalidatePreview(app: string, entityType: string, id: string): void {
  setPreviewStore(
    produce((state) => {
      delete state.byKey[key(app, entityType, id)]
    }),
  )
}

export function resetEntityPreviewStore(): void {
  setPreviewStore({ byKey: {} })
}

onSessionTeardown(resetEntityPreviewStore)

export { previewStore }
