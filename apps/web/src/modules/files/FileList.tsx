// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  type Component,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
  Suspense,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { fileParentRevision } from "~/modules/files/file-events"
import { fileIsImage, iconFor, iconTone } from "~/modules/files/file-icons"
import {
  deleteFile,
  downloadFile,
  type FileParent,
  type FileRow,
  getCachedPreviewObjectUrl,
  listFiles,
} from "~/modules/files/file-service"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

/**
 * A row's thumbnail. A presigned object-store URL (direct delivery) is shown
 * as is. A server-relative one (`/api/files/:id/inline?variant=thumb`, relayed
 * delivery) is the API's authenticated inline route, which a bare `<img src>`
 * cannot call (no Bearer header): it is loaded through the authed client into
 * the session's preview cache, the way AttachmentCard does.
 */
const FileListThumbnail: Component<{ fileId: string; url: string; fallback: JSX.Element }> = (
  props,
) => {
  const api = useApi()
  const relayed = () => props.url.startsWith("/")
  const [cached] = createResource(
    () => (relayed() ? props.fileId : null),
    (fileId: string) => getCachedPreviewObjectUrl(api, fileId),
  )
  // `state` is read, not the value, so a loading thumbnail never suspends the list.
  const src = () => (relayed() ? (cached.state === "ready" ? cached() : undefined) : props.url)
  return (
    <Show when={src()} fallback={props.fallback}>
      {(url) => (
        <img
          src={url()}
          alt=""
          class="h-20 w-full object-cover"
          data-testid={`file-list-thumbnail-${props.fileId}`}
        />
      )}
    </Show>
  )
}

interface Props {
  parent: FileParent
  /** Optimistic insert: pass a refresh signal that bumps when a new file is added. */
  refreshKey?: () => number
}

// Own Suspense boundary: the resource read below must never propagate to the
// tab-level <Suspense> in MainPanel — that would blank the entire tab while
// attachments load (the "view keeps reloading" blink).
const FileList: Component<Props> = (props) => (
  <Suspense fallback={null}>
    <FileListInner {...props} />
  </Suspense>
)

const FileListInner: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [error, setError] = createSignal<string | null>(null)
  // The server refused this viewer the files: no list, and no "No files yet".
  const [refused, setRefused] = createSignal(false)
  let activeController: AbortController | null = null
  onCleanup(() => activeController?.abort())
  // Source is a primitive key, not a fresh object literal — parents pass
  // `parent` as an inline object, so an object source would get a new
  // reference (and refetch) every time the parent view re-evaluates. The
  // live revision moves on every `kernel:file` event for this parent (an
  // agent attaching a file, another tab deleting one) and on a WebSocket
  // resync, so the shelf follows without a reload.
  const [files, { refetch }] = createResource(
    () =>
      `${props.parent.app}:${props.parent.entityType}:${props.parent.entityId}:${
        props.refreshKey?.() ?? 0
      }:${fileParentRevision(props.parent)}`,
    async () => {
      activeController?.abort()
      const ac = new AbortController()
      activeController = ac
      // A failed attachments fetch must not reject the resource — that would
      // surface as an unhandled rejection and tear down the parent view
      // (doc / thread / ticket). Degrade to an empty list with an inline error.
      // A viewer refused the files (403) sees none, quietly.
      try {
        const rows = await listFiles(api, props.parent, { signal: ac.signal })
        setRefused(false)
        return rows
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err
        if (err instanceof ApiError && err.status === 403) setRefused(true)
        else setError(i18n.t("kernel.filesUi.loadFailed"))
        return []
      }
    },
  )

  async function handleDownload(row: FileRow): Promise<void> {
    try {
      await downloadFile(api, row)
    } catch {
      setError(i18n.t("kernel.filesUi.downloadFailed"))
    }
  }

  async function handleDelete(row: FileRow, e: MouseEvent): Promise<void> {
    e.stopPropagation()
    try {
      await deleteFile(api, row.id)
      await refetch()
    } catch {
      setError(i18n.t("kernel.filesUi.deleteFailed"))
    }
  }

  return (
    <div class="flex flex-col gap-2" data-testid="file-list">
      <Show when={error()}>
        <span class="text-[11px] text-warning">{error()}</span>
      </Show>
      {/* A live refetch ("refreshing") keeps the shelf it already shows
          (`latest`) rather than flashing "Loading" over it each time a file
          event lands. */}
      <Show
        when={!files.loading || files.state === "refreshing"}
        fallback={<span class="text-[11px] text-text-tertiary">{i18n.t("kernel.loading")}</span>}
      >
        <Show
          when={(files.latest ?? []).length > 0}
          fallback={
            <Show when={!refused()}>
              <span data-testid="file-list-empty" class="text-[12px] text-text-tertiary">
                {i18n.t("kernel.filesUi.noFilesYet")}
              </span>
            </Show>
          }
        >
          <div class="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-2">
            <For each={files.latest ?? []}>
              {(row) => {
                const icon = iconFor(row.filename, row.mimeType)
                const Icon = icon.icon
                return (
                  <div
                    data-testid={`file-list-item-${row.id}`}
                    class="group/file flex flex-col gap-1 rounded-sm border border-border bg-surface p-2 text-left hover:bg-surface-hover"
                  >
                    <button
                      type="button"
                      class="flex flex-col gap-1 text-left"
                      onClick={() => void handleDownload(row)}
                    >
                      <div
                        class="flex h-20 w-full items-center justify-center overflow-hidden rounded-sm bg-bg"
                        data-testid={`file-list-preview-${row.id}`}
                        data-file-kind={icon.kind}
                      >
                        <Show
                          when={fileIsImage(row.mimeType) && row.thumbnailUrl}
                          fallback={
                            <span data-testid={`file-list-icon-${row.id}`}>
                              <Icon size={30} class={iconTone(icon.kind)} />
                            </span>
                          }
                        >
                          <FileListThumbnail
                            fileId={row.id}
                            url={row.thumbnailUrl as string}
                            fallback={<Icon size={30} class={iconTone(icon.kind)} />}
                          />
                        </Show>
                      </div>
                      <span class="truncate text-[11px] text-text" title={row.filename}>
                        {row.filename}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid={`file-list-delete-${row.id}`}
                      class="text-[10px] text-text-tertiary opacity-0 transition-opacity hover:text-warning group-hover/file:opacity-100 text-left"
                      onClick={(e) => void handleDelete(row, e)}
                    >
                      {i18n.t("kernel.common.delete")}
                    </button>
                  </div>
                )
              }}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  )
}

export default FileList
