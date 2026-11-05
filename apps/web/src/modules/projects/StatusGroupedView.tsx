// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createMemo, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { ProjectStatus, Task } from "~/modules/projects/project-store"
import { prettyStatus } from "~/modules/projects/status-label"

interface StatusGroupedViewProps {
  statuses: ProjectStatus[]
  tasks?: Task[]
  onTaskClick?: (taskId: string) => void
}

export const StatusGroupedView: Component<StatusGroupedViewProps> = (props) => {
  const i18n = useI18n()
  const sortedStatuses = createMemo(() => [...props.statuses].sort((a, b) => a.order - b.order))

  return (
    <div data-testid="status-grouped-vertical" class="flex flex-col gap-4 px-4 py-4">
      <For each={sortedStatuses()}>
        {(status) => {
          // Wrap in memo so the row body re-runs when props.tasks updates.
          // Without this, tasks created or moved after first render don't appear.
          const items = createMemo(() =>
            (props.tasks ?? [])
              .filter((t) => t.statusId === status.id)
              .sort((a, b) => a.position - b.position),
          )
          return (
            <section
              data-testid="status-grouped-vertical.section"
              data-status-id={status.id}
              class="rounded-md border border-border-subtle bg-surface"
            >
              <header class="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
                <span class="text-[12px] font-medium uppercase tracking-wide text-text-secondary">
                  {prettyStatus(status.label)}
                </span>
                <span class="text-[11px] text-text-tertiary">{items().length}</span>
              </header>
              <Show
                when={items().length > 0}
                fallback={
                  <div class="px-3 py-2 text-[12px] text-text-tertiary">
                    {i18n.t("projects.noTasks")}
                  </div>
                }
              >
                <ul class="divide-y divide-border-subtle">
                  <For each={items()}>
                    {(t) => (
                      <li
                        data-testid="status-grouped-vertical.task"
                        data-task-id={t.id}
                        class="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px] hover:bg-surface-hover"
                        onClick={() => props.onTaskClick?.(t.id)}
                      >
                        <Show when={t.key}>
                          <span class="shrink-0 font-mono text-[11px] text-text-tertiary">
                            {t.key}
                          </span>
                        </Show>
                        <span class="flex-1 text-text">{t.title}</span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </section>
          )
        }}
      </For>
    </div>
  )
}
