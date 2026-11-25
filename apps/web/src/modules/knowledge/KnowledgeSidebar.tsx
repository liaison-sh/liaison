// SPDX-License-Identifier: FSL-1.1-ALv2

import { FolderOpen, Plus, Search } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onMount,
  Show,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { rovingFocus } from "~/lib/roving-focus"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openEntity } from "~/modules/shell/entity-opener"
import { shellTier } from "~/modules/shell/shell-tier"
import { evictTabByEntity, openTab, tabStore } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { Dialog } from "~/ui/Dialog"
import { ScrollFade } from "~/ui/ScrollFade"
import KnowledgeCollectionTree, {
  type MoveDocArgs,
  type MoveRequest,
  type ReparentFolderArgs,
} from "./KnowledgeCollectionTree"
import KnowledgeMoveDialog, { type MoveTarget } from "./KnowledgeMoveDialog"
import {
  archiveCollection,
  archiveKnowledgeDocument,
  type CollectionTreeNode,
  createCollection,
  createKnowledgeDocument as createDocApi,
  getKnowledgeDocument,
  type KnowledgeSearchHit,
  moveKnowledgeDocument,
  runKnowledgeSearch,
  updateCollection,
  updateKnowledgeDocument,
} from "./knowledge-api"
import {
  findDocumentPlace,
  knowledgeStore,
  loadCollectionsTree,
  loadDocuments,
  loadKnowledgeHome,
  revealDocument,
  searchKnowledge,
  setFolderOpen,
  setKnowledgeView,
} from "./knowledge-store"
import { refusalMessage } from "./refusal"

/** The scope that lets a person archive a page (Trash replaces it later). */
const ARCHIVE_SCOPE = "knowledge:documents:archive"

function findNode(tree: readonly CollectionTreeNode[], id: string): CollectionTreeNode | null {
  for (const n of tree) {
    if (n.id === id) return n
    const child = findNode(n.children, id)
    if (child) return child
  }
  return null
}

/** The page a tab of the active kind shows, if the active tab is a page. */
export function activeKnowledgeDocId(): string | null {
  const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
  return tab && tab.type === "knowledge:document" ? tab.entityId : null
}

/** Open (or bring forward) the Knowledge tab that shows Home, Unfiled and Search. */
export function openKnowledgeHomeTab(label: string): void {
  openTab({ type: "knowledge:home", entityId: "knowledge-home", label, preview: false })
}

const KnowledgeSidebar: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [searchQuery, setSearchQuery] = createSignal("")
  const [searchResults, setSearchResults] = createSignal<KnowledgeSearchHit[]>([])
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  // Partition the tree into Personal (nodes owned by me: real folders or the
  // Personal notes bucket) and Shared (everything else: shared folders and
  // the Unfiled bucket). The server tags each node with its owner.
  const me = createMemo(() => userFromToken()?.userId ?? null)
  const partitionedTree = createMemo(() => {
    const personal: CollectionTreeNode[] = []
    const shared: CollectionTreeNode[] = []
    const myId = me()
    for (const node of knowledgeStore.collectionsTree) {
      if (myId && node.ownerUserId === myId) personal.push(node)
      else shared.push(node)
    }
    return { personal, shared }
  })
  const activeDocId = createMemo(activeKnowledgeDocId)
  /** Unfiled's count at the bottom: the tree's own bucket, so both agree and
   *  follow every reload of the tree. */
  const unfiledCount = createMemo(
    () =>
      knowledgeStore.collectionsTree.find((n) => n.kind === "unfiled" || n.id === "__unfiled__")
        ?.documents.length ?? 0,
  )
  const canArchiveDocs = () => hasScope(ARCHIVE_SCOPE)
  // Actions follow the person's scopes, as the server checks them: none is
  // offered that the server would refuse for want of one.
  const canManageFolders = () =>
    hasScope("knowledge:collections:manage") || hasScope("knowledge:documents:admin")
  const canCreatePages = () =>
    hasScope("knowledge:documents:create") || hasScope("knowledge:documents:admin")
  // The phone navigator sheet is outside the shell's touch floor: size here.
  const touch = () => shellTier() !== "desktop"

  // The open page's row stays in sight: its folders open when it opens, and
  // again when the tree reloads with it somewhere new.
  createEffect(
    on([activeDocId, () => knowledgeStore.collectionsTree], ([id]) => {
      if (id) revealDocument(id)
    }),
  )

  /** A refusal is said where the person acted, in their language. */
  function refused(err: unknown, fallback: string) {
    addToast({ type: "error", message: refusalMessage(err, fallback, i18n.t) })
  }

  async function runFederatedSearch(q: string) {
    if (!q.trim()) {
      setSearchResults([])
      return
    }
    try {
      const res = await runKnowledgeSearch(api, { query: q, limit: 20 })
      setSearchResults(res.hits ?? [])
    } catch {
      /* the list keeps its last results */
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
      const q = e.currentTarget.value
      void runFederatedSearch(q)
      // Enter shows every result, with each source's state, in the main panel.
      if (q.trim()) {
        void searchKnowledge(api, { query: q, limit: 25 })
        openKnowledgeHomeTab(i18n.t("kernel.nav.knowledge"))
      }
    }
  }

  onMount(() => {
    void loadDocuments(api)
    void loadCollectionsTree(api)
  })

  async function reloadAfterChange() {
    await loadCollectionsTree(api)
    if (knowledgeStore.homeData) void loadKnowledgeHome(api)
  }

  /** A new page: in a folder when given, private when `personal` (C7). */
  async function newPage(folderId: string | null, personal: boolean) {
    try {
      const doc = (await createDocApi(api, {
        title: i18n.t("knowledge.untitled"),
        documentScope: "organization",
        ...(personal ? { orgAccess: "none" } : {}),
        ...(folderId ? { collectionIds: [folderId] } : {}),
      })) as { id: string; title?: string }
      await reloadAfterChange()
      // Just created by the user: a permanent tab, not a preview.
      openTab({
        type: "knowledge:document",
        entityId: doc.id,
        label: doc.title ?? i18n.t("knowledge.untitled"),
        preview: false,
      })
    } catch (err) {
      refused(err, i18n.t("knowledge.couldNotCreatePage"))
    }
  }

  function openDoc(docId: string, title?: string) {
    openTab({ type: "knowledge:document", entityId: docId, label: title ?? "" })
  }

  // Name prompts and confirmations use the Dialog primitive.
  type Pending =
    | { kind: "create"; parentId: string | null; ownerUserId: string | null }
    | { kind: "rename"; folderId: string; initial: string }
    | { kind: "rename-doc"; docId: string; initial: string; revision: number }
    | { kind: "archive"; folderId: string; name: string; place: string | null }
    | { kind: "confirm-move"; text: string; run: () => Promise<void> }
    | null
  const [pending, setPending] = createSignal<Pending>(null)
  const [nameInput, setNameInput] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const isOpen = () => pending() !== null

  function openCreateDialog(parentId: string | null, ownerUserId: string | null) {
    setNameInput(i18n.t("knowledge.newFolder"))
    setPending({ kind: "create", parentId, ownerUserId })
  }

  function openRenameDialog(id: string) {
    const node = findNode(knowledgeStore.collectionsTree, id)
    if (!node || node.virtual) return
    setNameInput(node.name)
    setPending({ kind: "rename", folderId: id, initial: node.name })
  }

  async function openRenameDocDialog(docId: string) {
    try {
      const doc = (await getKnowledgeDocument(api, docId)) as { title: string; revision: number }
      setNameInput(doc.title)
      setPending({ kind: "rename-doc", docId, initial: doc.title, revision: doc.revision })
    } catch (err) {
      refused(err, i18n.t("knowledge.cannotDoThisOnPage"))
    }
  }

  function openArchiveDialog(id: string) {
    const node = findNode(knowledgeStore.collectionsTree, id)
    if (!node || node.virtual) return
    const parent = node.parentId ? findNode(knowledgeStore.collectionsTree, node.parentId) : null
    setPending({ kind: "archive", folderId: id, name: node.name, place: parent?.name ?? null })
  }

  function closeDialog() {
    setPending(null)
    setNameInput("")
  }

  async function confirmDialog() {
    const p = pending()
    if (!p || busy()) return
    // A name prompt left empty stays open: nothing to send, nothing lost.
    const named = p.kind === "create" || p.kind === "rename" || p.kind === "rename-doc"
    if (named && !nameInput().trim()) return
    setBusy(true)
    try {
      if (p.kind === "create") {
        const name = nameInput().trim()
        await createCollection(api, {
          name,
          parentCollectionId: p.parentId,
          ownerUserId: p.ownerUserId,
        })
        if (p.parentId) revealFolder(p.parentId)
      } else if (p.kind === "rename") {
        const name = nameInput().trim()
        if (name && name !== p.initial) await updateCollection(api, p.folderId, { name })
      } else if (p.kind === "rename-doc") {
        const title = nameInput().trim()
        if (title && title !== p.initial) {
          await updateKnowledgeDocument(api, p.docId, { title, revision: p.revision })
          void loadDocuments(api)
        }
      } else if (p.kind === "archive") {
        await archiveCollection(api, p.folderId)
      } else if (p.kind === "confirm-move") {
        await p.run()
      }
      await reloadAfterChange()
    } catch (err) {
      if (p.kind === "rename-doc" && err instanceof ApiError && err.status === 409) {
        addToast({ type: "error", message: i18n.t("knowledge.renameConflict") })
      } else {
        refused(err, i18n.t("knowledge.couldNotChangeFolder"))
      }
      await loadCollectionsTree(api)
    } finally {
      setBusy(false)
      closeDialog()
    }
  }

  function revealFolder(id: string) {
    setFolderOpen(id, true)
  }

  // ---- Moving ----------------------------------------------------------

  const sectionOfFolder = (id: string | null): "personal" | "shared" => {
    if (!id) return "shared"
    const node = findNode(knowledgeStore.collectionsTree, id)
    return node && me() && node.ownerUserId === me() ? "personal" : "shared"
  }

  /** Where a page is now, as the move dialog marks it. */
  const placeOfDoc = (docId: string, fromCollectionId: string | null): MoveTarget => {
    if (fromCollectionId) {
      return { collectionId: fromCollectionId, section: sectionOfFolder(fromCollectionId) }
    }
    const place = findDocumentPlace(knowledgeStore.collectionsTree, docId)
    const personal = place?.top.kind === "personal_notes" || place?.top.id === "__personal_notes__"
    return { collectionId: null, section: personal ? "personal" : "shared" }
  }

  const [moveItem, setMoveItem] = createSignal<MoveRequest | null>(null)
  const moveCurrent = (): MoveTarget => {
    const item = moveItem()
    if (!item) return { collectionId: null, section: "shared" }
    if (item.kind === "doc") return placeOfDoc(item.id, item.fromCollectionId)
    const node = findNode(knowledgeStore.collectionsTree, item.id)
    return {
      collectionId: node?.parentId ?? null,
      section: node && me() && node.ownerUserId === me() ? "personal" : "shared",
    }
  }

  async function moveDoc(args: MoveDocArgs) {
    try {
      // One request: the page is never in neither folder, and a refusal
      // leaves it where it was.
      await moveKnowledgeDocument(api, args.docId, {
        fromCollectionId: args.fromCollectionId,
        toCollectionId: args.toCollectionId,
      })
      if (args.toCollectionId) revealFolder(args.toCollectionId)
      await reloadAfterChange()
    } catch (err) {
      refused(err, i18n.t("knowledge.cannotDoThisOnPage"))
      await loadCollectionsTree(api)
    }
  }

  async function moveFolder(folderId: string, target: MoveTarget) {
    try {
      const myId = me()
      await updateCollection(api, folderId, {
        parentCollectionId: target.collectionId,
        // At the top level, the section says whose it is; inside a folder,
        // the server gives it the parent's owner.
        ...(target.collectionId === null
          ? { ownerUserId: target.section === "personal" ? myId : null }
          : {}),
      })
      if (target.collectionId) revealFolder(target.collectionId)
      await reloadAfterChange()
    } catch (err) {
      refused(err, i18n.t("knowledge.couldNotChangeFolder"))
      await loadCollectionsTree(api)
    }
  }

  function onMovePicked(target: MoveTarget) {
    const item = moveItem()
    setMoveItem(null)
    if (!item) return
    if (item.kind === "doc") {
      void moveDoc({
        docId: item.id,
        fromCollectionId: item.fromCollectionId,
        toCollectionId: target.collectionId,
      })
    } else {
      void moveFolder(item.id, target)
    }
  }

  /** A drag that crosses Personal and Shared asks first, as the dialog does. */
  function onDragMoveDoc(args: MoveDocArgs) {
    const from = placeOfDoc(args.docId, args.fromCollectionId).section
    const to = sectionOfFolder(args.toCollectionId)
    if (args.toCollectionId && from !== to) {
      setPending({
        kind: "confirm-move",
        text: i18n.t("knowledge.moveKeepsPageSharing"),
        run: () => moveDoc(args),
      })
    } else {
      void moveDoc(args)
    }
  }

  function onDragReparent(args: ReparentFolderArgs) {
    const node = findNode(knowledgeStore.collectionsTree, args.folderId)
    if (!node) return
    const from = me() && node.ownerUserId === me() ? "personal" : "shared"
    const target: MoveTarget = {
      collectionId: args.newParentId,
      section: args.newParentId ? sectionOfFolder(args.newParentId) : (args.section ?? from),
    }
    if (target.section !== from) {
      setPending({
        kind: "confirm-move",
        text: i18n.t(
          target.section === "personal"
            ? "knowledge.moveFolderToPersonal"
            : "knowledge.moveFolderToShared",
        ),
        run: () => moveFolder(args.folderId, target),
      })
    } else {
      void moveFolder(args.folderId, target)
    }
  }

  // ---- Page actions ----------------------------------------------------

  async function copyLink(docId: string) {
    const url = `${window.location.origin}/knowledge/documents/${docId}`
    try {
      await navigator.clipboard.writeText(url)
      addToast({ type: "success", message: i18n.t("knowledge.linkCopied") })
    } catch {
      addToast({ type: "error", message: i18n.t("knowledge.couldNotCopyLink") })
    }
  }

  async function archiveDoc(docId: string) {
    try {
      await archiveKnowledgeDocument(api, docId)
      evictTabByEntity("knowledge:document", docId)
      void loadDocuments(api)
      await reloadAfterChange()
      addToast({ type: "success", message: i18n.t("knowledge.pageArchived") })
    } catch (err) {
      refused(err, i18n.t("knowledge.cannotDoThisOnPage"))
    }
  }

  // ---- Views -----------------------------------------------------------

  const onHomeTab = () => {
    const tab = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
    return tab?.type === "knowledge:home"
  }

  /** Unfiled shows its list; a second click on it goes back to Home. */
  function toggleUnfiled() {
    if (knowledgeStore.view === "unfiled" && onHomeTab()) {
      setKnowledgeView("home")
      return
    }
    setKnowledgeView("unfiled")
    openKnowledgeHomeTab(i18n.t("kernel.nav.knowledge"))
  }

  const treeProps = () => ({
    activeDocId: activeDocId(),
    onOpenDoc: openDoc,
    onCreateChild: (parentId: string | null, ownerUserId: string | null) =>
      openCreateDialog(parentId, ownerUserId),
    onNewPage: (folderId: string | null, personal: boolean) => void newPage(folderId, personal),
    onRename: openRenameDialog,
    onRenameDoc: (id: string) => void openRenameDocDialog(id),
    onArchive: openArchiveDialog,
    onArchiveDoc: (id: string) => void archiveDoc(id),
    canArchiveDocs: canArchiveDocs(),
    canManageFolders: canManageFolders(),
    canCreatePages: canCreatePages(),
    onCopyLink: (id: string) => void copyLink(id),
    onMoveRequest: (item: MoveRequest) => setMoveItem(item),
    onMoveDoc: onDragMoveDoc,
    onReparentFolder: onDragReparent,
  })

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
        <Show when={canCreatePages()}>
          <button
            type="button"
            data-testid="knowledge-sidebar-new-page"
            aria-label={i18n.t("knowledge.newDocument")}
            title={i18n.t("knowledge.newDocument")}
            onClick={() => void newPage(null, false)}
            class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            <Plus size={16} />
          </button>
        </Show>
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
              <Show when={canManageFolders()}>
                <button
                  type="button"
                  data-testid="knowledge-sidebar-personal-new-folder"
                  aria-label={i18n.t("knowledge.newPersonalFolder")}
                  onClick={() => openCreateDialog(null, me())}
                  title={i18n.t("knowledge.newPersonalFolder")}
                  class={`flex items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary ${touch() ? "h-11 w-11" : "h-5 w-5"}`}
                >
                  <Plus size={12} />
                </button>
              </Show>
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
                section="personal"
                {...treeProps()}
              />
            </Show>
          </section>

          <section data-testid="knowledge-sidebar-section-shared" class="px-2 pt-3">
            <div class="flex items-center justify-between px-3 pb-1.5 pt-1">
              <span class="text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
                {i18n.t("knowledge.sharedWithOrg")}
              </span>
              <Show when={canManageFolders()}>
                <button
                  type="button"
                  data-testid="knowledge-sidebar-shared-new-folder"
                  aria-label={i18n.t("knowledge.newSharedFolder")}
                  onClick={() => openCreateDialog(null, null)}
                  title={i18n.t("knowledge.newSharedFolder")}
                  class={`flex items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary ${touch() ? "h-11 w-11" : "h-5 w-5"}`}
                >
                  <Plus size={12} />
                </button>
              </Show>
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
                section="shared"
                {...treeProps()}
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
      <Show when={unfiledCount() > 0}>
        <div class="border-t border-border-subtle py-1">
          <button
            type="button"
            data-testid="knowledge-sidebar-unfiled"
            aria-current={knowledgeStore.view === "unfiled" && onHomeTab() ? "page" : undefined}
            class={`flex w-full items-center gap-2 px-5 py-2.5 text-[13px] outline-none transition-colors ${
              knowledgeStore.view === "unfiled" && onHomeTab()
                ? "bg-surface-active font-medium text-text"
                : "text-text-tertiary hover:bg-surface-hover hover:text-text-secondary focus-visible:bg-surface-hover focus-visible:text-text-secondary"
            }`}
            onClick={toggleUnfiled}
          >
            <FolderOpen size={14} />
            <span class="flex-1 text-left">{i18n.t("knowledge.unfiled")}</span>
            <span class="rounded-full bg-surface px-2 py-0.5 text-[11px]">{unfiledCount()}</span>
          </button>
        </div>
      </Show>

      <Dialog open={isOpen()} onOpenChange={(o) => !o && closeDialog()}>
        <Dialog.Content>
          <Show when={pending()} keyed>
            {(p) => {
              const named = p.kind === "create" || p.kind === "rename" || p.kind === "rename-doc"
              return (
                <>
                  <Dialog.Title>
                    {p.kind === "create"
                      ? i18n.t("knowledge.newFolder")
                      : p.kind === "rename"
                        ? i18n.t("knowledge.renameFolder")
                        : p.kind === "rename-doc"
                          ? i18n.t("knowledge.renamePage")
                          : p.kind === "archive"
                            ? i18n.t("knowledge.confirmDeleteFolder", { name: p.name })
                            : i18n.t("knowledge.moveAcrossTitle")}
                  </Dialog.Title>
                  <Show when={p.kind === "archive" ? p : null}>
                    {(a) => (
                      <Dialog.Description>
                        <span data-testid="knowledge-folder-delete-where">
                          {a().place
                            ? i18n.t("knowledge.deleteFolderIntoParent", { place: a().place ?? "" })
                            : i18n.t("knowledge.deleteFolderAtTop")}
                        </span>
                      </Dialog.Description>
                    )}
                  </Show>
                  <Show when={p.kind === "confirm-move" ? p : null}>
                    {(m) => (
                      <Dialog.Description>
                        <span data-testid="knowledge-move-audience">{m().text}</span>
                      </Dialog.Description>
                    )}
                  </Show>
                  <Show when={named}>
                    <input
                      type="text"
                      data-testid="knowledge-folder-name-input"
                      aria-label={i18n.t("knowledge.name")}
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
                      disabled={busy()}
                      onClick={() => void confirmDialog()}
                      class={`rounded-md px-3 py-1.5 text-[12px] text-white transition-colors disabled:opacity-50 ${
                        p.kind === "archive"
                          ? "bg-red-500 hover:bg-red-600"
                          : "bg-accent hover:opacity-90"
                      }`}
                    >
                      {p.kind === "create"
                        ? i18n.t("kernel.common.create")
                        : p.kind === "archive"
                          ? i18n.t("kernel.common.delete")
                          : p.kind === "confirm-move"
                            ? i18n.t("knowledge.move")
                            : i18n.t("kernel.common.save")}
                    </button>
                  </div>
                </>
              )
            }}
          </Show>
        </Dialog.Content>
      </Dialog>

      <Show when={moveItem()} keyed>
        {(item) => (
          <KnowledgeMoveDialog
            item={item}
            tree={knowledgeStore.collectionsTree}
            me={me()}
            current={moveCurrent()}
            onMove={onMovePicked}
            onClose={() => setMoveItem(null)}
          />
        )}
      </Show>
    </nav>
  )
}

export default KnowledgeSidebar
