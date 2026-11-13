// SPDX-License-Identifier: FSL-1.1-ALv2

import { type Component, createEffect, createSignal, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { CellEditor } from "~/modules/dashboards/blocks/CellEditor"
import { parseCellInput } from "~/modules/dashboards/blocks/table-cells"
import type { TableColumn } from "~/modules/dashboards/dashboards-client"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import { useI18n } from "~/modules/i18n/i18n-context"
import { handleTaskEvent, type ProjectStatus, type Task } from "~/modules/projects/project-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"

interface NewTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  api: ApiClient
  projectId: string
  statuses: ProjectStatus[]
  parentTaskId?: string | null
  /** The project's task fields: the required ones are asked for here (the server requires them). */
  fields?: TableColumn[]
}

export const NewTaskDialog: Component<NewTaskDialogProps> = (props) => {
  const i18n = useI18n()
  const [title, setTitle] = createSignal("")
  const [description, setDescription] = createSignal("")
  let descriptionEditor: RichEditorHandle | undefined
  const descriptionEditorDictation = useDictation({ target: () => descriptionEditor })
  const [statusId, setStatusId] = createSignal<string | null>(null)
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  // The required fields' inputs, as their editors hold them (parsed on submit).
  const [fieldInputs, setFieldInputs] = createSignal<Record<string, unknown>>({})
  const requiredFields = () => (props.fields ?? []).filter((f) => f.required)

  const reset = () => {
    setTitle("")
    setDescription("")
    setStatusId(null)
    setError(null)
    setFieldInputs({})
  }

  /** The required fields' values, or the first one missing or malformed (named in the error). */
  const fieldValues = (): { ok: true; values: Record<string, unknown> } | { ok: false } => {
    const values: Record<string, unknown> = {}
    for (const f of requiredFields()) {
      const parsed = parseCellInput(f, fieldInputs()[f.key])
      if (!parsed.ok) {
        setError(
          `${f.label}: ${i18n.t(
            parsed.reason === "number"
              ? "projects.fields.numberError"
              : "projects.fields.requiredError",
          )}`,
        )
        return { ok: false }
      }
      values[f.key] = parsed.value
    }
    return { ok: true, values }
  }

  // Reset form state whenever the dialog transitions from closed → open so that
  // stale input from a previous session is never shown on reopen.
  createEffect(() => {
    if (props.open) reset()
  })

  const submit = async () => {
    const t = title().trim()
    if (!t) {
      setError("Title is required")
      return
    }
    setError(null)
    const fields = fieldValues()
    if (!fields.ok) return
    setSubmitting(true)
    try {
      const created = await props.api.post<Task>(`/projects/${props.projectId}/tasks`, {
        title: t,
        description: description() || undefined,
        statusId: statusId() ?? undefined,
        parentTaskId: props.parentTaskId ?? undefined,
        ...(requiredFields().length > 0 ? { fields: fields.values } : {}),
      })
      // Merge the created row (with its key) at once; the WS echo, before or
      // after, merges by id and never duplicates it.
      if (created?.id) handleTaskEvent("created", { ...created, projectId: props.projectId })
      reset()
      props.onOpenChange(false)
    } catch (err) {
      setError((err as Error).message ?? "Failed to create task")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{i18n.t("projects.newTask")}</Dialog.Title>
        <div data-testid="new-task-dialog" class="mt-4 flex flex-col gap-3">
          <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
            {i18n.t("projects.title")}
            <Input
              data-testid="new-task-dialog.title"
              value={title()}
              onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
              placeholder={i18n.t("projects.whatNeedsDoing")}
            />
          </label>
          <div class="flex flex-col gap-1 text-[12px] text-text-secondary">
            <div class="flex items-center justify-between gap-2">
              {i18n.t("kernel.common.description")}
              {/* The wand stays with the field; the mic sits left of Create. */}
              <span class="flex min-w-0 flex-1 items-center justify-end gap-0.5">
                <ComposerAssist target={() => descriptionEditor} />
              </span>
            </div>
            <RichEditor
              preset="full"
              ref={(handle) => {
                descriptionEditor = handle
              }}
              value={description()}
              onChange={setDescription}
              onSubmit={() => void submit()}
              placeholder={i18n.t("projects.addADescriptionMarkdownSupported")}
              aria-label={i18n.t("kernel.common.description")}
              data-testid="new-task-dialog.description"
              class="rounded-md border border-border-subtle bg-bg px-2 py-1.5 focus-within:border-accent-muted"
              editorClass="max-h-[40vh] min-h-[80px] overflow-y-auto"
            />
          </div>
          <Show when={props.statuses.length > 0}>
            <label class="flex flex-col gap-1 text-[12px] text-text-secondary">
              {i18n.t("kernel.common.status")}
              <select
                data-testid="new-task-dialog.status"
                value={statusId() ?? ""}
                onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value
                  setStatusId(v || null)
                }}
                class="rounded-md border border-border-subtle bg-bg px-2 py-1.5 text-[13px] text-text"
              >
                <option value="">{i18n.t("projects.defaultFirstStatus")}</option>
                <For each={[...props.statuses].sort((a, b) => a.order - b.order)}>
                  {(s) => <option value={s.id}>{s.label}</option>}
                </For>
              </select>
            </label>
          </Show>
          <For each={requiredFields()}>
            {(f) => (
              <div
                data-testid={`new-task-dialog.field-${f.key}`}
                class="flex flex-col gap-1 text-[12px] text-text-secondary"
              >
                <span>
                  {f.label}
                  <span aria-hidden="true"> *</span>
                </span>
                <CellEditor
                  column={f}
                  value={fieldInputs()[f.key] ?? null}
                  inline
                  testid={`new-task-dialog.field-input-${f.key}`}
                  onCommit={(v) => setFieldInputs((prev) => ({ ...prev, [f.key]: v }))}
                />
              </div>
            )}
          </For>
          <Show when={error()}>
            <p data-testid="new-task-dialog.error" class="text-[12px] text-warning">
              {error()}
            </p>
          </Show>
        </div>
        {/* A take turns this footer into the recorder line. */}
        <div class="mt-4 flex items-center justify-end gap-2">
          <RecorderRow dictation={descriptionEditorDictation}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                reset()
                props.onOpenChange(false)
              }}
            >
              {i18n.t("kernel.common.cancel")}
            </Button>
            <DictationMic dictation={descriptionEditorDictation} />
            <Button
              variant="primary"
              size="sm"
              disabled={submitting()}
              onClick={() => void submit()}
            >
              <span data-testid="new-task-dialog.submit">{i18n.t("projects.create")}</span>
            </Button>
          </RecorderRow>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
