// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Watched — the posts/videos/threads the poller is actively following. Each row
// shows a cadence pill (HOT/WARM/COOL/DECAYED) derived from status + cadence; a
// decayed watch shows a Resume action that flips it back to active.
import { type Component, For, Show } from "solid-js"
import { app } from "@liaison/host"
import { Badge, type BadgeTone, Button, EmptyState, PageHeader } from "./kit"

export interface WatchedRow {
  id: string
  platform: "facebook" | "instagram" | "youtube"
  external_id: string
  kind: string
  status: "active" | "decayed" | "stopped"
  cadence_seconds: number
  priority?: number | null
}

// ── Pure helper (unit-tested) ────────────────────────────────────────────────
/** Map a watch's status + cadence to a human cadence pill. */
export function cadenceLabel(status: WatchedRow["status"], cadenceSeconds: number): "HOT" | "WARM" | "COOL" | "DECAYED" | "STOPPED" {
  if (status === "decayed") return "DECAYED"
  if (status === "stopped") return "STOPPED"
  if (cadenceSeconds <= 300) return "HOT"
  if (cadenceSeconds <= 3600) return "WARM"
  return "COOL"
}

function cadenceTone(label: ReturnType<typeof cadenceLabel>): BadgeTone {
  switch (label) {
    case "HOT":
      return "error"
    case "WARM":
      return "warning"
    case "COOL":
      return "accent"
    case "DECAYED":
      return "muted"
    default:
      return "neutral"
  }
}

async function loadWatched(): Promise<WatchedRow[]> {
  try {
    const res = await app.invokeTool<{ watched?: WatchedRow[] }>("watched_list", {})
    return res?.watched ?? []
  } catch {
    return []
  }
}

export const Watched: Component = () => {
  const [rows, { refetch }] = app.createResource(loadWatched)
  const resume = async (r: WatchedRow) => {
    try {
      await app.invokeTool("watch_object", { platform: r.platform, external_id: r.external_id })
    } finally {
      void refetch()
    }
  }
  return (
    <div class="flex h-full min-h-0 flex-col">
      <PageHeader title="Watched" subtitle="Posts and videos the poller is following" />
      <div class="min-h-0 flex-1 overflow-y-auto" data-testid="social-watched-list">
        <Show when={(rows() ?? []).length > 0} fallback={<EmptyState title="Nothing watched yet">Active threads are promoted automatically.</EmptyState>}>
          <For each={rows() ?? []}>
            {(r) => {
              const label = cadenceLabel(r.status, r.cadence_seconds)
              return (
                <div
                  data-testid={`social-watched-row-${r.id}`}
                  class="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2"
                >
                  <span class="flex flex-col">
                    <span class="text-[12.5px] text-text">{r.external_id}</span>
                    <span class="text-[11px] text-text-tertiary">{r.platform} · {r.kind}</span>
                  </span>
                  <span class="flex items-center gap-2">
                    <Badge tone={cadenceTone(label)} testid={`social-watched-cadence-${r.id}`}>{label}</Badge>
                    <Show when={r.status === "decayed"}>
                      <Button variant="secondary" testid={`social-watched-resume-${r.id}`} onClick={() => void resume(r)}>
                        Resume
                      </Button>
                    </Show>
                  </span>
                </div>
              )
            }}
          </For>
        </Show>
      </div>
    </div>
  )
}
