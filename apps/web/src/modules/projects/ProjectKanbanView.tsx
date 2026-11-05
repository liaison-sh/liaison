// SPDX-License-Identifier: FSL-1.1-ALv2
// Kanban view with full PM-tool-style drag-and-drop:
//   - Drag a card to another column to change status
//   - Drop between cards to reorder within / across columns
//   - Drop on empty column area to append
//   - Drop indicators (a 2px accent line where the card would land) animate in
//   - Dragged card dims to make the drop zone obvious; cursor flips to grabbing
//
// Native HTML5 dnd; no external dependency. State piggybacks on dndState so
// the list view and kanban can never both show indicators at once.

import { type Component, createMemo, createSignal, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { log as logger } from "~/lib/logger"
import { formatDay } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import { ChecklistCounters } from "~/modules/projects/ChecklistCounters"
import { dndState } from "~/modules/projects/dnd-state"
import { dueBucket, dueChipColorClass } from "~/modules/projects/due-status"
import { KanbanLabelChips } from "~/modules/projects/KanbanLabelChips"
import { LinkedDocuments } from "~/modules/projects/LinkedDocuments"
import { type ProjectStatus, projectStore, type Task } from "~/modules/projects/project-store"
import { StatusGroupedView } from "~/modules/projects/StatusGroupedView"
import { prettyStatus } from "~/modules/projects/status-label"
import { addToast } from "~/modules/shell/toast-store"

const COLUMN_WIDTH = 240
const COLUMN_GAP = 8
const WORKSPACE_PADDING = 32

interface ProjectKanbanViewProps {
  statuses: ProjectStatus[]
  tasks?: Task[]
  workspaceWidth: number
  projectId?: string
  api?: ApiClient
  onTaskClick?: (taskId: string) => void
  disabled?: boolean
}

interface DragPayload {
  taskId: string
  fromStatusId: string
}

export const ProjectKanbanView: Component<ProjectKanbanViewProps> = (props) => {
  const i18n = useI18n()
  const sortedStatuses = createMemo(() => [...props.statuses].sort((a, b) => a.order - b.order))

  // Post-review visual contract: keep PM-tool-width Kanban columns and allow
  // horizontal scrolling at normal widths. Only fall back when fewer than two
  // columns can fit, where horizontal Kanban stops being useful.
  const shouldDegrade = createMemo(() => {
    const available = props.workspaceWidth - WORKSPACE_PADDING
    return available < COLUMN_WIDTH * 2 + COLUMN_GAP
  })

  // Inline column rename — the same PATCH the Statuses dialog uses, reachable
  // from the column itself (double-click the header, or its pencil) so a board
  // created with default columns can be renamed without hunting for a dialog.
  const [renamingId, setRenamingId] = createSignal<string | null>(null)
  const [renameDraft, setRenameDraft] = createSignal("")
  const [renameError, setRenameError] = createSignal<string | null>(null)
  const canRename = () => !!props.api && !!props.projectId && !props.disabled
  const beginRename = (status: ProjectStatus) => {
    if (!canRename()) return
    setRenameError(null)
    setRenameDraft(status.label)
    setRenamingId(status.id)
  }
  const cancelRename = () => {
    setRenamingId(null)
    setRenameDraft("")
  }
  const commitRename = async (status: ProjectStatus) => {
    const next = renameDraft().trim()
    if (!next || next === status.label) {
      cancelRename()
      return
    }
    try {
      await props.api!.patch(`/projects/${props.projectId}/statuses/${status.id}`, { label: next })
      cancelRename()
    } catch (err) {
      logger.error({ err }, "kanban_status_rename_failed")
      setRenameError((err as Error).message ?? i18n.t("projects.renameFailed"))
    }
  }

  // A failed move never moves the card: the board only follows the server
  // (realtime task events), so the card stays where it was. The checklist
  // never blocks a move.
  const reportMoveFailure = (err: unknown) => {
    logger.error({ err }, "kanban_move_failed")
    addToast({ message: i18n.t("projects.moveFailed"), type: "error" })
  }

  // Checklist counters on cards are a per-project option, on by default.
  const showChecklist = () =>
    !props.projectId || projectStore.project(props.projectId)?.checklistOnCards !== false

  // Effective labels walk the parent chain over the WHOLE project list:
  // `props.tasks` is the filtered list and may omit a card's ancestors.
  const labelById = createMemo(() => {
    const all = props.projectId ? projectStore.tasksFor(props.projectId) : (props.tasks ?? [])
    return new Map(all.map((t) => [t.id, t]))
  })

  const tasksFor = (statusId: string) =>
    (props.tasks ?? [])
      .filter((t) => t.statusId === statusId)
      .sort((a, b) => a.position - b.position)

  // Move resolution.
  // - Drop on a card with position "above" → before that card in its column
  // - Drop on a card with position "below" → after that card in its column
  // - Drop on column body (no card target) → append to that column
  const handleCardDrop = async (
    toStatusId: string,
    payload: DragPayload,
    targetTaskId: string,
    position: "above" | "below",
  ) => {
    if (props.disabled || !props.api || !props.projectId) return
    if (payload.taskId === targetTaskId) return
    const body =
      position === "above"
        ? { statusId: toStatusId, beforeTaskId: targetTaskId }
        : { statusId: toStatusId, afterTaskId: targetTaskId }
    try {
      await props.api.post(`/projects/${props.projectId}/tasks/${payload.taskId}/move`, body)
    } catch (err) {
      reportMoveFailure(err)
    }
  }

  const handleColumnDrop = async (toStatusId: string, payload: DragPayload) => {
    if (props.disabled || !props.api || !props.projectId) return
    // Same column with no target = no-op (drop on empty space, position
    // unchanged). Cross-column drop appends.
    if (payload.fromStatusId === toStatusId) return
    try {
      await props.api.post(`/projects/${props.projectId}/tasks/${payload.taskId}/move`, {
        statusId: toStatusId,
      })
    } catch (err) {
      reportMoveFailure(err)
    }
  }

  return (
    <Show
      when={!shouldDegrade()}
      fallback={
        <StatusGroupedView
          statuses={sortedStatuses()}
          tasks={props.tasks}
          onTaskClick={props.onTaskClick}
        />
      }
    >
      <div
        data-testid="project-kanban-board"
        class="flex h-full min-w-0 gap-2 overflow-x-auto overflow-y-hidden px-4 py-4"
        style={{ gap: `${COLUMN_GAP}px` }}
      >
        <For each={sortedStatuses()}>
          {(status) => {
            const items = createMemo(() => tasksFor(status.id))
            const isColumnDropTarget = () => {
              const dt = dndState.dropTarget
              return dt?.taskId === `column:${status.id}`
            }
            return (
              <section
                data-testid="project-kanban-column"
                data-status-id={status.id}
                data-column-drop-target={isColumnDropTarget() ? "true" : undefined}
                class="flex flex-none flex-col rounded-md border border-border-subtle bg-surface transition-colors duration-150"
                classList={{
                  "ring-1 ring-inset ring-accent-border bg-accent-tint": isColumnDropTarget(),
                }}
                style={{
                  width: `${COLUMN_WIDTH}px`,
                  "min-width": `${COLUMN_WIDTH}px`,
                  "max-width": `${COLUMN_WIDTH}px`,
                }}
                onDragOver={(e) => {
                  if (!dndState.activeTaskId) return
                  e.preventDefault()
                  e.dataTransfer!.dropEffect = "move"
                  // Column-level highlight only when the drop is in the empty
                  // tail of the column (not over a card — those handle their
                  // own indicator).
                  const target = e.target as HTMLElement
                  const onCard = target.closest('[data-testid="project-kanban-card"]')
                  if (!onCard) {
                    dndState.setDropTarget({
                      taskId: `column:${status.id}`,
                      position: "into",
                    })
                  }
                }}
                onDragLeave={(e) => {
                  const next = e.relatedTarget as Node | null
                  if (next && (e.currentTarget as HTMLElement).contains(next)) return
                  if (dndState.dropTarget?.taskId === `column:${status.id}`) {
                    dndState.setDropTarget(null)
                  }
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  const raw = e.dataTransfer?.getData("application/x-liaison-task")
                  dndState.clear()
                  if (!raw) return
                  try {
                    const payload = JSON.parse(raw) as DragPayload
                    void handleColumnDrop(status.id, payload)
                  } catch (err) {
                    logger.error({ err }, "kanban_drop_parse_failed")
                  }
                }}
              >
                <header
                  class="group flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2"
                  onDblClick={() => beginRename(status)}
                >
                  <Show
                    when={renamingId() === status.id}
                    fallback={
                      <span
                        data-testid="project-kanban-column-header"
                        class="truncate text-[12px] font-medium uppercase tracking-wide text-text-secondary"
                      >
                        {prettyStatus(status.label)}
                      </span>
                    }
                  >
                    <input
                      data-testid="project-kanban-column-rename-input"
                      value={renameDraft()}
                      ref={(el) => queueMicrotask(() => el.focus())}
                      onInput={(e) => setRenameDraft(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void commitRename(status)
                        } else if (e.key === "Escape") {
                          e.preventDefault()
                          cancelRename()
                        }
                      }}
                      onBlur={() => void commitRename(status)}
                      aria-label={i18n.t("projects.renameColumn")}
                      class="min-w-0 flex-1 rounded-sm border border-accent-muted bg-bg px-1.5 py-0.5 text-[12px] font-medium text-text outline-none"
                    />
                  </Show>
                  <span class="flex items-center gap-1">
                    <Show when={canRename() && renamingId() !== status.id}>
                      <button
                        type="button"
                        data-testid="project-kanban-column-rename"
                        title={i18n.t("projects.renameColumn")}
                        aria-label={i18n.t("projects.renameColumn")}
                        onClick={() => beginRename(status)}
                        class="rounded-sm px-1 text-[11px] text-text-tertiary opacity-0 transition-opacity hover:text-text focus:opacity-100 group-hover:opacity-100"
                      >
                        ✎
                      </button>
                    </Show>
                    <span class="text-[11px] text-text-tertiary">{items().length}</span>
                  </span>
                </header>
                <Show when={renamingId() === status.id && renameError()}>
                  <p
                    data-testid="project-kanban-column-rename-error"
                    class="px-3 py-1 text-[11px] text-warning"
                  >
                    {renameError()}
                  </p>
                </Show>
                <ul class="flex-1 space-y-1 overflow-y-auto px-2 py-2">
                  <For each={items()}>
                    {(t) => {
                      const isDragging = () => dndState.activeTaskId === t.id
                      const dropTarget = () => dndState.dropTarget
                      const isCardTarget = () => dropTarget()?.taskId === t.id
                      const cardPosition = () => (isCardTarget() ? dropTarget()!.position : null)
                      return (
                        <li
                          data-testid="project-kanban-card"
                          data-task-id={t.id}
                          data-dragging={isDragging() ? "true" : undefined}
                          draggable={!props.disabled}
                          onDragStart={(e) => {
                            const payload: DragPayload = {
                              taskId: t.id,
                              fromStatusId: t.statusId,
                            }
                            e.dataTransfer?.setData(
                              "application/x-liaison-task",
                              JSON.stringify(payload),
                            )
                            if (e.dataTransfer) e.dataTransfer.effectAllowed = "move"
                            dndState.beginDrag(t.id)
                          }}
                          onDragEnd={() => dndState.clear()}
                          onDragOver={(e) => {
                            if (!dndState.activeTaskId) return
                            if (dndState.activeTaskId === t.id) return
                            e.preventDefault()
                            e.stopPropagation()
                            e.dataTransfer!.dropEffect = "move"
                            const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                            const position =
                              e.clientY - rect.top < rect.height / 2 ? "above" : "below"
                            dndState.setDropTarget({ taskId: t.id, position })
                          }}
                          onDragLeave={(e) => {
                            const next = e.relatedTarget as Node | null
                            if (next && (e.currentTarget as HTMLElement).contains(next)) return
                            if (dndState.dropTarget?.taskId === t.id) {
                              dndState.setDropTarget(null)
                            }
                          }}
                          onDrop={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            const raw = e.dataTransfer?.getData("application/x-liaison-task")
                            const target = dndState.dropTarget
                            dndState.clear()
                            if (!raw) return
                            const targetTaskId = target?.taskId === t.id ? t.id : null
                            const position =
                              target?.taskId === t.id &&
                              (target.position === "above" || target.position === "below")
                                ? target.position
                                : "below"
                            try {
                              const payload = JSON.parse(raw) as DragPayload
                              if (targetTaskId) {
                                void handleCardDrop(status.id, payload, targetTaskId, position)
                              } else {
                                void handleColumnDrop(status.id, payload)
                              }
                            } catch (err) {
                              logger.error({ err }, "kanban_drop_parse_failed")
                            }
                          }}
                          onClick={() => {
                            if (dndState.activeTaskId) return
                            props.onTaskClick?.(t.id)
                          }}
                          class={
                            isDragging()
                              ? "relative cursor-grabbing rounded border border-border-subtle bg-elevated px-2 py-1.5 text-[12px] text-text opacity-40 transition-opacity"
                              : "relative cursor-grab rounded border border-border-subtle bg-elevated px-2 py-1.5 text-[12px] text-text hover:bg-surface-hover transition-colors"
                          }
                        >
                          {/* Above/below drop indicators */}
                          <Show when={cardPosition() === "above"}>
                            <span
                              aria-hidden="true"
                              data-testid="project-kanban-card.drop-line-above"
                              class="absolute -top-[2px] left-0 right-0 h-0.5 rounded-full bg-accent"
                            />
                          </Show>
                          <Show when={cardPosition() === "below"}>
                            <span
                              aria-hidden="true"
                              data-testid="project-kanban-card.drop-line-below"
                              class="absolute -bottom-[2px] left-0 right-0 h-0.5 rounded-full bg-accent"
                            />
                          </Show>
                          <Show when={t.key}>
                            <span class="mr-1.5 font-mono text-[11px] text-text-tertiary">
                              {t.key}
                            </span>
                          </Show>
                          <span>{t.title}</span>
                          <Show when={t.release}>
                            <span
                              data-testid="project-kanban-card.release"
                              title={i18n.t("projects.checklist.card.releaseTitle", {
                                release: t.release ?? "",
                              })}
                              class="ml-1.5 whitespace-nowrap rounded-sm border border-border-subtle px-1 font-mono text-[10.5px] text-text-secondary"
                            >
                              {t.release}
                            </span>
                          </Show>
                          <KanbanLabelChips task={t} byId={labelById()} />
                          <Show when={showChecklist() && t.checklist && t.checklist.total > 0}>
                            <span class="ml-1.5">
                              <ChecklistCounters status={t.checklist} />
                            </span>
                          </Show>
                          <Show when={props.api}>
                            {(api) => (
                              <LinkedDocuments compact description={t.description} api={api()} />
                            )}
                          </Show>
                          <Show when={t.dueDate}>
                            <span
                              data-testid="project-kanban-card.due-date"
                              title={i18n.t("projects.dueDateTitle", {
                                date: formatDay(t.dueDate, i18n.locale(), { dateStyle: "long" }),
                              })}
                              class={`ml-1.5 font-mono text-[11px] tabular-nums ${dueChipColorClass(
                                dueBucket(
                                  t.dueDate,
                                  status.terminal,
                                  new Date().toISOString().slice(0, 10),
                                ),
                              )}`}
                            >
                              {formatDay(t.dueDate, i18n.locale())}
                            </span>
                          </Show>
                        </li>
                      )
                    }}
                  </For>
                </ul>
              </section>
            )
          }}
        </For>
      </div>
    </Show>
  )
}
