// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A folder opened as a page (S20): its own text, then what is directly inside that
// the reader may open. Everything listed comes from the server's answer for this
// reader (GET /knowledge/collections/:id/page): nothing is named from elsewhere,
// so a page or folder the reader cannot open is never shown, not even by name.
//
// The folder has no page until someone writes in it: the first keystroke asks the
// server to make it (once, however fast the next keys come), and the page then opens
// on the text typed so far and saves the rest like any page. A synced folder has no
// page of its own, and someone who may not start one sees the list alone.
import { FileText, Folder } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  lazy,
  on,
  Show,
  Suspense,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import type { RichEditorHandle } from "~/modules/editor"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { ScrollFade } from "~/ui/ScrollFade"
import KnowledgeDocumentView, { type KnowledgeDocumentFetched } from "./KnowledgeDocumentView"
import {
  type CollectionTreeNode,
  createKnowledgeDocument,
  getKnowledgeFolderPage,
  type KnowledgeFolderPage,
  startKnowledgeFolderPage,
} from "./knowledge-api"
import { knowledgeStore, loadCollectionsTree } from "./knowledge-store"

const PageTextEditor = lazy(() => import("~/modules/editor/PageTextEditor"))

/** The folders above `id` in the tree the reader sees, top first. */
function ancestorsOf(tree: CollectionTreeNode[], id: string): CollectionTreeNode[] {
  const walk = (
    nodes: CollectionTreeNode[],
    path: CollectionTreeNode[],
  ): CollectionTreeNode[] | null => {
    for (const node of nodes) {
      if (node.id === id) return path
      const found = walk(node.children, node.virtual ? path : [...path, node])
      if (found) return found
    }
    return null
  }
  return walk(tree, []) ?? []
}

export const openFolder = (id: string, name: string) =>
  openTab({ type: "knowledge:folder", entityId: id, label: name })

const KnowledgeFolderView: Component<{ entityId: string }> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const phone = () => shellTier() === "phone"

  const [view, { refetch, mutate }] = createResource(
    () => props.entityId,
    async (id): Promise<KnowledgeFolderPage | "not-found" | null> => {
      if (!api) return null
      try {
        return await getKnowledgeFolderPage(api, id)
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return "not-found"
        throw err
      }
    },
  )
  const data = () => {
    const v = view.latest
    return v && v !== "not-found" ? v : null
  }
  // What is inside changes as the tree does (a page made, moved, a folder renamed).
  createEffect(
    on(
      () => knowledgeStore.collectionsTree,
      () => void refetch(),
      { defer: true },
    ),
  )

  /** The page made a moment ago from text typed here (opens on it, no reload). */
  const [fresh, setFresh] = createSignal<{ row: KnowledgeDocumentFetched; text: string } | null>(
    null,
  )
  const [startError, setStartError] = createSignal(false)
  let starting = false
  let startEditor: RichEditorHandle | undefined

  /** The first keystroke makes the folder's page; later keys wait for it. */
  const startPage = async () => {
    const v = data()
    if (starting || !api || !v) return
    starting = true
    setStartError(false)
    try {
      const row = await startKnowledgeFolderPage(api, v.folder.id, startEditor?.markdown() ?? "")
      const text = startEditor?.markdown() ?? row.body
      setFresh({ row: row as KnowledgeDocumentFetched, text })
      mutate({ ...v, page: { ...row, canEdit: true }, canStartPage: false })
      void loadCollectionsTree(api)
    } catch {
      setStartError(true)
    } finally {
      starting = false
    }
  }

  const newPage = async () => {
    const v = data()
    if (!api || !v) return
    try {
      const doc = (await createKnowledgeDocument(api, {
        title: i18n.t("knowledge.untitled"),
        documentScope: "organization",
        // A page of a personal folder is yours alone, like the folder.
        ...(v.folder.ownerUserId ? { orgAccess: "none" } : {}),
        collectionIds: [v.folder.id],
      })) as { id: string; title?: string }
      await loadCollectionsTree(api)
      openTab({
        type: "knowledge:document",
        entityId: doc.id,
        label: doc.title ?? i18n.t("knowledge.untitled"),
        preview: false,
      })
    } catch {
      addToast({ type: "error", message: i18n.t("knowledge.folderPage.newPageFailed") })
    }
  }

  const path = () => ancestorsOf(knowledgeStore.collectionsTree, props.entityId)
  const pad = () => (phone() ? "w-full px-4" : "mx-auto w-full max-w-2xl px-8")

  const breadcrumb = () => (
    <Show when={path().length > 0}>
      <nav
        data-testid="knowledge-folder-breadcrumb"
        aria-label={i18n.t("knowledge.folderPage.path")}
        class={`flex shrink-0 flex-wrap items-center gap-1 pt-2 text-[12px] text-text-tertiary ${pad()}`}
      >
        <For each={path()}>
          {(node, i) => (
            <>
              <Show when={i() > 0}>
                <span aria-hidden="true">/</span>
              </Show>
              <button
                type="button"
                data-testid={`knowledge-folder-crumb-${node.id}`}
                class="min-h-6 truncate rounded px-1 hover:bg-surface-hover hover:text-text-secondary [@media(pointer:coarse)]:min-h-11"
                onClick={() => openFolder(node.id, node.name)}
              >
                {node.name}
              </button>
            </>
          )}
        </For>
      </nav>
    </Show>
  )

  /** What is inside: only what the server listed for this reader. */
  const inside = (v: KnowledgeFolderPage) => {
    // The folder's own page is the text above, never a row of its list.
    const pages = () => v.pages.filter((p) => p.id !== v.page?.id)
    const row = (
      testid: string,
      icon: Component<{ size: number; class: string }>,
      label: string,
      onClick: () => void,
    ) => (
      <li>
        <button
          type="button"
          data-testid={testid}
          class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover [@media(pointer:coarse)]:min-h-11"
          onClick={onClick}
        >
          {icon({ size: 14, class: "shrink-0 text-text-tertiary" })}
          <span class="min-w-0 flex-1 truncate text-[13px] text-text">{label}</span>
        </button>
      </li>
    )
    return (
      <section
        data-testid="knowledge-folder-contents"
        class="mt-8 border-t border-border-subtle pt-6"
      >
        <div class="mb-3 flex items-center justify-between gap-2">
          <h3 class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
            {i18n.t("knowledge.folderPage.inside")}
          </h3>
          <Show when={!v.folder.synced}>
            <Button
              variant="outline"
              size="sm"
              data-testid="knowledge-folder-new-page"
              onClick={() => void newPage()}
            >
              {i18n.t("knowledge.folderPage.newPage")}
            </Button>
          </Show>
        </div>
        <Show
          when={v.folders.length + pages().length > 0}
          fallback={
            <p data-testid="knowledge-folder-empty" class="text-[13px] text-text-tertiary">
              {i18n.t("knowledge.folderPage.nothingHere")}
            </p>
          }
        >
          <ul class="-mx-3 flex flex-col gap-1">
            <For each={v.folders}>
              {(f) =>
                row(`knowledge-folder-item-folder-${f.id}`, Folder, f.name, () =>
                  openFolder(f.id, f.name),
                )
              }
            </For>
            <For each={pages()}>
              {(p) =>
                row(
                  `knowledge-folder-item-page-${p.id}`,
                  FileText,
                  p.title || i18n.t("knowledge.untitled"),
                  () => openTab({ type: "knowledge:document", entityId: p.id, label: p.title }),
                )
              }
            </For>
          </ul>
          <Show when={v.more}>
            <p data-testid="knowledge-folder-more" class="mt-2 text-[12px] text-text-tertiary">
              {i18n.t("knowledge.folderPage.more")}
            </p>
          </Show>
        </Show>
      </section>
    )
  }

  // One list, built again only when the server's answer changes.
  const insideList = createMemo(() => {
    const v = data()
    return v ? inside(v) : null
  })

  return (
    <Show
      when={view() !== "not-found"}
      fallback={
        <div
          data-testid="knowledge-folder-not-found"
          class="flex h-full items-center justify-center p-4"
        >
          <p class="text-sm text-text-secondary">{i18n.t("knowledge.folderPage.notFound")}</p>
        </div>
      }
    >
      <Show when={data()}>
        {(v) => (
          <div
            data-testid="knowledge-folder-view"
            data-folder-id={v().folder.id}
            class="flex h-full flex-col"
          >
            {breadcrumb()}
            <Show
              when={v().page?.id}
              keyed
              fallback={
                <>
                  <div
                    data-testid="knowledge-folder-header"
                    class="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2.5"
                  >
                    <Folder size={14} class="shrink-0 text-text-tertiary" />
                    <h1
                      data-testid="knowledge-folder-title"
                      class="truncate text-[15px] font-semibold text-text"
                    >
                      {v().folder.name}
                    </h1>
                  </div>
                  <ScrollFade class="min-h-0 flex-1" fadeColor="var(--color-surface)">
                    <div
                      class={phone() ? "w-full px-4 py-4" : "mx-auto w-full max-w-2xl px-8 py-8"}
                    >
                      <Show when={!v().folder.synced && v().canStartPage}>
                        <Show when={startError()}>
                          <p
                            data-testid="knowledge-folder-start-error"
                            role="alert"
                            class="mb-3 text-[12.5px] text-danger"
                          >
                            {i18n.t("knowledge.folderPage.startFailed")}
                          </p>
                        </Show>
                        <Suspense>
                          <PageTextEditor
                            value=""
                            ref={(h) => {
                              startEditor = h
                            }}
                            onEdit={() => void startPage()}
                            placeholder={i18n.t("knowledge.folderPage.writeAbout")}
                            aria-label={v().folder.name}
                            data-testid="knowledge-folder-start-editor"
                            editorClass="min-h-[8rem] text-[13px] leading-relaxed"
                          />
                        </Suspense>
                      </Show>
                      {insideList()}
                    </div>
                  </ScrollFade>
                </>
              }
            >
              {(pageId) => (
                <KnowledgeDocumentView
                  entityId={pageId}
                  folder={{
                    get below() {
                      return insideList()
                    },
                    onGone: () => {
                      setFresh(null)
                      void refetch()
                    },
                    get fresh() {
                      const f = fresh()
                      return f && f.row.id === pageId ? f : undefined
                    },
                  }}
                />
              )}
            </Show>
          </div>
        )}
      </Show>
    </Show>
  )
}

export default KnowledgeFolderView
