// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Organization > Imports: a person's own import. Upload the export
// (or none, for a transform that pulls from an API connection), pick a saved
// transform, preview it (a dry run that writes nothing), then start it: the
// run acts as this person, and its progress card follows it here.

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import ImportRunCard from "~/modules/imports/ImportRunCard"
import { importErrorText } from "~/modules/imports/import-errors"
import { ImportUploadInterruptedError, uploadImportFile } from "~/modules/imports/upload-client"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

const QUIET = { suppressGlobalError: true } as const
const MAX_REFUSED = 0.05

interface TransformRow {
  id: string
  name: string
  version: number
  kinds: string[]
  sourceType: "upload" | "api"
  connection: string | null
}

interface PreviewResult {
  previewId: string
  counts: Record<string, { created: number; skipped: number; failed: number }>
  errorRate: number
  errors: Array<Record<string, unknown>>
  report: Record<string, unknown>
  samples: string
}

function labelOf(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
  return s || "import"
}

/** The samples as plain text: the fence the agent reads is dropped, the content stays text. */
function samplesText(samples: string): string {
  return samples.replace(/<\/?external-content[^>]*>/g, "").trim()
}

function fileKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`
}

const NewImport: Component<{ onStarted?: () => void }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [transforms] = createResource(async () =>
    api.get<TransformRow[]>("/imports/transforms", QUIET).catch(() => [] as TransformRow[]),
  )
  const [files, setFiles] = createSignal<Array<{ name: string; id: string }>>([])
  const [uploading, setUploading] = createSignal<{ name: string; percent: number } | null>(null)
  const [transform, setTransform] = createSignal("")
  const [label, setLabel] = createSignal("")
  const [placeholders, setPlaceholders] = createSignal(false)
  const [preview, setPreview] = createSignal<PreviewResult | null>(null)
  const [busy, setBusy] = createSignal<"preview" | "start" | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [runId, setRunId] = createSignal<string | null>(null)
  /** Uploads stopped after their retries, by file: picking the file again resumes them. */
  const interrupted = new Map<string, string>()

  const selected = () => (transforms() ?? []).find((t) => t.name === transform())

  async function onFiles(list: FileList | null): Promise<void> {
    if (!list) return
    setError(null)
    setPreview(null)
    for (const file of Array.from(list)) {
      setUploading({ name: file.name, percent: 0 })
      const key = fileKey(file)
      try {
        const id = await uploadImportFile(api, file, {
          resumeId: interrupted.get(key),
          onProgress: (f) => setUploading({ name: file.name, percent: Math.round(f * 100) }),
        })
        interrupted.delete(key)
        setFiles((prev) => [...prev, { name: file.name, id }])
      } catch (err) {
        // Picking the same file again continues the upload where it stopped.
        if (err instanceof ImportUploadInterruptedError) interrupted.set(key, err.uploadId)
        setError(importErrorText(i18n.t, err, "kernel.imports.new.failed"))
      }
    }
    setUploading(null)
  }

  async function onPreview(): Promise<void> {
    const t = selected()
    if (!t) return
    setBusy("preview")
    setError(null)
    setPreview(null)
    try {
      const result = await api.post<PreviewResult>(
        "/imports/previews",
        {
          transform: t.name,
          version: t.version,
          ...(t.sourceType === "upload" ? { fileIds: files().map((f) => f.id) } : {}),
          sourceLabel: label() || labelOf(t.name),
          placeholders: placeholders(),
        },
        QUIET,
      )
      setPreview(result)
    } catch (err) {
      setError(importErrorText(i18n.t, err, "kernel.imports.new.failed"))
    } finally {
      setBusy(null)
    }
  }

  async function onStart(): Promise<void> {
    const p = preview()
    if (!p) return
    setBusy("start")
    setError(null)
    try {
      const run = await api.post<{ runId: string }>(
        `/imports/previews/${p.previewId}/start`,
        undefined,
        QUIET,
      )
      setRunId(run.runId)
      setPreview(null)
      props.onStarted?.()
    } catch (err) {
      setError(importErrorText(i18n.t, err, "kernel.imports.new.failed"))
    } finally {
      setBusy(null)
    }
  }

  const tooManyRefused = () => (preview()?.errorRate ?? 0) > MAX_REFUSED

  return (
    <section class="mb-6 space-y-3" data-testid="imports-new">
      <div>
        <h3 class="text-sm font-medium text-text">{i18n.t("kernel.imports.new.title")}</h3>
        <p class="text-xs text-text-secondary">{i18n.t("kernel.imports.new.help")}</p>
      </div>
      <label class="block text-sm">
        <span class="text-text-secondary">{i18n.t("kernel.imports.new.files")}</span>
        <input
          type="file"
          multiple
          class="mt-1 block text-sm"
          data-testid="imports-new-files"
          onChange={(e) => void onFiles(e.currentTarget.files)}
        />
      </label>
      <Show when={uploading()}>
        {(u) => (
          <p class="text-xs text-text-secondary" data-testid="imports-new-uploading">
            {i18n.t("kernel.imports.new.uploading", { name: u().name, percent: u().percent })}
          </p>
        )}
      </Show>
      <Show when={files().length > 0}>
        <p class="text-xs text-text-secondary" data-testid="imports-new-files-ready">
          {files()
            .map((f) => f.name)
            .join(", ")}
        </p>
      </Show>
      <label class="block text-sm">
        <span class="text-text-secondary">{i18n.t("kernel.imports.new.transform")}</span>
        <select
          class="mt-1 block w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-sm"
          data-testid="imports-new-transform"
          value={transform()}
          onChange={(e) => {
            setTransform(e.currentTarget.value)
            setPreview(null)
          }}
        >
          <option value="">{i18n.t("kernel.imports.new.pickTransform")}</option>
          <For each={transforms() ?? []}>
            {(t) => (
              <option value={t.name}>
                {t.name} v{t.version} ({t.kinds.join(", ")})
              </option>
            )}
          </For>
        </select>
      </label>
      <Show when={transforms() && (transforms() ?? []).length === 0}>
        <p class="text-xs text-text-secondary" data-testid="imports-new-no-transforms">
          {i18n.t("kernel.imports.new.noTransforms")}
        </p>
      </Show>
      <label class="block text-sm">
        <span class="text-text-secondary">{i18n.t("kernel.imports.new.sourceLabel")}</span>
        <input
          type="text"
          class="mt-1 block w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-sm"
          data-testid="imports-new-source-label"
          placeholder={selected() ? labelOf(selected()!.name) : ""}
          value={label()}
          onInput={(e) => setLabel(e.currentTarget.value)}
        />
      </label>
      <label class="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          data-testid="imports-new-placeholders"
          checked={placeholders()}
          onChange={(e) => setPlaceholders(e.currentTarget.checked)}
        />
        {i18n.t("kernel.imports.new.placeholders")}
      </label>
      <Button
        size="sm"
        data-testid="imports-new-preview"
        disabled={
          busy() !== null ||
          uploading() !== null ||
          !selected() ||
          (selected()?.sourceType === "upload" && files().length === 0)
        }
        onClick={() => void onPreview()}
      >
        {busy() === "preview"
          ? i18n.t("kernel.imports.new.previewing")
          : i18n.t("kernel.imports.new.preview")}
      </Button>
      <Show when={error()}>
        <p class="text-sm text-danger" data-testid="imports-new-error">
          {error()}
        </p>
      </Show>
      <Show when={preview()}>
        {(p) => (
          <div
            class="space-y-2 rounded-md border border-border-subtle p-3"
            data-testid="imports-new-preview-result"
          >
            <ul class="space-y-0.5 text-sm">
              <For each={Object.entries(p().counts)}>
                {([kind, c]) => (
                  <li>
                    <span class="text-text">{kind}</span>{" "}
                    <span class="text-text-secondary">
                      {i18n.t("kernel.imports.counts", {
                        created: c.created,
                        skipped: c.skipped,
                        failed: c.failed,
                      })}
                    </span>
                  </li>
                )}
              </For>
            </ul>
            <Show when={p().report?.cutAtLimit === true}>
              <p class="text-xs text-text-secondary">{i18n.t("kernel.imports.new.cutAtLimit")}</p>
            </Show>
            <Show when={p().errors.length > 0}>
              <ul class="space-y-0.5 text-xs text-text-secondary">
                <For each={p().errors.slice(0, 5)}>
                  {(e) => (
                    <li class="truncate">
                      <Show when={typeof e.at === "string"}>{String(e.at)}: </Show>
                      {String(e.error ?? "")}
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={tooManyRefused()}>
              <p class="text-sm text-danger" data-testid="imports-new-too-many-refused">
                {i18n.t("kernel.imports.new.tooManyRefused", {
                  percent: Math.round(p().errorRate * 1000) / 10,
                })}
              </p>
            </Show>
            <Show when={p().samples}>
              <details>
                <summary class="cursor-pointer text-xs text-text-secondary">
                  {i18n.t("kernel.imports.new.samples")}
                </summary>
                <pre
                  class="mt-1 max-h-48 overflow-auto rounded bg-surface-hover p-2 text-[11px]"
                  data-testid="imports-new-samples"
                >
                  {samplesText(p().samples)}
                </pre>
              </details>
            </Show>
            <Button
              size="sm"
              data-testid="imports-new-start"
              disabled={busy() !== null || tooManyRefused()}
              onClick={() => void onStart()}
            >
              {busy() === "start"
                ? i18n.t("kernel.imports.new.starting")
                : i18n.t("kernel.imports.new.start")}
            </Button>
          </div>
        )}
      </Show>
      <Show when={runId()}>{(id) => <ImportRunCard runId={id()} />}</Show>
    </section>
  )
}

export default NewImport
