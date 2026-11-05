// SPDX-License-Identifier: FSL-1.1-ALv2
// Task checklist section of the task detail (spec S18): one row per item with
// a named chip per validation level of the task's project (a checkbox in
// plain mode), inline title and details editing, drag reorder, in-page remove
// confirmation and an inline add row. Writes go through checklist-store,
// which echoes the server's answer locally (StatusPillPopover pattern).

import {
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  GripVertical,
  Minus,
  Plus,
  Trash2,
  X,
} from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { relativeTime } from "~/lib/relative-time"
import { userFromToken } from "~/modules/auth/auth-store"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { useI18n } from "~/modules/i18n/i18n-context"
import { checklistStore } from "~/modules/projects/checklist-store"
import type {
  ChecklistItem,
  ValidationLevel,
  ValidationRecord,
  ValidationState,
} from "~/modules/projects/checklist-types"
import { computeDropPosition } from "~/modules/projects/dnd-state"
import { MarkdownContent } from "~/modules/shell/markdown-content"
import { addToast } from "~/modules/shell/toast-store"
import { Tooltip } from "~/ui/Tooltip"

const K = "projects.checklist.detail"

const STATES: ValidationState[] = ["not_done", "success", "fail", "na"]

const STATE_KEY: Record<ValidationState, string> = {
  not_done: `${K}.state.notDone`,
  success: `${K}.state.success`,
  fail: `${K}.state.fail`,
  na: `${K}.state.na`,
}

const STATE_TONE: Record<ValidationState, string> = {
  not_done: "border-border text-text-secondary",
  success: "border-success-border bg-success-glow text-success",
  fail: "border-error-border bg-error-glow text-error",
  na: "border-dashed border-border text-text-tertiary",
}

const StateGlyph: Component<{ state: ValidationState }> = (props) => (
  <span aria-hidden="true" class="inline-flex w-3 justify-center">
    <Show when={props.state === "success"}>
      <Check class="h-3 w-3" />
    </Show>
    <Show when={props.state === "fail"}>
      <X class="h-3 w-3" />
    </Show>
    <Show when={props.state === "na"}>
      <Minus class="h-3 w-3" />
    </Show>
    <Show when={props.state === "not_done"}>
      <Circle class="h-2.5 w-2.5" />
    </Show>
  </span>
)

// --- Who set a state: user id -> display name, fetched once per id. ---
const nameCache = new Map<string, () => string | null>()

function useUserName(api: ApiClient, userId: () => string | undefined): () => string | null {
  return () => {
    const id = userId()
    if (!id) return null
    let get = nameCache.get(id)
    if (!get) {
      const [name, setName] = createSignal<string | null>(null)
      get = name
      nameCache.set(id, get)
      void api
        .getEnvelope<{ name: string | null; email: string | null }>(`/users/${id}/preview`)
        .then((res) => setName(res?.data?.name ?? res?.data?.email ?? null))
        .catch(() => undefined)
    }
    return get()
  }
}

/** Seams tests need on this module's private state (one named door, not a name per hook). */
export const ChecklistTestAccess = {
  /** Forget resolved assignee names between cases. */
  resetNames(): void {
    nameCache.clear()
  },
}

function toastSaveFailed(message: string, err: unknown): void {
  addToast({ message, type: "error" })
  console.error("checklist write failed", err)
}

interface ChecklistProps {
  api: ApiClient
  projectId: string
  taskId: string
  disabled?: boolean
}

export const Checklist: Component<ChecklistProps> = (props) => {
  const i18n = useI18n()

  createEffect(
    on(
      () => [props.projectId, props.taskId] as const,
      ([projectId, taskId]) => {
        void checklistStore.load(props.api, projectId, taskId)
      },
    ),
  )

  const levels = () => checklistStore.levels(props.taskId)
  const items = () => checklistStore.items(props.taskId)
  const status = () => checklistStore.status(props.taskId)

  const [dragId, setDragId] = createSignal<string | null>(null)
  const [dropAt, setDropAt] = createSignal<{ id: string; pos: "above" | "below" } | null>(null)

  const drop = async (targetId: string, pos: "above" | "below") => {
    const moving = dragId()
    setDragId(null)
    setDropAt(null)
    if (!moving || moving === targetId) return
    const order = items()
      .map((i) => i.id)
      .filter((id) => id !== moving)
    const at = order.indexOf(targetId) + (pos === "below" ? 1 : 0)
    const afterItemId = order[at - 1] ?? null
    const beforeItemId = order[at] ?? null
    try {
      await checklistStore.updateItem(props.api, props.projectId, props.taskId, moving, {
        afterItemId,
        beforeItemId,
      })
    } catch (err) {
      toastSaveFailed(i18n.t(`${K}.saveFailed`), err)
    }
  }

  return (
    <section
      id="task-checklist"
      data-testid="task-detail.checklist"
      class="flex flex-col gap-2 scroll-mt-4"
    >
      <h3
        data-testid="checklist.header"
        class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary"
      >
        {i18n.t(`${K}.title`)}
        <Show when={(status()?.total ?? 0) > 0}>
          {" · "}
          <span class="font-mono tabular-nums normal-case">
            {i18n.t(`${K}.complete`, {
              n: status()?.complete ?? 0,
              m: status()?.total ?? 0,
            })}
          </span>
          <Show when={(status()?.failing ?? 0) > 0}>
            {" · "}
            <span class="font-mono tabular-nums normal-case text-error">
              {i18n.t(`${K}.failing`, { count: status()?.failing ?? 0 })}
            </span>
          </Show>
        </Show>
      </h3>
      <Show when={checklistStore.get(props.taskId)?.error}>
        <p class="text-[12px] text-error">{i18n.t(`${K}.loadFailed`)}</p>
      </Show>
      <Show when={items().length > 0}>
        <ul class="divide-y divide-border-subtle border-y border-border-subtle">
          <For each={items()}>
            {(item) => (
              <ChecklistRow
                api={props.api}
                projectId={props.projectId}
                taskId={props.taskId}
                item={item}
                levels={levels()}
                disabled={!!props.disabled}
                dragging={dragId() === item.id}
                dropPosition={dropAt()?.id === item.id ? dropAt()!.pos : null}
                onDragStart={() => setDragId(item.id)}
                onDragEnd={() => {
                  setDragId(null)
                  setDropAt(null)
                }}
                onDragOver={(pos) => {
                  if (dragId() && dragId() !== item.id) setDropAt({ id: item.id, pos })
                }}
                onDrop={(pos) => void drop(item.id, pos)}
              />
            )}
          </For>
        </ul>
      </Show>
      <Show when={!props.disabled}>
        <AddItemRow api={props.api} projectId={props.projectId} taskId={props.taskId} />
      </Show>
    </section>
  )
}

const AddItemRow: Component<{ api: ApiClient; projectId: string; taskId: string }> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [title, setTitle] = createSignal("")
  let editor: RichEditorHandle | undefined

  const submit = async () => {
    const next = title().trim()
    if (!next || busy()) return
    setBusy(true)
    try {
      await checklistStore.addItems(props.api, props.projectId, props.taskId, [{ title: next }])
      setTitle("")
      editor?.focus()
    } catch (err) {
      toastSaveFailed(i18n.t(`${K}.saveFailed`), err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show
      when={open()}
      fallback={
        <button
          type="button"
          data-testid="checklist.add"
          class="inline-flex w-fit items-center gap-1 rounded-sm border border-dashed border-border px-2 py-1 text-[12px] text-text-tertiary transition-colors hover:text-text-secondary"
          onClick={() => setOpen(true)}
        >
          <Plus class="h-3 w-3" />
          {i18n.t(`${K}.addItem`)}
        </button>
      }
    >
      <RichEditor
        preset="inline"
        autofocus
        ref={(handle) => {
          editor = handle
        }}
        value={title()}
        onChange={setTitle}
        maxLength={300}
        disabled={busy()}
        placeholder={i18n.t(`${K}.addItemPlaceholder`)}
        aria-label={i18n.t(`${K}.addItem`)}
        data-testid="checklist.add-input"
        onSubmit={() => void submit()}
        onCancel={() => setOpen(false)}
        onBlur={() => {
          if (!title().trim()) setOpen(false)
        }}
        class="w-full rounded-sm border border-border bg-bg px-2 py-1 focus-within:border-accent-muted"
      />
    </Show>
  )
}

interface RowProps {
  api: ApiClient
  projectId: string
  taskId: string
  item: ChecklistItem
  levels: ValidationLevel[]
  disabled: boolean
  dragging: boolean
  dropPosition: "above" | "below" | null
  onDragStart(): void
  onDragEnd(): void
  onDragOver(pos: "above" | "below"): void
  onDrop(pos: "above" | "below"): void
}

const ChecklistRow: Component<RowProps> = (props) => {
  const i18n = useI18n()
  const [expanded, setExpanded] = createSignal(false)
  const [editingTitle, setEditingTitle] = createSignal(false)
  const [confirmRemove, setConfirmRemove] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  const save = async (patch: { title?: string; details?: string | null }) => {
    try {
      await checklistStore.updateItem(
        props.api,
        props.projectId,
        props.taskId,
        props.item.id,
        patch,
      )
    } catch (err) {
      toastSaveFailed(i18n.t(`${K}.saveFailed`), err)
    }
  }

  const toggleChecked = async (checked: boolean) => {
    try {
      await checklistStore.setValidations(props.api, props.projectId, props.taskId, [
        { itemId: props.item.id, checked },
      ])
    } catch (err) {
      toastSaveFailed(i18n.t(`${K}.saveFailed`), err)
    }
  }

  const remove = async () => {
    if (busy()) return
    setBusy(true)
    try {
      await checklistStore.removeItem(props.api, props.projectId, props.taskId, props.item.id)
    } catch (err) {
      toastSaveFailed(i18n.t(`${K}.saveFailed`), err)
    } finally {
      setBusy(false)
      setConfirmRemove(false)
    }
  }

  const posFromEvent = (e: DragEvent): "above" | "below" => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    // Shift semantics of the shared helper: sibling placement only, no nesting.
    return computeDropPosition(e, rect, true) === "above" ? "above" : "below"
  }

  return (
    <li
      data-testid={`checklist.item-${props.item.id}`}
      data-item-id={props.item.id}
      class="relative"
      classList={{
        "opacity-50": props.dragging,
        "before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent":
          props.dropPosition === "above",
        "after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-accent":
          props.dropPosition === "below",
      }}
      onDragOver={(e) => {
        e.preventDefault()
        props.onDragOver(posFromEvent(e))
      }}
      onDrop={(e) => {
        e.preventDefault()
        props.onDrop(posFromEvent(e))
      }}
    >
      <div class="group flex items-start gap-2 px-1 py-1.5">
        <Show when={!props.disabled}>
          <span
            draggable="true"
            data-testid="checklist.drag-handle"
            aria-hidden="true"
            title={i18n.t(`${K}.dragHandle`)}
            class="mt-0.5 cursor-grab text-text-tertiary opacity-0 transition-opacity group-hover:opacity-100 in-data-[shell-tier=phone]:hidden in-data-[shell-tier=tablet]:hidden"
            onDragStart={(e) => {
              e.dataTransfer?.setData("text/plain", props.item.id)
              props.onDragStart()
            }}
            onDragEnd={() => props.onDragEnd()}
          >
            <GripVertical class="h-3.5 w-3.5" />
          </span>
        </Show>
        <button
          type="button"
          data-testid="checklist.caret"
          aria-expanded={expanded()}
          aria-label={i18n.t(expanded() ? `${K}.collapse` : `${K}.expand`)}
          // A finger-tall target that stays chevron-wide, so the box sits next to it.
          data-touch-dense
          class="mt-0.5 flex items-center justify-center text-text-tertiary hover:text-text-secondary in-data-[shell-tier=phone]:-my-2.5 in-data-[shell-tier=phone]:h-11 in-data-[shell-tier=phone]:w-6 in-data-[shell-tier=tablet]:-my-2.5 in-data-[shell-tier=tablet]:h-11 in-data-[shell-tier=tablet]:w-6"
          onClick={() => setExpanded(!expanded())}
        >
          <Show when={expanded()} fallback={<ChevronRight class="h-3.5 w-3.5" />}>
            <ChevronDown class="h-3.5 w-3.5" />
          </Show>
        </button>
        <Show when={props.levels.length === 0}>
          <input
            type="checkbox"
            data-testid="checklist.checkbox"
            checked={props.item.checked}
            disabled={props.disabled}
            aria-label={i18n.t(`${K}.checkedLabel`, { title: props.item.title })}
            class="mt-1 accent-[var(--color-accent)]"
            onChange={(e) => void toggleChecked(e.currentTarget.checked)}
          />
        </Show>
        <div class="min-w-0 flex-1">
          <Show
            when={editingTitle()}
            fallback={
              <button
                type="button"
                data-testid="checklist.title"
                disabled={props.disabled}
                class="block w-full text-left text-[13px] text-text disabled:cursor-default"
                classList={{ "cursor-text": !props.disabled }}
                onClick={() => setEditingTitle(true)}
              >
                <MarkdownContent inline content={props.item.title} api={props.api} />
              </button>
            }
          >
            <ItemTitleEditor
              title={props.item.title}
              onDone={(next) => {
                setEditingTitle(false)
                if (next && next !== props.item.title) void save({ title: next })
              }}
            />
          </Show>
        </div>
        <div class="flex flex-wrap justify-end gap-1">
          <For each={props.levels}>
            {(level) => (
              <LevelChip
                api={props.api}
                projectId={props.projectId}
                taskId={props.taskId}
                item={props.item}
                level={level}
                disabled={props.disabled}
              />
            )}
          </For>
        </div>
        <Show when={!props.disabled}>
          <button
            type="button"
            data-testid="checklist.remove"
            aria-label={i18n.t(`${K}.remove`)}
            title={i18n.t(`${K}.remove`)}
            class="mt-0.5 text-text-tertiary opacity-0 transition-opacity hover:text-danger focus:opacity-100 group-hover:opacity-100"
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2 class="h-3.5 w-3.5" />
          </button>
        </Show>
      </div>
      <Show when={confirmRemove()}>
        <div
          data-testid="checklist.remove-confirm-row"
          class="flex items-center gap-2 px-7 pb-2 text-[12px]"
        >
          <span class="text-text-secondary">{i18n.t(`${K}.removeConfirm`)}</span>
          <button
            type="button"
            data-testid="checklist.remove-confirm"
            disabled={busy()}
            class="rounded-sm border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-danger disabled:opacity-50"
            onClick={() => void remove()}
          >
            {i18n.t(`${K}.removeConfirmAction`)}
          </button>
          <button
            type="button"
            data-testid="checklist.remove-cancel"
            class="px-1.5 py-0.5 text-text-tertiary hover:text-text-secondary"
            onClick={() => setConfirmRemove(false)}
          >
            {i18n.t(`${K}.cancel`)}
          </button>
        </div>
      </Show>
      <Show when={expanded()}>
        <ItemDetails
          api={props.api}
          item={props.item}
          levels={props.levels}
          disabled={props.disabled}
          onSave={(details) => void save({ details })}
        />
      </Show>
    </li>
  )
}

const ItemDetails: Component<{
  api: ApiClient
  item: ChecklistItem
  levels: ValidationLevel[]
  disabled: boolean
  onSave(details: string | null): void
}> = (props) => {
  const i18n = useI18n()
  const [editing, setEditing] = createSignal(false)
  const finishDetails = (next: string | null) => {
    setEditing(false)
    if (next !== null && next !== (props.item.details ?? "")) {
      props.onSave(next.length > 0 ? next : null)
    }
  }
  return (
    <div data-testid="checklist.details" class="flex flex-col gap-2 pb-2 pl-7 pr-1">
      <Show
        when={editing()}
        fallback={
          <div class="flex items-start gap-2">
            <div class="min-w-0 flex-1 text-[12.5px] text-text-secondary">
              <Show
                when={props.item.details}
                fallback={<span class="italic text-text-tertiary">{i18n.t(`${K}.noDetails`)}</span>}
              >
                <MarkdownContent
                  content={props.item.details ?? ""}
                  api={props.api}
                  class="prose-thread"
                  data-testid="checklist.details-rendered"
                />
              </Show>
            </div>
            <Show when={!props.disabled}>
              <button
                type="button"
                data-testid="checklist.details-edit"
                class="text-[11.5px] text-text-tertiary hover:text-text-secondary"
                onClick={() => setEditing(true)}
              >
                {i18n.t(`${K}.editDetails`)}
              </button>
            </Show>
          </div>
        }
      >
        <ItemDetailsEditor details={props.item.details ?? ""} onDone={finishDetails} />
      </Show>
      <For each={props.levels.filter((l) => props.item.validations?.[l.id])}>
        {(level) => (
          <RecordLine api={props.api} level={level} record={props.item.validations[level.id]!} />
        )}
      </For>
    </div>
  )
}

/**
 * A checklist title being edited: one line, marks only. Enter or leaving the
 * field saves, Escape keeps the stored title. The draft is local, so an echo of
 * this item from another tab never resets what is being typed.
 */
const ItemTitleEditor: Component<{ title: string; onDone(next: string | null): void }> = (
  props,
) => {
  const [draft, setDraft] = createSignal(props.title)
  let done = false
  const finish = (next: string | null) => {
    if (done) return
    done = true
    props.onDone(next)
  }
  return (
    <RichEditor
      preset="inline"
      autofocus
      value={untrack(() => props.title)}
      onChange={setDraft}
      maxLength={300}
      data-testid="checklist.title-input"
      onSubmit={() => finish(draft().trim())}
      onBlur={() => finish(draft().trim())}
      onCancel={() => finish(null)}
      class="w-full rounded-sm bg-surface px-1 ring-1 ring-accent-border"
    />
  )
}

/** A checklist item's details being edited: the full editor, saved on leaving it. */
const ItemDetailsEditor: Component<{ details: string; onDone(next: string | null): void }> = (
  props,
) => {
  const i18n = useI18n()
  const [draft, setDraft] = createSignal(props.details)
  let done = false
  const finish = (next: string | null) => {
    if (done) return
    done = true
    // The editor hands back the stored text verbatim while nothing changed.
    props.onDone(next === null || next === props.details ? next : next.trim())
  }
  return (
    <RichEditor
      preset="full"
      autofocus
      value={untrack(() => props.details)}
      onChange={setDraft}
      maxLength={10000}
      placeholder={i18n.t(`${K}.detailsPlaceholder`)}
      data-testid="checklist.details-input"
      onSubmit={() => finish(draft())}
      onBlur={() => finish(draft())}
      onCancel={() => finish(null)}
      class="rounded-sm border-l border-accent-border bg-(--editor-bg) px-3 py-2 [--editor-bg:color-mix(in_srgb,var(--color-surface)_60%,var(--color-bg))]"
      editorClass="min-h-[4.5rem]"
    />
  )
}

/** One line of provenance under the details: level, state, who, when, source. */
const RecordLine: Component<{
  api: ApiClient
  level: ValidationLevel
  record: ValidationRecord
}> = (props) => {
  const i18n = useI18n()
  const attribution = useAttribution(props.api, () => props.record)
  return (
    <p data-testid="checklist.record" class="text-[11.5px] text-text-tertiary">
      <span class="font-mono">{props.level.name}</span> {i18n.t(STATE_KEY[props.record.state])}.{" "}
      {attribution()}
      <Show when={props.record.source}>
        {". "}
        <SourceLink url={props.record.source!} />
      </Show>
    </p>
  )
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

/** A link only for an https URL; anything else is shown as inert text. */
const SourceLink: Component<{ url: string }> = (props) => {
  const i18n = useI18n()
  return (
    <Show
      when={isHttpsUrl(props.url)}
      fallback={
        <span data-testid="checklist.source-link" class="break-all text-text-secondary">
          {props.url}
        </span>
      }
    >
      <a
        href={props.url}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="checklist.source-link"
        class="text-accent underline-offset-2 hover:underline"
      >
        {i18n.t(`${K}.sourceLink`)}
      </a>
    </Show>
  )
}

/** "Set by Alice, 2 hours ago" / "Set by an agent for Alice, ..." for a record. */
function useAttribution(
  api: ApiClient,
  record: () => ValidationRecord | undefined,
): () => string | null {
  const i18n = useI18n()
  const name = useUserName(api, () => record()?.by)
  return () => {
    const r = record()
    if (!r) return null
    const who =
      r.by && r.by === userFromToken()?.userId
        ? i18n.t(`${K}.you`)
        : (name() ?? i18n.t(`${K}.someone`))
    const when = r.at ? relativeTime(r.at, i18n.locale()) : ""
    return r.via === "agent"
      ? i18n.t(`${K}.attributionAgent`, { name: who, when })
      : i18n.t(`${K}.attributionHuman`, { name: who, when })
  }
}

interface LevelChipProps {
  api: ApiClient
  projectId: string
  taskId: string
  item: ChecklistItem
  level: ValidationLevel
  disabled: boolean
}

/**
 * One named chip per level. Click opens the state popover (StatusPillPopover
 * pattern); Fail swaps the list for a required note posted to the thread.
 */
export const LevelChip: Component<LevelChipProps> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const [failing, setFailing] = createSignal(false)
  const [note, setNote] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  let rootRef: HTMLSpanElement | undefined

  const record = () => props.item.validations?.[props.level.id]
  const state = (): ValidationState => record()?.state ?? "not_done"
  const attribution = useAttribution(props.api, record)
  const stateLabel = () => i18n.t(STATE_KEY[state()])

  const tooltip = () => {
    const parts = [`${props.level.name}: ${stateLabel()}`]
    const a = attribution()
    if (a) parts.push(a)
    const src = record()?.source
    if (src) parts.push(i18n.t(`${K}.source`, { url: src }))
    return parts.join(". ")
  }

  const close = () => {
    setOpen(false)
    setFailing(false)
    setNote("")
  }

  // Outside click and Escape close the popover.
  createEffect(() => {
    if (!open()) return
    const onDown = (e: MouseEvent) => {
      if (rootRef && !rootRef.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    })
  })

  const write = async (next: ValidationState, noteText?: string) => {
    if (busy()) return
    setBusy(true)
    try {
      await checklistStore.setValidations(props.api, props.projectId, props.taskId, [
        {
          itemId: props.item.id,
          level: props.level.id,
          state: next,
          ...(noteText ? { note: noteText } : {}),
        },
      ])
      close()
    } catch (err) {
      toastSaveFailed(i18n.t(`${K}.saveFailed`), err)
    } finally {
      setBusy(false)
    }
  }

  const choose = (next: ValidationState) => {
    if (next === "fail") {
      setFailing(true)
      return
    }
    if (next === state()) {
      close()
      return
    }
    void write(next)
  }

  const submitFail = () => {
    const text = note().trim()
    if (!text) return
    void write("fail", text)
  }

  return (
    <span ref={rootRef} data-testid="checklist.chip-wrap" class="relative inline-flex">
      <Tooltip content={tooltip()} placement="top">
        <button
          type="button"
          data-testid="checklist.chip"
          data-level-id={props.level.id}
          data-state={state()}
          data-via={record()?.via}
          disabled={props.disabled}
          aria-label={`${props.level.name}: ${stateLabel()}`}
          aria-haspopup="dialog"
          aria-expanded={open()}
          class={`inline-flex items-center gap-1 rounded-full border py-px pl-1.5 pr-2 font-mono text-[11px] font-medium transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60 ${STATE_TONE[state()]}`}
          onClick={() => (open() ? close() : setOpen(true))}
        >
          <StateGlyph state={state()} />
          {props.level.name}
        </button>
      </Tooltip>
      <Show when={open() && !props.disabled}>
        <div
          role="dialog"
          aria-label={props.level.name}
          data-testid="checklist.chip-popover"
          class="absolute right-0 top-7 z-30 w-[240px] rounded-md border border-border-subtle bg-elevated p-1 shadow-popover"
        >
          <div class="px-2 py-1 text-[11px] text-text-tertiary">
            <span class="font-mono text-text-secondary">{props.level.name}</span>
            <Show when={attribution()}>
              {(a) => <span data-testid="checklist.popover-attribution">. {a()}</span>}
            </Show>
            <Show when={record()?.source}>
              {(src) => (
                <>
                  {attribution() ? ". " : " "}
                  <SourceLink url={src()} />
                </>
              )}
            </Show>
          </div>
          <Show
            when={failing()}
            fallback={
              <For each={STATES}>
                {(s) => (
                  <button
                    type="button"
                    data-testid="checklist.state-option"
                    data-state={s}
                    disabled={busy()}
                    class={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px] hover:bg-surface-hover ${
                      s === state() ? "text-accent" : "text-text"
                    }`}
                    onClick={() => choose(s)}
                  >
                    <span
                      class={`inline-flex items-center rounded-full border px-1 py-px ${STATE_TONE[s]}`}
                    >
                      <StateGlyph state={s} />
                    </span>
                    {i18n.t(STATE_KEY[s])}
                  </button>
                )}
              </For>
            }
          >
            <FailNoteForm
              note={note()}
              busy={busy()}
              onInput={setNote}
              onCancel={() => setFailing(false)}
              onSubmit={submitFail}
            />
          </Show>
        </div>
      </Show>
    </span>
  )
}

const FailNoteForm: Component<{
  note: string
  busy: boolean
  onInput(v: string): void
  onCancel(): void
  onSubmit(): void
}> = (props) => {
  const i18n = useI18n()
  const id = `fail-note-${Math.random().toString(36).slice(2)}`
  const ready = () => props.note.trim().length > 0 && !props.busy
  const onKeyDown: JSX.EventHandler<HTMLTextAreaElement, KeyboardEvent> = (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready()) props.onSubmit()
  }
  return (
    <form
      data-testid="checklist.fail-form"
      class="flex flex-col gap-1.5 p-1"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready()) props.onSubmit()
      }}
    >
      <label for={id} class="text-[11.5px] font-medium text-text-secondary">
        {i18n.t(`${K}.failNoteLabel`)}
      </label>
      <textarea
        id={id}
        data-testid="checklist.fail-note"
        required
        rows={3}
        maxLength={2000}
        value={props.note}
        placeholder={i18n.t(`${K}.failNotePlaceholder`)}
        ref={(el) => queueMicrotask(() => el.focus())}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        class="resize-none rounded-sm border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus:border-accent-muted"
      />
      <div class="flex justify-end gap-1">
        <button
          type="button"
          data-testid="checklist.fail-cancel"
          class="rounded-sm px-2 py-0.5 text-[12px] text-text-tertiary hover:text-text-secondary"
          onClick={() => props.onCancel()}
        >
          {i18n.t(`${K}.cancel`)}
        </button>
        <button
          type="submit"
          data-testid="checklist.fail-submit"
          disabled={!ready()}
          class="rounded-sm border border-error-border bg-error-glow px-2 py-0.5 text-[12px] text-error disabled:cursor-not-allowed disabled:opacity-50"
        >
          {i18n.t(`${K}.failSubmit`)}
        </button>
      </div>
    </form>
  )
}
