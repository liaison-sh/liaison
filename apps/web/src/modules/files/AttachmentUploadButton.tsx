// SPDX-License-Identifier: FSL-1.1-ALv2
import { Paperclip } from "lucide-solid"
import { type Component, createSignal } from "solid-js"
import {
  type FileParent,
  type FileRow,
  isUploadCancelled,
  uploadFile,
} from "~/modules/files/file-service"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

interface Props {
  /**
   * Staging parent for uploaded files, or a lazy resolver so the composer can
   * defer creating the staging container (upload session, mail draft) until
   * files are actually picked. The picker itself opens on the FIRST click —
   * the resolver runs after selection, not before.
   */
  parent: FileParent | (() => Promise<FileParent>)
  onUploaded: (row: FileRow) => void
  onError?: (err: unknown) => void
  /** Disable the button while parent state is in flight. */
  disabled?: boolean
}

/**
 * Composer-side upload control. Posts each selected file to the staging
 * parent and surfaces the resulting `FileRow` so the composer can render an
 * in-progress strip.
 *
 * Reparenting from the staging parent to the final message is the composer's
 * (or the server's) responsibility after send.
 */
export const AttachmentUploadButton: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [busy, setBusy] = createSignal(false)
  let inputRef: HTMLInputElement | undefined

  async function handleChange(e: Event): Promise<void> {
    const list = (e.target as HTMLInputElement).files
    if (!list || list.length === 0) return
    setBusy(true)
    try {
      const parent = typeof props.parent === "function" ? await props.parent() : props.parent
      for (const file of Array.from(list)) {
        let row: FileRow
        try {
          row = await uploadFile(api, file, parent, {
            disposition: file.type.startsWith("image/") ? "inline" : "attachment",
          })
        } catch (err) {
          // Removed from the strip while it uploaded: dropped, not an error,
          // and the rest of the pick carries on.
          if (isUploadCancelled(err)) continue
          throw err
        }
        props.onUploaded(row)
      }
    } catch (err) {
      props.onError?.(err)
    } finally {
      setBusy(false)
      if (inputRef) inputRef.value = ""
    }
  }

  return (
    <label
      data-testid="attachment-upload-button"
      class="inline-flex cursor-pointer items-center gap-1 rounded-sm border border-border bg-surface px-2 py-1 text-[11px] text-text hover:bg-surface-hover"
      aria-label={busy() ? i18n.t("kernel.filesUi.uploading") : i18n.t("kernel.filesUi.attach")}
      title={busy() ? i18n.t("kernel.filesUi.uploading") : i18n.t("kernel.filesUi.attach")}
      aria-disabled={busy() || props.disabled}
    >
      <Paperclip size={12} />
      {/* The label is worth its width wherever there is width. At phone width
          the composer row (wand, emoji, this, send) left the message field
          122px of a 402px viewport, and a labelled attach button was the
          widest of the four: the paperclip alone says the same thing, and the
          accessible name below keeps saying it to a screen reader. */}
      <span class="hidden sm:inline">
        {busy() ? i18n.t("kernel.filesUi.uploadingEllipsis") : i18n.t("kernel.filesUi.attach")}
      </span>
      <input
        ref={inputRef}
        type="file"
        multiple
        data-testid="attachment-upload-input"
        class="hidden"
        onChange={(e) => void handleChange(e)}
        disabled={busy() || props.disabled}
      />
    </label>
  )
}
