// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The task page's "Fields" section: one row per field the project declares, in its order, each
// value read as a dashboard table cell reads (cellText) and edited with the same editors
// (CellEditor). A save sends only the changed field: `onSave({ [key]: value })`, which the page
// turns into the task PATCH `{ fields }`. A checkbox toggles in place. Nothing renders when the
// project declares no field.
import { type Component, createEffect, createSignal, For, Show } from "solid-js"
import { CellEditor } from "~/modules/dashboards/blocks/CellEditor"
import { cellText, isEmptyCell, parseCellInput } from "~/modules/dashboards/blocks/table-cells"
import { loadPeople, personName } from "~/modules/dashboards/blocks/table-people"
import type { TableColumn } from "~/modules/dashboards/dashboards-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

export interface TaskFieldsSectionProps {
  fields: TableColumn[]
  values: Record<string, unknown>
  disabled?: boolean
  /** One changed field, `{ key: value }` (null empties it). */
  onSave: (change: Record<string, unknown>) => void | Promise<void>
}

export const TaskFieldsSection: Component<TaskFieldsSectionProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [editing, setEditing] = createSignal<string | null>(null)
  const [error, setError] = createSignal<{ key: string; message: string } | null>(null)

  // The member directory names person values (read once per session; the project may load late).
  createEffect(() => {
    if (props.fields.some((f) => f.type === "person")) void loadPeople(api)
  })

  const text = (f: TableColumn) =>
    cellText(f, props.values[f.key], {
      locale: i18n.locale(),
      personName,
      t: (k, p) => i18n.t(k, p),
    })

  const commit = (f: TableColumn, raw: unknown) => {
    const parsed = parseCellInput(f, raw)
    if (!parsed.ok) {
      // The editor has committed once; it closes, and the message stays until the next try.
      setEditing(null)
      setError({
        key: f.key,
        message: i18n.t(
          parsed.reason === "number"
            ? "projects.fields.numberError"
            : "projects.fields.requiredError",
        ),
      })
      return
    }
    setError(null)
    setEditing(null)
    const before = props.values[f.key]
    const same =
      JSON.stringify(isEmptyCell(before) ? null : before) ===
      JSON.stringify(isEmptyCell(parsed.value) ? null : parsed.value)
    if (!same) void props.onSave({ [f.key]: parsed.value })
  }

  return (
    <Show when={props.fields.length > 0}>
      <section data-testid="task-fields" class="flex flex-col gap-1.5">
        <h3 class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
          {i18n.t("projects.fields.title")}
        </h3>
        <dl class="grid grid-cols-[minmax(7rem,max-content)_1fr] items-start gap-x-4 gap-y-1 text-[12.5px]">
          <For each={props.fields}>
            {(f) => (
              <>
                <dt
                  data-testid={`task-fields.label-${f.key}`}
                  class="flex min-h-7 items-center text-text-tertiary"
                >
                  {f.label}
                  <Show when={f.required}>
                    <span class="ml-0.5" aria-hidden="true">
                      *
                    </span>
                  </Show>
                </dt>
                <dd data-testid={`task-fields.row-${f.key}`} class="m-0 min-w-0">
                  <Show
                    when={f.type !== "checkbox"}
                    fallback={
                      <label class="flex min-h-7 items-center">
                        <input
                          type="checkbox"
                          data-testid={`task-fields.checkbox-${f.key}`}
                          aria-label={f.label}
                          checked={props.values[f.key] === true}
                          disabled={props.disabled}
                          onChange={(e) => commit(f, e.currentTarget.checked)}
                        />
                      </label>
                    }
                  >
                    <Show
                      when={editing() === f.key && !props.disabled}
                      fallback={
                        <button
                          type="button"
                          data-testid={`task-fields.value-${f.key}`}
                          aria-label={i18n.t("projects.fields.edit", { field: f.label })}
                          disabled={props.disabled}
                          onClick={() => setEditing(f.key)}
                          class="flex min-h-7 w-full min-w-0 items-center rounded px-1.5 text-left hover:bg-surface-hover disabled:hover:bg-transparent"
                        >
                          <Show
                            when={text(f)}
                            fallback={
                              <span class="text-text-tertiary">
                                {i18n.t("projects.fields.notSet")}
                              </span>
                            }
                          >
                            <span class="truncate text-text">{text(f)}</span>
                          </Show>
                        </button>
                      }
                    >
                      <CellEditor
                        column={f}
                        value={props.values[f.key]}
                        testid={`task-fields.editor-${f.key}`}
                        onCommit={(v) => commit(f, v)}
                        onCancel={() => {
                          setError(null)
                          setEditing(null)
                        }}
                      />
                    </Show>
                  </Show>
                  <Show when={error()?.key === f.key}>
                    <p
                      data-testid={`task-fields.error-${f.key}`}
                      class="mt-0.5 text-[11.5px] text-text-secondary"
                    >
                      {error()?.message}
                    </p>
                  </Show>
                </dd>
              </>
            )}
          </For>
        </dl>
      </section>
    </Show>
  )
}
