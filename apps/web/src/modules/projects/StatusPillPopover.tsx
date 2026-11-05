// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createSignal, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { log as logger } from "~/lib/logger"
import { handleTaskEvent, type ProjectStatus, type Task } from "~/modules/projects/project-store"

interface StatusPillPopoverProps {
  api: ApiClient
  projectId: string
  taskId: string
  current: ProjectStatus | null
  statuses: ProjectStatus[]
  disabled?: boolean
  /** Receives the task row the server returned after a status change, so a
   *  host that holds its own copy (the task detail) shows the new status. */
  onChanged?: (row: Partial<Task> & { id: string }) => void
}

export const StatusPillPopover: Component<StatusPillPopoverProps> = (props) => {
  const [open, setOpen] = createSignal(false)

  const change = async (statusId: string) => {
    setOpen(false)
    if (props.disabled) return
    if (statusId === props.current?.id) return
    try {
      const updated = await props.api.patch<Task>(
        `/projects/${props.projectId}/tasks/${props.taskId}`,
        { statusId },
      )
      // Echo the change into the store immediately — the WS event that would
      // otherwise refresh the row rides the outbox worker and can lag (or be
      // dropped on reconnect), leaving the list stale until a manual reload.
      const row = updated?.id
        ? { ...updated, projectId: props.projectId }
        : { id: props.taskId, projectId: props.projectId, statusId }
      handleTaskEvent("updated", row)
      props.onChanged?.(row)
    } catch (err) {
      logger.error({ err }, "status_change_failed")
    }
  }

  return (
    <span data-testid="status-pill-popover" class="relative inline-flex">
      <button
        type="button"
        data-testid="status-pill-popover.trigger"
        disabled={props.disabled}
        onClick={() => setOpen(!open())}
        class="inline-flex h-[22px] items-center gap-1 rounded-full border border-border-subtle bg-surface px-2 text-[11px] font-medium text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          aria-hidden="true"
          class="h-1.5 w-1.5 rounded-full"
          style={{ background: props.current?.color ?? "var(--color-text-tertiary)" }}
        />
        {props.current?.label ?? "-"}
      </button>
      <Show when={open() && !props.disabled}>
        <div
          data-testid="status-pill-popover.menu"
          class="absolute left-0 top-7 z-30 min-w-[180px] rounded-md border border-border-subtle bg-elevated p-1 shadow-popover"
          onClick={(e) => e.stopPropagation()}
        >
          <For each={[...props.statuses].sort((a, b) => a.order - b.order)}>
            {(s) => (
              <button
                type="button"
                data-testid="status-pill-popover.item"
                data-status-id={s.id}
                onClick={() => void change(s.id)}
                class={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-surface-hover ${
                  s.id === props.current?.id ? "text-accent" : "text-text"
                }`}
              >
                <span
                  aria-hidden="true"
                  class="h-1.5 w-1.5 rounded-full"
                  style={{ background: s.color ?? "var(--color-text-tertiary)" }}
                />
                {s.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </span>
  )
}
