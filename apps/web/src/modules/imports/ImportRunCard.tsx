// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE IMPORT PROGRESS CARD: an import run as the conversation that started it
// shows it. Drawn under the agent's `import_start` (by the approval it waited
// on, or the run it started) and `import_status` calls; it follows the run
// live (the `import_run` events re-read it) and, read again from the server
// on a reload, survives one. Counts per kind, the refused records with where
// they came from, the final report, and Undo once the run is finished.

import { type Component, createEffect, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { importErrorText } from "./import-errors"
import { type ImportRun, importRunStore } from "./import-run-store"

const FINAL = new Set(["done", "failed", "cancelled"])
const ERRORS_SHOWN = 5

const ImportRunCard: Component<{ runId?: string; approvalRequestId?: string }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string | null>(null)
  const [confirming, setConfirming] = createSignal(false)

  createEffect(() => {
    if (!api) return
    if (props.runId) void importRunStore.ensureLoaded(api, props.runId).catch(() => undefined)
    else if (props.approvalRequestId) {
      void importRunStore.findForApproval(api, props.approvalRequestId).catch(() => undefined)
    }
  })

  const run = (): ImportRun | undefined => {
    const id =
      props.runId ??
      (props.approvalRequestId
        ? importRunStore.runIdForApproval(props.approvalRequestId)
        : undefined)
    return id ? importRunStore.getById(id) : undefined
  }

  async function onUndo(id: string): Promise<void> {
    if (!api) return
    setConfirming(false)
    setBusy(true)
    setFailure(null)
    try {
      await importRunStore.undo(api, id)
    } catch (err) {
      setFailure(importErrorText(i18n.t, err, "kernel.imports.undoFailed"))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={run()}>
      {(r) => {
        const report = () => r().report ?? {}
        const undone = () => report().undo as { deleted?: number; refused?: unknown[] } | undefined
        return (
          <div
            class="my-2 rounded-lg border border-border bg-elevated p-3 text-[13px]"
            data-testid={`import-run-card-${r().id}`}
          >
            <div class="flex items-center gap-2">
              <span class="font-medium text-text">{i18n.t("kernel.imports.card.title")}</span>
              <Show when={r().sourceLabel}>
                <span class="text-text-secondary">· {r().sourceLabel}</span>
              </Show>
              <span class="ml-auto text-text-secondary" data-testid="import-run-card-status">
                {i18n.t(`kernel.imports.status.${r().status}`)}
              </span>
            </div>
            <ul class="mt-2 space-y-0.5">
              <For each={Object.entries(r().counts ?? {})}>
                {([kind, c]) => (
                  <li data-testid={`import-run-card-kind-${kind}`} class="text-text-secondary">
                    <span class="text-text">{kind}</span>{" "}
                    {i18n.t("kernel.imports.counts", {
                      created: c.created,
                      skipped: c.skipped,
                      failed: c.failed,
                    })}
                  </li>
                )}
              </For>
            </ul>
            <Show when={(r().errors ?? []).length > 0}>
              <div class="mt-2" data-testid="import-run-card-errors">
                <div class="text-text-secondary">
                  {i18n.t("kernel.imports.card.refused", { count: r().errors.length })}
                </div>
                <ul class="mt-0.5 space-y-0.5 text-xs text-text-secondary">
                  <For each={r().errors.slice(0, ERRORS_SHOWN)}>
                    {(e) => (
                      <li class="truncate">
                        <Show when={typeof e.at === "string"}>{String(e.at)}: </Show>
                        {String(e.error ?? "")}
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
            <Show when={FINAL.has(r().status) && typeof report().attachmentsMissing === "number"}>
              <div class="mt-2 text-text-secondary" data-testid="import-run-card-report">
                {i18n.t("kernel.imports.card.missingFiles", {
                  count: Number(report().attachmentsMissing),
                })}
              </div>
            </Show>
            <Show when={undone()}>
              {(u) => (
                <div class="mt-2 text-text-secondary" data-testid="import-run-card-undo-result">
                  {i18n.t("kernel.imports.card.undone", {
                    deleted: u().deleted ?? 0,
                    kept: (u().refused ?? []).length,
                  })}
                </div>
              )}
            </Show>
            <Show when={failure()}>
              <div class="mt-2 text-danger" data-testid="import-run-card-error">
                {failure()}
              </div>
            </Show>
            <Show when={FINAL.has(r().status)}>
              <div class="mt-2">
                <Show
                  when={confirming()}
                  fallback={
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="import-run-card-undo"
                      disabled={busy()}
                      onClick={() => setConfirming(true)}
                    >
                      {busy() ? i18n.t("kernel.imports.undoing") : i18n.t("kernel.imports.undo")}
                    </Button>
                  }
                >
                  <p class="text-text-secondary">{i18n.t("kernel.imports.undoConfirm")}</p>
                  <div class="mt-1 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="import-run-card-undo-confirm"
                      onClick={() => void onUndo(r().id)}
                    >
                      {i18n.t("kernel.imports.undoConfirmAction")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="import-run-card-undo-cancel"
                      onClick={() => setConfirming(false)}
                    >
                      {i18n.t("kernel.imports.undoCancel")}
                    </Button>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        )
      }}
    </Show>
  )
}

export default ImportRunCard
