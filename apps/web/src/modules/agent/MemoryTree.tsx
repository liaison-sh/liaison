// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * One agent's memory tree as a file browser, with the in place editor.
 *
 * ORDER IS NORMATIVE (spec-memory.md): `MEMORY.md` first, then the type
 * folders, then earlier chats grouped per thread, then the conversation
 * summaries. The four group headers always render, empty or not, so the shape
 * of the tree is legible before anything has been remembered.
 *
 * The list uses `ResponsiveList` so a desktop row becomes a phone card with no
 * JS tier branching; the desktop row and the phone card carry DIFFERENT
 * testids (`agent-memory-file-<path>` and `agent-memory-card-<path>`) because
 * both markups are in the document at once and an unscoped duplicate testid
 * would be ambiguous.
 *
 * The REST contract this reads and writes is documented on `AgentProfile.tsx`.
 *
 * CREATE AND DELETE ARE THE TYPED MEMORY ROUTES (P4c FX-F1). The tree surface
 * is tree / file / search / forget: it has no create and no delete. The
 * unmounted flat screens (`MemoriesList` / `MemoryDetail`) had both, over
 * `POST /api/agent/memories` and `DELETE /api/agent/memories/:type/:name`, and
 * those are the calls this tab makes now, through `memories-store`, with the
 * SAME gating those screens had: none in the client, because the routes are
 * per user RLS plus `kernel:agent:memory:write` on the server. A typed memory
 * renders into the tree as `<type>/<name>.md`, so the tree is still the reader
 * of record and both mutations reload it rather than patching it locally.
 * Episodes and checkpoints are NOT typed memories: they carry no delete here,
 * only "Forget this conversation".
 */
import {
  capabilityCategories,
  MEMORY_TYPES,
  type MemoryType,
  resolveMemoryLinks,
} from "@liaison/shared"
import { Brain, ChevronLeft, Search } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
} from "solid-js"
import { cn } from "~/lib/cn"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { trackOpenRecord } from "~/modules/shell/open-record"
import { shellTier } from "~/modules/shell/shell-tier"
import { ResponsiveDetail } from "~/ui/ResponsiveDetail"
import { ResponsiveList } from "~/ui/ResponsiveList"
import {
  type AgentMemoryFile,
  type AgentMemoryHit,
  agentMemoryStore,
  clearAgentMemorySearch,
  forgetThreadMemory,
  hiddenMemoryCount,
  isCheckpointPath,
  isEditablePath,
  isEpisodePath,
  loadAgentMemoryFileBody,
  loadAgentMemoryTree,
  MEMORY_INDEX_MAX_LINES,
  MEMORY_INDEX_PATH,
  memoryRowParts,
  saveAgentMemoryFile,
  searchAgentMemory,
  setOpenMemoryPath,
  threadOfPath,
  visibleMemoryFiles,
  visibleMemoryHits,
} from "./agent-memory-store"
import MarkdownEditor from "./MarkdownEditor"
import { createMemory, deleteMemory, loadMemories, memoriesStore } from "./memories-store"

interface Props {
  agentId: string
  /** The agent's display name, interpolated into the forget confirmation. */
  agentName?: string
  /** A deep link's `?selected=<path>`: the file to open on arrival. */
  selected?: string
  /** The viewer picked something else, so the page drops the param. */
  onSelectedCleared?: () => void
  /** This tab is the one showing. Absent means yes. */
  active?: boolean
}

/** The name rule the flat create form enforced, unchanged. */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** A typed memory, addressed the way the tree renders it: `<type>/<name>.md`.
 *  Anything else (an episode, a checkpoint, `MEMORY.md`) is not one. */
function typedMemoryOf(path: string): { type: MemoryType; name: string } | null {
  const match = /^([a-z]+)\/(.+)\.md$/.exec(path)
  if (!match) return null
  const type = match[1] as MemoryType
  if (!(MEMORY_TYPES as readonly string[]).includes(type)) return null
  return { type, name: match[2] as string }
}

const MemoryTree: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  /** Who may read a raw scope name on this surface: the agents admin, nobody
   *  else. Everyone else reads capability categories. */
  const scopeAdmin = () => hasScope("kernel:agents:admin")
  const [draft, setDraft] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [saveError, setSaveError] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal("")
  const [forgetting, setForgetting] = createSignal(false)
  const [forgetPrompt, setForgetPrompt] = createSignal<string | null>(null)
  const [forgetResult, setForgetResult] = createSignal<{
    episodesDeleted: number
    checkpointsDeleted: number
  } | null>(null)
  const [forgetError, setForgetError] = createSignal<string | null>(null)

  // The typed memory create form, and the inline delete confirmation.
  const [creating, setCreating] = createSignal(false)
  const [newType, setNewType] = createSignal<MemoryType>("user")
  const [newName, setNewName] = createSignal("")
  const [newDescription, setNewDescription] = createSignal("")
  const [newContent, setNewContent] = createSignal("")
  const [createError, setCreateError] = createSignal<string | null>(null)
  const [createBusy, setCreateBusy] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  const [deleteError, setDeleteError] = createSignal<string | null>(null)
  const [deleteBusy, setDeleteBusy] = createSignal(false)

  // The file the viewer opened, under the agent whose tree it is: the turn may
  // be talking to another agent, and only the server can say what path that is.
  trackOpenRecord("kernel", "memory_file", () => {
    const path = agentMemoryStore.openPath
    if (props.active === false || !path || agentMemoryStore.agentId !== props.agentId) return null
    return `${props.agentId}:${path}`
  })

  /** The scrolling tree column, so the create form can be scrolled into view. */
  let listRef: HTMLDivElement | undefined

  onMount(() => {
    if (agentMemoryStore.agentId !== props.agentId) {
      void loadAgentMemoryTree(api as never, props.agentId)
    }
    // The typed memory rows, for `[[name]]` resolution: a link names a memory,
    // not a path, and the rows are what say which type it lives under.
    if (memoriesStore.memories.length === 0) void loadMemories(api as never)
  })

  // A deep link's selection, consumed ONCE: after that the viewer's own clicks
  // own the open file, and the page drops the param.
  let consumedSelection: string | null = null
  createEffect(() => {
    const path = props.selected
    if (!path || path === consumedSelection) return
    const file = visibleMemoryFiles().find((f) => f.path === path)
    if (!file) return
    consumedSelection = path
    void select(file)
  })

  const indexFiles = createMemo(() =>
    visibleMemoryFiles().filter((f) => f.path === MEMORY_INDEX_PATH),
  )
  const topicFiles = createMemo(() =>
    visibleMemoryFiles().filter(
      (f) => f.path !== MEMORY_INDEX_PATH && !isEpisodePath(f.path) && !isCheckpointPath(f.path),
    ),
  )
  /** Episodes read per thread: `episodes/<thread handle>/<date>.md`. */
  const episodeFiles = createMemo(() =>
    visibleMemoryFiles()
      .filter((f) => isEpisodePath(f.path))
      .sort((a, b) => a.path.localeCompare(b.path)),
  )
  const checkpointFiles = createMemo(() =>
    visibleMemoryFiles().filter((f) => isCheckpointPath(f.path)),
  )

  const openFile = createMemo<AgentMemoryFile | null>(
    () => visibleMemoryFiles().find((f) => f.path === agentMemoryStore.openPath) ?? null,
  )
  const body = createMemo(() => {
    const path = agentMemoryStore.openPath
    return path ? (agentMemoryStore.bodies[path] ?? "") : ""
  })
  const editing = createMemo(() => draft() !== null)
  /** Edit opens on the file as read: before it arrives, the draft would start
   *  empty and a save would write the file over with what was typed alone. */
  const bodyLoaded = () => {
    const path = agentMemoryStore.openPath
    return !!path && path in agentMemoryStore.bodies
  }

  async function select(file: AgentMemoryFile) {
    setDraft(null)
    setSaveError(null)
    setConfirmDelete(false)
    setDeleteError(null)
    setOpenMemoryPath(file.path)
    await loadAgentMemoryFileBody(api as never, props.agentId, file.path)
  }

  /** A row the viewer clicked: their choice replaces any deep linked one. */
  function pick(file: AgentMemoryFile) {
    props.onSelectedCleared?.()
    void select(file)
  }

  /** Open one path directly, whether or not the tree already lists it (a
   *  `[[name]]` link and a freshly created memory both land here). */
  async function openPath(path: string) {
    setDraft(null)
    setSaveError(null)
    setConfirmDelete(false)
    setDeleteError(null)
    props.onSelectedCleared?.()
    setOpenMemoryPath(path)
    await loadAgentMemoryFileBody(api as never, props.agentId, path)
  }

  function startCreate() {
    setNewType("user")
    setNewName("")
    setNewDescription("")
    setNewContent("")
    setCreateError(null)
    setCreating(true)
  }

  async function createEntry() {
    setCreateError(null)
    if (!SLUG_RE.test(newName())) {
      setCreateError(i18n.t("kernel.agentForms.memoryNameInvalid"))
      return
    }
    if (!newDescription().trim()) {
      setCreateError(i18n.t("kernel.agentForms.memoryDescriptionRequired"))
      return
    }
    if (!newContent().trim()) {
      setCreateError(i18n.t("kernel.agentForms.memoryContentRequired"))
      return
    }
    setCreateBusy(true)
    try {
      const type = newType()
      const name = newName()
      await createMemory(api as never, {
        type,
        name,
        description: newDescription(),
        content: newContent(),
      })
      setCreating(false)
      await loadAgentMemoryTree(api as never, props.agentId)
      await openPath(`${type}/${name}.md`)
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : i18n.t("kernel.agentForms.memoryCreateFailed"),
      )
    } finally {
      setCreateBusy(false)
    }
  }

  /** The open file, when it is a typed memory the viewer may delete. */
  const deletableEntry = createMemo(() => {
    const path = agentMemoryStore.openPath
    return path ? typedMemoryOf(path) : null
  })

  async function deleteEntry() {
    const entry = deletableEntry()
    if (!entry) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await deleteMemory(api as never, entry.type, entry.name)
      setOpenMemoryPath(null)
      setConfirmDelete(false)
      await loadAgentMemoryTree(api as never, props.agentId)
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : i18n.t("kernel.agentForms.memoryDeleteFailed"),
      )
    } finally {
      setDeleteBusy(false)
    }
  }

  /** What the `[[name]]` preview resolves against: the text on screen. */
  const linkSource = createMemo(() => (editing() ? (draft() ?? "") : body()))

  async function save() {
    const path = agentMemoryStore.openPath
    const next = draft()
    if (!path || next === null) return
    setBusy(true)
    setSaveError(null)
    try {
      await saveAgentMemoryFile(api as never, props.agentId, path, next)
      setDraft(null)
    } catch {
      setSaveError(i18n.t("kernel.agentMemorySaveFailed"))
    } finally {
      setBusy(false)
    }
  }

  function groupLabel(kind: AgentMemoryHit["kind"]): string {
    if (kind === "file") return i18n.t("kernel.agentMemorySearchGroupFiles")
    if (kind === "episode") return i18n.t("kernel.agentMemorySearchGroupEpisodes")
    return i18n.t("kernel.agentMemorySearchGroupTranscript")
  }

  async function runSearch() {
    await searchAgentMemory(api as never, props.agentId, query())
  }

  function clearSearch() {
    setQuery("")
    clearAgentMemorySearch()
  }

  const hitsOfKind = (kind: AgentMemoryHit["kind"]) =>
    visibleMemoryHits()
      .filter((h) => h.kind === kind)
      .sort((a, b) => b.fusedScore - a.fusedScore || a.key.localeCompare(b.key))

  /** The groups render in the order the fusion legs are named: memory files,
   *  then earlier chats, then what was actually said. */
  const searchGroups = createMemo(() =>
    (["file", "episode", "transcript"] as const)
      .map((kind) => ({ kind, hits: hitsOfKind(kind) }))
      .filter((g) => g.hits.length > 0),
  )

  const forgetThread = createMemo(() => {
    const path = agentMemoryStore.openPath
    return path ? threadOfPath(path) : null
  })

  async function confirmForget() {
    const thread = forgetPrompt()
    if (!thread) return
    setForgetting(true)
    setForgetError(null)
    try {
      const result = await forgetThreadMemory(api as never, props.agentId, thread)
      setForgetResult(result)
      setForgetPrompt(null)
    } catch {
      setForgetError(i18n.t("kernel.agentMemoryForgetFailed"))
    } finally {
      setForgetting(false)
    }
  }

  const isPhone = () => shellTier() === "phone"

  /** Phone shows ONE pane: the tree, or the file a row pushed over it. */
  const showDetailPane = () => !isPhone() || agentMemoryStore.openPath !== null
  const showListPane = () => !isPhone() || agentMemoryStore.openPath === null

  /** The thread titles the tree already knows: the conversation summaries
   *  group carries one row per thread, named by the THREAD, so an episode of
   *  the same conversation can be named the same way rather than by the
   *  handle in its path. */
  const threadTitles = createMemo(() => {
    const titles = new Map<string, string>()
    for (const file of visibleMemoryFiles()) {
      if (!isCheckpointPath(file.path)) continue
      const handle = threadOfPath(file.path)
      if (handle && file.name) titles.set(handle, file.name)
    }
    return titles
  })

  function rowParts(file: AgentMemoryFile): { title: string; date: string | null } {
    const handle = threadOfPath(file.path)
    return memoryRowParts(file, handle ? threadTitles().get(handle) : null)
  }

  /**
   * The row's title line.
   *
   * THE DAY IS NOT INSIDE THE TITLE. Glued into one string it was the first
   * thing the 320 px column cut, so a long conversation title took the day
   * away with it and the row said less than the name it was given to replace.
   * It is its own piece, which does not shrink, after a title that does.
   * A row with no day keeps exactly the markup it had.
   */
  function rowTitleLine(file: AgentMemoryFile, testidPrefix: string, titleClass: string) {
    const parts = rowParts(file)
    const title = (
      <span data-testid={`agent-memory-${testidPrefix}title-${file.path}`} class={titleClass}>
        {parts.title}
      </span>
    )
    if (!parts.date) return title
    return (
      // ONE LABEL, NOT A SPACE BETWEEN ROW. The title was `w-full`, so it ate
      // the whole line and shoved the day against the far edge: the row read
      // "qa-approval-3417            , 2026-09-17", two columns rather than one
      // name. The title takes only what it needs, truncating when it must, and
      // the day follows it immediately, muted.
      <span class="flex w-full min-w-0 items-baseline">
        <span
          data-testid={`agent-memory-${testidPrefix}title-${file.path}`}
          class={cn(titleClass, "w-auto min-w-0 shrink truncate")}
        >
          {parts.title}
        </span>
        <span
          data-testid={`agent-memory-${testidPrefix}date-${file.path}`}
          class="shrink-0 text-[13px] text-text-tertiary"
        >
          , {parts.date}
        </span>
      </span>
    )
  }

  function group(id: string, label: string, files: () => AgentMemoryFile[]) {
    return (
      <section class="border-b border-border-subtle" data-testid={`agent-memory-section-${id}`}>
        <header
          data-testid={`agent-memory-group-${id}`}
          class="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-text-tertiary"
        >
          {label}
        </header>
        {/* A HEADER WITH NOTHING UNDER IT SAYS NOTHING. The order is normative
            so the header stays, but an empty group now carries one line of its
            own instead of a bare rule the eye reads as a broken list. The
            whole-tree empty state already speaks when there is nothing at all,
            so this line is only for a group that is empty beside full ones. */}
        <Show when={files().length === 0 && visibleMemoryFiles().length > 0}>
          <p
            data-testid={`agent-memory-group-empty-${id}`}
            class="px-4 pb-3 text-[12px] text-text-tertiary"
          >
            {i18n.t("kernel.agentMemoryGroupEmpty")}
          </p>
        </Show>
        <ResponsiveList
          items={files()}
          renderRow={(file) => (
            <button
              type="button"
              data-testid={`agent-memory-file-${file.path}`}
              aria-current={agentMemoryStore.openPath === file.path ? "true" : undefined}
              onClick={() => pick(file)}
              class="flex min-h-11 w-full flex-col items-start gap-0.5 px-4 py-2.5 text-left transition-colors hover:bg-surface-hover"
              classList={{ "bg-surface-active": agentMemoryStore.openPath === file.path }}
            >
              {/* STACKED, NOT SIDE BY SIDE. The path used to sit on the
                  title's own line, pinned right and refusing to shrink, in a
                  320 px column: the title took whatever was left, which was one
                  character for a topic and nothing at all for an episode. Each
                  gets a full line now, and the ellipsis is its own.

                  The two testids stay OUT of the row's own
                  `agent-memory-file-<path>` namespace, or an oracle counting
                  rows by that prefix counts three elements per row. */}
              {rowTitleLine(file, "row", "w-full min-w-0 truncate text-[13px] text-text")}
              <span
                data-testid={`agent-memory-rowpath-${file.path}`}
                class="w-full truncate text-[11px] text-text-tertiary"
              >
                {file.path}
              </span>
            </button>
          )}
          renderCard={(file) => (
            <button
              type="button"
              data-testid={`agent-memory-card-${file.path}`}
              aria-current={agentMemoryStore.openPath === file.path ? "true" : undefined}
              onClick={() => pick(file)}
              class="flex min-h-11 w-full flex-col items-start gap-1 rounded-md px-1 py-2 text-left"
              classList={{ "bg-surface-active": agentMemoryStore.openPath === file.path }}
            >
              {rowTitleLine(file, "card", "w-full min-w-0 text-[13px] text-text")}
              <span class="w-full break-all text-[11px] text-text-tertiary">{file.path}</span>
            </button>
          )}
        />
      </section>
    )
  }

  return (
    <div data-testid="agent-memory-tree" class="flex h-full min-h-0 flex-col">
      <div class="flex items-center gap-2 border-b border-border-subtle px-4 py-2">
        <Search size={13} class="shrink-0 text-text-tertiary" />
        <input
          type="text"
          data-testid="agent-memory-search-input"
          value={query()}
          placeholder={i18n.t("kernel.agentMemorySearchPlaceholder")}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runSearch()
          }}
          class="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
        />
        <button
          type="button"
          data-testid="agent-memory-search-run"
          onClick={() => void runSearch()}
          class="min-h-11 shrink-0 rounded-md border border-border-subtle px-3 text-[12px] text-text-secondary hover:bg-surface-hover"
        >
          {i18n.t("kernel.agentMemorySearchRun")}
        </button>
        <Show when={agentMemoryStore.searched}>
          <button
            type="button"
            data-testid="agent-memory-search-clear"
            onClick={clearSearch}
            class="min-h-11 shrink-0 rounded-md px-2 text-[12px] text-text-tertiary hover:bg-surface-hover"
          >
            {i18n.t("kernel.agentMemorySearchClear")}
          </button>
        </Show>
        <button
          type="button"
          data-testid="agent-memory-new"
          onClick={startCreate}
          class="min-h-11 shrink-0 rounded-md border border-border-subtle px-3 text-[12px] text-text-secondary hover:bg-surface-hover"
        >
          {i18n.t("kernel.agentForms.memoryNew")}
        </button>
        {/* Forget lives in the HEADER as well as inside an episode file, so
            reaching it does not mean going looking for a conversation's own
            file first. It needs a conversation to be ABOUT though: it offered
            to forget "this conversation" over an empty pane, and over the New
            memory form, where "this conversation" is nothing at all. It renders
            when an episode or a session summary is the open file, and never
            while the create form is up. */}
        <Show when={!creating() && forgetThread() !== null && forgetPrompt() === null}>
          <button
            type="button"
            data-testid="agent-memory-forget"
            onClick={() => {
              setForgetError(null)
              setForgetResult(null)
              // The conversation in view is what "this conversation" means, so
              // the confirm opens on it. Cancel puts this control back.
              setForgetPrompt(forgetThread())
            }}
            class="min-h-11 shrink-0 rounded-md border border-border-subtle px-3 text-[12px] text-text-secondary hover:bg-surface-hover"
          >
            {i18n.t("kernel.agentMemoryForget")}
          </button>
        </Show>
      </div>

      {/* THE ONE FORGET. It used to sit in the header AND a second time, in
          red, above the open file's body: two controls with the same words for
          the same action. Only this one is left, and its confirm renders IN
          PLACE of the header control rather than beside it.

          CANCEL IS A FULL STEP BACK. It used to swap the confirm for a flat
          list of every conversation this agent remembers, each with its own
          destructive link, which replaced the tree and the open file and left
          no way back short of a reload. Cancelling now closes the panel and
          restores exactly what was on screen before the click; a conversation
          that is not open is forgotten by opening it, which is the same one
          affordance every time. */}
      <Show when={forgetPrompt() !== null && !creating() && forgetThread() !== null}>
        <div
          data-testid="memory-forget-panel"
          class="flex flex-col gap-2 border-b border-border-subtle px-4 py-3"
        >
          <p data-testid="agent-memory-forget-confirm-text" class="text-[12px] text-text-secondary">
            {i18n.t("kernel.agentMemoryForgetConfirmBody", {
              agentName: props.agentName ?? "",
            })}
          </p>
          <div class="flex gap-2">
            <button
              type="button"
              data-testid="agent-memory-forget-confirm"
              disabled={forgetting()}
              onClick={() => void confirmForget()}
              class="min-h-11 rounded-md bg-danger px-3 text-[12px] text-white disabled:opacity-60"
            >
              {i18n.t("kernel.agentMemoryForgetConfirm")}
            </button>
            <button
              type="button"
              data-testid="agent-memory-forget-cancel"
              onClick={() => {
                setForgetError(null)
                setForgetPrompt(null)
              }}
              class="min-h-11 rounded-md border border-border-subtle px-3 text-[12px] text-text-secondary hover:bg-surface-hover"
            >
              {i18n.t("kernel.agentMemoryForgetCancel")}
            </button>
          </div>
          <Show when={forgetError()}>
            <p data-testid="agent-memory-forget-error" class="text-[12px] text-red-300">
              {forgetError()}
            </p>
          </Show>
        </div>
      </Show>

      {/* MASTER AND DETAIL, LIKE SKILLS AND ROUTINES. The tree and the editor
          were one column, so the file you opened rendered UNDER the whole tree
          and a desktop window read as a phone one that had lost its content.
          The pair splits here, which is why the root above has a definite
          height: `flex-1` has nothing to divide in a box of auto height. The
          PHONE keeps push navigation: the tree is the screen, a row pushes the
          file over it and Back returns. */}
      <div
        data-testid="agent-memory-panes"
        class="flex min-h-0 flex-1"
        classList={{ "flex-col": isPhone() }}
      >
        <div
          ref={listRef}
          data-testid="agent-memory-list"
          class="flex min-h-0 flex-col overflow-auto border-border-subtle"
          classList={{
            hidden: !showListPane(),
            "w-full": isPhone(),
            "w-[320px] shrink-0 border-r": !isPhone(),
          }}
        >
          {/* The create form the flat detail screen used to be: a type, a slug, a
          one line hook and the body. Inline, never a popup.

          IT MOUNTS AT THE TOP OF A COLUMN THAT SCROLLS. With the tree scrolled
          down, New memory put the form out of view and the button read as
          dead, so the form brings itself into view on open. */}
          <Show when={creating()}>
            <div
              ref={(el) => {
                // The element is in the document by the time the microtask
                // runs, which is what `scrollIntoView` needs.
                queueMicrotask(() => {
                  if (listRef) listRef.scrollTop = 0
                  el.scrollIntoView?.({ block: "nearest" })
                })
              }}
              data-testid="agent-memory-create"
              class="flex flex-col gap-3 border-b border-border-subtle px-4 py-3"
            >
              <label class="flex flex-col gap-1 text-[12px] text-text-tertiary">
                {i18n.t("kernel.agentForms.type")}
                <select
                  data-testid="agent-memory-create-type"
                  value={newType()}
                  onChange={(e) => setNewType(e.currentTarget.value as MemoryType)}
                  class="rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[13px] text-text outline-none"
                >
                  <For each={MEMORY_TYPES}>{(t) => <option value={t}>{t}</option>}</For>
                </select>
              </label>
              <label class="flex flex-col gap-1 text-[12px] text-text-tertiary">
                {i18n.t("kernel.agentForms.memoryNameSlug")}
                <input
                  type="text"
                  data-testid="agent-memory-create-name"
                  value={newName()}
                  placeholder={i18n.t("kernel.agentUi.memoryNamePlaceholder")}
                  onInput={(e) => setNewName(e.currentTarget.value)}
                  class="rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[13px] text-text outline-none"
                />
              </label>
              <label class="flex flex-col gap-1 text-[12px] text-text-tertiary">
                {i18n.t("kernel.agentForms.memoryDescriptionHook")}
                <input
                  type="text"
                  data-testid="agent-memory-create-description"
                  value={newDescription()}
                  placeholder={i18n.t("kernel.agentForms.memoryDescriptionExample")}
                  onInput={(e) => setNewDescription(e.currentTarget.value)}
                  class="rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[13px] text-text outline-none"
                />
              </label>
              <label class="flex flex-col gap-1 text-[12px] text-text-tertiary">
                {i18n.t("kernel.agentForms.memoryContent")}
                <textarea
                  data-testid="agent-memory-create-content"
                  value={newContent()}
                  rows={6}
                  onInput={(e) => setNewContent(e.currentTarget.value)}
                  class="resize-y rounded-md border border-border-subtle bg-surface px-2 py-1.5 text-[13px] text-text outline-none"
                />
              </label>
              <Show when={createError()}>
                <p data-testid="agent-memory-create-error" class="text-[12px] text-red-300">
                  {createError()}
                </p>
              </Show>
              <div class="flex items-center justify-end gap-2">
                <button
                  type="button"
                  data-testid="agent-memory-create-cancel"
                  onClick={() => setCreating(false)}
                  class="min-h-11 rounded-md border border-border-subtle px-3 text-[12px] text-text-tertiary hover:bg-surface-hover"
                >
                  {i18n.t("kernel.agents.cancel")}
                </button>
                <button
                  type="button"
                  data-testid="agent-memory-create-save"
                  disabled={createBusy()}
                  onClick={() => void createEntry()}
                  class="min-h-11 rounded-md border border-accent/40 bg-accent/10 px-3 text-[12px] text-accent hover:bg-accent/20 disabled:opacity-50"
                >
                  {i18n.t("kernel.agents.create")}
                </button>
              </div>
            </div>
          </Show>

          <Show when={agentMemoryStore.searchUnavailable}>
            <p
              data-testid="agent-memory-search-unavailable"
              class="border-b border-border-subtle px-4 py-2 text-[12px] text-red-300"
            >
              {i18n.t("kernel.agentMemorySearchUnavailable")}
            </p>
          </Show>
          <Show when={agentMemoryStore.searchError}>
            <p
              data-testid="agent-memory-search-error"
              class="border-b border-border-subtle px-4 py-2 text-[12px] text-red-300"
            >
              {i18n.t("kernel.agentMemorySearchFailed")}
            </p>
          </Show>

          <Show
            when={
              agentMemoryStore.searched &&
              !agentMemoryStore.searchUnavailable &&
              !agentMemoryStore.searchError
            }
          >
            <Show
              when={searchGroups().length > 0}
              fallback={
                <p
                  data-testid="agent-memory-search-empty"
                  class="border-b border-border-subtle px-4 py-3 text-[12px] text-text-tertiary"
                >
                  {i18n.t("kernel.agentMemorySearchEmpty")}
                </p>
              }
            >
              <div
                data-testid="agent-memory-search-results"
                class="border-b border-border-subtle pb-2"
              >
                <For each={searchGroups()}>
                  {(group) => (
                    <section>
                      <header
                        data-testid={`agent-memory-search-group-${group.kind}`}
                        data-kind={group.kind}
                        class="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-text-tertiary"
                      >
                        {groupLabel(group.kind)}
                      </header>
                      <For each={group.hits}>
                        {(hit) => (
                          <div
                            data-testid={`agent-memory-search-hit-${hit.key}`}
                            class="flex flex-col gap-0.5 px-4 py-2"
                          >
                            <Show
                              when={hit.kind === "transcript"}
                              fallback={
                                <span class="text-[12px] text-text-tertiary">{hit.path}</span>
                              }
                            >
                              <span class="text-[12px] text-text-tertiary">
                                {`${hit.threadHandle ?? ""} ${hit.date ?? ""} ${hit.author ?? ""}`}
                              </span>
                            </Show>
                            <span class="text-[13px] text-text">{hit.snippet}</span>
                            <Show when={hit.kind !== "transcript" && hit.description}>
                              <span class="text-[12px] text-text-secondary">{hit.description}</span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </section>
                  )}
                </For>
              </div>
            </Show>
          </Show>

          <Show when={agentMemoryStore.index.full}>
            <p
              data-testid="agent-memory-index-full"
              class="border-b border-border-subtle px-4 py-2 text-[12px] text-red-300"
            >
              {i18n.t("kernel.agentMemoryIndexFull")}
            </p>
          </Show>
          <Show when={!agentMemoryStore.index.full && agentMemoryStore.index.nearLimit}>
            <p
              data-testid="agent-memory-index-nag"
              class="border-b border-border-subtle px-4 py-2 text-[12px] text-text-tertiary"
            >
              {i18n.t("kernel.agentMemoryIndexNearLimit", {
                lines: agentMemoryStore.index.lines,
                max: MEMORY_INDEX_MAX_LINES,
              })}
            </p>
          </Show>

          {group("index", i18n.t("kernel.agentMemoryGroupIndex"), indexFiles)}
          {group("topics", i18n.t("kernel.agentMemoryGroupTopics"), topicFiles)}
          {group("episodes", i18n.t("kernel.agentMemoryGroupEpisodes"), episodeFiles)}
          {group("checkpoints", i18n.t("kernel.agentMemoryGroupCheckpoints"), checkpointFiles)}

          <Show when={hiddenMemoryCount() > 0}>
            <p
              data-testid="agent-memory-hidden-count"
              class="px-4 py-2 text-[12px] text-text-tertiary"
            >
              {i18n.t("kernel.agentMemoryHiddenEntries", { n: hiddenMemoryCount() })}
            </p>
          </Show>

          <Show when={!agentMemoryStore.loading && visibleMemoryFiles().length === 0}>
            <div
              data-testid="agent-memory-empty"
              class="flex flex-col items-center gap-2 px-6 py-10 text-center text-text-tertiary"
            >
              <Brain size={20} class="text-text-tertiary" />
              <p class="text-[13px]">{i18n.t("kernel.agentMemoryEmpty")}</p>
            </div>
          </Show>

          <Show when={agentMemoryStore.error}>
            <p data-testid="agent-memory-error" class="px-4 py-2 text-[12px] text-red-300">
              {i18n.t("kernel.agentMemoryLoadFailed")}
            </p>
          </Show>

          <Show when={forgetResult()}>
            {(result) => (
              <p
                data-testid="agent-memory-forget-result"
                class="px-4 py-2 text-[12px] text-text-secondary"
              >
                {i18n.t("kernel.agentMemoryForgetDone", {
                  episodes: result().episodesDeleted,
                  checkpoints: result().checkpointsDeleted,
                })}
              </p>
            )}
          </Show>
        </div>

        <div
          data-testid="agent-memory-detail"
          class="min-h-0 min-w-0 flex-1 overflow-auto"
          classList={{ hidden: !showDetailPane() }}
        >
          <Show when={isPhone() && showDetailPane()}>
            <button
              type="button"
              data-testid="agent-memory-back"
              onClick={() => setOpenMemoryPath(null)}
              class="flex min-h-11 items-center gap-1 px-4 text-[13px] text-text-secondary"
            >
              <ChevronLeft size={14} />
              {i18n.t("kernel.agents.backToList")}
            </button>
          </Show>

          <Show
            when={openFile()}
            fallback={
              <p
                data-testid="agent-memory-no-selection"
                class="px-4 py-4 text-[12px] text-text-tertiary"
              >
                {i18n.t("kernel.agentMemorySelectFile")}
              </p>
            }
          >
            {(file) => (
              <ResponsiveDetail
                class="gap-4 px-4 py-4"
                contentClass="min-w-0"
                metadataClass="md:w-56 md:pl-4"
                content={
                  <div class="flex min-w-0 flex-col gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        data-testid="agent-memory-open-path"
                        class="text-[12px] text-text-tertiary"
                      >
                        {file().path}
                      </span>
                      <Show when={isEditablePath(file().path)}>
                        <Show
                          when={editing()}
                          fallback={
                            <button
                              type="button"
                              data-testid="agent-memory-edit"
                              disabled={!bodyLoaded()}
                              onClick={() => setDraft(body())}
                              class="ml-auto min-h-11 rounded-md border border-border-subtle px-3 text-[12px] text-text-secondary hover:bg-surface-hover disabled:opacity-60"
                            >
                              {i18n.t("kernel.agentMemoryEdit")}
                            </button>
                          }
                        >
                          <button
                            type="button"
                            data-testid="agent-memory-save"
                            disabled={busy()}
                            onClick={() => void save()}
                            class="ml-auto min-h-11 rounded-md border border-border-subtle px-3 text-[12px] text-text hover:bg-surface-hover disabled:opacity-60"
                          >
                            {busy()
                              ? i18n.t("kernel.agentMemorySaving")
                              : i18n.t("kernel.agentMemorySave")}
                          </button>
                        </Show>
                      </Show>
                    </div>

                    <Show when={!isEditablePath(file().path)}>
                      <p data-testid="agent-memory-readonly" class="text-[12px] text-text-tertiary">
                        {i18n.t("kernel.agentMemoryReadOnly")}
                      </p>
                    </Show>

                    {/* Delete, for a typed memory only, two step and inline: the
                    flat detail screen's own confirmation, unchanged. */}
                    <Show when={deletableEntry()}>
                      <div class="flex flex-col gap-2">
                        <Show
                          when={confirmDelete()}
                          fallback={
                            <button
                              type="button"
                              data-testid="memory-delete"
                              onClick={() => {
                                setDeleteError(null)
                                setConfirmDelete(true)
                              }}
                              class="self-start min-h-11 rounded-md border border-border-subtle px-3 text-[12px] text-danger hover:bg-danger/10"
                            >
                              {i18n.t("kernel.agentForms.memoryDelete")}
                            </button>
                          }
                        >
                          <div class="flex gap-2">
                            <button
                              type="button"
                              data-testid="memory-delete-confirm"
                              disabled={deleteBusy()}
                              onClick={() => void deleteEntry()}
                              class="min-h-11 rounded-md bg-danger px-3 text-[12px] text-white disabled:opacity-60"
                            >
                              {i18n.t("kernel.agentForms.memoryConfirmDelete")}
                            </button>
                            <button
                              type="button"
                              data-testid="memory-delete-cancel"
                              onClick={() => setConfirmDelete(false)}
                              class="min-h-11 rounded-md border border-border-subtle px-3 text-[12px] text-text-secondary hover:bg-surface-hover"
                            >
                              {i18n.t("kernel.agents.cancel")}
                            </button>
                          </div>
                        </Show>
                        <Show when={deleteError()}>
                          <p data-testid="memory-delete-error" class="text-[12px] text-red-300">
                            {deleteError()}
                          </p>
                        </Show>
                      </div>
                    </Show>

                    <MarkdownEditor
                      value={editing() ? (draft() ?? "") : body()}
                      readOnly={!editing()}
                      onInput={setDraft}
                    />

                    <Show when={saveError()}>
                      <p data-testid="agent-memory-save-error" class="text-[12px] text-red-300">
                        {saveError()}
                      </p>
                    </Show>

                    {/* `[[name]]` resolution, as the flat detail screen resolved
                    it: a known name opens that memory, an unknown one renders
                    dim and inert rather than as a dead link. */}
                    <Show when={linkSource().includes("[[")}>
                      <div
                        data-testid="agent-memory-link-preview"
                        class="rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12px] text-text-tertiary"
                      >
                        <div class="mb-1 text-[11px] uppercase tracking-wide">
                          {i18n.t("kernel.agentForms.memoryLinked")}
                        </div>
                        <For each={resolveMemoryLinks(linkSource(), memoriesStore.memories)}>
                          {(tok) =>
                            tok.kind === "link" ? (
                              tok.broken ? (
                                <span
                                  data-testid={`agent-memory-broken-link-${tok.name}`}
                                  class="mr-2 inline-block text-text-tertiary/50"
                                >
                                  [[{tok.name}]]
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  data-testid={`agent-memory-link-${tok.name}`}
                                  class="mr-2 inline-block text-accent underline"
                                  onClick={() => {
                                    const target = memoriesStore.memories.find(
                                      (m) => m.name === tok.name,
                                    )
                                    if (target) void openPath(`${target.type}/${target.name}.md`)
                                  }}
                                >
                                  [[{tok.name}]]
                                </button>
                              )
                            ) : null
                          }
                        </For>
                      </div>
                    </Show>
                  </div>
                }
                metadata={
                  <dl data-testid="agent-memory-metadata" class="flex flex-col gap-1 text-[12px]">
                    <dt class="text-text-tertiary">{i18n.t("kernel.agentMemoryFieldModified")}</dt>
                    <dd class="text-text">{file().modified}</dd>
                    <dt class="text-text-tertiary">{i18n.t("kernel.agentMemoryFieldScopes")}</dt>
                    {/* A SCOPE NAME IS NEVER SHOWN TO A NON ADMIN (A14): a memory
                    row carrying `kernel:...` used to print it verbatim. The
                    capability CATEGORIES stand in for everyone but a
                    `kernel:agents:admin` viewer. */}
                    <dd class="text-text" data-testid="agent-memory-scopes">
                      {(scopeAdmin()
                        ? file().requiredScopes
                        : capabilityCategories(file().requiredScopes ?? [])
                      ).join(", ")}
                    </dd>
                    <dt class="text-text-tertiary">{i18n.t("kernel.agentMemoryFieldSource")}</dt>
                    <dd class="text-text">
                      {file().sourceKind === "human"
                        ? i18n.t("kernel.agentMemorySourceHuman")
                        : i18n.t("kernel.agentMemorySourceAgent")}
                    </dd>
                  </dl>
                }
              />
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}

export default MemoryTree
