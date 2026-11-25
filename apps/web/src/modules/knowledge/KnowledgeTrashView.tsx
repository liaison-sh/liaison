// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Trash (S19, D4): the pages the person may restore, who moved each one and
// when, and the days left before it is deleted for good. Pages archived before
// Trash existed are kept: never deleted automatically. Restore for whoever may
// edit the page; Delete for good for administrators, after a short confirm.

import { FileText } from "lucide-solid"
import { type Component, createSignal, For, onMount, Show } from "solid-js"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { ScrollFade } from "~/ui/ScrollFade"
import type { KnowledgeTrashEntry } from "./knowledge-api"
import {
  canDeleteForGood,
  daysLeftLabel,
  deleteForGood,
  loadTrash,
  restoreFromTrash,
  trashEntries,
  trashedLine,
} from "./trash"

const KnowledgeTrashView: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const me = () => userFromToken()?.userId ?? null
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal(false)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [confirm, setConfirm] = createSignal<KnowledgeTrashEntry | null>(null)

  onMount(async () => {
    try {
      await loadTrash(api)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  })

  const restore = async (entry: KnowledgeTrashEntry) => {
    setBusy(entry.id)
    try {
      if (await restoreFromTrash(api, entry, i18n.t)) {
        addToast({
          type: "success",
          message: i18n.t("knowledge.trash.restoredToast", { title: entry.title }),
          action: {
            label: i18n.t("knowledge.trash.open"),
            onClick: () =>
              openTab({ type: "knowledge:document", entityId: entry.id, label: entry.title }),
          },
          durationMs: 5000,
        })
      }
    } finally {
      setBusy(null)
    }
  }

  const deleteConfirmed = async () => {
    const entry = confirm()
    if (!entry) return
    setConfirm(null)
    setBusy(entry.id)
    try {
      await deleteForGood(api, entry, i18n.t)
    } finally {
      setBusy(null)
    }
  }

  const list = () => trashEntries() ?? []

  return (
    <ScrollFade class="min-h-0 flex-1" fadeColor="var(--color-bg)">
      <div data-testid="knowledge-trash" class="mx-auto w-full max-w-2xl px-4 py-10 sm:px-8">
        <header class="mb-4">
          <h1 class="text-[15px] font-medium text-text">{i18n.t("knowledge.trash.title")}</h1>
          <p class="text-[12px] text-text-tertiary">{i18n.t("knowledge.trash.intro")}</p>
        </header>
        <Show when={error()}>
          <p data-testid="knowledge-trash-error" role="alert" class="mb-3 text-[13px] text-danger">
            {i18n.t("knowledge.trash.loadFailed")}
          </p>
        </Show>
        <Show
          when={!loading() && !error() && list().length > 0}
          fallback={
            <Show when={!error()}>
              <p data-testid="knowledge-trash-empty" class="text-[13px] text-text-tertiary">
                {loading() ? i18n.t("kernel.common.loading2") : i18n.t("knowledge.trash.empty")}
              </p>
            </Show>
          }
        >
          <ul class="flex flex-col gap-1">
            <For each={list()}>
              {(entry) => (
                <li
                  data-testid={`knowledge-trash-row-${entry.id}`}
                  class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 hover:bg-surface-hover"
                >
                  <FileText size={14} class="shrink-0 text-text-tertiary" />
                  <button
                    type="button"
                    class="min-w-0 flex-1 basis-40 text-left outline-none"
                    onClick={() =>
                      openTab({
                        type: "knowledge:document",
                        entityId: entry.id,
                        label: entry.title,
                      })
                    }
                  >
                    <span class="block truncate text-[13px] text-text">{entry.title}</span>
                    <span class="block truncate text-[12px] text-text-tertiary">
                      {trashedLine(entry, me(), i18n.locale(), i18n.t)}
                    </span>
                  </button>
                  <span
                    data-testid="knowledge-trash-days"
                    title={entry.daysLeft === null ? i18n.t("knowledge.trash.keptHint") : undefined}
                    class="shrink-0 text-[12px] text-text-tertiary"
                  >
                    {daysLeftLabel(entry, i18n.t)}
                  </span>
                  <span class="flex shrink-0 gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid={`knowledge-trash-restore-${entry.id}`}
                      disabled={busy() === entry.id}
                      onClick={() => void restore(entry)}
                    >
                      {i18n.t("knowledge.trash.restore")}
                    </Button>
                    <Show when={canDeleteForGood() && entry.daysLeft !== null}>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`knowledge-trash-delete-${entry.id}`}
                        disabled={busy() === entry.id}
                        onClick={() => setConfirm(entry)}
                      >
                        {i18n.t("knowledge.trash.deleteForGood")}
                      </Button>
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      <Dialog open={confirm() !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <Dialog.Content data-testid="knowledge-trash-delete-dialog">
          <Show when={confirm()}>
            {(entry) => (
              <>
                <Dialog.Title>
                  {i18n.t("knowledge.trash.deleteConfirmTitle", { title: entry().title })}
                </Dialog.Title>
                <Dialog.Description>
                  {i18n.t("knowledge.trash.deleteConfirmBody")}
                </Dialog.Description>
                <div class="mt-4 flex items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="knowledge-trash-delete-cancel"
                    onClick={() => setConfirm(null)}
                  >
                    {i18n.t("kernel.common.cancel")}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    data-testid="knowledge-trash-delete-confirm"
                    onClick={() => void deleteConfirmed()}
                  >
                    {i18n.t("knowledge.trash.deleteForGood")}
                  </Button>
                </div>
              </>
            )}
          </Show>
        </Dialog.Content>
      </Dialog>
    </ScrollFade>
  )
}

export default KnowledgeTrashView
