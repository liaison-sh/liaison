// SPDX-License-Identifier: FSL-1.1-ALv2
import { Paperclip } from "lucide-solid"
import { type Component, createSignal, Show } from "solid-js"
import {
  type FileParent,
  FileQuotaExceededError,
  type FileRow,
  FileStorageUnavailableError,
  uploadFile,
} from "~/modules/files/file-service"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

interface Props {
  parent: FileParent
  onUploaded?: (row: FileRow) => void
  disabled?: boolean
}

const FileUploadButton: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let inputRef: HTMLInputElement | undefined

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return
    setBusy(true)
    setError(null)
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i]
        const row = await uploadFile(api, f, props.parent)
        props.onUploaded?.(row)
      }
    } catch (e) {
      if (e instanceof FileStorageUnavailableError) {
        setError("Storage unavailable. Try again in a moment.")
      } else if (e instanceof FileQuotaExceededError) {
        setError("File exceeds quota.")
      } else {
        setError("Upload failed.")
      }
    } finally {
      setBusy(false)
      if (inputRef) inputRef.value = ""
    }
  }

  return (
    <div class="inline-flex flex-col gap-1" data-testid="file-upload-button">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface px-2 py-1 text-[12px] text-text-secondary hover:bg-surface-hover disabled:opacity-50"
        disabled={props.disabled || busy()}
        onClick={() => inputRef?.click()}
        data-testid="file-upload-trigger"
      >
        <Paperclip size={14} />
        {busy() ? i18n.t("kernel.filesUi.uploadingEllipsis") : i18n.t("kernel.filesUi.attach")}
      </button>
      <input
        ref={(el) => (inputRef = el)}
        type="file"
        multiple
        hidden
        data-testid="file-upload-input"
        onChange={(e) => void handleFiles((e.target as HTMLInputElement).files)}
      />
      <Show when={error()}>
        <span data-testid="file-upload-error" class="text-[11px] text-warning">
          {error()}
        </span>
      </Show>
    </div>
  )
}

export default FileUploadButton
