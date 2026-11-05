// SPDX-License-Identifier: FSL-1.1-ALv2
import { Download } from "lucide-solid"
import { type Component, createResource, createSignal, onCleanup, Show } from "solid-js"
import { formatBytes } from "~/modules/files/file-icons"
import { fetchInlineObjectUrl, getCachedPreviewObjectUrl } from "~/modules/files/file-service"
import { ImageLightbox } from "~/modules/files/ImageLightbox"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { settledValue } from "~/primitives/settledValue"
import { Skeleton } from "~/ui/Skeleton"
import { AttachmentCard, type AttachmentFile } from "./AttachmentCard"

interface Props {
  file: AttachmentFile
  onDownload?: () => void
}

/**
 * Slack-style inline rendering for image attachments: the picture itself is
 * the message chrome (a 10px-rounded preview, aspect ratio kept, at most
 * 320x240 on a desktop and up to three quarters of the column on a phone,
 * where a 320px cap would be nearly the whole screen), with filename/size and
 * a download action revealed on hover, and a click-to-expand lightbox that
 * streams the full-resolution bytes through the authenticated inline route.
 *
 * Falls back to the compact {@link AttachmentCard} whenever a preview cannot
 * be produced (no API context, thumbnail fetch failed) so the file is never
 * invisible.
 */
export const ImageAttachment: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [expanded, setExpanded] = createSignal(false)
  // Track decode so we can hold the skeleton's box until the bitmap lays out.
  // Without this the row briefly collapses (skeleton → not-yet-decoded <img> of
  // ~0 height → full image), and that transient *shrink* thrashes the
  // virtualized thread list's scroll position — see MessageList's bottom anchor.
  const [loaded, setLoaded] = createSignal(false)

  // Preview URLs come from the session-scoped cache (file-service) — the
  // virtualized message list mounts/unmounts these constantly during
  // scrollback. Never revoke the returned URL; the cache owns its lifetime.
  const [previewUrl] = createResource(
    () => (api ? { fileId: props.file.id, api } : null),
    (src: { fileId: string; api: NonNullable<typeof api> }) =>
      getCachedPreviewObjectUrl(src.api, src.fileId),
  )

  // Full-resolution bytes are fetched lazily, only once the lightbox opens.
  // Unlike previews these are NOT session-cached (originals can be tens of
  // MB), so this component owns and revokes the object URL.
  const [fullUrl] = createResource(
    () => (expanded() && api ? { fileId: props.file.id, api } : null),
    (src: { fileId: string; api: NonNullable<typeof api> }) =>
      fetchInlineObjectUrl(src.api, src.fileId),
  )
  // Read through settledValue: a preview loading here must never suspend the
  // tab around the message list (see settledValue).
  const preview = () => settledValue(previewUrl)
  const full = () => settledValue(fullUrl)
  const revokeFull = () => {
    const url = fullUrl.latest
    if (url) URL.revokeObjectURL(url)
  }
  onCleanup(revokeFull)

  return (
    <Show
      when={previewUrl.loading || preview()}
      fallback={<AttachmentCard file={props.file} onDownload={props.onDownload} />}
    >
      <div
        data-testid={`attachment-image-${props.file.id}`}
        data-disposition={props.file.disposition ?? "attachment"}
        class="group relative w-fit max-w-[min(320px,100%)] max-sm:max-w-[75%]"
      >
        <Show
          when={preview()}
          fallback={<Skeleton class="h-40 w-56 max-w-full rounded-[10px] border border-border" />}
        >
          {(url) => (
            <button
              type="button"
              class="relative block max-w-full cursor-zoom-in overflow-hidden rounded-[10px]"
              onClick={() => setExpanded(true)}
              aria-label={props.file.filename}
            >
              {/* Hold a fixed loading box until the bitmap decodes, then swap to
                  the image in a single render. The row height therefore only
                  ever *grows* (skeleton → image) and never collapses through a
                  zero-height frame — a mid-load collapse would yank the
                  virtualized thread list's scroll position (see MessageList's
                  bottom anchor). While loading, the <img> is taken out of flow
                  so it contributes no height until it is ready, and the button
                  clips it: an absolute <img> taller than the skeleton still
                  counted in the list's scrollHeight, so the pin went to a
                  bottom that did not exist yet, and when the image entered
                  the flow the browser's scroll anchoring pulled the view back
                  up by the difference and the list stopped following. */}
              <Show when={!loaded()}>
                <Skeleton class="h-40 w-56 max-w-full rounded-[10px] border border-border" />
              </Show>
              <img
                src={url()}
                alt={props.file.filename}
                class={`block h-auto max-h-60 w-auto max-w-full rounded-[10px] border border-border object-contain transition-opacity duration-150 max-sm:max-h-80 ${
                  loaded() ? "" : "pointer-events-none absolute inset-0 opacity-0"
                }`}
                onLoad={() => setLoaded(true)}
                data-testid={`attachment-thumbnail-${props.file.id}`}
              />
            </button>
          )}
        </Show>
        <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 rounded-b-[10px] bg-gradient-to-t from-black/70 to-transparent px-2 pt-5 pb-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          <span class="truncate text-[10.5px] leading-snug text-white" title={props.file.filename}>
            {props.file.filename}
            <span class="ml-1.5 text-white/70">{formatBytes(props.file.sizeBytes)}</span>
          </span>
          <button
            type="button"
            data-testid={`attachment-download-${props.file.id}`}
            class="pointer-events-auto flex items-center text-white/80 hover:text-white"
            aria-label={i18n.t("kernel.download")}
            onClick={(e) => {
              e.stopPropagation()
              props.onDownload?.()
            }}
          >
            <Download size={13} />
          </button>
        </div>

        {/* Show the (cached) preview while the original streams in, so the
            lightbox never opens onto a blank frame. */}
        <ImageLightbox
          open={expanded()}
          onOpenChange={(open) => {
            setExpanded(open)
            if (!open) revokeFull()
          }}
          src={full() ?? preview() ?? undefined}
          filename={props.file.filename}
          sizeBytes={props.file.sizeBytes}
          onDownload={props.onDownload}
          testId={props.file.id}
        />
      </div>
    </Show>
  )
}
