// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The text of a Knowledge page: for whoever may edit it, the page editor, always
// mounted (no Edit, no Save); for a reader, the rendered text (checklists do not
// tick). A synced page says where it comes from. Files sit under the text, or in a
// Sources sheet on a phone.

import { type Component, createSignal, lazy, Show, Suspense } from "solid-js"
import { appLabel } from "~/lib/app-label"
import { relativeTime } from "~/lib/relative-time"
import { hasScope } from "~/modules/auth/auth-store"
import type { RichEditorHandle } from "~/modules/editor"
import FileList from "~/modules/files/FileList"
import { useI18n } from "~/modules/i18n/i18n-context"
import { OverlaySheet } from "~/ui/OverlaySheet"
import { ScrollFade } from "~/ui/ScrollFade"
import { getPulseUpdated, isSyncedSourceArchived } from "./knowledge-store"
import { renderMarkdown } from "./markdown"

// The editor is its own chunk; while it loads the page shows its rendered text.
const PageTextEditor = lazy(() => import("~/modules/editor/PageTextEditor"))

/** What the server asks of a viewer to list or download a document's files. */
const ATTACHMENTS_SCOPE = "knowledge:attachments:download"

export interface PageBodyDoc {
  id: string
  title: string
  body: string
  syncedSourceId?: string | null
  syncedSourceName?: string | null
  syncedSourceApp?: string | null
  lastSyncedAt?: string | null
}

export interface PageBodyProps {
  doc: PageBodyDoc
  /** The text the editor opens with (the stored text, or a draft put back); null: read only. */
  editorText: string | null
  phone: boolean
  hasApi: boolean
  editorRef: (handle: RichEditorHandle) => void
  onEdit: () => void
  onRefreshSynced: () => void
}

export const PageBody: Component<PageBodyProps> = (props) => {
  const i18n = useI18n()
  const [sourcesOpen, setSourcesOpen] = createSignal(false)
  const readOnly = () => (
    <div
      data-testid="knowledge-doc-body-rendered"
      class="prose-thread min-h-[20rem] text-[13px] leading-relaxed text-text"
      // Sanitized by renderMarkdown (DOMPurify) before injection.
      innerHTML={renderMarkdown(props.doc.body ?? "")}
    />
  )

  return (
    <ScrollFade class="min-h-0 flex-1" fadeColor="var(--color-surface)">
      <div
        data-testid="knowledge-doc-body"
        class={props.phone ? "w-full px-4 py-4" : "mx-auto w-full max-w-2xl px-8 py-8"}
      >
        <Show when={props.doc.syncedSourceId}>
          {(sourceId) => {
            const sourceArchived = () => isSyncedSourceArchived(sourceId())
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
                    {props.doc.syncedSourceApp
                      ? appLabel(props.doc.syncedSourceApp, i18n.t)
                      : i18n.t("knowledge.externalSource")}
                    <Show when={props.doc.syncedSourceName}>{(name) => <> · {name()}</>}</Show>
                    <Show when={props.doc.lastSyncedAt}>
                      {i18n.t("knowledge.lastRefreshed")}
                      {relativeTime(props.doc.lastSyncedAt ?? null, i18n.locale()) ||
                        i18n.t("knowledge.neverSynced")}
                    </Show>
                  </span>
                </Show>
                <button
                  type="button"
                  data-testid="knowledge-doc-synced-refresh"
                  disabled={sourceArchived()}
                  onClick={() => {
                    if (!sourceArchived()) props.onRefreshSynced()
                  }}
                  class="ml-auto rounded px-2 py-0.5 text-[11px] text-text-secondary hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  {i18n.t("kernel.common.refresh")}
                </button>
                <Show when={getPulseUpdated(props.doc.id)}>
                  <span
                    data-testid="knowledge-doc-refreshed-pill"
                    class="ml-1 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
                  >
                    {i18n.t("knowledge.refreshedJustNow")}
                  </span>
                </Show>
              </div>
            )
          }}
        </Show>

        <Show when={props.editorText !== null} fallback={readOnly()}>
          {/* No autofocus: the caret at the end would scroll a long page away from
              where it was being read. */}
          <Suspense fallback={readOnly()}>
            <PageTextEditor
              ref={props.editorRef}
              value={props.editorText ?? ""}
              onEdit={props.onEdit}
              aria-label={props.doc.title}
              data-testid="knowledge-doc-body-editor"
              editorClass="min-h-[20rem] text-[13px] leading-relaxed"
            />
          </Suspense>
        </Show>

        <Show when={hasScope(ATTACHMENTS_SCOPE)}>
          <Show
            when={props.phone}
            fallback={
              <section
                data-testid="knowledge-attachment-list"
                class="mt-8 border-t border-border-subtle pt-6"
              >
                <h3 class="mb-3 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                  {i18n.t("knowledge.attachments")}
                </h3>
                <Show when={props.hasApi}>
                  <FileList
                    parent={{ app: "knowledge", entityType: "document", entityId: props.doc.id }}
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
                <Show when={props.hasApi}>
                  <FileList
                    parent={{ app: "knowledge", entityType: "document", entityId: props.doc.id }}
                  />
                </Show>
              </section>
            </OverlaySheet>
          </Show>
        </Show>
      </div>
    </ScrollFade>
  )
}

export default PageBody
