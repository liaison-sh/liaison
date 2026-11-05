// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createSignal, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { DeleteStatusDialog } from "~/modules/projects/DeleteStatusDialog"
import type { ProjectStatus } from "~/modules/projects/project-store"
import { ValidationLevelsSection } from "~/modules/projects/ValidationLevelsSection"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

interface StatusManagerProps {
  api: ApiClient
  projectId: string
  statuses: ProjectStatus[]
  archived?: boolean
}

export const StatusManager: Component<StatusManagerProps> = (props) => {
  const i18n = useI18n()
  const [adding, setAdding] = createSignal(false)
  const [newLabel, setNewLabel] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [deletingStatus, setDeletingStatus] = createSignal<ProjectStatus | null>(null)
  const [editingId, setEditingId] = createSignal<string | null>(null)
  const [editLabel, setEditLabel] = createSignal("")

  const sorted = () => [...props.statuses].sort((a, b) => a.order - b.order)

  const addStatus = async () => {
    const label = newLabel().trim()
    if (!label) return
    setBusy(true)
    setError(null)
    try {
      await props.api.post(`/projects/${props.projectId}/statuses`, { label })
      setNewLabel("")
      setAdding(false)
    } catch (err) {
      setError((err as Error).message ?? "Add failed")
    } finally {
      setBusy(false)
    }
  }

  const startEdit = (status: ProjectStatus) => {
    setEditingId(status.id)
    setEditLabel(status.label)
    setError(null)
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditLabel("")
  }

  const saveEdit = async (statusId: string) => {
    const next = editLabel().trim()
    if (!next) return
    setBusy(true)
    setError(null)
    try {
      await props.api.patch(`/projects/${props.projectId}/statuses/${statusId}`, {
        label: next,
      })
      cancelEdit()
    } catch (err) {
      setError((err as Error).message ?? "Rename failed")
    } finally {
      setBusy(false)
    }
  }

  // `terminal` is what makes a column count as done (done-vs-remaining
  // rollups, completedAt). A custom board's "Done" column has to be settable
  // from here, otherwise only the seeded defaults ever get the flag.
  const setTerminal = async (statusId: string, terminal: boolean) => {
    setBusy(true)
    setError(null)
    try {
      await props.api.patch(`/projects/${props.projectId}/statuses/${statusId}`, { terminal })
    } catch (err) {
      setError((err as Error).message ?? "Update failed")
    } finally {
      setBusy(false)
    }
  }

  const reorder = async (id: string, dir: -1 | 1) => {
    const list = sorted()
    const idx = list.findIndex((s) => s.id === id)
    const target = idx + dir
    if (target < 0 || target >= list.length) return
    const reordered = [...list]
    const [moved] = reordered.splice(idx, 1)
    reordered.splice(target, 0, moved!)
    setBusy(true)
    setError(null)
    try {
      await props.api.post(`/projects/${props.projectId}/statuses/reorder`, {
        orderedStatusIds: reordered.map((s) => s.id),
      })
    } catch (err) {
      setError((err as Error).message ?? "Reorder failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="status-manager" class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <h3 class="text-[12px] font-medium uppercase tracking-wide text-text-secondary">
          {i18n.t("projects.statuses")}
        </h3>
        <Show when={!props.archived && !adding()}>
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
            <span data-testid="status-manager.add-trigger">{i18n.t("projects.addStatus")}</span>
          </Button>
        </Show>
      </div>

      <Show when={adding() && !props.archived}>
        <div data-testid="status-manager.add-form" class="flex items-center gap-2">
          <Input
            data-testid="status-manager.add-input"
            value={newLabel()}
            onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
            placeholder={i18n.t("projects.newStatusLabel")}
          />
          <Button variant="primary" size="sm" disabled={busy()} onClick={() => void addStatus()}>
            <span data-testid="status-manager.add-confirm">{i18n.t("projects.add")}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
            {i18n.t("kernel.common.cancel")}
          </Button>
        </div>
      </Show>

      <ul class="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
        <For each={sorted()}>
          {(s, i) => (
            <li
              data-testid="status-manager.row"
              data-status-id={s.id}
              class="flex items-center gap-2 px-3 py-2 text-[13px]"
            >
              <Show
                when={editingId() === s.id}
                fallback={<span class="flex-1 text-text">{s.label}</span>}
              >
                <Input
                  data-testid="status-manager.rename-input"
                  value={editLabel()}
                  onInput={(e) => setEditLabel((e.target as HTMLInputElement).value)}
                  class="flex-1"
                />
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy() || !editLabel().trim()}
                  onClick={() => void saveEdit(s.id)}
                >
                  <span data-testid="status-manager.rename-save">{i18n.t("projects.save")}</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={cancelEdit}>
                  {i18n.t("kernel.common.cancel")}
                </Button>
              </Show>
              <Show when={!props.archived && editingId() !== s.id}>
                <label
                  class="flex items-center gap-1 text-[11px] text-text-tertiary"
                  title={i18n.t("projects.countsAsDone")}
                >
                  <input
                    type="checkbox"
                    data-testid="status-manager.terminal"
                    checked={s.terminal}
                    disabled={busy()}
                    onChange={(e) => void setTerminal(s.id, e.currentTarget.checked)}
                  />
                  {i18n.t("projects.countsAsDone")}
                </label>
                <button
                  type="button"
                  data-testid="status-manager.rename"
                  onClick={() => startEdit(s)}
                  class="text-[11px] text-text-tertiary hover:text-text"
                >
                  {i18n.t("kernel.common.rename")}
                </button>
                <button
                  type="button"
                  data-testid="status-manager.move-up"
                  disabled={i() === 0 || busy()}
                  onClick={() => void reorder(s.id, -1)}
                  class="text-[11px] text-text-tertiary hover:text-text disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  data-testid="status-manager.move-down"
                  disabled={i() === sorted().length - 1 || busy()}
                  onClick={() => void reorder(s.id, 1)}
                  class="text-[11px] text-text-tertiary hover:text-text disabled:opacity-30"
                >
                  ↓
                </button>
                <button
                  type="button"
                  data-testid="status-manager.delete"
                  onClick={() => setDeletingStatus(s)}
                  class="text-[11px] text-text-tertiary hover:text-warning"
                >
                  {i18n.t("kernel.common.delete")}
                </button>
              </Show>
            </li>
          )}
        </For>
      </ul>

      <Show when={error()}>
        <p data-testid="status-manager.error" class="text-[12px] text-warning">
          {error()}
        </p>
      </Show>

      <DeleteStatusDialog
        open={!!deletingStatus()}
        onOpenChange={(o) => {
          if (!o) setDeletingStatus(null)
        }}
        api={props.api}
        projectId={props.projectId}
        status={deletingStatus()}
        otherStatuses={sorted().filter((s) => s.id !== deletingStatus()?.id)}
      />

      <ValidationLevelsSection
        api={props.api}
        projectId={props.projectId}
        archived={props.archived}
      />
    </div>
  )
}
