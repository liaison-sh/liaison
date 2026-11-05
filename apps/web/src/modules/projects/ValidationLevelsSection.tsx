// SPDX-License-Identifier: FSL-1.1-ALv2
// "Checklist validations" section of the statuses dialog: the project's
// ordered validation levels, edited as a local draft and saved in one PUT
// carrying the whole ordered list (the API replaces the list, keeping ids of
// existing levels and deleting the states of removed ones), and the per-project
// option that shows the checklist counters on Kanban cards.
import { type Component, createSignal, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { checklistStore } from "~/modules/projects/checklist-store"
import type { ValidationLevel } from "~/modules/projects/checklist-types"
import { pluralFormFor } from "~/modules/projects/plural"
import { handleProjectEvent, projectStore } from "~/modules/projects/project-store"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"

export const MAX_LEVELS = 8
export const MAX_LEVEL_NAME = 24

interface DraftLevel {
  /** Local row key (stable across renames and moves). */
  key: string
  /** Server id; absent for a level added in this draft. */
  id?: string
  name: string
}

type NameError = "required" | "tooLong" | "duplicate"

/** Mirrors the API's rule (S2): 1..24 chars trimmed, unique case-insensitively. */
export function levelNameErrors(names: string[]): (NameError | null)[] {
  const seen = new Map<string, number>()
  for (const n of names) {
    const k = n.trim().toLowerCase()
    if (k) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return names.map((n) => {
    const t = n.trim()
    if (!t) return "required"
    if (t.length > MAX_LEVEL_NAME) return "tooLong"
    if ((seen.get(t.toLowerCase()) ?? 0) > 1) return "duplicate"
    return null
  })
}

interface ValidationLevelsSectionProps {
  api: ApiClient
  projectId: string
  archived?: boolean
}

let keySeq = 0

export const ValidationLevelsSection: Component<ValidationLevelsSectionProps> = (props) => {
  const i18n = useI18n()
  const [draft, setDraft] = createSignal<DraftLevel[] | null>(null)
  const [confirming, setConfirming] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const saved = (): ValidationLevel[] =>
    projectStore.project(props.projectId)?.validationLevels ?? []

  // Not editing: rows are the saved levels. First edit copies them into the draft.
  const rows = (): DraftLevel[] =>
    draft() ?? saved().map((l) => ({ key: l.id, id: l.id, name: l.name }))
  const edit = (fn: (list: DraftLevel[]) => DraftLevel[]) => {
    setError(null)
    setDraft(fn(rows().map((r) => ({ ...r }))))
  }

  const errors = () => levelNameErrors(rows().map((r) => r.name))
  const canSave = () => draft() !== null && !busy() && errors().every((e) => e === null)

  /** Items of the loaded board with a state recorded on the level (success, fail or N/A). */
  const recordedCount = (levelId: string): number => {
    let n = 0
    for (const task of projectStore.tasksFor(props.projectId)) {
      const cl = task.checklist
      const entry = cl?.perLevel?.find((p) => p.levelId === levelId)
      if (cl && entry) n += entry.success + entry.fail + (cl.total - entry.applicable)
    }
    return n
  }

  const rename = (key: string, name: string) =>
    edit((list) => list.map((r) => (r.key === key ? { ...r, name } : r)))
  const move = (key: string, dir: -1 | 1) =>
    edit((list) => {
      const idx = list.findIndex((r) => r.key === key)
      const target = idx + dir
      if (idx < 0 || target < 0 || target >= list.length) return list
      const [moved] = list.splice(idx, 1)
      list.splice(target, 0, moved!)
      return list
    })
  const add = () => {
    if (rows().length >= MAX_LEVELS) return
    keySeq += 1
    edit((list) => [...list, { key: `new-${keySeq}`, name: "" }])
  }
  const removeNow = (key: string) => {
    setConfirming(null)
    edit((list) => list.filter((r) => r.key !== key))
  }
  const requestRemove = (row: DraftLevel) => {
    if (row.id && recordedCount(row.id) > 0) setConfirming(row.key)
    else removeNow(row.key)
  }

  const save = async () => {
    if (!canSave()) return
    setBusy(true)
    setError(null)
    try {
      await checklistStore.setLevels(
        props.api,
        props.projectId,
        rows().map((r) => ({
          ...(r.id ? { id: r.id } : {}),
          name: r.name.trim(),
        })),
      )
      setDraft(null)
      setConfirming(null)
    } catch (err) {
      setError((err as Error).message || i18n.t("projects.checklist.levels.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  // Per-project option (absent reads as on). Applied locally at once, reverted
  // when the PATCH fails; the project updated event confirms it elsewhere.
  const [cardsBusy, setCardsBusy] = createSignal(false)
  const [cardsError, setCardsError] = createSignal(false)
  const onCards = () => projectStore.project(props.projectId)?.checklistOnCards !== false
  const setOnCards = async (next: boolean) => {
    const prev = onCards()
    setCardsBusy(true)
    setCardsError(false)
    handleProjectEvent("updated", { id: props.projectId, checklistOnCards: next })
    try {
      await props.api.patch(`/projects/${props.projectId}`, { checklistOnCards: next })
    } catch {
      handleProjectEvent("updated", { id: props.projectId, checklistOnCards: prev })
      setCardsError(true)
    } finally {
      setCardsBusy(false)
    }
  }

  const errorText = (e: NameError) =>
    e === "required"
      ? i18n.t("projects.checklist.levels.nameRequired")
      : e === "tooLong"
        ? i18n.t("projects.checklist.levels.nameTooLong")
        : i18n.t("projects.checklist.levels.nameDuplicate")

  const confirmText = (row: DraftLevel) => {
    const count = row.id ? recordedCount(row.id) : 0
    const key =
      pluralFormFor(i18n.locale(), count) === "one"
        ? "projects.checklist.levels.confirmRemoveOne"
        : "projects.checklist.levels.confirmRemoveMany"
    return i18n.t(key, { name: row.name.trim() || "", count: String(count) })
  }

  const btn = "text-[11px] text-text-tertiary hover:text-text disabled:opacity-30"

  return (
    <div data-testid="levels.section" class="mt-4 flex flex-col gap-2">
      <h3 class="text-[12px] font-medium uppercase tracking-wide text-text-secondary">
        {i18n.t("projects.checklist.levels.title")}
      </h3>

      <Show when={rows().length > 0}>
        <ul class="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
          <For each={rows()}>
            {(row, i) => (
              <li
                data-testid="levels.row"
                data-level-id={row.id ?? ""}
                class="flex flex-col gap-1 px-3 py-2 text-[13px]"
              >
                <div class="flex items-center gap-2">
                  <Input
                    data-testid="levels.name"
                    aria-label={i18n.t("projects.checklist.levels.nameLabel")}
                    value={row.name}
                    disabled={props.archived || busy()}
                    onInput={(e) => rename(row.key, (e.target as HTMLInputElement).value)}
                    class="flex-1"
                  />
                  <Show when={!props.archived}>
                    <button
                      type="button"
                      data-testid="levels.move-up"
                      aria-label={i18n.t("projects.checklist.levels.moveUp")}
                      disabled={i() === 0 || busy()}
                      onClick={() => move(row.key, -1)}
                      class={btn}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      data-testid="levels.move-down"
                      aria-label={i18n.t("projects.checklist.levels.moveDown")}
                      disabled={i() === rows().length - 1 || busy()}
                      onClick={() => move(row.key, 1)}
                      class={btn}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      data-testid="levels.remove"
                      disabled={busy()}
                      onClick={() => requestRemove(row)}
                      class="text-[11px] text-text-tertiary hover:text-warning disabled:opacity-30"
                    >
                      {i18n.t("projects.checklist.levels.remove")}
                    </button>
                  </Show>
                </div>
                <Show when={errors()[i()]}>
                  {(e) => (
                    <p data-testid="levels.error" class="text-[11px] text-warning">
                      {errorText(e())}
                    </p>
                  )}
                </Show>
                <Show when={confirming() === row.key}>
                  <div
                    data-testid="levels.confirm-remove"
                    class="flex items-center gap-2 text-[12px] text-text-secondary"
                  >
                    <span class="flex-1">{confirmText(row)}</span>
                    <Button variant="ghost" size="sm" onClick={() => removeNow(row.key)}>
                      <span data-testid="levels.confirm-remove.confirm">
                        {i18n.t("projects.checklist.levels.confirmRemove")}
                      </span>
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                      <span data-testid="levels.confirm-remove.cancel">
                        {i18n.t("projects.checklist.levels.cancel")}
                      </span>
                    </Button>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={!props.archived}>
        <div class="flex items-center justify-between gap-2">
          <button
            type="button"
            data-testid="levels.add"
            disabled={rows().length >= MAX_LEVELS || busy()}
            onClick={add}
            class="text-[12px] text-text-tertiary hover:text-text disabled:opacity-30"
          >
            + {i18n.t("projects.checklist.levels.add")}
          </button>
          <Button
            variant="primary"
            size="sm"
            data-testid="levels.save"
            disabled={!canSave()}
            onClick={() => void save()}
          >
            {busy()
              ? i18n.t("projects.checklist.levels.saving")
              : i18n.t("projects.checklist.levels.save")}
          </Button>
        </div>
        <Show when={rows().length >= MAX_LEVELS}>
          <p data-testid="levels.max" class="text-[11px] text-text-tertiary">
            {i18n.t("projects.checklist.levels.max")}
          </p>
        </Show>
      </Show>

      <p data-testid="levels.hint" class="text-[11px] text-text-tertiary">
        {i18n.t("projects.checklist.levels.hint")}
      </p>

      <label class="flex items-center gap-2 text-[13px] text-text">
        <input
          type="checkbox"
          data-testid="levels.show-on-cards"
          checked={onCards()}
          disabled={props.archived || cardsBusy()}
          onChange={(e) => void setOnCards((e.target as HTMLInputElement).checked)}
        />
        {i18n.t("projects.checklist.levels.showOnCards")}
      </label>
      <Show when={cardsError()}>
        <p data-testid="levels.show-on-cards-error" class="text-[12px] text-warning">
          {i18n.t("projects.checklist.levels.showOnCardsFailed")}
        </p>
      </Show>

      <Show when={error()}>
        <p data-testid="levels.save-error" class="text-[12px] text-warning">
          {error()}
        </p>
      </Show>
    </div>
  )
}
