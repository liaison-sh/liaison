// SPDX-License-Identifier: FSL-1.1-ALv2

import { Download } from "lucide-solid"
import { type Component, createResource, createSignal, onCleanup, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { cn } from "~/lib/cn"
import {
  fileExtension,
  fileIsImage,
  formatBytes,
  iconFor,
  iconTone,
} from "~/modules/files/file-icons"
import { fetchInlineObjectUrl, getCachedPreviewObjectUrl } from "~/modules/files/file-service"
import { ImageLightbox } from "~/modules/files/ImageLightbox"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { settledValue } from "~/primitives/settledValue"

export interface AttachmentFile {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  thumbnailKey?: string | null
  thumbnailUrl?: string | null
  downloadUrl?: string | null
  disposition?: "inline" | "attachment"
  contentId?: string | null
}

interface Props {
  file: AttachmentFile
  onDownload?: () => void
}

/**
 * Message-level attachment card. Renders a preview for image files (fetched
 * through the authenticated inline route — thumbnail variant when one exists),
 * otherwise the matching filetype icon. Filename + size + a download action are
 * always shown, including for inline images so the file remains downloadable.
 *
 * Image cards are click-to-expand: the thumbnail opens the same fullscreen
 * {@link ImageLightbox} as {@link ImageAttachment}, streaming the full-res
 * bytes through the authed inline route. This is the ONLY fullscreen path for
 * body-embedded images (`disposition: "inline"` + a `contentId`), which the
 * strip renders as compact cards rather than big previews — the message body's
 * `<img src="/api/files/:id/inline">` can't carry the Bearer header the route
 * requires, so clicking it there is a dead end.
 */
export const AttachmentCard: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const icon = () => iconFor(props.file.filename, props.file.mimeType)
  const isImage = () => fileIsImage(props.file.mimeType)
  const [expanded, setExpanded] = createSignal(false)

  // Preview URLs come from the session-scoped cache (file-service): the
  // virtualized message list mounts/unmounts cards constantly during
  // scrollback, and per-mount fetch+revoke caused icon→image flicker and
  // re-downloads. The cache owns the URL lifetime — never revoke it here.
  const [previewUrl] = createResource(
    () => (isImage() && api ? { fileId: props.file.id, api } : null),
    (src: { fileId: string; api: NonNullable<typeof api> }) =>
      getCachedPreviewObjectUrl(src.api, src.fileId),
  )

  // Full-resolution bytes are fetched lazily, only once the lightbox opens.
  // Unlike the cached preview these can be large, so this card owns and revokes
  // the object URL. Mirrors ImageAttachment's lightbox path.
  const [fullUrl] = createResource(
    () => (expanded() && api ? { fileId: props.file.id, api } : null),
    (src: { fileId: string; api: NonNullable<typeof api> }) =>
      fetchInlineObjectUrl(src.api, src.fileId),
  )
  // Read through settledValue: a preview loading here must never suspend the
  // tab around the message list (see settledValue).
  const previewSrc = () => settledValue(previewUrl)
  const full = () => settledValue(fullUrl)
  const revokeFull = () => {
    const url = fullUrl.latest
    if (url) URL.revokeObjectURL(url)
  }
  onCleanup(revokeFull)

  const preview = () => (
    <Show
      when={previewSrc()}
      fallback={
        <span data-testid={`attachment-icon-${props.file.id}`}>
          {(() => {
            const Icon = icon().icon
            return <Icon size={22} class={iconTone(icon().kind)} />
          })()}
        </span>
      }
    >
      {(url) => (
        <img
          src={url()}
          alt=""
          class="h-14 w-full object-cover opacity-0 transition-opacity duration-150"
          onLoad={(e) => e.currentTarget.classList.remove("opacity-0")}
          data-testid={`attachment-thumbnail-${props.file.id}`}
        />
      )}
    </Show>
  )
  const thumbBoxClass =
    "flex h-14 w-full items-center justify-center overflow-hidden rounded-sm bg-bg"

  // Any other file is a row, not a tile: the type icon, the name at a size
  // that reads, the size, and a download button. The 128px tile with a 56px
  // icon well and 9px text was the "generic file card" every file looked like.
  if (!isImage()) {
    const ext = () => fileExtension(props.file.filename).toUpperCase()
    return (
      <div
        data-testid={`attachment-card-${props.file.id}`}
        data-disposition={props.file.disposition ?? "attachment"}
        class="flex w-[260px] max-w-full items-center gap-3 rounded-[10px] border border-border bg-surface py-2 pl-2.5 pr-1.5"
      >
        <span
          data-testid={`attachment-icon-${props.file.id}`}
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-bg"
        >
          {(() => {
            const Icon = icon().icon
            return <Icon size={20} class={iconTone(icon().kind)} />
          })()}
        </span>
        <span class="min-w-0 flex-1">
          <span
            class="block truncate text-[13px] font-medium leading-snug text-text"
            title={props.file.filename}
          >
            {props.file.filename}
          </span>
          <span class="block text-[11.5px] leading-snug text-text-tertiary">
            {ext() ? `${ext()} · ` : ""}
            {formatBytes(props.file.sizeBytes)}
          </span>
        </span>
        <button
          type="button"
          data-testid={`attachment-download-${props.file.id}`}
          aria-label={`${i18n.t("kernel.download")} ${props.file.filename}`}
          title={i18n.t("kernel.download")}
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
          onClick={() => props.onDownload?.()}
        >
          <Download size={16} />
        </button>
      </div>
    )
  }

  return (
    <div
      data-testid={`attachment-card-${props.file.id}`}
      data-disposition={props.file.disposition ?? "attachment"}
      class="flex w-32 flex-col gap-1 rounded-sm border border-border bg-surface p-1.5 pb-2 text-left"
    >
      {/* Images are click-to-expand (a real <button>); other files are a plain
          box. Dynamic renders the single preview content under whichever tag,
          so it is never evaluated twice. */}
      <Dynamic
        component={isImage() ? "button" : "div"}
        type={isImage() ? "button" : undefined}
        onClick={isImage() ? () => setExpanded(true) : undefined}
        aria-label={isImage() ? props.file.filename : undefined}
        class={cn(thumbBoxClass, isImage() && "cursor-zoom-in")}
      >
        {preview()}
      </Dynamic>
      <span
        class="mt-0.5 truncate text-[10.5px] leading-snug text-text"
        title={props.file.filename}
      >
        {props.file.filename}
      </span>
      <div class="flex items-center justify-between text-[9px] text-text-tertiary">
        <span>{formatBytes(props.file.sizeBytes)}</span>
        <button
          type="button"
          data-testid={`attachment-download-${props.file.id}`}
          class="flex items-center gap-0.5 hover:text-text"
          onClick={() => props.onDownload?.()}
        >
          <Download size={10} />
          <span>{i18n.t("kernel.download")}</span>
        </button>
      </div>
      {/* Show the (cached) thumbnail while the original streams in, so the
          lightbox never opens onto a blank frame. */}
      <Show when={isImage()}>
        <ImageLightbox
          open={expanded()}
          onOpenChange={(open) => {
            setExpanded(open)
            if (!open) revokeFull()
          }}
          src={full() ?? previewSrc() ?? undefined}
          filename={props.file.filename}
          sizeBytes={props.file.sizeBytes}
          onDownload={props.onDownload}
          testId={props.file.id}
        />
      </Show>
    </div>
  )
}
