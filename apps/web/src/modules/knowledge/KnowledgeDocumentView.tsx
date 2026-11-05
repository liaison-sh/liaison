// SPDX-License-Identifier: FSL-1.1-ALv2

import {
  Archive,
  ArchiveRestore,
  ArrowLeftRight,
  CheckCircle,
  MoreHorizontal,
  Pencil,
  Share2,
} from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { appLabel } from "~/lib/app-label"
import { relativeTime } from "~/lib/relative-time"
import { rovingFocus } from "~/lib/roving-focus"
import { ComposerAssist } from "~/modules/assist/ComposerAssist"
import { DictationMic, RecorderRow } from "~/modules/assist/RecorderBar"
import { useDictation } from "~/modules/assist/useDictation"
import { hasScope } from "~/modules/auth/auth-store"
import { RichEditor, type RichEditorHandle } from "~/modules/editor"
import FileList from "~/modules/files/FileList"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { evictTabByEntity } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"
import { FloatingPanel } from "~/ui/FloatingPanel"
import { OverlaySheet } from "~/ui/OverlaySheet"
import { ScrollFade } from "~/ui/ScrollFade"

import { renderMarkdown } from "./markdown"

function formatRelative(iso: string | null, locale: string, never: string): string {
  return relativeTime(iso, locale) || never
}

import { useApi } from "~/modules/shell/ApiContext"
import KnowledgeShareDialog from "./KnowledgeShareDialog"
import {
  archiveKnowledgeDocument,
  getKnowledgeDocument,
  getKnowledgeDocumentBacklinks,
  type KnowledgeBacklink,
  restoreKnowledgeDocument,
  runSyncedSourceNow,
  updateKnowledgeDocument,
  verifyKnowledgeDocument,
} from "./knowledge-api"
import { getPulseUpdated, isSyncedSourceArchived, loadDocuments } from "./knowledge-store"

interface KnowledgeDocumentFetched {
  id: string
  title: string
  body: string
  revision: number
  reviewStatus?: string
  documentScope?: "personal" | "organization"
  ownerUserId?: string | null
  sensitivity?: string
  team?: string[]
  status?: string
  syncedSourceId?: string | null
  externalRev?: string | null
  lastSyncedAt?: string | null
  syncedSourceName?: string | null
  syncedSourceApp?: string | null
  /** The server's own write check (service.ts canEditDocumentRow): the Edit control shows from it. */
  canEdit?: boolean
}

/** What the server asks of a viewer to list or download a document's files. */
const ATTACHMENTS_SCOPE = "knowledge:attachments:download"

const KnowledgeDocumentView: Component<{ entityId: string }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const apiForSidebar = useApi()

  let docController: AbortController | null = null
  let backlinksController: AbortController | null = null
  onCleanup(() => {
    docController?.abort()
    backlinksController?.abort()
  })
  const [doc, { refetch }] = createResource(
    () => props.entityId,
    async (id: string | null): Promise<KnowledgeDocumentFetched | null | "not-found"> => {
      if (!id || !api) return null
      docController?.abort()
      const ac = new AbortController()
      docController = ac
      try {
        return (await getKnowledgeDocument(api, id, {
          signal: ac.signal,
        })) as KnowledgeDocumentFetched
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err
        if (err instanceof ApiError && err.status === 404) return "not-found"
        throw err
      }
    },
  )

  // The text being edited (null while reading), and the text a save is
  // carrying: shown at once, as saved, until the server has answered.
  const [draft, setDraft] = createSignal<string | null>(null)
  const [pending, setPending] = createSignal<string | null>(null)
  const editing = () => draft() !== null
  let bodyEditor: RichEditorHandle | undefined
  const bodyDictation = useDictation({ target: () => bodyEditor })
  const storedBody = () => {
    const d = doc()
    return d && d !== "not-found" ? (d.body ?? "") : ""
  }
  const renderedBody = createMemo(() => renderMarkdown(pending() ?? storedBody()))
  const [conflict, setConflict] = createSignal(false)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const [backlinks, setBacklinks] = createSignal<KnowledgeBacklink[]>([])
  const [_backlinksLoading, setBacklinksLoading] = createSignal(false)
  const [menuOpen, setMenuOpen] = createSignal(false)
  const [backlinksOpen, setBacklinksOpen] = createSignal(false)
  const [shareOpen, setShareOpen] = createSignal(false)
  const [sourcesOpen, setSourcesOpen] = createSignal(false)
  const phone = () => shellTier() === "phone"

  let titleEl: HTMLHeadingElement | undefined

  // Zero-knowledge denial / deleted doc: the fetch resolved "not-found", so
  // this tab points at an entity the user cannot see. Evict it silently —
  // manifest-app tab types have no validateEntity hook, so the tab would
  // otherwise dangle (T23: no knowledge:document tab may survive a 404).
  createEffect(() => {
    if (doc() === "not-found") {
      evictTabByEntity("knowledge:document", props.entityId)
    }
  })

  createEffect(() => {
    const d = doc()
    if (d && d !== "not-found" && titleEl && titleEl.textContent !== d.title) {
      titleEl.textContent = d.title
    }
  })

  createEffect(() => {
    const id = props.entityId
    if (!id || !api) return
    backlinksController?.abort()
    const ac = new AbortController()
    backlinksController = ac
    setBacklinksLoading(true)
    void getKnowledgeDocumentBacklinks(api, id, { signal: ac.signal })
      .then((result) => {
        if (ac.signal.aborted) return
        setBacklinks(result.backlinks ?? [])
      })
      .catch((err) => {
        if (err instanceof DOMException && err.name === "AbortError") return
        setBacklinks([])
      })
      .finally(() => {
        if (!ac.signal.aborted) setBacklinksLoading(false)
      })
  })

  const startEditing = () => {
    setConflict(false)
    setActionError(null)
    setDraft(storedBody())
  }

  const cancelEditing = () => {
    setDraft(null)
    setConflict(false)
  }

  // Saved against the revision it was opened at: if someone saved in between,
  // the server refuses (409) and the edit stays in the editor, never written
  // over theirs.
  const save = async () => {
    const d = doc()
    const next = draft()
    if (!d || d === "not-found" || !api || next === null) return
    // The editor hands back the stored text untouched while nothing was edited.
    if (next === (d.body ?? "")) {
      setDraft(null)
      return
    }
    setActionError(null)
    setPending(next)
    setDraft(null)
    try {
      await updateKnowledgeDocument(api, d.id, { body: next, revision: d.revision })
      await refetch()
      void loadDocuments(apiForSidebar)
    } catch (err) {
      setDraft(next)
      if (err instanceof ApiError && err.status === 409) setConflict(true)
      else setActionError(err instanceof Error ? err.message : i18n.t("knowledge.saveFailed"))
    } finally {
      setPending(null)
    }
  }

  /** After a refused save: drop this edit and read what was saved meanwhile. */
  const loadLatest = async () => {
    setDraft(null)
    setConflict(false)
    await refetch()
  }

  const archive = async () => {
    const d = doc()
    if (!d || d === "not-found" || !api) return
    setActionError(null)
    try {
      await archiveKnowledgeDocument(api, d.id)
      void refetch()
      void loadDocuments(apiForSidebar)
      setMenuOpen(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : i18n.t("knowledge.archiveFailed"))
    }
  }

  const restore = async () => {
    const d = doc()
    if (!d || d === "not-found" || !api) return
    setActionError(null)
    try {
      await restoreKnowledgeDocument(api, d.id)
      void refetch()
      void loadDocuments(apiForSidebar)
      setMenuOpen(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : i18n.t("knowledge.restoreFailed"))
    }
  }

  const verify = async () => {
    const d = doc()
    if (!d || d === "not-found" || !api) return
    setActionError(null)
    try {
      await verifyKnowledgeDocument(api, d.id, { revision: d.revision })
      void refetch()
      setMenuOpen(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : i18n.t("knowledge.verifyFailed"))
    }
  }

  const handleTitleBlur = async () => {
    const d = doc()
    if (!d || d === "not-found" || !api || !d.canEdit) return
    const newTitle = titleEl?.textContent ?? ""
    if (!newTitle.trim() || newTitle === d.title) return
    try {
      await updateKnowledgeDocument(api, d.id, { title: newTitle, revision: d.revision })
      void refetch()
      void loadDocuments(apiForSidebar)
    } catch (err) {
      console.error("Failed to update title:", err)
      if (titleEl) titleEl.textContent = d.title
    }
  }

  const handleTitleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      titleEl?.blur()
    } else if (e.key === "Escape") {
      e.preventDefault()
      const d = doc()
      if (d && d !== "not-found" && titleEl) titleEl.textContent = d.title
      titleEl?.blur()
    }
  }

  return (
    <Show
      when={doc() !== "not-found"}
      fallback={
        <div
          data-testid="knowledge-doc-not-found"
          class="flex h-full items-center justify-center p-4"
        >
          <p class="text-sm text-text-secondary">{i18n.t("knowledge.knowledgeItemNotFound")}</p>
        </div>
      }
    >
      <Show when={doc() && doc() !== "not-found" ? (doc() as KnowledgeDocumentFetched) : null}>
        {(d) => {
          const document = d()
          return (
            <div
              data-testid="knowledge-document-view"
              data-document-id={document.id}
              // A guided tour points at a seeded document by its title.
              data-doc-title={document.title}
              class="flex h-full flex-col"
            >
              {/* Header — ThreadHeader pattern */}
              <div
                data-testid="knowledge-doc-header"
                class="flex shrink-0 items-center justify-between border-b border-border-subtle px-4 py-2.5"
              >
                {/* Left: inline-editable title + badges */}
                <div class="flex min-w-0 flex-col gap-0.5">
                  <h1
                    ref={titleEl}
                    data-testid="knowledge-doc-title"
                    contenteditable={document.canEdit ? "true" : "false"}
                    class="truncate text-[15px] font-semibold text-text outline-none
                           focus:ring-1 focus:ring-accent/20 focus:rounded-sm"
                    onBlur={handleTitleBlur}
                    onKeyDown={handleTitleKeyDown}
                  >
                    {document.title}
                  </h1>
                  <div class="flex gap-1.5">
                    <Show when={document.reviewStatus && document.documentScope !== "personal"}>
                      <span
                        data-testid="knowledge-doc-review-status"
                        class="rounded bg-surface-hover px-1.5 text-[11px] text-text-secondary"
                      >
                        {document.reviewStatus}
                      </span>
                    </Show>
                    <Show when={document.sensitivity ?? document.documentScope}>
                      {(label) => (
                        <span
                          data-testid="knowledge-doc-scope-badge"
                          class="rounded bg-surface-hover px-1.5 text-[11px] text-text-secondary"
                        >
                          {label()}
                        </span>
                      )}
                    </Show>
                    <Show when={document.status === "archived"}>
                      <span
                        data-testid="knowledge-doc-archived-badge"
                        class="rounded bg-surface-hover px-1.5 text-[11px] text-warning"
                      >
                        {i18n.t("knowledge.archived")}
                      </span>
                    </Show>
                  </div>
                </div>

                {/* Right: while editing, Cancel and Save; otherwise backlinks,
                    Edit (for whoever may), share and the actions menu. */}
                <Show when={editing()}>
                  <div class="flex shrink-0 items-center gap-1.5">
                    <RecorderRow dictation={bodyDictation} barClass="w-[18rem] max-w-[60vw]">
                      <ComposerAssist target={() => bodyEditor} />
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid="knowledge-doc-cancel-edit"
                        onClick={cancelEditing}
                      >
                        {i18n.t("kernel.common.cancel")}
                      </Button>
                      {/* The mic immediately left of Save, the row's primary action. */}
                      <DictationMic dictation={bodyDictation} />
                      <Button
                        size="sm"
                        data-testid="knowledge-doc-save"
                        disabled={conflict()}
                        onClick={() => void save()}
                      >
                        {i18n.t("knowledge.save")}
                      </Button>
                    </RecorderRow>
                  </div>
                </Show>
                <div class="flex items-center gap-1" classList={{ hidden: editing() }}>
                  {/* Visible backlink count — first-class, not buried in MoreHorizontal */}
                  <Show when={backlinks().length > 0}>
                    <FloatingPanel open={backlinksOpen()} onOpenChange={setBacklinksOpen}>
                      <FloatingPanel.Trigger
                        class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]
                               text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                      >
                        <ArrowLeftRight size={12} />
                        {backlinks().length} {backlinks().length === 1 ? "reference" : "references"}
                      </FloatingPanel.Trigger>
                      <FloatingPanel.Content class="w-64 py-2">
                        <div class="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                          {i18n.t("knowledge.referencedBy")}
                        </div>
                        <For each={backlinks()}>
                          {(link) => (
                            <button
                              type="button"
                              class="flex w-full items-center gap-2 px-3 py-1.5 text-left
                                     hover:bg-surface-hover"
                            >
                              <span class="text-[11px] text-text-tertiary">
                                {link.app}:{link.entityType}
                              </span>
                              <span class="truncate text-[13px] text-text">{link.title}</span>
                            </button>
                          )}
                        </For>
                      </FloatingPanel.Content>
                    </FloatingPanel>
                  </Show>

                  <Show when={pending() !== null}>
                    <span
                      data-testid="knowledge-doc-saving"
                      class="px-1 text-[11px] text-text-tertiary"
                    >
                      {i18n.t("knowledge.saving")}
                    </span>
                  </Show>
                  <Show when={document.canEdit}>
                    <button
                      type="button"
                      data-testid="knowledge-doc-edit"
                      aria-label={i18n.t("kernel.common.edit")}
                      disabled={pending() !== null}
                      onClick={startEditing}
                      class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px]
                             text-text-tertiary hover:bg-surface-hover hover:text-text-secondary disabled:opacity-50"
                    >
                      <Pencil size={13} />
                      <Show when={!phone()}>{i18n.t("kernel.common.edit")}</Show>
                    </button>
                  </Show>

                  {/* Share */}
                  <button
                    type="button"
                    data-testid="knowledge-share-button"
                    aria-label={i18n.t("knowledge.share")}
                    onClick={() => setShareOpen(true)}
                    class="flex h-7 w-7 items-center justify-center rounded-md
                           text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                  >
                    <Share2 size={14} />
                  </button>

                  {/* Actions menu */}
                  <FloatingPanel open={menuOpen()} onOpenChange={setMenuOpen}>
                    <FloatingPanel.Trigger
                      class="flex h-7 w-7 items-center justify-center rounded-md
                             text-text-tertiary hover:bg-surface-hover hover:text-text-secondary"
                    >
                      <MoreHorizontal size={16} />
                    </FloatingPanel.Trigger>
                    <FloatingPanel.Content class="w-48" onKeyDown={rovingFocus}>
                      <button
                        type="button"
                        data-roving
                        class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                        onClick={() => void verify()}
                      >
                        <CheckCircle size={14} />
                        {i18n.t("knowledge.verify")}
                      </button>

                      <div class="my-1 h-px bg-border-subtle" />

                      <Show
                        when={document.status === "archived"}
                        fallback={
                          <button
                            type="button"
                            data-roving
                            class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                            onClick={() => void archive()}
                          >
                            <Archive size={14} />
                            {i18n.t("kernel.common.archive")}
                          </button>
                        }
                      >
                        <button
                          type="button"
                          data-roving
                          class="flex w-full items-center gap-2.5 px-3 py-1.5 text-[13px] text-text-secondary outline-none transition-colors hover:bg-surface-hover hover:text-text focus-visible:bg-surface-hover focus-visible:text-text"
                          onClick={() => void restore()}
                        >
                          <ArchiveRestore size={14} />
                          {i18n.t("kernel.common.restore")}
                        </button>
                      </Show>
                    </FloatingPanel.Content>
                  </FloatingPanel>
                </div>
              </div>

              {/* Notices about the edit sit above the scrolling text: Save is
                  often pressed far down a document, where a notice at the top
                  of the text was out of sight. */}
              <Show when={conflict() || actionError()}>
                <div
                  class={`flex shrink-0 flex-col gap-2 pt-3 ${phone() ? "px-4" : "mx-auto w-full max-w-2xl px-8"}`}
                >
                  {/* A save refused because someone saved first: the edit is
                      kept below, and loading theirs is the reader's choice. */}
                  <Show when={conflict()}>
                    <div
                      data-testid="knowledge-doc-conflict-banner"
                      role="alert"
                      class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-text"
                    >
                      <span class="min-w-0 flex-1 basis-60">
                        {i18n.t("knowledge.thisDocumentWasUpdatedBySomeone")}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        data-testid="knowledge-doc-load-latest"
                        onClick={() => void loadLatest()}
                      >
                        {i18n.t("knowledge.loadLatestVersion")}
                      </Button>
                    </div>
                  </Show>
                  <Show when={actionError()}>
                    <p data-testid="knowledge-doc-error" role="alert" class="text-xs text-danger">
                      {actionError()}
                    </p>
                  </Show>
                </div>
              </Show>

              {/* Scrollable body */}
              <ScrollFade class="min-h-0 flex-1" fadeColor="var(--color-surface)">
                <div
                  data-testid="knowledge-doc-body"
                  class={phone() ? "w-full px-4 py-4" : "mx-auto w-full max-w-2xl px-8 py-8"}
                >
                  {/* T-9: synced read-only banner. I4: switches to
                      "Source removed" + disabled Refresh when the upstream
                      source has been archived (e.g. someone hit Remove in
                      Settings while this tab is still open). */}
                  <Show when={document.syncedSourceId}>
                    {(() => {
                      const sourceArchived = () =>
                        document.syncedSourceId
                          ? isSyncedSourceArchived(document.syncedSourceId)
                          : false
                      return (
                        <div
                          data-testid="knowledge-doc-synced-banner"
                          data-source-archived={sourceArchived() ? "true" : undefined}
                          class="mb-3 flex items-center gap-2 border-b border-border-subtle pb-2 text-[12px] text-text-tertiary"
                        >
                          <span aria-hidden class="opacity-70">
                            ☁
                          </span>
                          <Show
                            when={!sourceArchived()}
                            fallback={
                              <span data-testid="knowledge-doc-source-removed">
                                {i18n.t("knowledge.sourceRemovedThisDocumentIsNo")}
                              </span>
                            }
                          >
                            <span>
                              {i18n.t("knowledge.syncedFrom")}{" "}
                              {document.syncedSourceApp
                                ? appLabel(document.syncedSourceApp, i18n.t)
                                : i18n.t("knowledge.externalSource")}
                              <Show when={document.syncedSourceName}>
                                {(name) => <> · {name()}</>}
                              </Show>
                              <Show when={document.lastSyncedAt}>
                                {i18n.t("knowledge.lastRefreshed")}
                                {formatRelative(
                                  document.lastSyncedAt ?? null,
                                  i18n.locale(),
                                  i18n.t("knowledge.neverSynced"),
                                )}
                              </Show>
                            </span>
                          </Show>
                          <button
                            type="button"
                            data-testid="knowledge-doc-synced-refresh"
                            disabled={sourceArchived()}
                            onClick={async () => {
                              if (!api || !document.syncedSourceId) return
                              if (sourceArchived()) return
                              try {
                                await runSyncedSourceNow(api, document.syncedSourceId)
                              } catch {
                                // surface via existing actionError pathway
                                setActionError(i18n.t("knowledge.refreshFailed"))
                              }
                            }}
                            class="ml-auto rounded px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                          >
                            {i18n.t("kernel.common.refresh")}
                          </button>
                          <Show when={getPulseUpdated(document.id)}>
                            <span
                              data-testid="knowledge-doc-refreshed-pill"
                              class="ml-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
                            >
                              {i18n.t("knowledge.refreshedJustNow")}
                            </span>
                          </Show>
                        </div>
                      )
                    })()}
                  </Show>

                  <Show
                    when={editing()}
                    fallback={
                      <div
                        data-testid="knowledge-doc-body-rendered"
                        data-saving={pending() !== null ? "true" : undefined}
                        class="prose-thread min-h-[20rem] text-[13px] leading-relaxed text-text"
                        // Sanitized by renderMarkdown (DOMPurify) before injection.
                        innerHTML={renderedBody()}
                      />
                    }
                  >
                    {/* No autofocus: the caret at the end would scroll a long
                        document away from where it was being read. */}
                    <RichEditor
                      preset="document"
                      ref={(handle) => {
                        bodyEditor = handle
                      }}
                      value={draft() ?? ""}
                      onChange={setDraft}
                      onSubmit={() => void save()}
                      aria-label={document.title}
                      data-testid="knowledge-doc-body-editor"
                      editorClass="min-h-[20rem] text-[13px] leading-relaxed"
                    />
                  </Show>

                  {/* Attachments. At phone width the reading column IS the
                      screen, so this side panel becomes a Sources sheet
                      reached from one control rather than a second column of
                      rows under the text. A viewer the server would refuse
                      them to is not shown the section at all. */}
                  <Show when={hasScope(ATTACHMENTS_SCOPE)}>
                    <Show
                      when={phone()}
                      fallback={
                        <section
                          data-testid="knowledge-attachment-list"
                          class="mt-8 border-t border-border-subtle pt-6"
                        >
                          <h3 class="mb-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                            {i18n.t("knowledge.attachments")}
                          </h3>
                          <Show when={api}>
                            <FileList
                              parent={{
                                app: "knowledge",
                                entityType: "document",
                                entityId: document.id,
                              }}
                            />
                          </Show>
                        </section>
                      }
                    >
                      <div class="mt-8 border-t border-border-subtle pt-4">
                        <button
                          type="button"
                          data-testid="knowledge-doc-sources-open"
                          onClick={() => setSourcesOpen(true)}
                          class="flex min-h-11 w-full items-center justify-between rounded-md border border-border px-3 text-[15px] text-text hover:bg-surface-hover"
                        >
                          {i18n.t("kernel.knowledgeSources")}
                        </button>
                      </div>
                      <OverlaySheet
                        open={sourcesOpen()}
                        onClose={() => setSourcesOpen(false)}
                        variant="bottom"
                        title={i18n.t("kernel.knowledgeSources")}
                      >
                        <section data-testid="knowledge-attachment-list" class="px-4 py-3">
                          <Show when={api}>
                            <FileList
                              parent={{
                                app: "knowledge",
                                entityType: "document",
                                entityId: document.id,
                              }}
                            />
                          </Show>
                        </section>
                      </OverlaySheet>
                    </Show>
                  </Show>
                </div>
              </ScrollFade>

              <KnowledgeShareDialog
                documentId={document.id}
                documentTitle={document.title}
                open={shareOpen()}
                onOpenChange={setShareOpen}
              />
            </div>
          )
        }}
      </Show>
    </Show>
  )
}

export default KnowledgeDocumentView
