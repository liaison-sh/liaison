// SPDX-License-Identifier: FSL-1.1-ALv2
import { Download, X } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { formatBytes } from "~/modules/files/file-icons"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Dialog } from "~/ui/Dialog"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Image source — object URL, inline route, or remote URL. */
  src: string | undefined
  filename?: string
  sizeBytes?: number
  onDownload?: () => void
  /** Stable id suffix for test hooks (defaults to "body-image"). */
  testId?: string
}

/**
 * Fullscreen image preview overlay — the single lightbox used everywhere an
 * image can be clicked: attachment previews (via {@link ImageAttachment}) and
 * images embedded in rendered mail/ticket HTML bodies.
 */
export const ImageLightbox: Component<Props> = (props) => {
  const i18n = useI18n()
  // The images this lightbox opens (inline body images, attachment
  // thumbnails) are plain buttons, never a Kobalte `Dialog.Trigger` — so on
  // close Kobalte's default `onCloseAutoFocus` has no registered trigger ref
  // to restore focus to and falls back to focusing `document.body`. Safari
  // scrolls the nearest scrollable ancestor (the ticket/thread message list)
  // to the TOP to bring `<body>` into view when that happens, resetting the
  // reader's scroll position on every lightbox close. Capture the element
  // that had focus when the lightbox opened and restore focus to it
  // ourselves (without scrolling), bypassing Kobalte's fallback.
  let elementToRestoreFocus: HTMLElement | null = null
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content
        class="w-auto max-w-[96vw] border-none bg-transparent p-0 shadow-none"
        onOpenAutoFocus={() => {
          elementToRestoreFocus =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(e: Event) => {
          e.preventDefault()
          elementToRestoreFocus?.focus({ preventScroll: true })
          elementToRestoreFocus = null
        }}
      >
        <div
          class="flex flex-col items-center gap-2"
          data-testid={`attachment-lightbox-${props.testId ?? "body-image"}`}
        >
          <img
            src={props.src}
            alt={props.filename ?? ""}
            class="max-h-[88vh] max-w-[94vw] rounded-md object-contain"
          />
          <div class="flex items-center gap-3 text-xs text-white/90">
            <Show when={props.filename}>
              <span class="max-w-[60vw] truncate" title={props.filename}>
                {props.filename}
              </span>
            </Show>
            <Show when={props.sizeBytes !== undefined}>
              <span class="text-white/60">{formatBytes(props.sizeBytes ?? 0)}</span>
            </Show>
            <Show when={props.onDownload}>
              <button
                type="button"
                class="flex items-center gap-1 hover:text-white"
                onClick={() => props.onDownload?.()}
              >
                <Download size={13} />
                <span>{i18n.t("kernel.download")}</span>
              </button>
            </Show>
            <Dialog.Close class="flex items-center gap-1 hover:text-white">
              <X size={13} />
              <span>{i18n.t("kernel.close")}</span>
            </Dialog.Close>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
