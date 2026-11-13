// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The project's task fields (settings dialog beside the status manager): add, edit, remove and
// reorder fields, and edit a choice field's options. The list is edited as a draft and saved in
// one `PUT /projects/:id/fields` (the server replaces the whole list). Renaming an option a saved
// field already had sends it in `renames`, so the tasks holding it follow. The server refuses a
// change the tasks' values no longer fit; its typed errors (`choice_in_use`, `field_type_in_use`,
// `invalid_fields`) read here in plain words. A field's key never changes once saved.
import { ArrowDown, ArrowUp, X } from "lucide-solid"
import { type Component, createEffect, createSignal, For, on, Show } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { columnKeyFrom } from "~/modules/dashboards/blocks/table-cells"
import {
  TABLE_COLUMN_TYPES,
  type TableColumn,
  type TableColumnType,
} from "~/modules/dashboards/dashboards-client"
import { useI18n } from "~/modules/i18n/i18n-context"
import { handleProjectEvent } from "~/modules/projects/project-store"
import { Button } from "~/ui/Button"

export interface FieldsManagerProps {
  api: ApiClient
  projectId: string
  /** The saved fields, in order. */
  fields: TableColumn[]
  archived?: boolean
}

interface DraftOption {
  /** The option's saved name (null for one added in this draft): a changed name is a rename. */
  orig: string | null
  name: string
}

interface DraftField {
  key: string
  label: string
  type: TableColumnType
  required: boolean
  currency: string
  linkTo?: TableColumn["linkTo"]
  options: DraftOption[]
  /** Added in this draft (its key is not saved yet, its options rename nothing). */
  isNew: boolean
  /** The saved type, for an existing field. */
  savedType?: TableColumnType
}

const FIELD =
  "h-7 min-w-0 rounded border border-border bg-bg px-2 text-[12.5px] text-text outline-none focus:border-accent"
const ICON_BTN =
  "flex h-6 w-6 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover hover:text-text disabled:opacity-30"

const hasOptions = (t: TableColumnType) => t === "choice" || t === "choices"

function draftOf(fields: TableColumn[]): DraftField[] {
  return fields.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    required: f.required === true,
    currency: f.currency ?? "",
    linkTo: f.linkTo,
    options: (f.choices ?? []).map((c) => ({ orig: c, name: c })),
    isNew: false,
    savedType: f.type,
  }))
}

/** The PUT body of a draft: the field list and the option renames of saved choice fields. */
export function fieldsPayload(draft: DraftField[]): {
  fields: TableColumn[]
  renames: Record<string, Record<string, string>>
} {
  const renames: Record<string, Record<string, string>> = {}
  const fields = draft.map((d) => {
    const col: TableColumn = { key: d.key, label: d.label.trim(), type: d.type }
    if (d.required) col.required = true
    if (hasOptions(d.type)) {
      col.choices = d.options.map((o) => o.name.trim()).filter(Boolean)
      if (!d.isNew && d.savedType && hasOptions(d.savedType)) {
        for (const o of d.options) {
          const name = o.name.trim()
          if (o.orig !== null && name && name !== o.orig) {
            renames[d.key] = { ...(renames[d.key] ?? {}), [o.orig]: name }
          }
        }
      }
    }
    if (d.type === "amount") col.currency = d.currency.trim().toUpperCase()
    if (d.type === "link" && d.linkTo) col.linkTo = d.linkTo
    return col
  })
  return { fields, renames }
}

export const FieldsManager: Component<FieldsManagerProps> = (props) => {
  const i18n = useI18n()
  const [draft, setDraft] = createStore<DraftField[]>(draftOf(props.fields))
  const [dirty, setDirty] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [saved, setSaved] = createSignal(false)
  const [newLabel, setNewLabel] = createSignal("")
  const [newType, setNewType] = createSignal<TableColumnType>("text")
  const [optionInputs, setOptionInputs] = createStore<Record<string, string>>({})

  // The saved list changed (a save here, or someone else's): start over from it unless editing.
  createEffect(
    on(
      () => props.fields,
      (fields) => {
        if (!dirty()) setDraft(reconcile(draftOf(fields)))
      },
      { defer: true },
    ),
  )

  const typeLabel = (t: TableColumnType) => i18n.t(`kernel.dashboards.tables.type.${t}`)
  const edit = (fn: (d: DraftField[]) => void) => {
    setDraft(produce(fn))
    setDirty(true)
    setSaved(false)
    setError(null)
  }

  const addField = () => {
    const label = newLabel().trim()
    if (!label) return
    const key = columnKeyFrom(label, [
      ...draft.map((d) => d.key),
      ...props.fields.map((f) => f.key),
    ])
    edit((d) => {
      d.push({
        key,
        label,
        type: newType(),
        required: false,
        currency: newType() === "amount" ? "EUR" : "",
        options: [],
        isNew: true,
      })
    })
    setNewLabel("")
  }

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= draft.length) return
    edit((d) => {
      const [m] = d.splice(i, 1)
      if (m) d.splice(j, 0, m)
    })
  }

  const addOption = (key: string) => {
    const name = (optionInputs[key] ?? "").trim()
    if (!name) return
    edit((d) => {
      const f = d.find((x) => x.key === key)
      if (f && !f.options.some((o) => o.name.trim() === name)) f.options.push({ orig: null, name })
    })
    setOptionInputs(key, "")
  }

  const errorText = (err: unknown): string => {
    if (err instanceof ApiError) {
      const details = err.details ?? {}
      const field = typeof details.field === "string" ? details.field : ""
      const fieldLabel = draft.find((d) => d.key === field)?.label ?? field
      if (err.code === "choice_in_use") {
        const options = Array.isArray(details.options) ? details.options.map(String) : []
        return i18n.t("projects.fields.errorChoiceInUse", {
          options: options.map((o) => `“${o}”`).join(", "),
          field: fieldLabel,
        })
      }
      if (err.code === "field_type_in_use") {
        return i18n.t("projects.fields.errorTypeInUse", {
          count: typeof details.taskCount === "number" ? details.taskCount : 1,
          field: fieldLabel,
        })
      }
      if (err.code === "invalid_fields") {
        return i18n.t("projects.fields.errorInvalid", { message: err.message })
      }
    }
    return i18n.t("projects.fields.errorGeneric")
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const body = fieldsPayload(draft)
      const result = await props.api.put<{ projectId: string; fields: TableColumn[] }>(
        `/projects/${props.projectId}/fields`,
        Object.keys(body.renames).length > 0 ? body : { fields: body.fields },
      )
      const fields = result?.fields ?? body.fields
      setDirty(false)
      setDraft(reconcile(draftOf(fields)))
      setSaved(true)
      handleProjectEvent("updated", { id: props.projectId, fields })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="fields-manager" class="flex flex-col gap-3">
      <p class="text-[12px] text-text-tertiary">{i18n.t("projects.fields.managerHint")}</p>

      <Show
        when={draft.length > 0}
        fallback={
          <p data-testid="fields-manager.empty" class="text-[12.5px] text-text-tertiary">
            {i18n.t("projects.fields.none")}
          </p>
        }
      >
        <ul class="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
          <For each={draft}>
            {(f, i) => (
              <li
                data-testid={`fields-manager.row-${f.key}`}
                class="flex flex-col gap-2 px-3 py-2 text-[12.5px]"
              >
                <div class="flex flex-wrap items-center gap-2">
                  <input
                    data-testid={`fields-manager.label-${f.key}`}
                    aria-label={i18n.t("projects.fields.label")}
                    class={`${FIELD} flex-1`}
                    value={f.label}
                    disabled={props.archived}
                    onInput={(e) => {
                      const v = e.currentTarget.value
                      edit((d) => {
                        const x = d[i()]
                        if (x) x.label = v
                      })
                    }}
                  />
                  <select
                    data-testid={`fields-manager.type-${f.key}`}
                    aria-label={i18n.t("projects.fields.type")}
                    class={FIELD}
                    value={f.type}
                    disabled={props.archived}
                    onChange={(e) => {
                      const v = e.currentTarget.value as TableColumnType
                      edit((d) => {
                        const x = d[i()]
                        if (!x) return
                        x.type = v
                        if (v === "amount" && !x.currency) x.currency = "EUR"
                      })
                    }}
                  >
                    <For each={TABLE_COLUMN_TYPES}>
                      {(t) => <option value={t}>{typeLabel(t)}</option>}
                    </For>
                  </select>
                  <label class="flex items-center gap-1 text-[11.5px] text-text-secondary">
                    <input
                      type="checkbox"
                      data-testid={`fields-manager.required-${f.key}`}
                      checked={f.required}
                      disabled={props.archived}
                      onChange={(e) => {
                        const v = e.currentTarget.checked
                        edit((d) => {
                          const x = d[i()]
                          if (x) x.required = v
                        })
                      }}
                    />
                    {i18n.t("projects.fields.required")}
                  </label>
                  <Show when={!props.archived}>
                    <button
                      type="button"
                      data-testid={`fields-manager.move-up-${f.key}`}
                      aria-label={i18n.t("projects.fields.moveUp")}
                      disabled={i() === 0}
                      onClick={() => move(i(), -1)}
                      class={ICON_BTN}
                    >
                      <ArrowUp class="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      data-testid={`fields-manager.move-down-${f.key}`}
                      aria-label={i18n.t("projects.fields.moveDown")}
                      disabled={i() === draft.length - 1}
                      onClick={() => move(i(), 1)}
                      class={ICON_BTN}
                    >
                      <ArrowDown class="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      data-testid={`fields-manager.remove-${f.key}`}
                      onClick={() => edit((d) => void d.splice(i(), 1))}
                      class="text-[11.5px] text-text-tertiary hover:text-text"
                    >
                      {i18n.t("projects.fields.remove")}
                    </button>
                  </Show>
                </div>

                <Show when={f.type === "amount"}>
                  <label class="flex items-center gap-2 text-[11.5px] text-text-secondary">
                    {i18n.t("projects.fields.currency")}
                    <input
                      data-testid={`fields-manager.currency-${f.key}`}
                      class={`${FIELD} w-16 uppercase`}
                      maxLength={3}
                      value={f.currency}
                      disabled={props.archived}
                      onInput={(e) => {
                        const v = e.currentTarget.value
                        edit((d) => {
                          const x = d[i()]
                          if (x) x.currency = v
                        })
                      }}
                    />
                  </label>
                </Show>

                <Show when={hasOptions(f.type)}>
                  <div
                    data-testid={`fields-manager.options-${f.key}`}
                    class="flex flex-col gap-1 pl-2"
                  >
                    <span class="text-[11px] text-text-tertiary">
                      {i18n.t("projects.fields.options")}
                    </span>
                    <For each={f.options}>
                      {(o, oi) => (
                        <div class="flex items-center gap-1">
                          <input
                            data-testid={`fields-manager.option-${f.key}-${oi()}`}
                            aria-label={i18n.t("projects.fields.options")}
                            class={`${FIELD} flex-1`}
                            value={o.name}
                            disabled={props.archived}
                            onInput={(e) => {
                              const v = e.currentTarget.value
                              edit((d) => {
                                const opt = d[i()]?.options[oi()]
                                if (opt) opt.name = v
                              })
                            }}
                          />
                          <Show when={!props.archived}>
                            <button
                              type="button"
                              data-testid={`fields-manager.option-remove-${f.key}-${oi()}`}
                              aria-label={i18n.t("projects.fields.removeOption", {
                                option: o.name,
                              })}
                              onClick={() => edit((d) => void d[i()]?.options.splice(oi(), 1))}
                              class={ICON_BTN}
                            >
                              <X class="h-3.5 w-3.5" />
                            </button>
                          </Show>
                        </div>
                      )}
                    </For>
                    <Show when={!props.archived}>
                      <div class="flex items-center gap-1">
                        <input
                          data-testid={`fields-manager.option-new-${f.key}`}
                          placeholder={i18n.t("projects.fields.newOption")}
                          aria-label={i18n.t("projects.fields.newOption")}
                          class={`${FIELD} flex-1`}
                          value={optionInputs[f.key] ?? ""}
                          onInput={(e) => setOptionInputs(f.key, e.currentTarget.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault()
                              addOption(f.key)
                            }
                          }}
                        />
                        <Button variant="ghost" size="sm" onClick={() => addOption(f.key)}>
                          <span data-testid={`fields-manager.option-add-${f.key}`}>
                            {i18n.t("projects.fields.addOption")}
                          </span>
                        </Button>
                      </div>
                    </Show>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <Show when={!props.archived}>
        <div data-testid="fields-manager.add-form" class="flex flex-wrap items-center gap-2">
          <input
            data-testid="fields-manager.new-label"
            placeholder={i18n.t("projects.fields.label")}
            aria-label={i18n.t("projects.fields.label")}
            class={`${FIELD} flex-1`}
            value={newLabel()}
            onInput={(e) => setNewLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                addField()
              }
            }}
          />
          <select
            data-testid="fields-manager.new-type"
            aria-label={i18n.t("projects.fields.type")}
            class={FIELD}
            value={newType()}
            onChange={(e) => setNewType(e.currentTarget.value as TableColumnType)}
          >
            <For each={TABLE_COLUMN_TYPES}>{(t) => <option value={t}>{typeLabel(t)}</option>}</For>
          </select>
          <Button variant="ghost" size="sm" disabled={!newLabel().trim()} onClick={addField}>
            <span data-testid="fields-manager.add">{i18n.t("projects.fields.add")}</span>
          </Button>
        </div>
      </Show>

      <Show when={error()}>
        <p data-testid="fields-manager.error" role="alert" class="text-[12px] text-warning">
          {error()}
        </p>
      </Show>

      <Show when={!props.archived}>
        <div class="flex items-center justify-end gap-3">
          <Show when={dirty()}>
            <span data-testid="fields-manager.unsaved" class="text-[11.5px] text-text-tertiary">
              {i18n.t("projects.fields.unsaved")}
            </span>
          </Show>
          <Show when={saved() && !dirty()}>
            <span data-testid="fields-manager.saved" class="text-[11.5px] text-text-tertiary">
              {i18n.t("projects.fields.saved")}
            </span>
          </Show>
          <Button
            variant="primary"
            size="sm"
            disabled={busy() || !dirty()}
            onClick={() => void save()}
          >
            <span data-testid="fields-manager.save">{i18n.t("projects.fields.save")}</span>
          </Button>
        </div>
      </Show>
    </div>
  )
}
