// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A DASHBOARD'S VERSION HISTORY, in a panel on the right (not a modal: the dashboard and the
// chat stay at hand). Every save keeps a copy; the list shows the last ones, newest first, with
// who saved each, when, and what it changed against the one before. "Show blocks" previews a
// version's blocks; Restore (for someone who may edit) brings it back as a new version, so
// nothing in the history is ever lost. Its bottom keeps clear of the chat dock's bar.
import { History, X } from "lucide-solid"
import {
  type Component,
  createResource,
  createSignal,
  For,
  Match,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { DISCUSSION_RAIL_BOTTOM_PAD } from "~/modules/threads/discussion-rail"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import type { DashboardVersionDetail, DashboardVersionSummary } from "./dashboards-client"
import { type VersionChange, versionChanges } from "./edit-mode"

export interface VersionHistoryPanelProps {
  /** Bumped when the dashboard is saved again: the list reads again. */
  revision: number
  loadVersions: () => Promise<DashboardVersionSummary[]>
  loadVersion: (version: number) => Promise<DashboardVersionDetail>
  /** Absent when the viewer may not change the dashboard: no Restore then. */
  onRestore?: (version: number) => void
  /** A restore is being saved. */
  busy?: boolean
  onClose: () => void
  locale?: string
}

type T = (key: string, params?: Record<string, string | number>) => string

/** What a version changed, as it reads. */
export function changeText(change: VersionChange, t: T): string {
  switch (change.kind) {
    case "first":
      return change.blocks === 1
        ? t("kernel.dashboards.historyBlocksOne")
        : t("kernel.dashboards.historyBlocksMany", { count: change.blocks })
    case "renamed":
      return t("kernel.dashboards.historyRenamed", { title: change.title })
    case "added":
      return change.count === 1
        ? t("kernel.dashboards.historyAddedOne")
        : t("kernel.dashboards.historyAddedMany", { count: change.count })
    case "removed":
      return change.count === 1
        ? t("kernel.dashboards.historyRemovedOne")
        : t("kernel.dashboards.historyRemovedMany", { count: change.count })
    case "changed":
      return t("kernel.dashboards.historyChanged")
  }
}

export const VersionHistoryPanel: Component<VersionHistoryPanelProps> = (props) => {
  const i18n = useI18n()
  const locale = () => props.locale ?? i18n.locale()
  const t: T = (key, params) => i18n.t(key, params)
  let closeButton: HTMLButtonElement | undefined
  onMount(() => closeButton?.focus())

  const [versions] = createResource(
    () => props.revision,
    async () => {
      try {
        return { ok: true as const, rows: await props.loadVersions() }
      } catch {
        return { ok: false as const, rows: [] as DashboardVersionSummary[] }
      }
    },
  )
  const changes = () => versionChanges(versions()?.rows ?? [])
  const [preview, setPreview] = createSignal<number | null>(null)
  const [detail] = createResource(preview, async (v) => {
    try {
      return { ok: true as const, version: await props.loadVersion(v) }
    } catch {
      return { ok: false as const }
    }
  })

  const when = (iso: string) => {
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) return iso
    return new Date(at).toLocaleString(locale(), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    })
  }

  return (
    <aside
      data-testid="dashboard-history-panel"
      aria-label={i18n.t("kernel.dashboards.historyTitle")}
      style={{ "padding-bottom": DISCUSSION_RAIL_BOTTOM_PAD }}
      class="absolute inset-0 z-10 flex min-h-0 flex-col bg-bg @2xl:static @2xl:inset-auto @2xl:z-auto @2xl:w-[360px] @2xl:shrink-0 @2xl:border-l @2xl:border-border-subtle"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation()
          props.onClose()
        }
      }}
    >
      <header class="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
        <History size={14} aria-hidden="true" class="shrink-0 text-text-tertiary" />
        <h2 class="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-text">
          {i18n.t("kernel.dashboards.historyTitle")}
        </h2>
        <button
          type="button"
          ref={closeButton}
          data-testid="dashboard-history-close"
          aria-label={i18n.t("kernel.dashboards.drillClose")}
          title={i18n.t("kernel.dashboards.drillClose")}
          onClick={() => props.onClose()}
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <X size={15} />
        </button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Switch>
          <Match when={versions.loading && !versions()}>
            <div data-testid="dashboard-history-loading" class="space-y-2">
              <Skeleton class="h-10 w-full" />
              <Skeleton class="h-10 w-full" />
            </div>
          </Match>
          <Match when={versions() && !versions()?.ok}>
            <p data-testid="dashboard-history-error" class="py-4 text-[13px] text-text-tertiary">
              {i18n.t("kernel.dashboards.historyFailed")}
            </p>
          </Match>
          <Match when={versions()?.rows.length === 0}>
            <p data-testid="dashboard-history-empty" class="py-4 text-[13px] text-text-tertiary">
              {i18n.t("kernel.dashboards.historyEmpty")}
            </p>
          </Match>
          <Match when={versions()?.ok}>
            <ol class="flex flex-col gap-2">
              <For each={versions()?.rows ?? []}>
                {(v, i) => (
                  <li
                    data-testid={`dashboard-history-version-${v.version}`}
                    data-current={v.current ? "true" : undefined}
                    class="rounded-md border border-border-subtle px-3 py-2"
                  >
                    <div class="flex items-center gap-2">
                      <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium text-text">
                        {i18n.t("kernel.dashboards.historyVersion", { version: v.version })}
                      </span>
                      <Show when={v.current}>
                        <span class="shrink-0 rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-text-tertiary">
                          {i18n.t("kernel.dashboards.historyCurrent")}
                        </span>
                      </Show>
                    </div>
                    <p
                      data-testid={`dashboard-history-change-${v.version}`}
                      class="mt-0.5 text-[12px] text-text-secondary"
                    >
                      {changes()[i()] ? changeText(changes()[i()]!, t) : ""}
                    </p>
                    <p
                      data-testid={`dashboard-history-saved-${v.version}`}
                      class="mt-0.5 text-[11.5px] text-text-tertiary"
                      title={v.savedAt}
                    >
                      {v.savedByName
                        ? i18n.t("kernel.dashboards.historySavedBy", {
                            name: v.savedByName,
                            when: when(v.savedAt),
                          })
                        : when(v.savedAt)}
                    </p>
                    <div class="mt-1.5 flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`dashboard-history-preview-${v.version}`}
                        aria-expanded={preview() === v.version}
                        onClick={() => setPreview((p) => (p === v.version ? null : v.version))}
                      >
                        {preview() === v.version
                          ? i18n.t("kernel.dashboards.historyHideBlocks")
                          : i18n.t("kernel.dashboards.historyShowBlocks")}
                      </Button>
                      <Show when={props.onRestore && !v.current}>
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid={`dashboard-history-restore-${v.version}`}
                          disabled={props.busy}
                          onClick={() => props.onRestore?.(v.version)}
                        >
                          {i18n.t("kernel.dashboards.historyRestore")}
                        </Button>
                      </Show>
                    </div>
                    <Show when={preview() === v.version}>
                      <div data-testid={`dashboard-history-blocks-${v.version}`} class="mt-1.5">
                        <Switch>
                          <Match when={detail.loading}>
                            <Skeleton class="h-4 w-2/3" />
                          </Match>
                          <Match when={detail() && !detail()?.ok}>
                            <p class="text-[12px] text-text-tertiary">
                              {i18n.t("kernel.dashboards.historyFailed")}
                            </p>
                          </Match>
                          <Match when={detail()?.ok && detail()}>
                            {(d) => {
                              const ver = () =>
                                (d() as { ok: true; version: DashboardVersionDetail }).version
                              return (
                                <ul class="list-disc pl-4 text-[12px] text-text-secondary">
                                  <For each={ver().spec.blocks}>
                                    {(b) => <li class="truncate">{b.title}</li>}
                                  </For>
                                </ul>
                              )
                            }}
                          </Match>
                        </Switch>
                      </div>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </Match>
        </Switch>
      </div>
    </aside>
  )
}
