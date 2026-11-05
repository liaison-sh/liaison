// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Fields & mapping tab of a PDF form template: one row per field of the
// uploaded form, taking its value from a record field, a fixed value or an
// image of the template (a signature, a stamp), with an optional placeholder
// printed in grey when the value is missing. The server checks the mapping
// (field names, constant types, image files) and its refusal shows inline.

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { createStore, reconcile, unwrap } from "solid-js/store"
import { listFiles } from "~/modules/files/file-service"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import {
  type DocumentTemplate,
  type InlineError,
  inlineError,
  type Mapping,
  type MappingEntry,
  type RecordType,
  templateParent,
  updateTemplate,
  uploadTemplateImage,
} from "./documents-api"

type Source = "none" | "path" | "const" | "image"

const CELL_INPUT =
  "w-full rounded-sm border border-border bg-bg px-2 py-1 text-[12.5px] text-text focus-visible:outline-2 focus-visible:outline-accent"

function sourceOf(entry: MappingEntry | undefined): Source {
  if (!entry) return "none"
  if (entry.path !== undefined) return "path"
  if (entry.const !== undefined) return "const"
  if (entry.image_file_id !== undefined) return "image"
  return "none"
}

/**
 * The record paths a form field can take: plain fields as declared, and each
 * list field once per row number the form could hold (`lines.0.sku`, ...).
 */
export function mappablePaths(recordType: RecordType | undefined, rows = 10) {
  if (!recordType) return []
  const out: Array<{ path: string; label: string }> = []
  for (const f of recordType.fields) {
    if (!f.repeat) {
      out.push({ path: f.path, label: f.label })
      continue
    }
    const prefix = `${f.repeat}.`
    const rest = f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path
    for (let i = 0; i < rows; i++) {
      out.push({ path: `${f.repeat}.${i}.${rest}`, label: `${f.label} ${i + 1}` })
    }
  }
  return out
}

export const FieldMapping: Component<{
  template: DocumentTemplate
  recordType: RecordType | undefined
  onSaved: (t: DocumentTemplate) => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [mapping, setMapping] = createStore<Mapping>(structuredClone(props.template.mapping))
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [saved, setSaved] = createSignal(false)
  const [error, setError] = createSignal<InlineError | null>(null)
  const [images, { refetch: refetchImages }] = createResource(
    () => props.template.id,
    async (id) => {
      const rows = await listFiles(api, templateParent(id)).catch(() => [])
      return rows.filter((f) => /^image\/(png|jpeg)$/i.test(f.mimeType))
    },
  )
  const paths = () => mappablePaths(props.recordType)

  function setEntry(field: string, entry: MappingEntry | undefined) {
    const next: Mapping = structuredClone(unwrap(mapping))
    if (entry === undefined) delete next[field]
    else next[field] = { ...entry }
    setMapping(reconcile(next))
    setDirty(true)
    setSaved(false)
  }

  function setSource(field: string, source: Source, fieldType: string) {
    const placeholder = mapping[field]?.placeholder
    const keep = placeholder !== undefined ? { placeholder } : {}
    if (source === "none") setEntry(field, placeholder !== undefined ? keep : undefined)
    else if (source === "path") setEntry(field, { ...keep, path: paths()[0]?.path ?? "" })
    else if (source === "const")
      setEntry(field, { ...keep, const: fieldType === "checkbox" ? true : "" })
    else setEntry(field, { ...keep, image_file_id: images()?.[0]?.id ?? "" })
  }

  function setPlaceholder(field: string, value: string) {
    const current = { ...(mapping[field] ?? {}) }
    if (value) current.placeholder = value
    else delete current.placeholder
    setEntry(field, Object.keys(current).length > 0 ? current : undefined)
  }

  async function uploadImage(field: string, file: File) {
    setError(null)
    try {
      const fileId = await uploadTemplateImage(api, props.template.id, file)
      await refetchImages()
      const placeholder = mapping[field]?.placeholder
      setEntry(field, { ...(placeholder ? { placeholder } : {}), image_file_id: fileId })
    } catch (err) {
      setError(inlineError(err, i18n.t("kernel.documentsUi.uploadFailed")))
    }
  }

  async function save() {
    setError(null)
    setSaving(true)
    try {
      const clean: Mapping = {}
      for (const [k, v] of Object.entries(structuredClone(unwrap(mapping)))) if (v) clean[k] = v
      const updated = await updateTemplate(api, props.template.id, { mapping: clean })
      setMapping(reconcile(structuredClone(updated.mapping)))
      setDirty(false)
      setSaved(true)
      props.onSaved(updated)
    } catch (err) {
      setError(inlineError(err, i18n.t("kernel.documentsUi.saveFailed")))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="space-y-3" data-testid="documents-mapping">
      <p class="text-[12.5px] text-text-secondary">{i18n.t("kernel.documentsUi.mappingIntro")}</p>
      <Show when={!props.recordType}>
        <p class="text-[12.5px] text-text-secondary" data-testid="documents-mapping-no-fields">
          {i18n.t("kernel.documentsUi.noFieldsHint")}
        </p>
      </Show>
      <table class="w-full text-[12.5px]" data-testid="documents-mapping-table">
        <thead>
          <tr class="border-b border-border-subtle text-left text-text-secondary">
            <th class="py-1.5 pr-2">{i18n.t("kernel.documentsUi.pdfField")}</th>
            <th class="py-1.5 pr-2">{i18n.t("kernel.documentsUi.source")}</th>
            <th class="py-1.5 pr-2">{i18n.t("kernel.documentsUi.value")}</th>
            <th class="py-1.5">{i18n.t("kernel.documentsUi.placeholder")}</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.template.fields}>
            {(field) => {
              const entry = () => mapping[field.name]
              const source = () => sourceOf(entry())
              const id = `documents-mapping-${field.name}`
              return (
                <tr
                  class="border-b border-border-subtle align-top"
                  classList={{ "bg-error/5": error()?.field === field.name }}
                  data-testid={id}
                >
                  <td class="py-1.5 pr-2">
                    <span class="font-medium text-text">{field.name}</span>
                    <span class="block text-text-secondary">
                      {i18n.t(`kernel.documentsUi.fieldType.${field.type}`)} ·{" "}
                      {i18n.t("kernel.documentsUi.page", { n: field.page + 1 })}
                    </span>
                  </td>
                  <td class="py-1.5 pr-2">
                    <select
                      class={CELL_INPUT}
                      value={source()}
                      onChange={(e) =>
                        setSource(field.name, e.currentTarget.value as Source, field.type)
                      }
                      data-testid={`${id}-source`}
                    >
                      <option value="none">{i18n.t("kernel.documentsUi.sourceNone")}</option>
                      <option value="path">{i18n.t("kernel.documentsUi.sourcePath")}</option>
                      <Show when={field.type === "text" || field.type === "checkbox"}>
                        <option value="const">{i18n.t("kernel.documentsUi.sourceConst")}</option>
                      </Show>
                      <option value="image">{i18n.t("kernel.documentsUi.sourceImage")}</option>
                    </select>
                  </td>
                  <td class="py-1.5 pr-2">
                    <Show when={source() === "path"}>
                      <select
                        class={CELL_INPUT}
                        value={entry()?.path ?? ""}
                        onChange={(e) =>
                          setEntry(field.name, { ...entry(), path: e.currentTarget.value })
                        }
                        data-testid={`${id}-path`}
                      >
                        <Show when={!paths().some((p) => p.path === entry()?.path)}>
                          <option value={entry()?.path ?? ""}>{entry()?.path ?? ""}</option>
                        </Show>
                        <For each={paths()}>
                          {(p) => (
                            <option value={p.path}>
                              {p.label} ({p.path})
                            </option>
                          )}
                        </For>
                      </select>
                    </Show>
                    <Show when={source() === "const"}>
                      <Show
                        when={field.type === "checkbox"}
                        fallback={
                          <input
                            class={CELL_INPUT}
                            value={typeof entry()?.const === "string" ? String(entry()?.const) : ""}
                            onInput={(e) =>
                              setEntry(field.name, { ...entry(), const: e.currentTarget.value })
                            }
                            data-testid={`${id}-const`}
                          />
                        }
                      >
                        <input
                          type="checkbox"
                          checked={entry()?.const === true}
                          onChange={(e) =>
                            setEntry(field.name, { ...entry(), const: e.currentTarget.checked })
                          }
                          data-testid={`${id}-const`}
                        />
                      </Show>
                    </Show>
                    <Show when={source() === "image"}>
                      <select
                        class={CELL_INPUT}
                        value={entry()?.image_file_id ?? ""}
                        onChange={(e) =>
                          setEntry(field.name, { ...entry(), image_file_id: e.currentTarget.value })
                        }
                        data-testid={`${id}-image`}
                      >
                        <option value="">{i18n.t("kernel.documentsUi.pickImage")}</option>
                        <For each={images() ?? []}>
                          {(img) => <option value={img.id}>{img.filename}</option>}
                        </For>
                      </select>
                      <input
                        type="file"
                        accept="image/png,image/jpeg"
                        class="mt-1 block text-[12px]"
                        onChange={(e) => {
                          const f = e.currentTarget.files?.[0]
                          e.currentTarget.value = ""
                          if (f) void uploadImage(field.name, f)
                        }}
                        data-testid={`${id}-image-upload`}
                      />
                    </Show>
                  </td>
                  <td class="py-1.5">
                    <input
                      class={CELL_INPUT}
                      value={entry()?.placeholder ?? ""}
                      placeholder={field.tooltip ?? field.name}
                      onInput={(e) => setPlaceholder(field.name, e.currentTarget.value)}
                      data-testid={`${id}-placeholder`}
                    />
                  </td>
                </tr>
              )
            }}
          </For>
        </tbody>
      </table>
      <Show when={error()}>
        {(e) => (
          <p class="text-[12.5px] text-error" role="alert" data-testid="documents-mapping-error">
            {e().message}
          </p>
        )}
      </Show>
      <div class="flex items-center gap-3">
        <Button
          size="sm"
          loading={saving()}
          disabled={saving() || !dirty()}
          onClick={() => void save()}
          data-testid="documents-mapping-save"
        >
          {i18n.t("kernel.documentsUi.save")}
        </Button>
        <Show when={saved()}>
          <span class="text-[12.5px] text-text-secondary" data-testid="documents-mapping-saved">
            {i18n.t("kernel.documentsUi.saved")}
          </span>
        </Show>
      </div>
    </div>
  )
}
