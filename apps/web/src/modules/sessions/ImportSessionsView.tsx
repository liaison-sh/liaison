// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE IMPORT SESSIONS TAB (S8-S18; `/import-sessions`, the Sessions list as
// its sidebar). The owner's Claude Code sessions on one of their online
// computers, to Follow (a read-only live mirror) or Take over (steered here).
//
// - Left: a node picker when several computers are online; "Working in" (the
//   shared folders, then Add or find folders… into Computers settings); the
//   search field; one group per shared folder with its exact count (S12), the
//   folder worked in first and open; then "Not shared yet" groups (a name, a
//   `~` path and a count, never a title: S13), each with Share this folder or
//   why not; the skipped line (S14); the footer with Manage folders (S15).
// - Right: the picked row (S11): title, status pill, folder, worktree or
//   subfolder, branch, last active, first prompt, and Follow / Take over, or
//   Open in Liaison. On the phone the detail is pushed over the tree (S18).
// - Listings run one at a time; a `superseded` answer is asked once more,
//   quietly (A14). A folder whose count is above its loaded rows lists itself
//   alone, only when the listing carried counts (A2); a folder answer without
//   counts (a plain fallback) keeps the loaded rows.
// - The search filters the listed rows in the client; only over a truncated
//   listing that the filter cannot match does "Search all sessions on this
//   computer" send one server search (D47).
// - An older computer's answer (no counts, no groups, no skipped) still
//   renders (S16); an API older than wave 3 hides the entry (D42).

import { ArrowLeft, ChevronDown, ChevronRight, FolderGit2 } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { cn } from "~/lib/cn"
import { relativeTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import { nodeFoldersRoute, shareNodeFolder } from "~/modules/nodes/node-folders-api"
import { hasEnabledNode, loadNodes, nodes, refetchNodes } from "~/modules/nodes/nodes-store"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"
import { PopupMenu } from "~/ui/PopupMenu"
import { setImportSupported } from "./import-support"
import {
  type FolderGroup,
  folderGroups,
  folderSummary,
  matches,
  needsFolderFetch,
  placeOf,
  type RowStatus,
  rowStatus,
} from "./import-tree"
import { isPhone, phoneTap } from "./phone"
import {
  type ImportableRow,
  type ImportListing,
  type ImportListOutcome,
  type ImportRefusal,
  listImportable,
  startImport,
  type UnsharedGroup,
} from "./session-api"

/** Refusal codes with their own sentence (kernel.nodeSessions.import.error.*). */
const ERROR_KEYS = new Set([
  "node_outdated",
  "node_offline",
  "import_in_flight",
  "already_in_liaison",
  "outside_shared",
  "not_found",
  "timeout",
  "server_outdated",
  // The computer's own check codes (A44, A56, S42).
  "unsafe_subdir",
  "symlink",
  "not_regular",
  "ambiguous_transcript",
  "already_liaison",
  "model_unavailable",
])

/** A folder share's refusals, each a sentence (the Folders tab's own). */
const SHARE_ERRORS: Record<string, string> = {
  node_offline: "kernel.nodeSessions.folders.offline",
  timeout: "kernel.nodeSessions.folders.timeout",
  SharedRootsFull: "kernel.nodeSessions.folders.sharedFull",
  ShareOutsideSearchRoots: "kernel.nodeSessions.folders.shareOutside",
  SharedRootHome: "kernel.nodeSessions.sharedFolders.refusedHome",
  SharedRootMissing: "kernel.nodeSessions.sharedFolders.refusedMissing",
}

/** At most this many rows in one listing (the node's cap). */
const LIST_CAP = 200

/**
 * A session the person just created (Follow, Take over) opens as a permanent
 * tab: a preview one would replace this tab (itself a preview) and lose its
 * folder, selection and the row turning In Liaison.
 */
function openSessionTab(id: string, label: string, opts: { created?: boolean } = {}): void {
  openTab({
    type: "kernel:session",
    entityId: id,
    label,
    routePath: `/sessions/${encodeURIComponent(id)}`,
    ...(opts.created ? { preview: false } : {}),
  })
}

/** A row's key across listings: the API names each row anew per listing. */
const rowKey = (row: ImportableRow) =>
  [row.folderName, row.worktreePath ?? "", row.cwdSubdir, row.lastModified, row.title].join("\n")

type Listing =
  | { status: "loading" }
  | { status: "ready"; listing: ImportListing; query: string | null }
  | { status: "error"; refusal: ImportRefusal }

/** One folder listed alone (S12): its rows, or the plain fallback's answer (kept rows). */
type FolderListing =
  | { status: "loading" }
  | { status: "ready"; rows: ImportableRow[] | null }
  | { status: "error"; refusal: ImportRefusal }

export default function ImportSessionsView(_props: { entityId?: string }) {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()

  const online = createMemo(() => nodes().filter((n) => n.enabled && n.online))
  const [nodeId, setNodeId] = createSignal("")
  const [listing, setListing] = createSignal<Listing>({ status: "loading" })
  /** A live session's Take over is armed by the first click and runs on the second. */
  const [armed, setArmed] = createSignal<string | null>(null)
  const [byFolder, setByFolder] = createStore<Record<string, FolderListing>>({})
  const [expanded, setExpanded] = createSignal<string[]>([])
  const [first, setFirst] = createSignal<string | null>(null)
  const [query, setQuery] = createSignal("")
  const [searched, setSearched] = createSignal<string[]>([])
  const [selected, setSelected] = createSignal<string | null>(null)
  const [imported, setImported] = createSignal<Record<string, string>>({})
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ImportRefusal | null>(null)
  /** A server search's refusal, said under the tree (the detail says an import's). */
  const [searchError, setSearchError] = createSignal<ImportRefusal | null>(null)
  const [shareError, setShareError] = createSignal<{ name: string; message: string } | null>(null)
  const [sharing, setSharing] = createSignal<string | null>(null)
  const [pickerOpen, setPickerOpen] = createSignal(false)

  onMount(() => void loadNodes(api))

  // The first online computer until the owner picks one; a computer that
  // went offline gives way to another.
  createEffect(() => {
    const list = online()
    if (list.some((n) => n.id === nodeId())) return
    setNodeId(list[0]?.id ?? "")
  })

  // A14: one listing at a time; a superseded one is asked once more, quietly.
  let queue: Promise<unknown> = Promise.resolve()
  function serial(id: string, q?: string, folder?: string): Promise<ImportListOutcome> {
    const run = async () => {
      const outcome = await listImportable(api, id, q, folder)
      if (!outcome.ok && outcome.code === "superseded") {
        return listImportable(api, id, q, folder)
      }
      return outcome
    }
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  /**
   * The Not shared yet groups, the skipped count and "and more", from the
   * last full listing only: a folder or search answer may carry groups
   * without a fresh share proof, so they never replace these.
   */
  const [full, setFull] = createSignal<{
    unshared: UnsharedGroup[]
    skipped: number
    partial: boolean
  }>({ unshared: [], skipped: 0, partial: false })

  /** The last full listing, shown again when the search is cleared. */
  let fullListing: ImportListing | null = null
  let generation = 0
  /** Bumped when the search is cleared: a search still in flight is then dropped. */
  let searchGeneration = 0
  async function load(id: string, q?: string, quiet = false): Promise<void> {
    const mine = ++generation
    const search = searchGeneration
    setSearchError(null)
    if (!q && !quiet) setListing({ status: "loading" })
    const outcome = await serial(id, q)
    if (mine !== generation || (q && search !== searchGeneration)) return
    if (!outcome.ok) {
      if (outcome.code === "server_outdated") setImportSupported(false)
      if (q) setSearchError(outcome)
      else setListing({ status: "error", refusal: outcome })
      return
    }
    clearFolders()
    setListing({ status: "ready", listing: outcome, query: q ?? null })
    if (!q) {
      fullListing = outcome
      setFull({
        unshared: outcome.unshared ?? [],
        skipped: outcome.skipped ?? 0,
        partial: outcome.unsharedPartial === true,
      })
    }
    if (!q && !quiet) {
      const lead = first() ?? groups()[0]?.name ?? null
      if (lead) {
        setFirst(lead)
        expand(lead, true)
      }
    }
  }

  function clearFolders(): void {
    setByFolder(
      produce((s) => {
        for (const k of Object.keys(s)) delete s[k]
      }),
    )
  }

  /** The search box emptied: back to the full listing, its counts and its folders (D47). */
  function clearSearch(): void {
    if (searched().length === 0) return
    searchGeneration++
    setSearched([])
    setSearchError(null)
    const l = listing()
    if (l.status !== "ready" || l.query === null) return
    clearFolders()
    if (fullListing) setListing({ status: "ready", listing: fullListing, query: null })
    else void load(nodeId())
  }

  // One listing per open and per node change (D47), never per keystroke.
  createEffect(
    on(nodeId, (id) => {
      fullListing = null
      setSearched([])
      setSelected(null)
      setFirst(null)
      setExpanded([])
      setFull({ unshared: [], skipped: 0, partial: false })
      if (id) void load(id)
    }),
  )

  const ready = () => {
    const l = listing()
    return l.status === "ready" ? l : null
  }
  const listingRefusal = () => {
    const l = listing()
    return l.status === "error" ? l.refusal : null
  }
  const hasCounts = () => ready()?.listing.folders !== undefined

  /** The listed rows, with the imports made here since (S11). */
  const withImports = (row: ImportableRow): ImportableRow => {
    const held = row.candidateId ? imported()[row.candidateId] : undefined
    return held && !row.inLiaison ? { ...row, inLiaison: held } : row
  }

  const node = () => online().find((n) => n.id === nodeId())
  const nodeName = () => node()?.name ?? ""

  const groups = createMemo((): FolderGroup[] => {
    const l = ready()
    if (!l) return []
    const extra: Record<string, ImportableRow[]> = {}
    for (const [name, f] of Object.entries(byFolder)) {
      if (f.status === "ready" && f.rows) extra[name] = f.rows
    }
    return folderGroups({
      rows: l.listing.rows,
      names: node()?.sharedFolderNames ?? [],
      folders: l.listing.folders,
      extra,
      first: first(),
      within: node()?.sharedFolderWithin,
    }).map((g) => ({ ...g, rows: g.rows.map(withImports) }))
  })

  /** The folders the person shared, and the repos inside them listed too. */
  const summary = createMemo(() =>
    folderSummary(
      [...new Set([...(node()?.sharedFolderNames ?? []), ...groups().map((g) => g.name)])],
      node()?.sharedFolderWithin,
    ),
  )

  const q = () => query().trim()
  /** A server search's answer is already that query's rows. */
  const serverSearch = () => {
    const l = ready()
    return l?.query !== null && l?.query !== undefined && l.query === q()
  }
  const shownGroups = createMemo(() =>
    groups()
      .map((g) => ({ ...g, rows: serverSearch() ? g.rows : g.rows.filter((r) => matches(r, q())) }))
      .filter((g) => !q() || g.rows.length > 0),
  )
  const anyShown = () => shownGroups().some((g) => g.rows.length > 0)
  const canSearchAll = () => {
    const l = ready()
    return (
      l?.listing.truncated === true && q().length > 0 && !anyShown() && !searched().includes(q())
    )
  }

  function searchAll(): void {
    const id = nodeId()
    const text = q().slice(0, 100)
    if (!id || !canSearchAll()) return
    setSearched([...searched(), text])
    void load(id, text)
  }

  const isOpen = (name: string) => q().length > 0 || expanded().includes(name)

  /** Opens a folder; lists it alone when its count is above its loaded rows (S12, A2). */
  function expand(name: string, open: boolean): void {
    setExpanded((e) =>
      open ? [...e.filter((x) => x !== name), name] : e.filter((x) => x !== name),
    )
    if (!open) return
    const group = groups().find((g) => g.name === name)
    if (!group || byFolder[name] || !needsFolderFetch(group, hasCounts())) return
    void loadFolder(name)
  }

  async function loadFolder(name: string): Promise<void> {
    const id = nodeId()
    const mine = generation
    setByFolder(name, { status: "loading" })
    const outcome = await serial(id, undefined, name)
    if (mine !== generation) return
    if (!outcome.ok) {
      setByFolder(name, { status: "error", refusal: outcome })
      return
    }
    // Without counts the server fell back to a plain listing: not this folder's rows alone.
    setByFolder(name, {
      status: "ready",
      rows:
        outcome.folders === undefined ? null : outcome.rows.filter((r) => r.folderName === name),
    })
  }

  function pickFolder(name: string): void {
    setFirst(name)
    expand(name, true)
  }

  function openSettings(): void {
    openTab({
      type: "kernel:settings",
      entityId: "settings",
      label: t("kernel.common.settings"),
      routePath: nodeFoldersRoute(nodeId()),
      preview: false,
    })
  }

  const allRows = createMemo(() => groups().flatMap((g) => g.rows))
  const current = createMemo(() => {
    const key = selected()
    return key ? (allRows().find((r) => rowKey(r) === key) ?? null) : null
  })

  async function start(row: ImportableRow, mode: "follow" | "take_over"): Promise<void> {
    const candidateId = row.candidateId
    if (!candidateId || busy()) return
    if (mode === "take_over" && row.liveNow && armed() !== candidateId) {
      setArmed(candidateId)
      return
    }
    setArmed(null)
    setError(null)
    setBusy(true)
    const outcome = await startImport(api, { candidateId, mode })
    setBusy(false)
    if (!outcome.ok) {
      setError(outcome)
      return
    }
    setImported((m) => ({ ...m, [candidateId]: outcome.sessionId }))
    openSessionTab(outcome.sessionId, row.title, { created: true })
  }

  /** A group with neither a share proof nor a refusal can be shared once a full listing issues one. */
  const shareable = (g: UnsharedGroup) => g.candidateId !== null || g.refusal === null

  async function shareGroup(group: UnsharedGroup): Promise<void> {
    const id = nodeId()
    if (!shareable(group) || sharing()) return
    setSharing(group.display)
    setShareError(null)
    try {
      let candidateId = group.candidateId
      if (!candidateId) {
        // No proof yet: a full listing issues a fresh one for the same folder.
        await load(id, undefined, true)
        const fresh = full().unshared.find((g) => g.display === group.display)
        candidateId = fresh?.candidateId ?? null
        if (!candidateId) return
      }
      await shareNodeFolder(api, id, candidateId)
      void refetchNodes()
      await load(id, undefined, true)
    } catch (err) {
      const code = (err as { code?: unknown })?.code
      // A used or forgotten id, or a folder shared since: the listing again shows the truth.
      if (code === "candidate_unknown" || code === "ShareNotIssued") {
        await load(id, undefined, true)
      } else {
        const key = typeof code === "string" ? SHARE_ERRORS[code] : undefined
        setShareError({
          name: group.display,
          message: t(key ?? "kernel.nodeSessions.folders.failed", {
            name: group.name,
            node: nodeName(),
          }),
        })
      }
    } finally {
      setSharing(null)
    }
  }

  const errorText = (r: ImportRefusal) =>
    ERROR_KEYS.has(r.code)
      ? t(`kernel.nodeSessions.import.error.${r.code}`)
      : t("kernel.nodeSessions.import.error.failed")

  const statusLabel = (s: RowStatus) => t(`kernel.nodeSessions.import.status.${s}`)
  const dot = (s: RowStatus) =>
    cn(
      "h-2 w-2 shrink-0 rounded-full",
      s === "running" && "bg-success",
      s === "imported" && "bg-text-tertiary",
      s === "available" && "border border-text-tertiary",
    )
  const when = (row: ImportableRow) => relativeTime(row.lastModified, i18n.locale())
  const meta = (row: ImportableRow) =>
    [when(row), row.branch, placeOf(row)].filter((x): x is string => Boolean(x)).join(" · ")

  const unshared = () => (ready() ? full().unshared : [])
  const skipped = () => (ready() ? full().skipped : 0)
  const nothingAtAll = () =>
    ready() !== null && groups().every((g) => g.count === 0) && unshared().length === 0

  function ErrorLine(p: { refusal: ImportRefusal }) {
    return (
      <div role="alert" data-testid="import-error" class="text-[12.5px] text-text-secondary">
        <span>{errorText(p.refusal)}</span>
        <Show when={p.refusal.code === "already_in_liaison" && p.refusal.sessionId}>
          {(id) => (
            <button
              type="button"
              data-testid="import-error-open"
              class={cn("ml-2 text-accent underline", phoneTap())}
              onClick={() => openSessionTab(id(), "")}
            >
              {t("kernel.nodeSessions.import.openSession")}
            </button>
          )}
        </Show>
      </div>
    )
  }

  const sectionLabel = "px-1 text-[11.5px] font-medium uppercase tracking-wide text-text-tertiary"

  const tree = () => (
    <div data-testid="import-tree" class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      <Show when={online().length > 1}>
        <label class="flex flex-col gap-1 text-[12.5px] text-text-secondary">
          {t("kernel.nodeSessions.import.node")}
          <select
            data-testid="import-node"
            value={nodeId()}
            onChange={(e) => setNodeId(e.currentTarget.value)}
            class="min-h-9 w-full rounded-sm border border-border bg-bg px-2 text-[13px] text-text"
          >
            <For each={online()}>{(n) => <option value={n.id}>{n.name}</option>}</For>
          </select>
        </label>
      </Show>

      <div class="flex flex-col gap-1">
        <span class={sectionLabel}>{t("kernel.nodeSessions.import.workingIn")}</span>
        <PopupMenu open={pickerOpen()} onOpenChange={setPickerOpen}>
          <PopupMenu.Trigger
            data-testid="import-working-in"
            class={cn(
              "flex min-h-9 w-full items-center gap-2 rounded-sm border border-border bg-bg px-2 text-left text-[13px] text-text",
              phoneTap(),
            )}
          >
            <span class="min-w-0 flex-1 truncate">
              {first() ?? t("kernel.nodeSessions.import.workingInNone")}
            </span>
            <ChevronDown class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
          </PopupMenu.Trigger>
          <PopupMenu.Content class="min-w-56">
            <For each={groups()}>
              {(g) => (
                <PopupMenu.Item
                  data-testid={`import-working-in-${g.name}`}
                  onSelect={() => pickFolder(g.name)}
                >
                  <span class={cn("min-w-0 flex-1 truncate", g.within && "pl-4")}>{g.name}</span>
                  <span class="text-[12px] tabular-nums text-text-tertiary">{g.count}</span>
                </PopupMenu.Item>
              )}
            </For>
            <PopupMenu.Separator />
            <PopupMenu.Item data-testid="import-add-folders" onSelect={openSettings}>
              {t("kernel.nodeSessions.import.addFolders")}
            </PopupMenu.Item>
          </PopupMenu.Content>
        </PopupMenu>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          searchAll()
        }}
      >
        <input
          type="search"
          data-testid="import-search"
          value={query()}
          placeholder={t("kernel.nodeSessions.import.search")}
          aria-label={t("kernel.nodeSessions.import.search")}
          onInput={(e) => {
            setQuery(e.currentTarget.value)
            if (!q()) clearSearch()
          }}
          class="min-h-9 w-full rounded-sm border border-border bg-bg px-2 text-[13px] text-text"
        />
      </form>

      <Show when={listing().status === "loading"}>
        <p data-testid="import-loading" class="text-[12.5px] text-text-tertiary">
          {t("kernel.nodeSessions.import.loading")}
        </p>
      </Show>
      <Show when={listingRefusal()}>
        {(r) => (
          <div class="flex flex-col gap-2">
            <ErrorLine refusal={r()} />
            <Button
              type="button"
              variant="outline"
              data-testid="import-retry"
              class={cn("self-start", phoneTap())}
              onClick={() => void load(nodeId())}
            >
              {t("kernel.nodeSessions.import.retry")}
            </Button>
          </div>
        )}
      </Show>

      <Show when={ready()}>
        {(l) => (
          <>
            <Show when={nothingAtAll()}>
              <div data-testid="import-empty" class="flex flex-col gap-2 py-2">
                <p class="text-[13px] text-text-secondary">
                  {t("kernel.nodeSessions.import.emptyAll")}
                </p>
              </div>
            </Show>

            <ul class="flex flex-col gap-1">
              <For each={shownGroups()}>
                {(g) => {
                  const loadingFolder = () => byFolder[g.name]?.status === "loading"
                  const folderRefusal = () => {
                    const f = byFolder[g.name]
                    return f?.status === "error" ? f.refusal : null
                  }
                  const fetched = () => byFolder[g.name]?.status === "ready"
                  return (
                    <li
                      data-testid="import-folder-group"
                      data-name={g.name}
                      data-within={g.within}
                      class={cn(g.within && "pl-4")}
                    >
                      <button
                        type="button"
                        data-testid="import-folder"
                        aria-expanded={isOpen(g.name)}
                        title={
                          g.within
                            ? t("kernel.nodeSessions.import.repoInside", { folder: g.within })
                            : undefined
                        }
                        class={cn(
                          "flex min-h-8 w-full items-center gap-1.5 rounded-sm px-1 text-left text-[13px] text-text hover:bg-surface-hover",
                          g.within ? "font-normal" : "font-medium",
                          phoneTap(),
                        )}
                        onClick={() => expand(g.name, !isOpen(g.name))}
                      >
                        <Show
                          when={isOpen(g.name)}
                          fallback={
                            <ChevronRight class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                          }
                        >
                          <ChevronDown class="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
                        </Show>
                        <Show when={g.within}>
                          <FolderGit2
                            data-testid="import-folder-repo-icon"
                            class="h-3.5 w-3.5 shrink-0 text-text-tertiary"
                          />
                        </Show>
                        <span class="min-w-0 flex-1 truncate">{g.name}</span>
                        <span
                          data-testid="import-folder-count"
                          class="text-[12px] font-normal tabular-nums text-text-tertiary"
                        >
                          {g.count}
                        </span>
                      </button>
                      <Show when={isOpen(g.name)}>
                        <ul class="flex flex-col">
                          <For each={g.rows}>
                            {(row) => {
                              const status = () => rowStatus(row)
                              return (
                                <li>
                                  <button
                                    type="button"
                                    data-testid="import-row"
                                    data-status={status()}
                                    aria-current={selected() === rowKey(row) ? "true" : undefined}
                                    class={cn(
                                      "flex w-full items-start gap-2 rounded-sm py-1.5 pl-6 pr-1 text-left hover:bg-surface-hover",
                                      selected() === rowKey(row) && "bg-surface-hover",
                                      status() === "imported" && "opacity-60",
                                      phoneTap(),
                                    )}
                                    onClick={() => {
                                      setError(null)
                                      setSelected(rowKey(row))
                                    }}
                                  >
                                    <span
                                      class={cn(dot(status()), "mt-1.5")}
                                      title={statusLabel(status())}
                                    />
                                    <span class="flex min-w-0 flex-1 flex-col">
                                      <span class="flex items-center gap-1.5">
                                        <span class="min-w-0 flex-1 truncate text-[13px] text-text">
                                          {row.title}
                                        </span>
                                        <Show when={status() === "imported"}>
                                          <span
                                            data-testid="import-row-pill"
                                            class="shrink-0 rounded-full border border-border px-1.5 text-[11px] text-text-secondary"
                                          >
                                            {statusLabel("imported")}
                                          </span>
                                        </Show>
                                      </span>
                                      <span
                                        data-testid="import-row-meta"
                                        class="truncate text-[12px] text-text-tertiary"
                                      >
                                        {meta(row)}
                                      </span>
                                    </span>
                                  </button>
                                </li>
                              )
                            }}
                          </For>
                          <Show when={loadingFolder()}>
                            <li
                              data-testid="import-folder-loading"
                              class="py-1 pl-6 text-[12px] text-text-tertiary"
                            >
                              {t("kernel.nodeSessions.import.folderLoading")}
                            </li>
                          </Show>
                          <Show when={folderRefusal()}>
                            {(r) => (
                              <li
                                data-testid="import-folder-error"
                                class="flex flex-col gap-1 py-1 pl-6"
                              >
                                <ErrorLine refusal={r()} />
                                <Button
                                  type="button"
                                  variant="outline"
                                  data-testid="import-folder-retry"
                                  class={cn("self-start", phoneTap())}
                                  onClick={() => void loadFolder(g.name)}
                                >
                                  {t("kernel.nodeSessions.import.retry")}
                                </Button>
                              </li>
                            )}
                          </Show>
                          <Show
                            when={
                              !q() &&
                              !loadingFolder() &&
                              g.count > g.rows.length &&
                              (fetched() || !hasCounts() || g.rows.length >= LIST_CAP)
                            }
                          >
                            <li
                              data-testid="import-folder-more"
                              class="py-1 pl-6 text-[12px] text-text-tertiary"
                            >
                              {t("kernel.nodeSessions.import.folderMore", {
                                shown: g.rows.length,
                                total: g.count,
                              })}
                            </li>
                          </Show>
                        </ul>
                      </Show>
                    </li>
                  )
                }}
              </For>
            </ul>

            <Show when={q() && !anyShown()}>
              <p class="text-[12.5px] text-text-tertiary">
                {t("kernel.nodeSessions.import.noMatch")}
              </p>
            </Show>
            <Show when={l().listing.truncated && !canSearchAll() && !q()}>
              <p class="text-[12px] text-text-tertiary">
                {t("kernel.nodeSessions.import.truncated")}
              </p>
            </Show>
            <Show when={canSearchAll()}>
              <Button
                type="button"
                variant="ghost"
                data-testid="import-search-all"
                class={cn("self-start", phoneTap())}
                onClick={searchAll}
              >
                {t("kernel.nodeSessions.import.searchAll")}
              </Button>
            </Show>
            <Show when={searchError()}>{(r) => <ErrorLine refusal={r()} />}</Show>

            <Show when={unshared().length > 0}>
              <section data-testid="import-unshared" class="flex flex-col gap-1 pt-2">
                <span class={sectionLabel}>{t("kernel.nodeSessions.import.notSharedTitle")}</span>
                <p class="px-1 text-[12px] text-text-tertiary">
                  {t("kernel.nodeSessions.import.notSharedHint")}
                </p>
                <ul class="flex flex-col">
                  <For each={unshared()}>
                    {(group) => (
                      <li
                        data-testid="import-unshared-group"
                        class="flex flex-col gap-1 rounded-sm px-1 py-1.5"
                      >
                        <div class="flex items-center gap-2">
                          <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate text-[13px] text-text">{group.name}</span>
                            <span class="truncate text-[12px] text-text-tertiary">
                              {group.display}
                            </span>
                          </span>
                          <span
                            data-testid="import-unshared-count"
                            class="text-[12px] tabular-nums text-text-tertiary"
                          >
                            {group.sessions}
                          </span>
                        </div>
                        <Show
                          when={shareable(group)}
                          fallback={
                            <p
                              data-testid="import-unshared-reason"
                              class="text-[12px] text-text-tertiary"
                            >
                              {t(
                                `kernel.nodeSessions.import.unsharedRefusal.${group.refusal ?? "outside_search"}`,
                              )}
                              <Show when={(group.refusal ?? "outside_search") === "outside_search"}>
                                <button
                                  type="button"
                                  data-testid="import-unshared-settings"
                                  class={cn("ml-1 text-accent underline", phoneTap())}
                                  onClick={openSettings}
                                >
                                  {t("kernel.nodeSessions.import.addFolders")}
                                </button>
                              </Show>
                            </p>
                          }
                        >
                          <Button
                            type="button"
                            variant="outline"
                            data-testid="import-unshared-share"
                            class={cn("self-start", phoneTap())}
                            loading={sharing() === group.display}
                            disabled={sharing() !== null}
                            onClick={() => void shareGroup(group)}
                          >
                            {t("kernel.nodeSessions.import.shareFolder")}
                          </Button>
                        </Show>
                        <Show
                          when={shareError()?.name === group.display ? shareError()?.message : null}
                        >
                          {(message) => (
                            <p
                              data-testid="import-unshared-error"
                              class="text-[12px] text-text-secondary"
                            >
                              {message()}
                            </p>
                          )}
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={full().partial}>
                  <p data-testid="import-unshared-more" class="px-1 text-[12px] text-text-tertiary">
                    {t("kernel.nodeSessions.import.unsharedMore")}
                  </p>
                </Show>
              </section>
            </Show>

            <Show when={skipped() > 0}>
              <p data-testid="import-skipped" class="px-1 text-[12px] text-text-tertiary">
                {t("kernel.nodeSessions.import.skipped", { count: skipped() })}
              </p>
            </Show>
          </>
        )}
      </Show>
    </div>
  )

  const footer = () => (
    <div class="flex items-center gap-2 border-t border-border-subtle px-3 py-2 text-[12px] text-text-tertiary">
      <span
        data-testid="import-shared-summary"
        class="min-w-0 flex-1 truncate"
        title={t("kernel.nodeSessions.import.sharedHint")}
      >
        {t("kernel.nodeSessions.import.sharedCount", { count: summary().folders })}
        <Show when={summary().repos > 0}>
          {" · "}
          {t("kernel.nodeSessions.import.reposInside", { count: summary().repos })}
        </Show>
      </span>
      <button
        type="button"
        data-testid="import-manage-folders"
        class={cn("text-accent hover:underline", phoneTap())}
        onClick={openSettings}
      >
        {t("kernel.nodeSessions.import.manageFolders")}
      </button>
    </div>
  )

  const detail = () => (
    <div data-testid="import-detail" class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      <Show when={isPhone()}>
        <button
          type="button"
          data-testid="import-detail-back"
          class={cn(
            "inline-flex items-center gap-1 self-start text-[13px] text-text-secondary",
            phoneTap(),
          )}
          onClick={() => setSelected(null)}
        >
          <ArrowLeft class="h-4 w-4" />
          {t("kernel.nodeSessions.import.back")}
        </button>
      </Show>
      <Show
        when={current()}
        fallback={
          <p data-testid="import-detail-empty" class="text-[13px] text-text-tertiary">
            {t("kernel.nodeSessions.import.pick")}
          </p>
        }
      >
        {(row) => {
          const status = () => rowStatus(row())
          return (
            <>
              <div class="flex flex-col gap-2">
                <h2 data-testid="import-detail-title" class="text-[16px] font-semibold text-text">
                  {row().title}
                </h2>
                <span
                  data-testid="import-detail-status"
                  data-status={status()}
                  class="inline-flex items-center gap-1.5 self-start rounded-full border border-border px-2 py-0.5 text-[12px] text-text-secondary"
                >
                  <span class={dot(status())} />
                  {statusLabel(status())}
                </span>
              </div>
              <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
                <dt class="text-text-tertiary">{t("kernel.nodeSessions.import.detail.folder")}</dt>
                <dd data-testid="import-detail-folder" class="min-w-0 truncate text-text">
                  {row().folderName}
                </dd>
                <Show when={row().worktreePath}>
                  <dt class="text-text-tertiary">
                    {t("kernel.nodeSessions.import.detail.worktree")}
                  </dt>
                  <dd data-testid="import-detail-place" class="min-w-0 truncate text-text">
                    {placeOf(row())}
                  </dd>
                </Show>
                <Show when={!row().worktreePath && row().cwdSubdir}>
                  <dt class="text-text-tertiary">
                    {t("kernel.nodeSessions.import.detail.subfolder")}
                  </dt>
                  <dd data-testid="import-detail-place" class="min-w-0 truncate text-text">
                    {row().cwdSubdir}
                  </dd>
                </Show>
                <Show when={row().branch}>
                  <dt class="text-text-tertiary">
                    {t("kernel.nodeSessions.import.detail.branch")}
                  </dt>
                  <dd class="min-w-0 truncate text-text">{row().branch}</dd>
                </Show>
                <dt class="text-text-tertiary">
                  {t("kernel.nodeSessions.import.detail.lastActive")}
                </dt>
                <dd class="text-text">{when(row())}</dd>
                <dt class="text-text-tertiary">{t("kernel.nodeSessions.import.detail.from")}</dt>
                <dd class="text-text">{t(`kernel.nodeSessions.import.from.${row().from}`)}</dd>
              </dl>
              <Show when={row().firstPrompt}>
                <div class="flex flex-col gap-1">
                  <span class="text-[12px] text-text-tertiary">
                    {t("kernel.nodeSessions.import.detail.firstPrompt")}
                  </span>
                  <p
                    data-testid="import-detail-prompt"
                    class="line-clamp-6 whitespace-pre-wrap rounded-sm bg-surface-hover px-3 py-2 text-[13px] text-text-secondary"
                  >
                    {row().firstPrompt}
                  </p>
                </div>
              </Show>
              <Show
                when={!row().inLiaison}
                fallback={
                  <Button
                    type="button"
                    data-testid="import-in-liaison"
                    class={cn("self-start", phoneTap())}
                    onClick={() => openSessionTab(row().inLiaison as string, row().title)}
                  >
                    {t("kernel.nodeSessions.import.openInLiaison")}
                  </Button>
                }
              >
                <Show
                  when={row().candidateId && row().from !== "liaison"}
                  fallback={
                    <p class="text-[12.5px] text-text-tertiary">
                      {t("kernel.nodeSessions.import.error.already_liaison")}
                    </p>
                  }
                >
                  <div class="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      data-testid="import-follow"
                      disabled={busy()}
                      class={phoneTap()}
                      onClick={() => void start(row(), "follow")}
                    >
                      {t("kernel.nodeSessions.import.follow")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      data-testid="import-take-over"
                      disabled={busy()}
                      class={phoneTap()}
                      onClick={() => void start(row(), "take_over")}
                    >
                      {t("kernel.nodeSessions.import.takeOver")}
                    </Button>
                  </div>
                  <Show when={row().liveNow && armed() === row().candidateId}>
                    <p data-testid="import-live-warning" class="text-[12.5px] text-text-secondary">
                      {t("kernel.nodeSessions.import.takeOverLive")}
                    </p>
                  </Show>
                </Show>
              </Show>
              <Show when={error()}>{(r) => <ErrorLine refusal={r()} />}</Show>
            </>
          )
        }}
      </Show>
      <div
        data-testid="import-statements"
        class="mt-auto flex flex-col gap-1 border-t border-border-subtle pt-2 text-[12px] text-text-tertiary"
      >
        <p>{t("kernel.nodeSessions.import.redaction")}</p>
        <p>{t("kernel.nodeSessions.import.outsideContent")}</p>
      </div>
    </div>
  )

  /** S18: on the phone a picked row's detail is pushed over the tree. */
  const detailOnly = () => isPhone() && current() !== null

  return (
    <section data-testid="import-sessions" class="flex h-full min-w-0 flex-col">
      <header class="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
        <h1 class="min-w-0 flex-1 truncate text-[14px] font-semibold text-text">
          {nodeName()
            ? t("kernel.nodeSessions.import.title", { node: nodeName() })
            : t("kernel.nodeSessions.import.tabTitle")}
        </h1>
      </header>
      <Show
        when={online().length > 0}
        fallback={
          <p data-testid="import-no-node" class="p-4 text-[13px] text-text-secondary">
            {hasEnabledNode()
              ? t("kernel.nodeSessions.import.noOnlineNode")
              : t("kernel.nodeSessions.newDialog.noNode")}
          </p>
        }
      >
        <div class="flex min-h-0 flex-1">
          <Show when={!detailOnly()}>
            <div
              class={cn(
                "flex min-h-0 flex-col",
                isPhone() ? "w-full" : "w-[22rem] shrink-0 border-r border-border-subtle",
              )}
            >
              {tree()}
              {footer()}
            </div>
          </Show>
          <Show when={!isPhone() || detailOnly()}>{detail()}</Show>
        </div>
      </Show>
    </section>
  )
}
