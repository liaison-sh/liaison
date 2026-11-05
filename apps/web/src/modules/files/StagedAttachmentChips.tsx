// SPDX-License-Identifier: FSL-1.1-ALv2
import { X } from "lucide-solid"
import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  type ParentComponent,
  Show,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { fileIsImage, formatBytes, iconFor, iconTone } from "~/modules/files/file-icons"
import {
  cancelUpload,
  type FileRow,
  getCachedPreviewObjectUrl,
  type InFlightUpload,
  inFlightUploadsFor,
} from "~/modules/files/file-service"
import { tNow, useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { settledValue } from "~/primitives/settledValue"

interface Props {
  files: FileRow[]
  /** The person removed a staged file. Called AT ONCE, before the server has
   *  deleted it: the tile leaves the strip immediately and the file must not
   *  go out with the message. */
  onRemoved: (file: FileRow) => void
  /** The server refused the delete: put the file back at `index` (use
   *  `restoreStaged`). The strip says why under the tiles. */
  onRestored: (file: FileRow, index: number) => void
  /** The server deleted it (or it was already gone): the removal is final. */
  onRemoveSettled?: (file: FileRow) => void
  error?: string | null
  disabled?: boolean
  /** Replaces the strip's own layout (one left-aligned row above the field,
   *  the same in every composer) for a host that needs other padding. */
  class?: string
  /** `app:entityType:entityId` of the staging parent (file-service
   *  `parentKeyOf`). When given, files still uploading to it show in the strip
   *  with a spinner, so a picked photo appears at once rather than after the
   *  round trip. */
  uploadParentKey?: string | null
}

/**
 * The "about to be sent" strip every composer renders ABOVE its text field,
 * inside the composer card: each staged file, removable before send, plus the
 * upload error line (uploads must never fail silently).
 *
 * An image is a 64px square thumbnail of the picture itself. The preview comes
 * from the picked bytes (a local object URL set by `uploadFile`), then the
 * server's thumbnail, then the authenticated inline route streamed into a blob
 * (the Bearer path the native apps also use, since an `<img>` cannot carry the
 * token). It used to be a 36px tile that showed only the server thumbnail,
 * which does not exist yet right after upload, so an iPhone showed a blank
 * "PNG" badge squeezed under the send button.
 *
 * Any other file is a compact chip: type icon, truncated name, size. The strip
 * scrolls sideways once it runs out of width, and has no border of its own: a
 * full-width bordered row read as a second card on top of the input
 * (2026-08-05 layout pass). Every composer draws it the same way, one row
 * left-aligned at the text's edge above the field: tickets and mail used to
 * right-align it under the editor, beside the send button.
 *
 * Removal is optimistic: the tile leaves at once and the server DELETE runs
 * behind it. It used to wait for the round trip, so the X seemed not to work.
 * A refused delete puts the file back with a message; a file already gone
 * (404) counts as removed.
 */
export const StagedAttachmentChips: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()

  const [removeError, setRemoveError] = createSignal<string | null>(null)
  // Local previews of files whose delete is still in flight: kept alive so a
  // refused delete brings the tile back with its picture.
  const removing = new Set<string>()

  async function remove(file: FileRow): Promise<void> {
    const index = props.files.findIndex((f) => f.id === file.id)
    setRemoveError(null)
    if (file.localPreviewUrl) removing.add(file.localPreviewUrl)
    props.onRemoved(file)
    try {
      await api.delete(`/files/${file.id}`)
    } catch (err) {
      // Already gone (a concurrent delete, a swept staging row): removed.
      if (!(err instanceof ApiError && err.status === 404)) {
        props.onRestored(file, Math.max(index, 0))
        setRemoveError(tNow("kernel.filesUi.removeFailed", { filename: file.filename }))
        return
      }
    } finally {
      if (file.localPreviewUrl) {
        removing.delete(file.localPreviewUrl)
        releaseGone()
      }
    }
    props.onRemoveSettled?.(file)
  }

  // A local preview holds the picked bytes in memory until it is revoked. The
  // strip owns every one it is handed: one is released as soon as its file
  // leaves the list, whichever way it left (removed, sent with the message,
  // the draft discarded), and the rest when the strip goes away.
  const localPreviews = new Set<string>()
  function releaseGone(): void {
    const current = new Set<string>()
    for (const f of props.files) if (f.localPreviewUrl) current.add(f.localPreviewUrl)
    for (const url of localPreviews) {
      if (current.has(url) || removing.has(url)) continue
      URL.revokeObjectURL(url)
      localPreviews.delete(url)
    }
    for (const url of current) localPreviews.add(url)
  }
  createEffect(releaseGone)
  onCleanup(() => {
    for (const url of localPreviews) URL.revokeObjectURL(url)
    localPreviews.clear()
  })

  const uploads = () => inFlightUploadsFor(props.uploadParentKey)

  const removeControl = (testId: string, filename: string, onRemove: () => void): JSX.Element => (
    <button
      type="button"
      data-testid={testId}
      aria-label={i18n.t("kernel.filesUi.removeFile", { filename })}
      // Dense on purpose: the tier's 44px floor would draw a 44px disc over a
      // 64px thumbnail. The ::before gives the finger a 36px target instead.
      data-touch-dense=""
      class="absolute -right-1.5 -top-1.5 z-10 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-elevated text-text-secondary shadow-sm transition-colors before:absolute before:-inset-2 before:content-[''] hover:text-text disabled:opacity-50"
      disabled={props.disabled}
      onClick={onRemove}
    >
      <X size={11} strokeWidth={2.5} />
    </button>
  )
  const removeButton = (f: FileRow): JSX.Element =>
    removeControl(`composer-attachment-remove-${f.id}`, f.filename, () => void remove(f))

  return (
    <>
      <Show when={props.files.length > 0 || uploads().length > 0}>
        <div data-testid="composer-attachment-strip" class={props.class ?? STRIP}>
          <For each={props.files}>
            {(f) => (
              <div
                data-testid={`composer-attachment-${f.id}`}
                data-kind={fileIsImage(f.mimeType) ? "image" : "file"}
                title={f.filename}
                class="relative shrink-0 pr-1.5 pt-1.5"
              >
                <Show when={fileIsImage(f.mimeType)} fallback={<FileChip file={f} />}>
                  <StagedImage file={f} />
                  <span class="sr-only">{f.filename}</span>
                </Show>
                {removeButton(f)}
              </div>
            )}
          </For>
          <For each={uploads()}>
            {(u) => (
              <UploadingTile upload={u} label={i18n.t("kernel.filesUi.uploading")}>
                {removeControl(
                  `composer-attachment-cancel-${u.key}`,
                  u.filename,
                  // Aborts the upload: the tile and its preview go at once,
                  // and no file is left on the server (file-service
                  // cancelUpload).
                  () => cancelUpload(u.key),
                )}
              </UploadingTile>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.error || removeError()}>
        <div
          data-testid="composer-attachment-error"
          class="px-3 pt-1 text-[11px] text-warning"
          role="alert"
        >
          {props.error || removeError()}
        </div>
      </Show>
    </>
  )
}

/** One row at the text's left edge that scrolls sideways; each tile carries
 *  6px above it for its corner remove button, hence the lighter top padding.
 *  The chat composer passes its own padding (it follows the phone tier). */
const STRIP = "flex items-center gap-2.5 overflow-x-auto px-3 pt-2 pb-0.5 [scrollbar-width:thin]"

/** Puts a file whose delete the server refused back where it was. */
export function restoreStaged(list: FileRow[], file: FileRow, index: number): FileRow[] {
  if (list.some((f) => f.id === file.id)) return list
  return [...list.slice(0, index), file, ...list.slice(index)]
}

const TILE = "h-16 w-16 overflow-hidden rounded-lg border border-border bg-bg"

/** A staged image: the picture, cropped square. Each source that fails to
 *  load hands over to the next one, and the extension badge is the last. */
const StagedImage: Component<{ file: FileRow }> = (props) => {
  const api = useApi()
  const [failed, setFailed] = createSignal<string[]>([])
  const direct = () =>
    [props.file.localPreviewUrl, props.file.thumbnailUrl].find(
      (u): u is string => !!u && !failed().includes(u),
    ) ?? null
  // Only when the row carries nothing usable (a draft restored after reload):
  // the authenticated route, cached for the session like message previews.
  const [fetched] = createResource(
    () => (direct() ? null : props.file.id),
    (id: string) => getCachedPreviewObjectUrl(api, id),
  )
  const src = () => {
    const d = direct()
    if (d) return d
    const f = settledValue(fetched)
    return f && !failed().includes(f) ? f : null
  }
  return (
    <div class={TILE}>
      <Show
        when={src()}
        fallback={
          <span class="flex h-full w-full items-center justify-center text-[10px] font-medium uppercase text-text-tertiary">
            {extensionLabel(props.file.filename)}
          </span>
        }
      >
        {(url) => (
          <img
            src={url()}
            alt={props.file.filename}
            class="h-full w-full object-cover"
            onError={() => setFailed((l) => [...l, url()])}
          />
        )}
      </Show>
    </div>
  )
}

/** A staged non-image: the chip the sent message will show, in small. */
const FileChip: Component<{
  file: Pick<FileRow, "filename" | "mimeType" | "sizeBytes">
  busy?: boolean
}> = (props) => {
  const choice = () => iconFor(props.file.filename, props.file.mimeType)
  return (
    <div class="flex h-16 w-[190px] items-center gap-2.5 rounded-lg border border-border bg-bg px-2.5">
      <span class="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-surface">
        <Show when={!props.busy} fallback={<Spinner />}>
          {(() => {
            const Icon = choice().icon
            return <Icon size={18} class={iconTone(choice().kind)} />
          })()}
        </Show>
      </span>
      <span class="min-w-0 flex-1">
        <span class="block truncate text-[12.5px] font-medium text-text">
          {props.file.filename}
        </span>
        <span class="block text-[11px] text-text-tertiary">
          {formatBytes(props.file.sizeBytes)}
        </span>
      </span>
    </div>
  )
}

const Spinner: Component = () => (
  <span class="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
)

/** A file still uploading: its preview dimmed under a spinner, or its chip
 *  with the spinner where the type icon goes. */
const UploadingTile: ParentComponent<{ upload: InFlightUpload; label: string }> = (props) => (
  <div
    // No title: a chip's title (its filename) means STAGED, which is what
    // the e2e scenarios wait on before sending.
    data-testid="composer-attachment-uploading"
    role="status"
    aria-label={`${props.label} ${props.upload.filename}`}
    aria-busy="true"
    class="relative shrink-0 pr-1.5 pt-1.5"
  >
    <Show when={props.upload.previewUrl} fallback={<FileChip file={props.upload} busy />}>
      {(url) => (
        <div class={`${TILE} relative`}>
          <img src={url()} alt="" class="h-full w-full object-cover opacity-50" />
          <span class="absolute inset-0 flex items-center justify-center">
            <Spinner />
          </span>
        </div>
      )}
    </Show>
    {props.children}
  </div>
)

/** Human-readable message for a failed staging upload. */
export function attachmentErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message)
    return tNow("kernel.filesUi.attachmentFailed", { reason: err.message })
  return tNow("kernel.filesUi.attachmentFailedGeneric")
}

/** Short uppercase extension for the non-image badge, e.g. "PDF". */
function extensionLabel(filename: string): string {
  const dot = filename.lastIndexOf(".")
  const ext = dot > 0 ? filename.slice(dot + 1) : ""
  return (ext || "FILE").slice(0, 4).toUpperCase()
}
