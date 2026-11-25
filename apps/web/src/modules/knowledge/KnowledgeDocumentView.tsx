// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A Knowledge page. Whoever may edit it edits in place: the editor is always
// mounted and the page saves itself (autosave.ts), with its unsaved text kept in a
// local draft per user, page and tab (drafts.ts). Opening the page offers back a
// draft that a closed tab left; a save that meets someone else's shows both texts
// and the person chooses (D7: leaving with the choice open shows theirs and keeps
// mine in Page history). A reader sees the rendered text only.

import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { relativeTime } from "~/lib/relative-time"
import { useDictation } from "~/modules/assist/useDictation"
import { userFromToken } from "~/modules/auth/auth-store"
import { authManager } from "~/modules/auth/createAuthManager"
import type { RichEditorHandle } from "~/modules/editor"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi, useOptionalApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { evictTabByEntity } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import {
  createPageSaver,
  draftInHistory,
  openDrafts,
  type PageSaver,
  postDraftToHistory,
  type SavedRow,
  type SaverStatus,
} from "./autosave"
import { ConflictDialog } from "./ConflictDialog"
import { draftKey, pageDrafts, webLocks } from "./drafts"
import KnowledgeShareDialog from "./KnowledgeShareDialog"
import {
  getKnowledgeDocument,
  getKnowledgeDocumentBacklinks,
  getKnowledgeTrashEntry,
  type KnowledgeBacklink,
  type KnowledgeTrashEntry,
  type KnowledgeVersionItem,
  listKnowledgeVersions,
  restoreKnowledgeVersion,
  runSyncedSourceNow,
  verifyKnowledgeDocument,
} from "./knowledge-api"
import {
  isCollectionsTreeLoaded,
  knowledgeStore,
  loadCollectionsTree,
  loadDocuments,
} from "./knowledge-store"
import { PageBody } from "./PageBody"
import { PageHeader } from "./PageHeader"
import { PageHistory, versionAuthor } from "./PageHistory"
import { pageFileView, uploadPageFile, uploadRefusal } from "./page-files"
import { editorPages, pageLinkDeps } from "./page-links"
import {
  canMoveToTrash,
  daysLeftLabel,
  moveToTrash,
  restoreFromTrash,
  trashedLine,
  trashRefusalKey,
} from "./trash"

export interface KnowledgeDocumentFetched {
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
  updatedAt?: string
  updatedBy?: string | null
  /** The server's own write check (service.ts canEditDocumentRow). */
  canEdit?: boolean
}

/** A page in Trash the person may restore: its link shows the Trash card (B3). */
interface TrashedPage {
  trashEntry: KnowledgeTrashEntry
}

/** A page shown as its folder's own page (KnowledgeFolderView). */
export interface DocumentInFolder {
  /** Shown under the text: what is inside the folder. */
  below: JSX.Element
  /** The page is no longer the folder's (gone, in the trash): the folder view asks again. */
  onGone: () => void
  /** The page was made a moment ago from this text (still being typed): it opens on
   *  that row and that text at once, with no reload, and saves what came after. */
  fresh?: {
    row: KnowledgeDocumentFetched
    text: string
    /** The page was someone else's already (made meanwhile): the text meets it as a conflict. */
    existing?: boolean
  }
}

type Fetched = KnowledgeDocumentFetched | TrashedPage | null | "not-found"

const isRow = (d: Fetched | undefined): d is KnowledgeDocumentFetched =>
  !!d && d !== "not-found" && !("trashEntry" in d)

const KnowledgeDocumentView: Component<{ entityId: string; folder?: DocumentInFolder }> = (
  props,
) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const apiForSidebar = useApi()
  const phone = () => shellTier() === "phone"
  const me = () => userFromToken()?.userId ?? null

  let docController: AbortController | null = null
  /** Pages opened on a fresh row already (a later fetch asks the server). */
  const freshUsed = new Set<string>()
  /** The page made from text being typed: its editor takes the caret when it opens. */
  let focusOnOpen = false
  const [doc, { refetch, mutate }] = createResource(
    () => props.entityId,
    async (id: string | null): Promise<Fetched> => {
      if (!id || !api) return null
      const fresh = untrack(() => props.folder?.fresh)
      if (fresh && fresh.row.id === id && !freshUsed.has(id)) {
        freshUsed.add(id)
        return { ...fresh.row, canEdit: fresh.row.canEdit ?? true }
      }
      docController?.abort()
      const ac = new AbortController()
      docController = ac
      try {
        return (await getKnowledgeDocument(api, id, {
          signal: ac.signal,
        })) as KnowledgeDocumentFetched
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") throw err
        if (!(err instanceof ApiError && err.status === 404)) throw err
        // Not readable: a page in Trash the person may restore shows its Trash
        // card; anything else is the not-found of an unknown id.
        try {
          return { trashEntry: await getKnowledgeTrashEntry(api, id) }
        } catch {
          return "not-found"
        }
      }
    },
  )

  /** The editor opens with this text (null: read only). Set once per page. */
  const [editorText, setEditorText] = createSignal<string | null>(null)
  const [status, setStatus] = createSignal<SaverStatus>({ state: "idle" })
  const [conflictMode, setConflictMode] = createSignal<"choose" | "both" | null>(null)
  const [conflictBusy, setConflictBusy] = createSignal(false)
  /** The conflict comes from a draft found on opening (not from a save). */
  const [fromDraft, setFromDraft] = createSignal(false)
  const [theirName, setTheirName] = createSignal<string | null>(null)
  const [historyOpen, setHistoryOpen] = createSignal(false)
  const [edited, setEdited] = createSignal<string | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const [backlinks, setBacklinks] = createSignal<KnowledgeBacklink[]>([])
  const [shareOpen, setShareOpen] = createSignal(false)

  let saver: PageSaver | null = null
  let editor: RichEditorHandle | undefined
  let titleEl: HTMLHeadingElement | undefined

  // The breadcrumb reads the folder tree; at phone width no sidebar loaded it.
  onMount(() => {
    if (!isCollectionsTreeLoaded() && apiForSidebar) void loadCollectionsTree(apiForSidebar)
  })
  /** The text as it was when the view went away (the editor may be gone). */
  let lastText: { title: string; body: string } | null = null
  const bodyDictation = useDictation({ target: () => editor })

  const row = () => {
    const d = doc()
    return isRow(d) ? d : null
  }
  const editable = () => {
    const d = row()
    return !!d && d.canEdit === true && !d.syncedSourceId
  }

  /** The text in the editor now (the title as typed, the body serialized on demand). */
  const readText = () => {
    if (lastText) return lastText
    const d = row()
    return {
      title: titleEl?.textContent ?? d?.title ?? "",
      body: editor ? editor.markdown() : (untrack(editorText) ?? d?.body ?? ""),
    }
  }

  const setTitle = (title: string) => {
    if (titleEl && document.activeElement !== titleEl && titleEl.textContent !== title)
      titleEl.textContent = title
  }

  // ── Who edited last ───────────────────────────────────────────────────────
  const editedLine = (name: string | null, self: boolean, at: string | undefined) => {
    const when = relativeTime(at ?? null, i18n.locale(), { style: "long" }) || ""
    if (self) return i18n.t("knowledge.autosave.editedByYou", { when })
    if (name) return i18n.t("knowledge.autosave.editedBy", { name, when })
    return when ? i18n.t("knowledge.autosave.edited", { when }) : null
  }
  const loadEdited = async (d: KnowledgeDocumentFetched) => {
    if (!api) return
    setEdited(editedLine(null, false, d.updatedAt))
    if (!editable()) return
    try {
      const versions = await listKnowledgeVersions(api, d.id)
      const last = versions.find((v) => v.kind !== "unapplied")
      if (last)
        setEdited(
          editedLine(
            versionAuthor(last, i18n.t),
            last.authorType === "user" && last.authorId === me(),
            d.updatedAt,
          ),
        )
    } catch {
      // The line keeps the date alone.
    }
  }

  // ── Who saved theirs (a conflict) ─────────────────────────────────────────
  const loadTheirName = async (theirs: SavedRow) => {
    setTheirName(null)
    if (!api) return
    try {
      const versions = await listKnowledgeVersions(api, theirs.id)
      const last = versions.find((v) => v.kind !== "unapplied")
      if (!last) return
      // My other tab: "another of your tabs", never my own name.
      if (last.authorType === "user" && last.authorId === me()) setTheirName(null)
      else setTheirName(versionAuthor(last, i18n.t))
    } catch {
      setTheirName(i18n.t("knowledge.autosave.someone"))
    }
  }

  // ── The saver of this page view ───────────────────────────────────────────
  let setupFor: string | null = null
  createEffect(() => {
    const d = row()
    if (!d || setupFor === d.id) return
    setupFor = d.id
    untrack(() => {
      void loadEdited(d)
      if (editable() && api && me()) void startEditing(d)
      else setEditorText(null)
      if (titleEl) titleEl.textContent = d.title
    })
  })

  const makeSaver = (
    client: ApiClient,
    userId: string,
    d: KnowledgeDocumentFetched,
    drafts: ReturnType<typeof pageDrafts>,
    liveness: ReturnType<typeof webLocks>,
  ): PageSaver =>
    createPageSaver({
      api: client,
      userId,
      docId: d.id,
      base: { title: d.title, body: d.body, revision: d.revision },
      read: readText,
      currentUserId: me,
      beforeRequest: () => authManager.pendingRefresh(),
      drafts,
      liveness,
      untitled: () => i18n.t("knowledge.untitled"),
      onStatus: (next) => {
        setStatus(next)
        if (next.state === "conflict" && next.theirs) void loadTheirName(next.theirs)
      },
      onSaved: saved,
      onTitleAdopted: (title) => {
        if (titleEl) titleEl.textContent = title
      },
    })

  const startEditing = async (d: KnowledgeDocumentFetched) => {
    const userId = me()
    if (!api || !userId) return
    const drafts = pageDrafts()
    const liveness = webLocks()
    let opened: Awaited<ReturnType<typeof openDrafts>> = {
      restore: null,
      conflict: null,
      extra: [],
    }
    // Made a moment ago from the text in the folder view: no draft can be older than
    // the page, and waiting for the drafts store would drop the keys typed meanwhile.
    const fresh = props.folder?.fresh
    if (fresh && fresh.row.id === d.id) {
      focusOnOpen = true
      setEditorText(fresh.text)
      const s = makeSaver(api, userId, d, drafts, liveness)
      saver = s
      if (fresh.text === d.body) return
      if (fresh.existing) {
        // Someone else's text is the page: mine is never saved over it, the person
        // chooses (Keep mine, Take theirs, See both).
        s.markConflict({ ...d })
        await s.persistDraft()
      } else s.edit()
      return
    }
    try {
      opened = await openDrafts({
        drafts,
        liveness,
        userId,
        docId: d.id,
        current: d,
        inHistory: draftInHistory(api, userId),
      })
    } catch {
      // No drafts store here: the page opens on its stored text.
    }
    if (setupFor !== d.id) return
    const draft = opened.restore ?? opened.conflict
    setEditorText(draft ? draft.body : d.body)
    if (draft && titleEl) titleEl.textContent = draft.title || d.title
    const s = makeSaver(api, userId, d, drafts, liveness)
    saver = s
    if (opened.restore) {
      s.edit()
      await s.persistDraft()
      await drafts.remove(draftKey(opened.restore)).catch(() => {})
      addToast({ type: "info", message: i18n.t("knowledge.autosave.restoredDraft") })
    } else if (opened.conflict) {
      setFromDraft(true)
      s.markConflict({ ...d })
      await s.persistDraft()
      await drafts.remove(draftKey(opened.conflict)).catch(() => {})
    }
    for (const extra of opened.extra)
      await postDraftToHistory(api, drafts, extra, i18n.t("knowledge.untitled"))
  }

  // ── Files ────────────────────────────────────────────────────────────────
  const fileView = api ? pageFileView(api, i18n.t) : null
  // Links to other pages: titles for this reader, and the writer's `@` / `[[` picker.
  const pageLinks = api ? pageLinkDeps(api, i18n.t) : null
  const pagePicker = api ? editorPages(api, i18n.t, props.entityId) : undefined
  const refused = (message: string) => addToast({ type: "warning", message })
  const upload = async (file: File): Promise<string> => {
    const d = row()
    if (!api || !d) throw new Error(i18n.t("knowledge.files.failed", { name: file.name }))
    try {
      return (await uploadPageFile(api, d.id, file)).id
    } catch (err) {
      throw new Error(uploadRefusal(i18n.t, err, file.name))
    }
  }
  const editorFiles = fileView
    ? {
        view: fileView,
        upload,
        onRefused: refused,
        unreadable: i18n.t("knowledge.files.unreadable"),
        uploading: (name: string) => i18n.t("kernel.editor.uploadingFile", { name }),
      }
    : undefined
  const addFiles = (files: File[]) => {
    for (const file of files) void upload(file).catch((err: Error) => refused(err.message))
  }
  /** Files of other pages the save could not copy yet (storage full): said once each. */
  const toldNotCopied = new Set<string>()
  const filesOfSave = (stored: SavedRow) => {
    const map = stored.fileIdMap as Record<string, string> | undefined
    if (map && Object.keys(map).length) editor?.replaceFileIds(map)
    const notCopied = (stored.notCopied as Array<{ id: string; reason: string }> | undefined) ?? []
    const later = notCopied.filter(
      (n) => (n.reason === "quota" || n.reason === "storage") && !toldNotCopied.has(n.id),
    )
    for (const n of later) toldNotCopied.add(n.id)
    if (later.length) refused(i18n.t("knowledge.files.copyLater"))
  }

  /** The server stored this view's text. */
  const saved = (stored: SavedRow) => {
    filesOfSave(stored)
    const before = row()
    mutate((d) =>
      isRow(d) ? ({ ...d, ...stored, body: stored.body, title: stored.title } as Fetched) : d,
    )
    setEdited(editedLine(null, true, new Date().toISOString()))
    if (before && before.title !== stored.title) {
      void loadDocuments(apiForSidebar)
      void loadCollectionsTree(apiForSidebar)
      void loadCollectionsTree(apiForSidebar)
    }
  }

  // Someone else's save arrives (the socket refreshed the page in the store): taken
  // in place while this view has nothing unsaved; otherwise the next save meets it.
  createEffect(
    on(
      () => knowledgeStore.documentsById[props.entityId] as SavedRow | undefined,
      (remote) => {
        const s = saver
        if (!remote || !s || typeof remote.revision !== "number") return
        // Our own save comes back here too: its revision is not newer.
        if (remote.revision <= s.revision()) return
        if (!s.adoptRemote(remote)) return
        editor?.applyRemote(remote.body)
        setTitle(remote.title)
        mutate((d) => (isRow(d) ? ({ ...d, ...remote } as Fetched) : d))
      },
    ),
  )

  // ── Leaving the page (tab closed, another page, sign-out) ────────────────
  const leave = () => {
    const s = saver
    saver = null
    if (!s) return
    try {
      lastText = readText()
    } catch {
      lastText = { title: row()?.title ?? "", body: row()?.body ?? "" }
    }
    const st = s.status()
    if (st.state === "conflict" && st.theirs) {
      // D7: theirs is shown, mine goes to Page history.
      const theirs = st.theirs
      void s
        .takeTheirs(theirs)
        .then((ok) =>
          addToast({
            type: ok ? "info" : "warning",
            message: i18n.t(
              ok ? "knowledge.autosave.leftConflictToast" : "knowledge.autosave.notStoredToast",
            ),
          }),
        )
        .finally(() => void s.destroy())
    } else {
      void s.flush().finally(() => void s.destroy())
    }
  }
  createEffect(
    on(
      () => props.entityId,
      () => {
        leave()
        lastText = null
        setupFor = null
        setEditorText(null)
        setStatus({ state: "idle" })
        setConflictMode(null)
        setFromDraft(false)
        setHistoryOpen(false)
      },
      { defer: true },
    ),
  )
  onCleanup(() => {
    docController?.abort()
    leave()
  })

  // A page that is not found closes its tab, unless this view holds text that is
  // not saved yet: that text stays on screen until the person has it (edge 3).
  createEffect(() => {
    if (doc() === "not-found" && !(saver?.hasUnsaved() ?? false)) {
      // A folder's page that went away leaves the folder open: it asks again.
      if (props.folder) props.folder.onGone()
      else evictTabByEntity("knowledge:document", props.entityId)
    }
  })

  // What links here; asked again each time the list is opened, so titles are current.
  let backlinksAsk: AbortController | undefined
  const loadBacklinks = (id: string) => {
    if (!id || !api) return
    backlinksAsk?.abort()
    const ac = new AbortController()
    backlinksAsk = ac
    void getKnowledgeDocumentBacklinks(api, id, { signal: ac.signal })
      .then((result) => {
        if (!ac.signal.aborted) setBacklinks(result.backlinks ?? [])
      })
      .catch(() => {
        if (!ac.signal.aborted) setBacklinks([])
      })
  }
  createEffect(() => loadBacklinks(props.entityId))
  onCleanup(() => backlinksAsk?.abort())

  // ── Conflict choices ──────────────────────────────────────────────────────
  const theirs = () => {
    const st = status()
    return st.state === "conflict" ? (st.theirs ?? null) : null
  }
  const keepMine = async () => {
    const s = saver
    const t = theirs()
    if (!s || !t) return
    setConflictBusy(true)
    try {
      await s.keepMine(t.revision)
      if (s.status().state === "saved") {
        setConflictMode(null)
        setFromDraft(false)
        addToast({ type: "success", message: i18n.t("knowledge.autosave.keptMineToast") })
      }
    } finally {
      setConflictBusy(false)
    }
  }
  const takeTheirs = async () => {
    const s = saver
    const t = theirs()
    if (!s || !t) return
    setConflictBusy(true)
    try {
      if (await s.takeTheirs(t)) {
        editor?.applyRemote(t.body)
        if (titleEl) titleEl.textContent = t.title
        mutate((d) => (isRow(d) ? ({ ...d, ...t } as Fetched) : d))
        setConflictMode(null)
        setFromDraft(false)
        addToast({ type: "success", message: i18n.t("knowledge.autosave.tookTheirsToast") })
      } else {
        addToast({ type: "warning", message: i18n.t("knowledge.autosave.notStoredToast") })
      }
    } finally {
      setConflictBusy(false)
    }
  }

  // ── Page actions ──────────────────────────────────────────────────────────
  const act = async (run: () => Promise<unknown>, failed: string) => {
    setActionError(null)
    try {
      await run()
      void refetchMeta()
      void loadDocuments(apiForSidebar)
      void loadCollectionsTree(apiForSidebar)
    } catch (err) {
      setActionError(err instanceof Error && err.message ? err.message : i18n.t(failed))
    }
  }
  /** The page's state again, without touching the text being edited. */
  const refetchMeta = async () => {
    if (!api) return
    if (!saver) {
      await refetch()
      return
    }
    try {
      const fresh = (await getKnowledgeDocument(api, props.entityId)) as KnowledgeDocumentFetched
      // Verify, archive and sharing move the revision without the text.
      saver?.adoptRemote({
        id: fresh.id,
        title: fresh.title,
        body: fresh.body,
        revision: fresh.revision,
      })
      mutate((d) => (isRow(d) ? ({ ...d, ...fresh, title: d.title, body: d.body } as Fetched) : d))
    } catch {
      // The header keeps what it showed.
    }
  }
  const verify = () =>
    act(async () => {
      await saver?.flush()
      const d = row()
      if (d && api)
        await verifyKnowledgeDocument(api, d.id, { revision: saver?.revision() ?? d.revision })
    }, "knowledge.verifyFailed")
  // ── Trash (S19, D3) ──────────────────────────────────────────────────────
  let disposed = false
  onCleanup(() => {
    disposed = true
  })
  const trashOffered = () => editable() && canMoveToTrash()
  const trashPage = async () => {
    const d = row()
    if (!d || !api) return
    setActionError(null)
    // The text typed so far is saved first; text that cannot be saved stays here.
    const s = saver
    await s?.flush()
    if (s?.hasUnsaved()) {
      setActionError(i18n.t("knowledge.trash.unsavedRefused"))
      return
    }
    const page = { id: d.id, title: titleEl?.textContent || d.title }
    try {
      await moveToTrash(api, page, i18n.t, {
        onRestored: () => {
          if (!disposed && props.entityId === page.id) void refetch()
        },
      })
    } catch (err) {
      setActionError(i18n.t(trashRefusalKey(err, "trash")))
      return
    }
    // The page is in Trash: this view stops editing it and shows its Trash card.
    saver = null
    setupFor = null
    setEditorText(null)
    setStatus({ state: "idle" })
    if (s) void s.destroy()
    // In Trash it is no longer the folder's page: the folder view asks again.
    if (props.folder) props.folder.onGone()
    else void refetch()
  }
  const [restoring, setRestoring] = createSignal(false)
  const restoreTrashed = async (entry: KnowledgeTrashEntry) => {
    if (!api) return
    setRestoring(true)
    try {
      if (await restoreFromTrash(api, entry, i18n.t)) await refetch()
    } finally {
      setRestoring(false)
    }
  }
  const trashed = () => {
    const d = doc()
    return d && d !== "not-found" && "trashEntry" in d ? d.trashEntry : null
  }

  const openHistory = async () => {
    await saver?.flush()
    setHistoryOpen(true)
  }

  const restoreVersion = async (v: KnowledgeVersionItem): Promise<boolean> => {
    const d = row()
    const s = saver
    if (!d || !api || !s) return false
    await s.flush()
    if (s.hasUnsaved()) {
      addToast({ type: "error", message: i18n.t("knowledge.autosave.restoreFailed") })
      return false
    }
    try {
      const restored = (await restoreKnowledgeVersion(api, d.id, v.id, s.revision())) as SavedRow
      s.adoptRemote(restored)
      editor?.applyRemote(restored.body)
      if (titleEl) titleEl.textContent = restored.title
      mutate((x) => (isRow(x) ? ({ ...x, ...restored } as Fetched) : x))
      setHistoryOpen(false)
      void loadDocuments(apiForSidebar)
      void loadCollectionsTree(apiForSidebar)
      addToast({ type: "success", message: i18n.t("knowledge.autosave.restoredToast") })
      return true
    } catch {
      addToast({ type: "error", message: i18n.t("knowledge.autosave.restoreFailed") })
      return false
    }
  }

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(readText().body)
      addToast({ type: "success", message: i18n.t("knowledge.autosave.copied") })
    } catch {
      addToast({ type: "error", message: i18n.t("knowledge.autosave.copyFailed") })
    }
  }

  const notice = (
    testid: string,
    text: string,
    action?: { label: string; run: () => void; testid: string },
  ) => (
    <div
      data-testid={testid}
      role="alert"
      class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] text-text"
    >
      <span class="min-w-0 flex-1 basis-60">{text}</span>
      <Show when={action}>
        {(a) => (
          <Button variant="outline" size="sm" data-testid={a().testid} onClick={() => a().run()}>
            {a().label}
          </Button>
        )}
      </Show>
    </div>
  )

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
      <Show when={trashed()}>
        {(entry) => (
          <div class="flex h-full items-start justify-center p-4 pt-16">
            <div
              data-testid="knowledge-doc-trash-card"
              class="flex w-full max-w-md flex-col gap-3 rounded-md border border-border-subtle bg-surface px-4 py-3"
            >
              <div class="flex min-w-0 flex-col gap-0.5">
                <span class="truncate text-[13px] font-medium text-text">{entry().title}</span>
                <span class="text-[12px] text-text-tertiary">
                  {i18n.t("knowledge.trash.pageInTrash")}{" "}
                  {trashedLine(entry(), me(), i18n.locale(), i18n.t)}
                </span>
                <span data-testid="knowledge-trash-days" class="text-[12px] text-text-tertiary">
                  {daysLeftLabel(entry(), i18n.t)}
                </span>
              </div>
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="knowledge-doc-trash-restore"
                  disabled={restoring()}
                  onClick={() => void restoreTrashed(entry())}
                >
                  {i18n.t("knowledge.trash.restore")}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Show>
      <Show when={row()}>
        {(d) => (
          <div
            data-testid="knowledge-document-view"
            data-document-id={d().id}
            // A guided tour points at a seeded document by its title.
            data-doc-title={d().title}
            class="flex h-full flex-col"
          >
            <Show when={historyOpen() && api}>
              <PageHistory
                api={api!}
                docId={d().id}
                me={me()}
                current={{ title: d().title, body: d().body }}
                onRestore={restoreVersion}
                onClose={() => setHistoryOpen(false)}
              />
            </Show>
            <div class="flex min-h-0 flex-1 flex-col" classList={{ hidden: historyOpen() }}>
              <PageHeader
                doc={d()}
                editable={editorText() !== null}
                hasHistory={editable()}
                phone={phone()}
                status={status()}
                edited={edited()}
                backlinks={backlinks()}
                onBacklinksOpen={() => loadBacklinks(props.entityId)}
                dictation={bodyDictation}
                editor={() => editor}
                titleRef={(el) => {
                  titleEl = el
                  el.textContent = d().title
                }}
                onTitleInput={() => saver?.edit()}
                onTitleDone={() => editor?.focus()}
                onShare={() => setShareOpen(true)}
                onHistory={() => void openHistory()}
                onVerify={() => void verify()}
                canTrash={trashOffered()}
                onTrash={() => void trashPage()}
              />

              <Show
                when={
                  status().state === "conflict" ||
                  status().state === "no-access" ||
                  status().state === "too-large" ||
                  actionError()
                }
              >
                <div
                  class={`flex shrink-0 flex-col gap-2 pt-3 ${phone() ? "px-4" : "mx-auto w-full max-w-2xl px-8"}`}
                >
                  <Show when={status().state === "conflict"}>
                    {notice(
                      "knowledge-doc-conflict-banner",
                      fromDraft()
                        ? i18n.t("knowledge.autosave.draftConflictBanner")
                        : theirName()
                          ? i18n.t("knowledge.autosave.conflictBanner", { name: theirName() ?? "" })
                          : i18n.t("knowledge.autosave.conflictBannerSelf"),
                      {
                        label: i18n.t("knowledge.autosave.chooseWhatToKeep"),
                        run: () => setConflictMode("choose"),
                        testid: "conflict-open",
                      },
                    )}
                  </Show>
                  <Show when={status().state === "no-access"}>
                    {notice(
                      "knowledge-doc-no-access",
                      i18n.t("knowledge.autosave.noAccessNotice"),
                      {
                        label: i18n.t("knowledge.autosave.copyText"),
                        run: () => void copyText(),
                        testid: "knowledge-doc-copy-text",
                      },
                    )}
                  </Show>
                  <Show when={status().state === "too-large"}>
                    {notice(
                      "knowledge-doc-too-large",
                      i18n.t("knowledge.autosave.tooLargeNotice", {
                        size: (status().size ?? 0).toLocaleString(i18n.locale()),
                      }),
                    )}
                  </Show>
                  <Show when={actionError()}>
                    <p data-testid="knowledge-doc-error" role="alert" class="text-xs text-danger">
                      {actionError()}
                    </p>
                  </Show>
                </div>
              </Show>

              <PageBody
                doc={d()}
                editorText={editorText()}
                phone={phone()}
                hasApi={!!api}
                editorRef={(handle) => {
                  editor = handle
                  if (focusOnOpen) {
                    focusOnOpen = false
                    handle.focus()
                  }
                }}
                below={props.folder?.below}
                fileView={fileView}
                editorFiles={editorText() !== null ? editorFiles : undefined}
                pageLinks={pageLinks}
                editorPages={editorText() !== null ? pagePicker : undefined}
                onAddFiles={editorText() !== null && api ? addFiles : undefined}
                onEdit={() => saver?.edit()}
                onRefreshSynced={() => {
                  const sourceId = d().syncedSourceId
                  if (!api || !sourceId) return
                  void runSyncedSourceNow(api, sourceId).catch(() =>
                    setActionError(i18n.t("knowledge.refreshFailed")),
                  )
                }}
              />
            </div>

            <ConflictDialog
              open={conflictMode() !== null && theirs() !== null}
              mode={conflictMode() ?? "choose"}
              theirName={fromDraft() ? i18n.t("knowledge.autosave.someone") : theirName()}
              mine={conflictMode() ? readText().body : ""}
              theirs={theirs()?.body ?? ""}
              busy={conflictBusy()}
              onMode={setConflictMode}
              onKeepMine={() => void keepMine()}
              onTakeTheirs={() => void takeTheirs()}
              onClose={() => setConflictMode(null)}
            />

            <KnowledgeShareDialog
              documentId={d().id}
              documentTitle={d().title}
              open={shareOpen()}
              onOpenChange={setShareOpen}
            />
          </div>
        )}
      </Show>
    </Show>
  )
}

export default KnowledgeDocumentView
