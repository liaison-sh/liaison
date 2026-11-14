// SPDX-License-Identifier: FSL-1.1-ALv2
// Linked documents on a task: every `@[Label](app:entityType:id)` mention in
// the description that points at a Knowledge document, a registered remote
// doc (Drive spec, source_link) or a file, plus the files attached to the task
// itself and the files posted with the task's discussion comments (as an
// issue tracker lists a comment's attachments with the issue's files). Each renders as a collapsible card — closed: icon + label + open;
// expanded: the document body (markdown), the picture, the text/code (mono,
// clamped), or the remote link. The same component serves the task page (full,
// with upload) and the kanban card (compact chips), so a spec linked by the
// agent is visible from the board without opening the task.
import {
  ChevronRight,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Link2,
  Trash2,
} from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import type { ApiClient } from "~/lib/api-client"
import { isSafeUserUrl } from "~/lib/sanitize"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { AttachmentCard, type AttachmentFile } from "~/modules/files/AttachmentCard"
import { AttachmentUploadButton } from "~/modules/files/AttachmentUploadButton"
import { fileExtension, fileIsImage, formatBytes } from "~/modules/files/file-icons"
import {
  deleteFile,
  type FileRow,
  fetchInlineObjectUrl,
  listFiles,
} from "~/modules/files/file-service"
import { useI18n } from "~/modules/i18n/i18n-context"
import { renderMarkdown } from "~/modules/knowledge/markdown"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"
import { extractMentionRefs } from "~/modules/shell/markdown-content"
import { addToast } from "~/modules/shell/toast-store"
import {
  getMessages,
  loadMessages,
  loadMoreMessages,
  messageStore,
} from "~/modules/threads/message-store"

export type LinkedKind = "document" | "source_link" | "file"

export interface LinkedItem {
  key: string
  kind: LinkedKind
  label: string
  app: string
  entityType: string
  entityId: string
  /** Known up front for the task's own attachments (no metadata round-trip). */
  file?: AttachmentFile
  /** Posted with a comment of the task's discussion, by this author. */
  fromDiscussion?: { authorName: string }
  /** One of the task's own attachments the viewer may remove. */
  removable?: boolean
}

/**
 * Who may remove a task attachment, mirroring the server rule (the projects
 * manifest's task fileParent `deleteScope`): the person who added it, or a
 * holder of the projects admin scope. Files linked from the description or
 * posted with a comment are not the task's: they go with their source.
 */
export const TASK_FILE_ADMIN_SCOPE = "projects:settings:admin"
export function canRemoveTaskFile(file: Pick<FileRow, "uploadedBy">): boolean {
  const me = userFromToken()?.userId
  if (me && file.uploadedBy === me) return true
  return hasScope(TASK_FILE_ADMIN_SCOPE)
}

const LINKABLE: Record<string, LinkedKind> = {
  "knowledge:document": "document",
  "knowledge:source_link": "source_link",
  "kernel:file": "file",
}

/** The mentions in a description that are documents/files (users, tasks,
 *  contacts etc. stay plain mentions in the prose). */
export function linkedItemsFromDescription(description: string | null | undefined): LinkedItem[] {
  return extractMentionRefs(description).flatMap((m) => {
    const kind = LINKABLE[`${m.app}:${m.entityType}`]
    if (!kind) return []
    return [
      {
        key: m.ref,
        kind,
        label: m.label,
        app: m.app,
        entityType: m.entityType,
        entityId: m.entityId,
      },
    ]
  })
}

const TEXT_MIME_PREFIXES = ["text/"]
const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/x-yaml",
  "application/yaml",
  "application/sql",
  "application/x-sh",
])
const TEXT_EXTENSIONS = new Set([
  "md",
  "txt",
  "json",
  "yml",
  "yaml",
  "js",
  "ts",
  "tsx",
  "jsx",
  "py",
  "sql",
  "csv",
  "sh",
  "css",
  "html",
  "xml",
  "toml",
  "ini",
  "log",
  "env",
])

/** Text or code we can show inline as monospace (images and binaries are not). */
export function fileIsText(filename: string, mimeType: string | null | undefined): boolean {
  const mime = (mimeType ?? "").toLowerCase()
  if (TEXT_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true
  if (TEXT_MIMES.has(mime)) return true
  return TEXT_EXTENSIONS.has(fileExtension(filename).toLowerCase())
}

const MAX_TEXT_PREVIEW_CHARS = 20_000

interface LinkedDocumentsProps {
  description: string | null | undefined
  api: ApiClient
  /** When set, the task's own attachments are listed too and can be added. */
  taskId?: string
  /** The task's discussion thread: files posted with its comments are listed
   *  too, read from the thread's own messages (the same read, and so the same
   *  visibility, as the discussion itself). */
  discussionThreadId?: string | null
  /** Chip row for the kanban card. */
  compact?: boolean
  /** Bumped when a file was attached elsewhere on the page (pasted into the description). */
  attachmentsVersion?: number
  disabled?: boolean
}

export const LinkedDocuments: Component<LinkedDocumentsProps> = (props) => {
  const i18n = useI18n()
  // The upload button resolves the API from context (shell surfaces); it is
  // simply absent where there is none, the list itself only needs props.api.
  const canUpload = !!useOptionalApi()
  const fromDescription = createMemo(() => linkedItemsFromDescription(props.description))

  // The source is compared by its values: a host that re-reads its task (a
  // store event, a field edit) re-evaluates these props with the same task, and
  // a fresh object each time would list the files again. The list is read with
  // `.latest` below, so a reload (an upload bumping the version) keeps the
  // section as it is instead of suspending the whole page around it.
  const attachmentsSource = createMemo(
    () =>
      props.taskId
        ? { api: props.api, taskId: props.taskId, version: props.attachmentsVersion }
        : null,
    undefined,
    {
      equals: (a, b) =>
        a === b ||
        (!!a && !!b && a.api === b.api && a.taskId === b.taskId && a.version === b.version),
    },
  )
  const [attachments, { refetch }] = createResource(attachmentsSource, async (src) => {
    try {
      return await listFiles(src.api, {
        app: "projects",
        entityType: "task",
        entityId: src.taskId,
      })
    } catch {
      return [] as FileRow[]
    }
  })

  // The discussion's messages come from the shared message store, which the
  // task page's discussion loads too. Every page is read, so a file posted
  // long ago still lists here (bounded: a task thread is a comment thread).
  let olderPagesRead = 0
  createEffect(() => {
    const threadId = props.discussionThreadId
    if (!threadId || props.compact) return
    if (!messageStore.threads[threadId]) {
      if (!messageStore.loading[threadId]) void loadMessages(props.api, threadId)
      return
    }
    if (
      messageStore.hasMore[threadId] &&
      !messageStore.loadingMore[threadId] &&
      olderPagesRead < MAX_DISCUSSION_PAGES
    ) {
      olderPagesRead += 1
      void loadMoreMessages(props.api, threadId)
    }
  })

  const discussionFiles = createMemo<LinkedItem[]>(() => {
    const threadId = props.discussionThreadId
    if (!threadId || props.compact) return []
    return getMessages(threadId)
      .filter((m) => !m.deletedAt && !m.pending)
      .flatMap((m) =>
        (m.attachments ?? []).map<LinkedItem>((a) => ({
          key: `kernel:file:${a.id}`,
          kind: "file",
          label: a.filename,
          app: "kernel",
          entityType: "file",
          entityId: a.id,
          file: {
            id: a.id,
            filename: a.filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            thumbnailUrl: a.thumbnailUrl ?? null,
            disposition: a.disposition,
            contentId: a.contentId ?? null,
          },
          fromDiscussion: { authorName: m.authorName },
        })),
      )
  })

  const items = createMemo<LinkedItem[]>(() => {
    const linked = fromDescription()
    const listedFileIds = new Set(linked.filter((l) => l.kind === "file").map((l) => l.entityId))
    const attached = (attachments.latest ?? [])
      .filter((f) => !listedFileIds.has(f.id))
      .map<LinkedItem>((f) => ({
        key: `kernel:file:${f.id}`,
        kind: "file",
        label: f.filename,
        app: "kernel",
        entityType: "file",
        entityId: f.id,
        file: f,
        removable: !props.disabled && canRemoveTaskFile(f),
      }))
    for (const a of attached) listedFileIds.add(a.entityId)
    const fromDiscussion = discussionFiles().filter((f) => !listedFileIds.has(f.entityId))
    return [...linked, ...attached, ...fromDiscussion]
  })

  return (
    <Show when={items().length > 0 || (props.taskId && !props.compact)}>
      <Show
        when={!props.compact}
        fallback={
          <div data-testid="linked-documents" data-compact="true" class="mt-1 flex flex-col gap-1">
            <For each={items()}>
              {(item) => <LinkedDocumentCard item={item} api={props.api} compact />}
            </For>
          </div>
        }
      >
        <section data-testid="linked-documents" class="flex flex-col gap-2">
          <div class="flex items-center justify-between">
            <h3 class="text-[11px] uppercase tracking-[0.04em] text-text-tertiary">
              {i18n.t("projects.linkedDocuments")} ·{" "}
              <span class="font-mono tabular-nums">{items().length}</span>
            </h3>
            <Show when={props.taskId && !props.disabled && canUpload}>
              <span class="text-[11px] text-text-tertiary">
                <AttachmentUploadButton
                  parent={{ app: "projects", entityType: "task", entityId: props.taskId! }}
                  onUploaded={() => void refetch()}
                />
              </span>
            </Show>
          </div>
          <Show
            when={items().length > 0}
            fallback={
              <p data-testid="linked-documents.empty" class="text-[12px] text-text-tertiary">
                {i18n.t("projects.linkedDocumentsHint")}
              </p>
            }
          >
            <ul class="flex flex-col gap-1.5">
              <For each={items()}>
                {(item) => (
                  <li>
                    <LinkedDocumentCard
                      item={item}
                      api={props.api}
                      onRemoved={() => void refetch()}
                    />
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </Show>
    </Show>
  )
}

/** Older discussion pages read for its files (50 messages a page). */
const MAX_DISCUSSION_PAGES = 20

const KIND_LABEL: Record<LinkedKind, string> = {
  document: "projects.kind.document",
  source_link: "Drive",
  file: "projects.kind.file",
}

const LinkedDocumentCard: Component<{
  item: LinkedItem
  api: ApiClient
  compact?: boolean
  /** After the attachment was removed (the list refetches). */
  onRemoved?: () => void
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  const [confirmingRemove, setConfirmingRemove] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  const remove = async (): Promise<void> => {
    if (removing()) return
    setRemoving(true)
    try {
      await deleteFile(props.api, props.item.entityId)
      props.onRemoved?.()
    } catch {
      addToast({ message: i18n.t("projects.removeAttachmentFailed"), type: "error" })
    } finally {
      setRemoving(false)
      setConfirmingRemove(false)
    }
  }
  const icon = () => {
    if (props.item.kind === "source_link") return Link2
    if (props.item.file && fileIsImage(props.item.file.mimeType)) return ImageIcon
    return FileText
  }
  const openItem = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    void openEntity(
      props.api,
      props.item.app,
      props.item.entityType,
      props.item.entityId,
      props.item.label,
    ).catch(() => {})
  }
  return (
    // The card sits inside clickable/draggable parents (a kanban card opens
    // the task on click): toggling a preview must not bubble into them.
    // biome-ignore lint/a11y/noStaticElementInteractions: click containment only; the toggle itself is a <button>.
    // biome-ignore lint/a11y/useKeyWithClickEvents: containment only.
    <div
      data-testid="linked-document"
      data-kind={props.item.kind}
      data-source={props.item.fromDiscussion ? "discussion" : undefined}
      title={
        props.item.fromDiscussion
          ? i18n.t("projects.discussionFileTitle", { name: props.item.fromDiscussion.authorName })
          : undefined
      }
      data-open={open() ? "true" : undefined}
      class={
        props.compact
          ? "rounded-sm border border-border-subtle bg-surface text-[11px]"
          : "rounded-sm border border-border-subtle bg-surface/40 text-[12.5px]"
      }
      onClick={(e) => e.stopPropagation()}
      onDragStart={(e) => e.stopPropagation()}
    >
      <div class="flex items-center gap-1.5 px-2 py-1">
        <button
          type="button"
          data-testid="linked-document.toggle"
          aria-expanded={open()}
          onClick={() => setOpen((v) => !v)}
          class="flex min-w-0 flex-1 items-center gap-1.5 text-left text-text hover:text-accent"
        >
          <ChevronRight
            class="h-3 w-3 shrink-0 text-text-tertiary transition-transform"
            classList={{ "rotate-90": open() }}
          />
          <Dynamic component={icon()} class="h-3 w-3 shrink-0 text-text-tertiary" />
          <span class="truncate">{props.item.label}</span>
          <span class="shrink-0 rounded-sm bg-surface-hover px-1 text-[10px] uppercase tracking-wide text-text-tertiary">
            {props.item.kind === "source_link"
              ? KIND_LABEL.source_link
              : props.item.fromDiscussion
                ? i18n.t("projects.kind.discussion")
                : i18n.t(KIND_LABEL[props.item.kind])}
          </span>
        </button>
        <button
          type="button"
          data-testid="linked-document.open"
          title={i18n.t("kernel.common.open")}
          aria-label={i18n.t("kernel.common.open")}
          onClick={openItem}
          class="shrink-0 rounded-sm p-0.5 text-text-tertiary hover:text-text"
        >
          <ExternalLink class="h-3 w-3" />
        </button>
        <Show when={props.item.removable && !props.compact && !confirmingRemove()}>
          <button
            type="button"
            data-testid="linked-document.remove"
            title={i18n.t("projects.removeAttachment")}
            aria-label={i18n.t("projects.removeAttachment")}
            onClick={() => setConfirmingRemove(true)}
            class="shrink-0 rounded-sm p-0.5 text-text-tertiary hover:text-danger"
          >
            <Trash2 class="h-3 w-3" />
          </button>
        </Show>
      </div>
      <Show when={confirmingRemove()}>
        <div
          data-testid="linked-document.remove-confirm-row"
          class="flex items-center gap-2 border-t border-border-subtle px-2 py-1 text-[12px]"
        >
          <span class="flex-1 text-text-secondary">
            {i18n.t("projects.removeAttachmentConfirm")}
          </span>
          <button
            type="button"
            data-testid="linked-document.remove-confirm"
            disabled={removing()}
            onClick={() => void remove()}
            class="rounded-sm border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-danger disabled:opacity-50"
          >
            {i18n.t("projects.removeAttachment")}
          </button>
          <button
            type="button"
            data-testid="linked-document.remove-cancel"
            disabled={removing()}
            onClick={() => setConfirmingRemove(false)}
            class="rounded-sm px-1.5 py-0.5 text-text-tertiary hover:text-text-secondary disabled:opacity-50"
          >
            {i18n.t("kernel.common.cancel")}
          </button>
        </div>
      </Show>
      <Show when={open()}>
        <div
          data-testid="linked-document.body"
          class="max-h-72 overflow-auto border-t border-border-subtle px-2 py-1.5"
        >
          <LinkedDocumentBody item={props.item} api={props.api} />
        </div>
      </Show>
    </div>
  )
}

interface DocumentView {
  title?: string
  summary?: string | null
  body?: string | null
}

interface SourceLinkView {
  title?: string
  source?: string
  url?: string | null
  summary?: string | null
  mimeType?: string | null
  visibilityStatus?: string | null
}

interface FileMetadata {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

type LoadedPreview =
  | { kind: "document"; doc: DocumentView }
  | { kind: "source_link"; link: SourceLinkView }
  | { kind: "image"; file: AttachmentFile }
  | { kind: "text"; file: AttachmentFile; text: string; truncated: boolean }
  | { kind: "binary"; file: AttachmentFile }

async function loadPreview(api: ApiClient, item: LinkedItem): Promise<LoadedPreview> {
  if (item.kind === "document") {
    const doc = await api.get<DocumentView>(`/knowledge/documents/${item.entityId}`)
    return { kind: "document", doc: doc ?? {} }
  }
  if (item.kind === "source_link") {
    const link = await api.get<SourceLinkView>(`/knowledge/source-links/${item.entityId}`)
    return { kind: "source_link", link: link ?? {} }
  }
  let file: AttachmentFile | undefined = item.file
  if (!file) {
    const meta = await api.get<FileMetadata>(`/files/${item.entityId}/metadata`)
    file = {
      id: meta.id,
      filename: meta.filename,
      mimeType: meta.mimeType,
      sizeBytes: meta.sizeBytes,
    }
  }
  if (fileIsImage(file.mimeType)) return { kind: "image", file }
  if (fileIsText(file.filename, file.mimeType)) {
    const url = await fetchInlineObjectUrl(api, file.id)
    try {
      const text = await (await fetch(url)).text()
      return {
        kind: "text",
        file,
        text: text.slice(0, MAX_TEXT_PREVIEW_CHARS),
        truncated: text.length > MAX_TEXT_PREVIEW_CHARS,
      }
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  return { kind: "binary", file }
}

const LinkedDocumentBody: Component<{ item: LinkedItem; api: ApiClient }> = (props) => {
  const i18n = useI18n()
  const [preview] = createResource(
    () => props.item,
    (item) => loadPreview(props.api, item),
  )
  return (
    <Show
      when={!preview.error}
      fallback={
        <p data-testid="linked-document.error" class="text-[11.5px] text-warning">
          {String((preview.error as Error)?.message ?? "Could not load this document.")}
        </p>
      }
    >
      <Show
        when={preview()}
        fallback={
          <p class="text-[11.5px] text-text-tertiary">{i18n.t("kernel.common.loading2")}</p>
        }
      >
        {(p) => renderPreview(p(), i18n.t)}
      </Show>
    </Show>
  )
}

function renderPreview(
  p: LoadedPreview,
  t: (key: string, params?: Record<string, string>) => string,
): JSX.Element {
  switch (p.kind) {
    case "document":
      return (
        <div
          data-testid="linked-document.markdown"
          class="prose-thread text-[12.5px]"
          innerHTML={renderMarkdown(p.doc.body || p.doc.summary || "")}
        />
      )
    case "source_link": {
      const href = isSafeUserUrl(p.link.url)
      return (
        <div class="flex flex-col gap-1">
          <Show when={p.link.summary}>
            <p class="text-[12px] text-text-secondary">{p.link.summary}</p>
          </Show>
          <p class="text-[11px] text-text-tertiary">
            {p.link.source ?? "remote"}
            <Show when={p.link.mimeType}> · {p.link.mimeType}</Show>
            <Show when={p.link.visibilityStatus && p.link.visibilityStatus !== "visible"}>
              {" "}
              · {p.link.visibilityStatus}
            </Show>
          </p>
          <Show when={href}>
            <a
              data-testid="linked-document.external"
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              class="text-[12px] text-accent hover:underline"
            >
              {t("projects.openInSource", {
                source: p.link.source ?? t("projects.sourceFallback"),
              })}
            </a>
          </Show>
        </div>
      )
    }
    case "image":
      return <AttachmentCard file={p.file} />
    case "text":
      return (
        <div class="flex flex-col gap-1">
          <pre
            data-testid="linked-document.text"
            class="overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-snug text-text-secondary"
          >
            {p.text}
          </pre>
          <p class="text-[10.5px] text-text-tertiary">
            {formatBytes(p.file.sizeBytes)}
            <Show when={p.truncated}> · {t("projects.previewTruncated")}</Show>
          </p>
        </div>
      )
    default:
      return <AttachmentCard file={p.file} />
  }
}
