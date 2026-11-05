// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createSignal, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { ProjectStatus } from "~/modules/projects/project-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

interface DeleteStatusDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  api: ApiClient
  projectId: string
  status: ProjectStatus | null
  otherStatuses: ProjectStatus[]
}

interface InUseDetails {
  count: number
  taskIds?: string[]
}

export const DeleteStatusDialog: Component<DeleteStatusDialogProps> = (props) => {
  const i18n = useI18n()
  const [inUse, setInUse] = createSignal<InUseDetails | null>(null)
  const [migrateTo, setMigrateTo] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const reset = () => {
    setInUse(null)
    setMigrateTo(null)
    setBusy(false)
    setError(null)
  }

  const close = () => {
    reset()
    props.onOpenChange(false)
  }

  const tryDelete = async () => {
    if (!props.status) return
    setBusy(true)
    setError(null)
    try {
      await props.api.delete(`/projects/${props.projectId}/statuses/${props.status.id}`)
      close()
    } catch (err) {
      if (err instanceof ApiError && err.code === "status_in_use") {
        const details = (err.details ?? {}) as Partial<InUseDetails>
        setInUse({ count: details.count ?? 0, taskIds: details.taskIds ?? [] })
      } else {
        setError((err as Error).message ?? "Delete failed")
      }
    } finally {
      setBusy(false)
    }
  }

  const migrateAndDelete = async () => {
    const target = migrateTo()
    if (!target || !props.status) {
      setError("Pick a target status")
      return
    }
    setBusy(true)
    setError(null)
    try {
      await props.api.post(`/projects/${props.projectId}/statuses/${props.status.id}/migrate`, {
        targetStatusId: target,
      })
      await props.api.delete(`/projects/${props.projectId}/statuses/${props.status.id}`)
      close()
    } catch (err) {
      setError((err as Error).message ?? "Migration failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={(o) => (o ? props.onOpenChange(true) : close())}>
      <Dialog.Content>
        <Dialog.Title>{i18n.t("projects.deleteStatus")}</Dialog.Title>
        <Show when={!inUse()}>
          <p class="mt-3 text-[13px] text-text-secondary">
            {i18n.t("kernel.common.delete")}{" "}
            <span class="text-text">{props.status?.label ?? i18n.t("projects.thisStatus")}</span>?
          </p>
        </Show>
        <Show when={inUse()}>
          {(details) => (
            <div data-testid="delete-status-dialog.in-use" class="mt-3 flex flex-col gap-3">
              <p class="text-[13px] text-text-secondary">
                <span data-testid="delete-status-dialog.count" class="text-text">
                  {details().count}
                </span>{" "}
                {i18n.t("projects.tasksStillUseThisStatusMove")}
              </p>
              <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
                {i18n.t("projects.moveTasksTo")}
                <select
                  data-testid="delete-status-dialog.migrate-target"
                  value={migrateTo() ?? ""}
                  onChange={(e) => setMigrateTo((e.target as HTMLSelectElement).value || null)}
                  class="rounded-md border border-border-subtle bg-bg px-2 py-1.5 text-[13px] text-text"
                >
                  <option value="">{i18n.t("projects.pickATarget")}</option>
                  <For each={[...props.otherStatuses].sort((a, b) => a.order - b.order)}>
                    {(s) => <option value={s.id}>{s.label}</option>}
                  </For>
                </select>
              </label>
            </div>
          )}
        </Show>
        <Show when={error()}>
          <p data-testid="delete-status-dialog.error" class="mt-2 text-[12px] text-warning">
            {error()}
          </p>
        </Show>
        <div class="mt-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={close}>
            {i18n.t("kernel.common.cancel")}
          </Button>
          <Show when={!inUse()}>
            <Button variant="danger" size="sm" disabled={busy()} onClick={() => void tryDelete()}>
              <span data-testid="delete-status-dialog.delete">{i18n.t("projects.delete")}</span>
            </Button>
          </Show>
          <Show when={inUse()}>
            <Button
              variant="primary"
              size="sm"
              disabled={busy() || !migrateTo()}
              onClick={() => void migrateAndDelete()}
            >
              <span data-testid="delete-status-dialog.migrate-and-delete">
                {i18n.t("projects.moveDelete")}
              </span>
            </Button>
          </Show>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
