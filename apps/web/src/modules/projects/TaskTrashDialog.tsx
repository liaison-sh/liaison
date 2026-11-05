// SPDX-License-Identifier: FSL-1.1-ALv2
// projects:trash — the bin for deleted tasks.
//
// Deleting a task is a SOFT delete (`archived_at`), so the row and its subtree
// survive and are recoverable. Until this panel existed nothing could list them
// and nothing could undo it, which made the soft delete a permanent one with
// extra steps. Archived is NOT a status column: a binned task is out of the
// board entirely, not parked in a "cancelled" lane, which is why this is a
// separate panel rather than another column.

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { projectStore, type Task } from "~/modules/projects/project-store"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"

interface TaskTrashDialogProps {
  projectId: string
  /** Bumped by the parent when the dialog opens, so the bin is re-read rather
   *  than served stale from the last time it was looked at. */
  refreshKey: number
}

export const TaskTrashDialog: Component<TaskTrashDialogProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [restoring, setRestoring] = createSignal<string | null>(null)

  const [binned, { mutate, refetch }] = createResource(
    () => ({ projectId: props.projectId, key: props.refreshKey }),
    async (args): Promise<Task[]> => {
      const res = await api.get<{ items?: Task[] }>(
        `/projects/${args.projectId}/tasks?archived=only`,
      )
      const items = (res as unknown as { items?: Task[] }).items
      return Array.isArray(items) ? items : ((res as unknown as Task[]) ?? [])
    },
  )

  const restore = async (task: Task): Promise<void> => {
    if (restoring()) return
    setRestoring(task.id)
    try {
      await api.post(`/projects/${props.projectId}/tasks/${task.id}/restore`, {})
      // Drop it from the bin immediately rather than waiting a round trip, then
      // reload the board so the restored subtree reappears there.
      mutate((prev) => (prev ?? []).filter((t) => t.id !== task.id))
      await projectStore.load(api, props.projectId)
      addToast({ message: i18n.t("projects.taskRestored"), type: "info" })
      void refetch()
    } catch (err) {
      addToast({ message: i18n.t("projects.taskRestoreFailed"), type: "error" })
      console.error("task restore failed", err)
    } finally {
      setRestoring(null)
    }
  }

  return (
    <div data-testid="task-trash" class="mt-4">
      <Show when={binned.loading}>
        <p class="text-[12.5px] text-text-tertiary">{i18n.t("projects.trashLoading")}</p>
      </Show>
      <Show when={!binned.loading && binned.error}>
        <p data-testid="task-trash.error" class="text-[12.5px] text-danger">
          {i18n.t("projects.trashLoadFailed")}
        </p>
      </Show>
      <Show when={!binned.loading && !binned.error && (binned() ?? []).length === 0}>
        <p data-testid="task-trash.empty" class="text-[12.5px] text-text-tertiary">
          {i18n.t("projects.trashEmpty")}
        </p>
      </Show>
      <ul class="divide-y divide-border-subtle">
        <For each={binned() ?? []}>
          {(task) => (
            <li data-testid={`task-trash.row-${task.id}`} class="flex items-center gap-3 py-2">
              <span class="flex-1 truncate text-[13px] text-text-secondary line-through">
                {task.title}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={restoring() === task.id}
                onClick={() => void restore(task)}
              >
                <span data-testid={`task-trash.restore-${task.id}`}>
                  {i18n.t("projects.restoreTask")}
                </span>
              </Button>
            </li>
          )}
        </For>
      </ul>
    </div>
  )
}
