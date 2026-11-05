// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Content tab of a rich text template: its page settings and an ordered
// list of blocks, edited inline (add, move, delete). Text takes {{path}}
// placeholders; "Insert field" puts one at the cursor from the record type's
// declared fields (inside a list block, the fields of one row). Images are
// staged then moved onto the template. Saving sends the whole body; the
// server validates it and a refusal is shown on the block it names.

import { type Component, createSignal, For, Show } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import {
  blockIndexOf,
  type DocumentTemplate,
  type InlineError,
  inlineError,
  insertablePaths,
  insertPlaceholder,
  type RecordType,
  type RecordTypeField,
  type RichTextBlock,
  type RichTextBody,
  recordLists,
  updateTemplate,
  uploadTemplateImage,
} from "./documents-api"

const INPUT =
  "w-full rounded-sm border border-border bg-bg px-2.5 py-1.5 text-[13px] text-text focus-visible:outline-2 focus-visible:outline-accent"

function cloneBody(body: RichTextBody | null | undefined): RichTextBody {
  const blocks = Array.isArray(body?.blocks) ? body.blocks : []
  return structuredClone({ ...(body?.page ? { page: body.page } : {}), blocks })
}

/** A textarea with an "Insert field" picker that puts {{path}} at the cursor. */
export const PlaceholderTextarea: Component<{
  value: string
  onChange: (next: string) => void
  fields: RecordTypeField[]
  testId: string
  rows?: number
}> = (props) => {
  const i18n = useI18n()
  let ref: HTMLTextAreaElement | undefined
  function insert(path: string) {
    if (!path) return
    const start = ref?.selectionStart ?? props.value.length
    const end = ref?.selectionEnd ?? start
    const next = insertPlaceholder(props.value, start, end, path)
    props.onChange(next.text)
    queueMicrotask(() => {
      if (!ref) return
      ref.focus()
      ref.setSelectionRange(next.caret, next.caret)
    })
  }
  return (
    <div class="space-y-1">
      <textarea
        ref={ref}
        class={INPUT}
        rows={props.rows ?? 2}
        value={props.value}
        onInput={(e) => props.onChange(e.currentTarget.value)}
        data-testid={props.testId}
      />
      <Show when={props.fields.length > 0}>
        <select
          class="rounded-sm border border-border bg-bg px-2 py-1 text-[12px] text-text-secondary"
          value=""
          onChange={(e) => {
            insert(e.currentTarget.value)
            e.currentTarget.value = ""
          }}
          data-testid={`${props.testId}-insert`}
        >
          <option value="">{i18n.t("kernel.documentsUi.insertField")}</option>
          <For each={props.fields}>
            {(f) => (
              <option value={f.path}>
                {f.label} ({f.path})
              </option>
            )}
          </For>
        </select>
      </Show>
    </div>
  )
}

export const RichTextEditor: Component<{
  template: DocumentTemplate
  recordType: RecordType | undefined
  onSaved: (t: DocumentTemplate) => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [body, setBody] = createStore<RichTextBody>(cloneBody(props.template.body))
  const [dirty, setDirty] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<InlineError | null>(null)
  const [saved, setSaved] = createSignal(false)
  const [uploading, setUploading] = createSignal(false)
  let imageInput: HTMLInputElement | undefined

  const errorBlock = () => blockIndexOf(error()?.field)

  function edit(fn: (b: RichTextBody) => void) {
    setBody(produce(fn))
    setDirty(true)
    setSaved(false)
  }

  function add(block: RichTextBlock) {
    edit((b) => {
      b.blocks.push(block)
    })
  }

  function move(i: number, delta: number) {
    const j = i + delta
    if (j < 0 || j >= body.blocks.length) return
    edit((b) => {
      const [moved] = b.blocks.splice(i, 1)
      if (moved) b.blocks.splice(j, 0, moved)
    })
  }

  function remove(i: number) {
    edit((b) => {
      b.blocks.splice(i, 1)
    })
  }

  function setField(i: number, key: string, value: unknown) {
    edit((b) => {
      const block = b.blocks[i] as Record<string, unknown> | undefined
      if (!block) return
      if (value === undefined || value === "") delete block[key]
      else block[key] = value
    })
  }

  function setPage(key: "size" | "fontSize", value: string | number | undefined) {
    edit((b) => {
      const page: Record<string, unknown> = { ...(b.page ?? {}) }
      if (value === undefined || value === "") delete page[key]
      else page[key] = value
      b.page = page
    })
  }

  async function addImage(file: File) {
    setError(null)
    setUploading(true)
    try {
      const fileId = await uploadTemplateImage(api, props.template.id, file)
      add({ type: "image", fileId, width: 120, align: "left" })
    } catch (err) {
      setError(inlineError(err, i18n.t("kernel.documentsUi.uploadFailed")))
    } finally {
      setUploading(false)
    }
  }

  async function save() {
    setError(null)
    setSaving(true)
    try {
      const updated = await updateTemplate(api, props.template.id, {
        body: structuredClone(unwrap(body)),
      })
      setBody(reconcile(cloneBody(updated.body)))
      setDirty(false)
      setSaved(true)
      props.onSaved(updated)
    } catch (err) {
      setError(inlineError(err, i18n.t("kernel.documentsUi.saveFailed")))
    } finally {
      setSaving(false)
    }
  }

  const topFields = () => insertablePaths(props.recordType)
  const lists = () => recordLists(props.recordType)
  const typeLabel = (type: RichTextBlock["type"]) => i18n.t(`kernel.documentsUi.block.${type}`)

  return (
    <div class="space-y-3" data-testid="documents-content">
      <div class="flex flex-wrap items-end gap-3 text-[12.5px] text-text-secondary">
        <label>
          {i18n.t("kernel.documentsUi.pageSize")}
          <select
            class={INPUT}
            value={body.page?.size ?? "A4"}
            onChange={(e) => setPage("size", e.currentTarget.value)}
            data-testid="documents-content-page-size"
          >
            <option value="A4">A4</option>
            <option value="Letter">{i18n.t("kernel.documentsUi.pageSizeLetter")}</option>
          </select>
        </label>
        <label>
          {i18n.t("kernel.documentsUi.fontSize")}
          <input
            type="number"
            min="8"
            max="14"
            class={INPUT}
            value={body.page?.fontSize ?? 10}
            onChange={(e) => setPage("fontSize", Number(e.currentTarget.value) || undefined)}
            data-testid="documents-content-font-size"
          />
        </label>
      </div>
      <Show when={!props.recordType}>
        <p class="text-[12.5px] text-text-secondary" data-testid="documents-content-no-fields">
          {i18n.t("kernel.documentsUi.noFieldsHint")}
        </p>
      </Show>

      <Show
        when={body.blocks.length > 0}
        fallback={
          <p class="text-[13px] text-text-secondary" data-testid="documents-content-empty">
            {i18n.t("kernel.documentsUi.noBlocks")}
          </p>
        }
      >
        <ol class="space-y-2" data-testid="documents-blocks">
          <For each={body.blocks}>
            {(block, index) => (
              <li
                class="rounded-md border border-border-subtle p-2.5"
                classList={{ "border-error": errorBlock() === index() }}
                data-testid={`documents-block-${index()}`}
                data-block-type={block.type}
              >
                <div class="mb-1.5 flex items-center gap-2 text-[12px] text-text-secondary">
                  <span class="font-medium text-text">{typeLabel(block.type)}</span>
                  <span class="ml-auto flex gap-1">
                    <button
                      type="button"
                      class="rounded px-1.5 hover:bg-surface-hover disabled:opacity-40"
                      disabled={index() === 0}
                      aria-label={i18n.t("kernel.documentsUi.moveUp")}
                      onClick={() => move(index(), -1)}
                      data-testid={`documents-block-${index()}-up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="rounded px-1.5 hover:bg-surface-hover disabled:opacity-40"
                      disabled={index() === body.blocks.length - 1}
                      aria-label={i18n.t("kernel.documentsUi.moveDown")}
                      onClick={() => move(index(), 1)}
                      data-testid={`documents-block-${index()}-down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="rounded px-1.5 hover:bg-surface-hover"
                      onClick={() => remove(index())}
                      data-testid={`documents-block-${index()}-delete`}
                    >
                      {i18n.t("kernel.documentsUi.delete")}
                    </button>
                  </span>
                </div>

                <Show when={block.type === "heading" && block}>
                  {(b) => (
                    <div class="space-y-1.5">
                      <PlaceholderTextarea
                        value={b().text}
                        onChange={(v) => setField(index(), "text", v)}
                        fields={topFields()}
                        rows={1}
                        testId={`documents-block-${index()}-text`}
                      />
                      <select
                        class="rounded-sm border border-border bg-bg px-2 py-1 text-[12px]"
                        value={String(b().level ?? 1)}
                        onChange={(e) => setField(index(), "level", Number(e.currentTarget.value))}
                        data-testid={`documents-block-${index()}-level`}
                      >
                        <option value="1">{i18n.t("kernel.documentsUi.level", { n: 1 })}</option>
                        <option value="2">{i18n.t("kernel.documentsUi.level", { n: 2 })}</option>
                        <option value="3">{i18n.t("kernel.documentsUi.level", { n: 3 })}</option>
                      </select>
                    </div>
                  )}
                </Show>
                <Show when={block.type === "paragraph" && block}>
                  {(b) => (
                    <PlaceholderTextarea
                      value={b().text}
                      onChange={(v) => setField(index(), "text", v)}
                      fields={topFields()}
                      rows={3}
                      testId={`documents-block-${index()}-text`}
                    />
                  )}
                </Show>
                <Show when={block.type === "list" && block}>
                  {(b) => (
                    <div class="space-y-1.5">
                      <label class="block text-[12px] text-text-secondary">
                        {i18n.t("kernel.documentsUi.listFrom")}
                        <Show
                          when={lists().length > 0}
                          fallback={
                            <input
                              class={INPUT}
                              value={b().from}
                              onInput={(e) => setField(index(), "from", e.currentTarget.value)}
                              data-testid={`documents-block-${index()}-from`}
                            />
                          }
                        >
                          <select
                            class={INPUT}
                            value={b().from}
                            onChange={(e) => setField(index(), "from", e.currentTarget.value)}
                            data-testid={`documents-block-${index()}-from`}
                          >
                            <For each={lists()}>{(l) => <option value={l}>{l}</option>}</For>
                          </select>
                        </Show>
                      </label>
                      <div class="block text-[12px] text-text-secondary">
                        {i18n.t("kernel.documentsUi.listLine")}
                        <PlaceholderTextarea
                          value={b().line}
                          onChange={(v) => setField(index(), "line", v)}
                          fields={insertablePaths(props.recordType, b().from)}
                          rows={1}
                          testId={`documents-block-${index()}-line`}
                        />
                      </div>
                    </div>
                  )}
                </Show>
                <Show when={block.type === "image" && block}>
                  {(b) => (
                    <div class="flex flex-wrap items-end gap-3 text-[12px] text-text-secondary">
                      <span data-testid={`documents-block-${index()}-file`}>{b().fileId}</span>
                      <label>
                        {i18n.t("kernel.documentsUi.imageWidth")}
                        <input
                          type="number"
                          min="8"
                          max="600"
                          class={INPUT}
                          value={b().width ?? ""}
                          onChange={(e) =>
                            setField(index(), "width", Number(e.currentTarget.value) || undefined)
                          }
                          data-testid={`documents-block-${index()}-width`}
                        />
                      </label>
                      <label>
                        {i18n.t("kernel.documentsUi.imageAlign")}
                        <select
                          class={INPUT}
                          value={b().align ?? "left"}
                          onChange={(e) => setField(index(), "align", e.currentTarget.value)}
                          data-testid={`documents-block-${index()}-align`}
                        >
                          <option value="left">{i18n.t("kernel.documentsUi.alignLeft")}</option>
                          <option value="center">{i18n.t("kernel.documentsUi.alignCenter")}</option>
                          <option value="right">{i18n.t("kernel.documentsUi.alignRight")}</option>
                        </select>
                      </label>
                    </div>
                  )}
                </Show>
                <Show when={block.type === "spacer" && block}>
                  {(b) => (
                    <label class="text-[12px] text-text-secondary">
                      {i18n.t("kernel.documentsUi.spacerHeight")}
                      <input
                        type="number"
                        min="1"
                        max="400"
                        class={INPUT}
                        value={b().height}
                        onChange={(e) =>
                          setField(index(), "height", Number(e.currentTarget.value) || 1)
                        }
                        data-testid={`documents-block-${index()}-height`}
                      />
                    </label>
                  )}
                </Show>
                <Show when={errorBlock() === index() && error()}>
                  {(e) => (
                    <p
                      class="mt-1.5 text-[12px] text-error"
                      data-testid={`documents-block-${index()}-error`}
                    >
                      {i18n.t("kernel.documentsUi.blockError", { path: e().field ?? "" })}
                    </p>
                  )}
                </Show>
              </li>
            )}
          </For>
        </ol>
      </Show>

      <div
        class="flex flex-wrap items-center gap-2 text-[12.5px]"
        data-testid="documents-add-block"
      >
        <span class="text-text-secondary">{i18n.t("kernel.documentsUi.addBlock")}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => add({ type: "heading", text: "", level: 1 })}
          data-testid="documents-add-heading"
        >
          {typeLabel("heading")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => add({ type: "paragraph", text: "" })}
          data-testid="documents-add-paragraph"
        >
          {typeLabel("paragraph")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => add({ type: "list", from: lists()[0] ?? "lines", line: "" })}
          data-testid="documents-add-list"
        >
          {typeLabel("list")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          loading={uploading()}
          onClick={() => imageInput?.click()}
          data-testid="documents-add-image"
        >
          {typeLabel("image")}
        </Button>
        <input
          ref={imageInput}
          type="file"
          accept="image/png,image/jpeg"
          class="hidden"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0]
            e.currentTarget.value = ""
            if (f) void addImage(f)
          }}
          data-testid="documents-add-image-input"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => add({ type: "spacer", height: 12 })}
          data-testid="documents-add-spacer"
        >
          {typeLabel("spacer")}
        </Button>
      </div>

      <Show when={error()}>
        {(e) => (
          <p class="text-[12.5px] text-error" role="alert" data-testid="documents-content-error">
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
          data-testid="documents-content-save"
        >
          {i18n.t("kernel.documentsUi.save")}
        </Button>
        <Show when={saved()}>
          <span class="text-[12.5px] text-text-secondary" data-testid="documents-content-saved">
            {i18n.t("kernel.documentsUi.saved")}
          </span>
        </Show>
      </div>
    </div>
  )
}
