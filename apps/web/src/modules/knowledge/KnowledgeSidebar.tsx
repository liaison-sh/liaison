// SPDX-License-Identifier: FSL-1.1-ALv2

import { FolderOpen, Plus, Search } from "lucide-solid"
import { type Component, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { rovingFocus } from "~/lib/roving-focus"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"
import { openTab } from "~/modules/shell/tab-store"
import { Dialog } from "~/ui/Dialog"
import { ScrollFade } from "~/ui/ScrollFade"
import KnowledgeCollectionTree from "./KnowledgeCollectionTree"
import {
  addDocumentToCollection,
  archiveCollection,
  createCollection,
  createKnowledgeDocument as createDocApi,
  type KnowledgeSearchHit,
  removeDocumentFromCollection,
  runKnowledgeSearch,
  updateCollection,
} from "./knowledge-api"
import {
  knowledgeStore,
  loadCollectionsTree,
  loadDocuments,
  setKnowledgeView,
} from "./knowledge-store"

function findNodeName(
  tree: import("./knowledge-api").CollectionTreeNode[],
  id: string,
): string | null {
  for (const n of tree) {
    if (n.id === id) return n.name
    const child = findNodeName(n.children, id)
    if (child !== null) return child
  }
  return null
}

const KnowledgeSidebar: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [searchQuery, setSearchQuery] = createSignal("")
  const [searchResults, setSearchResults] = createSignal<KnowledgeSearchHit[]>([])
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  // Partition the tree into Personal (nodes owned by me — real folders or
  // virtual __personal_notes__) and Shared (everything else: org-shared
  // folders + the Unfiled bucket of org-scope orphans). The server tags
  // each tree node with ownerUserId so we can split without re-fetching.
  const me = createMemo(() => userFromToken()?.userId ?? null)
  const partitionedTree = createMemo(() => {
    const personal: typeof knowledgeStore.collectionsTree = []
    const shared: typeof knowledgeStore.collectionsTree = []
    const myId = me()
    for (const node of knowledgeStore.collectionsTree) {
      if (myId && node.ownerUserId === myId) personal.push(node)
      else shared.push(node)
    }
    return { personal, shared }
  })

  async function runFederatedSearch(q: string) {
    if (!q.trim()) {
      setSearchResults([])
      return
    }
    try {
      const res = await runKnowledgeSearch(api, { query: q, limit: 20 })
      setSearchResults(res.hits ?? [])
    } catch {
      /* fall back silently */
    }
  }

  function onSearchInput(e: InputEvent & { currentTarget: HTMLInputElement }) {
    const v = e.currentTarget.value
    setSearchQuery(v)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => void runFederatedSearch(v), 200)
  }

  function onSearchKeydown(e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (e.key === "Enter") {
      e.preventDefault()
      if (debounceTimer) clearTimeout(debounceTimer)
      void runFederatedSearch(e.currentTarget.value)
    }
  }

  onMount(() => {
    void loadDocuments(api)
    void loadCollectionsTree(api)
  })

  async function handleNewDocument() {
    try {
      // Knowledge is a shared, org-wide business knowledge base — new documents
      // default to organization scope so they land under "Shared with org" and
      // are visible to the whole org, not siloed as a private personal note.
      const doc = (await createDocApi(api, {
        title: i18n.t("knowledge.untitled"),
        documentScope: "organization",
      })) as { id: string; title?: string }
      await loadCollectionsTree(api)
      // Just created by the user — open as a permanent tab, not an ephemeral preview.
      openTab({
        type: "knowledge:document",
        entityId: doc.id,
        label: doc.title ?? i18n.t("knowledge.untitled"),
        preview: false,
      })
    } catch (err) {
      console.error("Failed to create document:", err)
    }
  }

  function openDoc(docId: string, label = "Document") {
    openTab({ type: "knowledge:document", entityId: docId, label })
  }

  // Folder name + delete prompts use the Dialog primitive instead of the raw
  // window.{prompt,confirm} sequence — keeps the surface inside the app's
  // styling and accessibility envelope.
  type Pending =
    | { kind: "create"; parentId: string | null; ownerUserId: string | null }
    | { kind: "rename"; folderId: string; initial: string }
    | { kind: "archive"; folderId: string; name: string }
    | null
  const [pending, setPending] = createSignal<Pending>(null)
  const [nameInput, setNameInput] = createSignal("")
  const isOpen = () => pending() !== null

  function openCreateDialog(parentId: string | null, ownerUserId: string | null) {
    setNameInput("New folder")
    setPending({ kind: "create", parentId, ownerUserId })
  }

  function openRenameDialog(id: string) {
    if (id === "__unfiled__") return
    const current = findNodeName(knowledgeStore.collectionsTree, id) ?? ""
    setNameInput(current)
    setPending({ kind: "rename", folderId: id, initial: current })
  }

  function openArchiveDialog(id: string) {
    if (id === "__unfiled__") return
    const name = findNodeName(knowledgeStore.collectionsTree, id) ?? "this folder"
    setPending({ kind: "archive", folderId: id, name })
  }

  function closeDialog() {
    setPending(null)
    setNameInput("")
  }

  async function confirmDialog() {
    const p = pending()
    if (!p) return
    try {
      if (p.kind === "create") {
        const name = nameInput().trim()
        if (!name) return
        await createCollection(api, {
          name,
          parentCollectionId: p.parentId && p.parentId !== "__unfiled__" ? p.parentId : null,
          ownerUserId: p.ownerUserId,
        })
      } else if (p.kind === "rename") {
        const name = nameInput().trim()
        if (!name || name === p.initial) {
          closeDialog()
          return
        }
        await updateCollection(api, p.folderId, { name })
      } else if (p.kind === "archive") {
        await archiveCollection(api, p.folderId)
      }
      await loadCollectionsTree(api)
    } catch (err) {
      console.error(`Failed to ${p.kind} folder:`, err)
    } finally {
      closeDialog()
    }
  }

  async function handleCreateFolder(parentId: string | null, ownerUserId: string | null) {
    openCreateDialog(parentId, ownerUserId)
  }

  async function handleRename(id: string) {
    openRenameDialog(id)
  }

  async function handleMoveDoc(args: {
    docId: string
    fromCollectionId: string | null
    toCollectionId: string | null
  }) {
    try {
      if (args.fromCollectionId) {
        await removeDocumentFromCollection(api, args.fromCollectionId, args.docId)
      }
      if (args.toCollectionId) {
        await addDocumentToCollection(api, args.toCollectionId, args.docId)
      }
      await loadCollectionsTree(api)
    } catch (err) {
      console.error("Failed to move document:", err)
      await loadCollectionsTree(api)
    }
  }

  async function handleReparentFolder(args: { folderId: string; newParentId: string | null }) {
    try {
      await updateCollection(api, args.folderId, { parentCollectionId: args.newParentId })
      await loadCollectionsTree(api)
    } catch (err) {
      console.error("Failed to reparent folder:", err)
      await loadCollectionsTree(api)
    }
  }

  async function handleArchive(id: string) {
    openArchiveDialog(id)
  }

  return (
    <nav data-testid="knowledge-sidebar" class="flex min-h-0 flex-1 flex-col">
      {/* Search + New */}
      <div class="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
        <div class="flex flex-1 items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5">
          <Search size={14} class="shrink-0 text-text-tertiary" />
          <input
            type="text"
            data-testid="knowledge-sidebar-search-input"
            placeholder={i18n.t("knowledge.searchDocs")}
            class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
            value={searchQuery()}
            onInput={onSearchInput}
            onKeyDown={onSearchKeydown}
          />
        </div>
        <button
          type="button"
          aria-label={i18n.t("knowledge.newDocument")}
          onClick={() => void handleNewDocument()}
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Tree + search results */}
      <ScrollFade class="min-h-0 flex-1">
        <div onKeyDown={rovingFocus} tabindex="-1">
          <Show when={searchResults().length > 0}>
            <div class="px-3 pt-2">
              <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                {i18n.t("knowledge.searchResults")}
              </span>
            </div>
            <For each={searchResults()}>
              {(hit) => {
                const entityType: "document" | "source_link" =
                  hit.type === "document" || hit.type === "source_link"
                    ? hit.type
                    : hit.source === "knowledge" || hit.source === "local"
                      ? "document"
                      : "source_link"
                return (
                  <button
                    type="button"
                    data-testid={`knowledge-search-result-${entityType}-${hit.sourceEntityId}`}
                    data-search-hit
                    data-roving
                    class="group flex w-full items-start gap-2 border-l-2 border-transparent px-3 py-2 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
                    onClick={() =>
                      void openEntity(api, "knowledge", entityType, hit.sourceEntityId, hit.title)
                    }
                  >
                    <div class="min-w-0 flex-1">
                      <span class="truncate text-[13px] font-medium text-text">{hit.title}</span>
                      <span
                        data-testid={`knowledge-search-result-source-${hit.source}`}
                        class="ml-1.5 rounded bg-surface px-1.5 text-[11px] text-text-tertiary"
                      >
                        {hit.source}
                      </span>
                      <Show when={hit.syncedSourceApp}>
                        {(app) => (
                          <span
                            data-testid={`knowledge-search-result-synced-${hit.sourceEntityId}`}
                            class="ml-1.5 inline-flex items-center gap-0.5 rounded bg-surface px-1.5 text-[11px] text-text-tertiary"
                            title={i18n.t("knowledge.syncedFromApp", { app: app() })}
                          >
                            <span aria-hidden>☁</span>
                            {app()}
                          </span>
                        )}
                      </Show>
                    </div>
                  </button>
                )
              }}
            </For>
            <div class="mx-3 my-1 h-px bg-border-subtle" />
          </Show>

          <section data-testid="knowledge-sidebar-section-personal" class="px-2 pt-2">
            <div class="flex items-center justify-between px-3 pb-1.5 pt-1">
              <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                {i18n.t("knowledge.personal")}
              </span>
              <button
                type="button"
                data-testid="knowledge-sidebar-personal-new-folder"
                aria-label={i18n.t("knowledge.newPersonalFolder")}
                onClick={() => void handleCreateFolder(null, me())}
                class="flex h-5 w-5 items-center justify-center rounded text-text-tertiary opacity-0 transition-all hover:bg-surface-hover hover:text-text-secondary group-hover/personal:opacity-100 focus-visible:opacity-100"
              >
                <Plus size={12} />
              </button>
            </div>
            <Show
              when={partitionedTree().personal.length > 0}
              fallback={
                <div
                  data-testid="knowledge-sidebar-personal-empty"
                  class="px-3 py-2 text-[12px] text-text-tertiary"
                >
                  {i18n.t("knowledge.noPersonalNotesYet")}
                </div>
              }
            >
              <KnowledgeCollectionTree
                tree={partitionedTree().personal}
                onOpenDoc={(id) => openDoc(id)}
                onCreateChild={(parentId, ownerUserId) =>
                  void handleCreateFolder(parentId, ownerUserId)
                }
                onRename={(id) => void handleRename(id)}
                onArchive={(id) => void handleArchive(id)}
                onMoveDoc={(args) => void handleMoveDoc(args)}
                onReparentFolder={(args) => void handleReparentFolder(args)}
              />
            </Show>
          </section>

          <section data-testid="knowledge-sidebar-section-shared" class="px-2 pt-3">
            <div class="flex items-center justify-between px-3 pb-1.5 pt-1">
              <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                {i18n.t("knowledge.sharedWithOrg")}
              </span>
              <button
                type="button"
                data-testid="knowledge-sidebar-shared-new-folder"
                aria-label={i18n.t("knowledge.newSharedFolder")}
                onClick={() => void handleCreateFolder(null, null)}
                class="flex h-5 w-5 items-center justify-center rounded text-text-tertiary opacity-0 transition-all hover:bg-surface-hover hover:text-text-secondary group-hover/shared:opacity-100 focus-visible:opacity-100"
              >
                <Plus size={12} />
              </button>
            </div>
            <Show
              when={partitionedTree().shared.length > 0}
              fallback={
                <div
                  data-testid="knowledge-sidebar-shared-empty"
                  class="px-3 py-2 text-[12px] text-text-tertiary"
                >
                  {i18n.t("knowledge.noSharedKnowledgeYet")}
                </div>
              }
            >
              <KnowledgeCollectionTree
                tree={partitionedTree().shared}
                onOpenDoc={(id) => openDoc(id)}
                onCreateChild={(parentId, ownerUserId) =>
                  void handleCreateFolder(parentId, ownerUserId)
                }
                onRename={(id) => void handleRename(id)}
                onArchive={(id) => void handleArchive(id)}
                onMoveDoc={(args) => void handleMoveDoc(args)}
                onReparentFolder={(args) => void handleReparentFolder(args)}
              />
            </Show>
          </section>

          <Show
            when={knowledgeStore.collectionsTree.length === 0 && !knowledgeStore.documentsLoading}
          >
            <div class="px-4 py-8 text-center text-[13px] text-text-tertiary">
              {i18n.t("knowledge.noDocumentsYetCreateYourFirst")}
            </div>
          </Show>
        </div>
      </ScrollFade>

      {/* Auto-appearing Unfiled entry — only when there are orphan docs */}
      <Show when={(knowledgeStore.homeData?.unfiledCount ?? 0) > 0}>
        <div class="border-t border-border-subtle py-1">
          <button
            type="button"
            data-testid="knowledge-sidebar-unfiled"
            aria-current={knowledgeStore.view === "unfiled" ? "page" : undefined}
            class={`flex w-full items-center gap-2 px-5 py-2.5 text-[13px] outline-none transition-colors ${
              knowledgeStore.view === "unfiled"
                ? "bg-surface-active font-medium text-text"
                : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary focus-visible:bg-surface-hover focus-visible:text-text-secondary"
            }`}
            onClick={() => setKnowledgeView("unfiled")}
          >
            <FolderOpen size={14} />
            <span class="flex-1 text-left">{i18n.t("knowledge.unfiled")}</span>
            <span class="rounded-full bg-surface px-2 py-0.5 text-[11px]">
              {knowledgeStore.homeData?.unfiledCount}
            </span>
          </button>
        </div>
      </Show>

      <Dialog open={isOpen()} onOpenChange={(o) => !o && closeDialog()}>
        <Dialog.Content>
          <Show when={pending()} keyed>
            {(p) => (
              <>
                <Dialog.Title>
                  {p.kind === "create"
                    ? i18n.t("knowledge.newFolder")
                    : p.kind === "rename"
                      ? i18n.t("knowledge.renameFolder")
                      : i18n.t("knowledge.confirmDeleteFolder", { name: p.name })}
                </Dialog.Title>
                <Show when={p.kind === "archive"}>
                  <Dialog.Description>
                    {i18n.t("knowledge.documentsInsideRemainOnlyTheFolder")}
                  </Dialog.Description>
                </Show>
                <Show when={p.kind !== "archive"}>
                  <input
                    type="text"
                    data-testid="knowledge-folder-name-input"
                    autofocus
                    class="mt-4 w-full rounded-md border border-border-subtle bg-surface-elevated px-3 py-2 text-[13px] text-text outline-none focus:border-accent"
                    value={nameInput()}
                    onInput={(e) => setNameInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void confirmDialog()
                      }
                    }}
                  />
                </Show>
                <div class="mt-4 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid="knowledge-folder-dialog-cancel"
                    onClick={closeDialog}
                    class="rounded-md border border-border-subtle px-3 py-1.5 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
                  >
                    {i18n.t("kernel.common.cancel")}
                  </button>
                  <button
                    type="button"
                    data-testid="knowledge-folder-dialog-confirm"
                    onClick={() => void confirmDialog()}
                    class={`rounded-md px-3 py-1.5 text-[12px] text-white transition-colors ${
                      p.kind === "archive"
                        ? "bg-red-500 hover:bg-red-600"
                        : "bg-accent hover:opacity-90"
                    }`}
                  >
                    {p.kind === "create"
                      ? i18n.t("kernel.common.create")
                      : p.kind === "rename"
                        ? i18n.t("kernel.common.save")
                        : i18n.t("kernel.common.delete")}
                  </button>
                </div>
              </>
            )}
          </Show>
        </Dialog.Content>
      </Dialog>
    </nav>
  )
}

export default KnowledgeSidebar
