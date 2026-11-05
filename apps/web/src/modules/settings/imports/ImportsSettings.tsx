// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Organization > Imports: a new import (upload, a saved transform,
// preview, start: NewImport) above the org's import runs (newest first, previews
// left out) with their status, counts per kind, source, and Undo for a
// finished run.
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { importErrorText } from "~/modules/imports/import-errors"
import { useApi } from "~/modules/shell/ApiContext"
import NewImport from "./NewImport"

export interface ImportRunRow {
  id: string
  kindSet: string[]
  sourceLabel: string
  status: string
  counts: Record<string, { created: number; skipped: number; failed: number }>
  startedBy: string | null
  createdAt: string
  report?: { undo?: { deleted: number; refused: unknown[] } }
}

const FINAL = new Set(["done", "failed", "cancelled"])

function totals(run: ImportRunRow): { created: number; skipped: number; failed: number } {
  const t = { created: 0, skipped: 0, failed: 0 }
  for (const c of Object.values(run.counts ?? {})) {
    t.created += c.created
    t.skipped += c.skipped
    t.failed += c.failed
  }
  return t
}

const ImportsSettings: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [runs, { refetch }] = createResource(async () => {
    const res = await api.getEnvelope<ImportRunRow[]>("/imports")
    return res.data
  })
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)

  async function undo(runId: string): Promise<void> {
    setBusy(runId)
    setError(null)
    try {
      await api.post(`/imports/${runId}/undo`)
      await refetch()
    } catch (err) {
      setError(importErrorText(i18n.t, err, "kernel.imports.undoFailed"))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div data-testid="imports-settings">
      <NewImport onStarted={() => void refetch()} />
      <h3 class="mb-2 text-sm font-medium text-text">{i18n.t("kernel.imports.runs")}</h3>
      <Show when={error()}>
        <p class="mb-3 text-sm text-danger" data-testid="imports-error">
          {error()}
        </p>
      </Show>
      <Show
        when={(runs() ?? []).length > 0}
        fallback={
          <p class="text-sm text-text-secondary" data-testid="imports-empty">
            {runs.loading ? i18n.t("kernel.common.loading2") : i18n.t("kernel.imports.empty")}
          </p>
        }
      >
        <ul class="divide-y divide-border-subtle" data-testid="imports-list">
          <For each={runs()}>
            {(run) => {
              const t = totals(run)
              return (
                <li
                  class="flex items-center gap-3 py-2 text-sm"
                  data-testid={`import-run-${run.id}`}
                >
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-text">
                      {run.kindSet.join(", ")}
                      <Show when={run.sourceLabel}>
                        <span class="text-text-secondary"> · {run.sourceLabel}</span>
                      </Show>
                    </div>
                    <div class="text-xs text-text-secondary">
                      <span data-testid={`import-run-status-${run.id}`}>
                        {i18n.t(`kernel.imports.status.${run.status}`)}
                      </span>
                      {" · "}
                      <span data-testid={`import-run-counts-${run.id}`}>
                        {i18n.t("kernel.imports.counts", {
                          created: t.created,
                          skipped: t.skipped,
                          failed: t.failed,
                        })}
                      </span>
                      {" · "}
                      {new Date(run.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <Show when={FINAL.has(run.status)}>
                    <button
                      type="button"
                      class="rounded-md border border-border-subtle px-3 py-1 text-sm hover:bg-surface-hover disabled:opacity-50"
                      data-testid={`import-run-undo-${run.id}`}
                      disabled={busy() !== null}
                      onClick={() => void undo(run.id)}
                    >
                      {busy() === run.id
                        ? i18n.t("kernel.imports.undoing")
                        : i18n.t("kernel.imports.undo")}
                    </button>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>
    </div>
  )
}

export default ImportsSettings
