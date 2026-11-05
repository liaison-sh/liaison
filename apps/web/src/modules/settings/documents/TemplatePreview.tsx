// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Preview tab: render the saved template against the record type's
// sample, or against one record by its id, and show the PDF here (with
// "Open" and "Download"). Nothing is stored. The fields that printed as grey
// placeholders are listed: a person, or the record, has to fill them.

import { type Component, createSignal, For, onCleanup, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import {
  type DocumentTemplate,
  type InlineError,
  inlineError,
  type PreviewResult,
  pdfBlob,
  previewTemplate,
} from "./documents-api"

export const TemplatePreview: Component<{ template: DocumentTemplate }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [mode, setMode] = createSignal<"sample" | "record">("sample")
  const [recordId, setRecordId] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<InlineError | null>(null)
  const [result, setResult] = createSignal<PreviewResult | null>(null)
  const [url, setUrl] = createSignal<string | null>(null)

  function setObjectUrl(next: string | null) {
    const prev = url()
    if (prev) URL.revokeObjectURL(prev)
    setUrl(next)
  }
  onCleanup(() => setObjectUrl(null))

  async function run() {
    setError(null)
    const id = recordId().trim()
    if (mode() === "record" && !id) {
      setError({ message: i18n.t("kernel.documentsUi.recordIdRequired") })
      return
    }
    setBusy(true)
    try {
      const out = await previewTemplate(
        api,
        props.template.id,
        mode() === "record" ? { recordId: id } : {},
      )
      setResult(out)
      setObjectUrl(
        typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(pdfBlob(out.pdfBase64))
          : null,
      )
    } catch (err) {
      setResult(null)
      setObjectUrl(null)
      setError(inlineError(err, i18n.t("kernel.documentsUi.previewFailed")))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="space-y-3" data-testid="documents-preview">
      <fieldset class="flex flex-wrap items-center gap-4 text-[13px]">
        <label class="flex items-center gap-1.5">
          <input
            type="radio"
            name="documents-preview-mode"
            checked={mode() === "sample"}
            onChange={() => setMode("sample")}
            data-testid="documents-preview-mode-sample"
          />
          {i18n.t("kernel.documentsUi.previewSample")}
        </label>
        <label class="flex items-center gap-1.5">
          <input
            type="radio"
            name="documents-preview-mode"
            checked={mode() === "record"}
            disabled={!props.template.recordType}
            onChange={() => setMode("record")}
            data-testid="documents-preview-mode-record"
          />
          {i18n.t("kernel.documentsUi.previewRecord")}
        </label>
        <Show when={mode() === "record"}>
          <input
            class="rounded-sm border border-border bg-bg px-2 py-1 text-[13px]"
            placeholder={i18n.t("kernel.documentsUi.recordIdPlaceholder")}
            value={recordId()}
            onInput={(e) => setRecordId(e.currentTarget.value)}
            data-testid="documents-preview-record-id"
          />
        </Show>
        <Button
          size="sm"
          loading={busy()}
          disabled={busy()}
          onClick={() => void run()}
          data-testid="documents-preview-run"
        >
          {i18n.t("kernel.documentsUi.previewRun")}
        </Button>
      </fieldset>
      <p class="text-[12px] text-text-secondary">{i18n.t("kernel.documentsUi.previewSavedOnly")}</p>

      <Show when={error()}>
        {(e) => (
          <p class="text-[12.5px] text-error" role="alert" data-testid="documents-preview-error">
            {e().message}
          </p>
        )}
      </Show>

      <Show when={result()}>
        {(r) => (
          <div class="space-y-2">
            <Show when={r().sample}>
              <p
                class="text-[12.5px] text-text-secondary"
                data-testid="documents-preview-sample-note"
              >
                {i18n.t("kernel.documentsUi.previewSampleNote")}
              </p>
            </Show>
            <Show
              when={r().blanks.length > 0}
              fallback={
                <p
                  class="text-[12.5px] text-text-secondary"
                  data-testid="documents-preview-no-blanks"
                >
                  {i18n.t("kernel.documentsUi.noBlanks")}
                </p>
              }
            >
              <div data-testid="documents-preview-blanks">
                <p class="text-[12.5px] font-medium text-text">
                  {i18n.t("kernel.documentsUi.blanksTitle", { n: r().blanks.length })}
                </p>
                <ul class="list-disc pl-5 text-[12.5px] text-text-secondary">
                  <For each={r().blanks}>
                    {(b) => (
                      <li data-testid={`documents-preview-blank-${b.field}`}>
                        {b.label}
                        <Show when={b.path && b.path !== b.label}>
                          {" "}
                          <span class="text-text-tertiary">({b.path})</span>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </div>
            </Show>
            <Show when={url()}>
              {(u) => (
                <>
                  <div class="flex gap-3 text-[12.5px]">
                    <a
                      href={u()}
                      target="_blank"
                      rel="noopener"
                      class="text-accent underline-offset-2 hover:underline"
                      data-testid="documents-preview-open"
                    >
                      {i18n.t("kernel.documentsUi.open")}
                    </a>
                    <a
                      href={u()}
                      download={r().filename}
                      class="text-accent underline-offset-2 hover:underline"
                      data-testid="documents-preview-download"
                    >
                      {i18n.t("kernel.documentsUi.download")}
                    </a>
                  </div>
                  <iframe
                    src={u()}
                    title={r().filename}
                    class="h-[70vh] w-full rounded-md border border-border-subtle"
                    data-testid="documents-preview-frame"
                  />
                </>
              )}
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
