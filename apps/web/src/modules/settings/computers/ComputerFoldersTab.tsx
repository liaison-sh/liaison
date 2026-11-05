// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A COMPUTER'S FOLDERS TAB, from any client (web, phone, desktop): the places
// the OS refused to let Liaison read (with System Settings on this computer,
// and Check again), the one list of folders agents can work in (a repository
// or a folder, missing on disk, Remove; the recent-folders default and Back
// to the default on this computer), "Add a folder", Scan for repos and Find
// repos I can access (RepoScanSection, RemoteReposSection), and folded under More:
// where Add a folder looks, and, on this computer, the folder for work that
// needs no folder.
//
// Every change goes through the server to the computer (node-folders-api.ts)
// and the computer checks it with its own rules; on this computer the native
// picker and the default go through the shell (desktop-shell-contract.ts).
// An offline computer is said, with its last known folder names.

import type { NodeFolderList } from "@liaison/shared"
import { ChevronDown, Plus, TriangleAlert } from "lucide-solid"
import {
  type Component,
  createEffect,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import type { DesktopNodeRoot } from "~/lib/desktop-shell-contract"
import { useI18n } from "~/modules/i18n/i18n-context"
import { folderLabels, folderName } from "~/modules/nodes/folder-labels"
import type { NodeSummary } from "~/modules/nodes/node-api"
import {
  addSearchRoot,
  type CloneAnswer,
  cloneOntoNode,
  type FoundFolder,
  followCloneRequest,
  nodeFolders,
  removeSearchRoot,
  shareNodeFolder,
  unshareNodeFolder,
} from "~/modules/nodes/node-folders-api"
import { refetchNodes } from "~/modules/nodes/nodes-store"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Skeleton } from "~/ui/Skeleton"
import { AddFolderDialog } from "./AddFolderDialog"
import { osKey, placesLabel, rootKind, tildePath } from "./computer-model"
import { RemoteReposSection } from "./RemoteReposSection"
import { RepoScanSection } from "./RepoScanSection"
import type { ThisComputer } from "./this-computer"

type Status = "loading" | "error" | "ready"

/** The computer's refusal codes, each a sentence; `{{name}}` is the folder, `{{node}}` the computer. */
const ERRORS: Record<string, string> = {
  SharedRootRefused: "kernel.nodeSessions.sharedFolders.refusedPath",
  SharedRootMissing: "kernel.nodeSessions.sharedFolders.refusedMissing",
  SharedRootHome: "kernel.nodeSessions.sharedFolders.refusedHome",
  SearchRootRefused: "kernel.nodeSessions.folders.searchRefusedPath",
  SearchRootAboveHome: "kernel.nodeSessions.folders.searchAboveHome",
  CloneUrlRefused: "kernel.nodeSessions.folders.clone.urlRefused",
  CloneNameRefused: "kernel.nodeSessions.folders.clone.nameRefused",
  CloneTargetExists: "kernel.nodeSessions.folders.clone.exists",
  CloneAuthFailed: "kernel.nodeSessions.folders.clone.authFailed",
  CloneHostUnreachable: "kernel.nodeSessions.folders.clone.hostUnreachable",
  CloneNotFound: "kernel.nodeSessions.folders.clone.notFound",
  CloneTimeout: "kernel.nodeSessions.folders.clone.timeout",
  CloneTooLarge: "kernel.nodeSessions.folders.clone.tooLarge",
  CloneFailed: "kernel.nodeSessions.folders.clone.failed",
  node_offline: "kernel.nodeSessions.folders.offline",
  timeout: "kernel.nodeSessions.folders.timeout",
  candidate_unknown: "kernel.nodeSessions.folders.candidateGone",
  ShareNotIssued: "kernel.nodeSessions.folders.candidateGone",
  ShareOutsideSearchRoots: "kernel.nodeSessions.folders.shareOutside",
  SearchRootSystem: "kernel.nodeSessions.folders.searchSystem",
  SharedRootsFull: "kernel.nodeSessions.folders.sharedFull",
}

const target = "min-h-[44px]"
const textButton = `${target} shrink-0 px-2 text-[12.5px] text-text-tertiary underline-offset-2 hover:text-warning hover:underline disabled:opacity-50 sm:min-h-0`

export const ComputerFoldersTab: Component<{
  node: NodeSummary
  isThis: boolean
  tc: ThisComputer
  /** A folder name to search for at once (a blocked card's "Fix it", the agent's link). */
  initialQuery?: string | null
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const shell = props.tc.shell
  const [status, setStatus] = createSignal<Status>("loading")
  const [loadError, setLoadError] = createSignal<string | null>(null)
  const [list, setList] = createSignal<NodeFolderList | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [dropped, setDropped] = createSignal<string[]>([])
  const [busy, setBusy] = createSignal(false)
  const [adding, setAdding] = createSignal(false)
  const [moreOpen, setMoreOpen] = createSignal(false)
  const [rootDraft, setRootDraft] = createSignal("")
  /** A place to look in, waiting for the owner's confirmation (review m8). */
  const [confirmingRoot, setConfirmingRoot] = createSignal<string | null>(null)
  /** The folder being cloned, while the computer clones it. */
  const [cloning, setCloning] = createSignal<string | null>(null)
  const [nodeRoot, setNodeRoot] = createSignal<DesktopNodeRoot | null>(null)
  const [rootError, setRootError] = createSignal<string | null>(null)
  let followTimer: ReturnType<typeof setTimeout> | undefined
  let moreRef: HTMLDetailsElement | undefined
  onCleanup(() => clearTimeout(followTimer))

  const nodeName = () => props.node.name
  const online = () => props.node.online && props.node.enabled
  /** What only this computer, in the desktop app, can do. */
  const local = () => (props.isThis ? shell : null)

  function sentence(err: unknown, name = ""): string {
    const code = err instanceof ApiError ? err.code : typeof err === "string" ? err : undefined
    const key = code ? ERRORS[code] : undefined
    return key
      ? i18n.t(key, { name, node: nodeName() })
      : i18n.t("kernel.nodeSessions.folders.failed")
  }

  async function load(): Promise<void> {
    if (!online()) return
    if (!list()) setStatus("loading")
    setLoadError(null)
    try {
      setList(await nodeFolders(api, props.node.id))
      setStatus("ready")
    } catch (err) {
      setLoadError(sentence(err))
      setStatus("error")
    }
  }

  async function act(run: () => Promise<NodeFolderList>, name = ""): Promise<boolean> {
    if (busy()) return false
    setBusy(true)
    setError(null)
    setNotice(null)
    setDropped([])
    try {
      setList(await run())
      return true
    } catch (err) {
      setError(sentence(err, name))
      return false
    } finally {
      setBusy(false)
    }
  }

  /** Reads the places again, after the owner gave access on the computer. */
  async function checkAccess(): Promise<void> {
    const before = list()?.search.denied.length ?? 0
    await load()
    const after = list()?.search.denied ?? []
    if (before > 0 && after.length === 0) {
      setNotice(i18n.t("kernel.nodeSessions.folders.deniedAllowed", { node: nodeName() }))
    }
  }

  async function share(folder: FoundFolder): Promise<true | string> {
    setError(null)
    setNotice(null)
    try {
      setList(await shareNodeFolder(api, props.node.id, folder.id))
      setNotice(i18n.t("kernel.nodeSessions.folders.sharedNotice", { name: folder.name }))
      void refetchNodes()
      return true
    } catch (err) {
      return sentence(err, folder.name)
    }
  }

  /** On this computer: the picked folder joins the list through the shell. */
  async function choose(): Promise<boolean | string> {
    const s = local()
    if (!s?.pickDirectory || !s.setSharedRoots) return false
    const picked = await s.pickDirectory().catch(() => null)
    if (!picked) return false
    const current = list()?.shared.roots ?? []
    if (current.includes(picked)) return true
    try {
      const answer = await s.setSharedRoots([...current, picked])
      setDropped(answer.dropped ?? [])
      setNotice(i18n.t("kernel.nodeSessions.folders.sharedNotice", { name: folderName(picked) }))
      await load()
      void refetchNodes()
      return true
    } catch (err) {
      // The shell answers a code; the reader gets a sentence, never the code.
      return sentence(String(err), folderName(picked))
    }
  }

  async function backToDefault(): Promise<void> {
    const s = local()
    if (!s?.setSharedRoots || busy()) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const answer = await s.setSharedRoots(null)
      setDropped(answer.dropped ?? [])
      await load()
      void refetchNodes()
    } catch (err) {
      setError(sentence(String(err)))
    } finally {
      setBusy(false)
    }
  }

  /** Clones and follows the clone; resolves null once added, else the sentence said. */
  async function clone(url: string, name: string, explicit: boolean): Promise<string | null> {
    setError(null)
    setNotice(null)
    setCloning(name)
    try {
      let answer: CloneAnswer = await cloneOntoNode(
        api,
        props.node.id,
        url,
        explicit ? name : undefined,
      )
      while (answer.state === "cloning") {
        await new Promise<void>((resolve) => {
          followTimer = setTimeout(resolve, 2000)
        })
        answer = await followCloneRequest(api, props.node.id, answer.requestId)
      }
      setList(answer.list)
      setCloning(null)
      setNotice(i18n.t("kernel.nodeSessions.folders.clone.done", { name }))
      void refetchNodes()
      return null
    } catch (err) {
      setCloning(null)
      const said = sentence(err, name)
      setError(said)
      return said
    }
  }

  async function addRoot(path: string): Promise<void> {
    const p = path.trim()
    if (!p) return
    if (await act(() => addSearchRoot(api, props.node.id, p), p)) setRootDraft("")
  }

  async function pickPlace(): Promise<void> {
    const picked = await local()
      ?.pickDirectory?.()
      .catch(() => null)
    if (picked) setConfirmingRoot(picked)
  }

  async function changeNodeRoot(next: string | null): Promise<void> {
    const s = local()
    if (!s?.setNodeRoot) return
    setRootError(null)
    try {
      setNodeRoot(await s.setNodeRoot(next))
    } catch (err) {
      setRootError(
        String(err) === "JobRunning"
          ? i18n.t("kernel.computers.nodeRoot.jobRunning")
          : i18n.t("kernel.computers.nodeRoot.refused"),
      )
    }
  }

  async function pickNodeRoot(): Promise<void> {
    const picked = await local()
      ?.pickDirectory?.()
      .catch(() => null)
    if (picked) await changeNodeRoot(picked)
  }

  function openWhere(): void {
    setAdding(false)
    setMoreOpen(true)
    queueMicrotask(() => moreRef?.scrollIntoView?.({ block: "start", behavior: "smooth" }))
  }

  onMount(async () => {
    if (props.initialQuery) setAdding(true)
    await load()
  })

  // The folder for work without one: read once this is known to be this
  // computer (the shell says so after mount).
  createEffect(
    on(local, (s) => {
      if (s?.nodeRoot && !nodeRoot()) {
        void s
          .nodeRoot()
          .then(setNodeRoot)
          .catch(() => undefined)
      }
    }),
  )

  const sharedLabels = () => folderLabels(list()?.shared.roots ?? [])
  /** The repos inside a shared folder that the computer shares with it. */
  const reposInside = (path: string): string[] =>
    Object.entries(props.node.sharedFolderWithin ?? {})
      .filter(([, holder]) => holder === folderName(path))
      .map(([name]) => name)
      .sort((a, b) => a.localeCompare(b))
  const isMissing = (path: string) => list()?.shared.missing.includes(path) === true
  const isRefused = (path: string) => list()?.shared.refused.includes(path) === true
  const denied = () => list()?.search.denied ?? []

  const kindLabel = (path: string): string | null => {
    const kind = rootKind(path, list())
    if (!kind) return null
    if (!kind.repo) return i18n.t("kernel.computers.folders.folder")
    return kind.branch
      ? i18n.t("kernel.computers.folders.repoBranch", { branch: kind.branch })
      : i18n.t("kernel.computers.folders.repo")
  }

  return (
    <div
      data-testid={`computer-folders-${props.node.id}`}
      data-status={online() ? status() : "offline"}
      class="flex flex-col gap-8"
    >
      <Show when={!online()}>
        <div data-testid="computer-folders-offline" class="flex flex-col gap-2">
          <p class="text-[13px] leading-relaxed text-warning">
            {i18n.t("kernel.nodeSessions.folders.offline", { node: nodeName() })}
          </p>
          <Show when={(props.node.sharedFolderNames ?? []).length > 0}>
            <p class="text-[12.5px] text-text-secondary">
              {i18n.t("kernel.nodeSessions.folders.sharedLastKnown", {
                names: (props.node.sharedFolderNames ?? []).join(", "),
              })}
            </p>
          </Show>
        </div>
      </Show>

      <Show when={online() && status() === "loading"}>
        <div data-testid="computer-folders-loading" class="flex flex-col gap-3">
          <Skeleton class="h-10 w-full" />
          <Skeleton class="h-10 w-full" />
        </div>
      </Show>

      <Show when={online() && status() === "error"}>
        <div data-testid="computer-folders-error" class="flex flex-wrap items-center gap-3">
          <p class="text-[13px] text-warning">
            {loadError() ?? i18n.t("kernel.nodeSessions.folders.loadError", { node: nodeName() })}
          </p>
          <Button variant="outline" class={`w-auto shrink-0 ${target}`} onClick={() => void load()}>
            {i18n.t("kernel.computers.retry")}
          </Button>
        </div>
      </Show>

      <Show when={online() && status() === "ready" && list()}>
        {(current) => (
          <>
            <Show when={denied().length > 0}>
              <div
                role="alert"
                data-testid="computer-folders-denied"
                class="flex flex-col gap-3 rounded-lg border border-warning-border bg-warning-glow px-4 py-3"
              >
                <p class="flex items-start gap-2.5 text-[13px] leading-relaxed text-text">
                  <TriangleAlert size={18} aria-hidden="true" class="mt-px shrink-0 text-warning" />
                  <span>
                    {i18n.t(`kernel.computers.folders.denied.${osKey(props.node.os)}`, {
                      node: nodeName(),
                      places: placesLabel(denied()),
                    })}
                  </span>
                </p>
                <div class="flex flex-col gap-2 pl-7 sm:flex-row">
                  <Show when={local()?.openPrivacySettings && props.node.os !== "linux"}>
                    <Button
                      variant="outline"
                      class={`w-full shrink-0 sm:w-auto ${target} sm:min-h-0`}
                      data-testid="computer-folders-open-settings"
                      onClick={() => void local()?.openPrivacySettings?.()}
                    >
                      {i18n.t("kernel.computers.folders.openSystemSettings")}
                    </Button>
                  </Show>
                  <Button
                    variant="outline"
                    class={`w-full shrink-0 sm:w-auto ${target} sm:min-h-0`}
                    data-testid="computer-folders-check-again"
                    disabled={busy()}
                    onClick={() => void checkAccess()}
                  >
                    {i18n.t("kernel.nodeSessions.folders.deniedCheck")}
                  </Button>
                </div>
              </div>
            </Show>

            <section data-testid="computer-folders-shared">
              <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div class="min-w-0">
                  <h2 class="text-[15px] font-medium text-text">
                    {i18n.t("kernel.computers.folders.title")}
                  </h2>
                  <p class="mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-text-secondary">
                    {i18n.t("kernel.computers.folders.hint", { node: nodeName() })}
                  </p>
                </div>
                <Button
                  class={`w-full shrink-0 sm:w-auto ${target} sm:min-h-0`}
                  data-testid="computer-folders-add"
                  onClick={() => setAdding(true)}
                >
                  <Plus size={15} aria-hidden="true" />
                  {i18n.t("kernel.computers.folders.add")}
                </Button>
              </div>
              <Show when={current().shared.isDefault}>
                <p
                  data-testid="computer-folders-default"
                  class="mt-3 text-[12.5px] text-text-tertiary"
                >
                  {i18n.t("kernel.nodeSessions.sharedFolders.default")}
                </p>
              </Show>
              <Show
                when={current().shared.roots.length > 0}
                fallback={
                  <p
                    data-testid="computer-folders-empty"
                    class="mt-3 text-[13px] text-text-tertiary"
                  >
                    {i18n.t("kernel.nodeSessions.folders.sharedEmpty")}
                  </p>
                }
              >
                <ul class="mt-3 flex flex-col divide-y divide-border-subtle border-y border-border-subtle">
                  <For each={current().shared.roots}>
                    {(path, index) => (
                      <li
                        data-testid="computer-folder"
                        data-missing={String(isMissing(path))}
                        data-refused={String(isRefused(path))}
                        class="flex items-center justify-between gap-3 py-2"
                      >
                        <span class="flex min-w-0 flex-col">
                          <span class="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                            <span
                              class="min-w-0 truncate font-medium"
                              classList={{
                                "text-text": !isMissing(path),
                                "text-text-tertiary line-through": isMissing(path),
                              }}
                              title={path}
                            >
                              {sharedLabels()[index()]}
                            </span>
                            <Show
                              when={isMissing(path) || isRefused(path)}
                              fallback={
                                <Show when={kindLabel(path)}>
                                  {(label) => (
                                    <span
                                      data-testid="computer-folder-kind"
                                      class="text-[12px] text-text-tertiary"
                                    >
                                      {label()}
                                    </span>
                                  )}
                                </Show>
                              }
                            >
                              <span class="text-[12px] text-warning">
                                {isMissing(path)
                                  ? i18n.t("kernel.nodeSessions.sharedFolders.missing")
                                  : i18n.t("kernel.nodeSessions.sharedFolders.refusedRoot")}
                              </span>
                            </Show>
                          </span>
                          <Show when={tildePath(path, current())}>
                            {(shown) => (
                              <span class="truncate text-[12px] text-text-tertiary">{shown()}</span>
                            )}
                          </Show>
                          <Show when={reposInside(path).length > 0}>
                            <span
                              data-testid="computer-folder-repos"
                              class="text-[12px] text-text-tertiary"
                            >
                              {i18n.t("kernel.nodeSessions.sharedFolders.reposInside", {
                                names: reposInside(path).join(", "),
                              })}
                            </span>
                          </Show>
                        </span>
                        <button
                          type="button"
                          data-testid={`computer-folder-remove-${folderName(path)}`}
                          disabled={busy()}
                          class={textButton}
                          onClick={() =>
                            void act(
                              () => unshareNodeFolder(api, props.node.id, path),
                              folderName(path),
                            ).then((ok) => ok && void refetchNodes())
                          }
                        >
                          {i18n.t("kernel.nodeSessions.sharedFolders.remove")}
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={local()?.setSharedRoots && !current().shared.isDefault}>
                <Button
                  variant="outline"
                  class={`mt-3 w-auto shrink-0 ${target} sm:min-h-0`}
                  data-testid="computer-folders-reset"
                  disabled={busy()}
                  onClick={() => void backToDefault()}
                >
                  {i18n.t("kernel.computers.folders.backToDefault")}
                </Button>
              </Show>
              <Show when={dropped().length > 0}>
                <p
                  data-testid="computer-folders-dropped"
                  class="mt-2 text-[12.5px] text-text-secondary"
                >
                  {i18n.t("kernel.nodeSessions.sharedFolders.droppedNote", {
                    names: dropped().map(folderName).join(", "),
                  })}
                </p>
              </Show>
              <Show when={cloning()}>
                {(name) => (
                  <p
                    role="status"
                    data-testid="computer-folders-cloning"
                    class="mt-2 text-[12.5px] text-text-secondary"
                  >
                    {i18n.t("kernel.nodeSessions.folders.clone.cloning", {
                      name: name(),
                      node: nodeName(),
                    })}
                  </p>
                )}
              </Show>
            </section>

            <RepoScanSection
              node={props.node}
              sentence={sentence}
              onShared={(next, names) => {
                setList(next)
                setError(null)
                setNotice(
                  names.length > 0
                    ? i18n.t("kernel.nodeSessions.folders.sharedNotice", { name: names.join(", ") })
                    : null,
                )
                void refetchNodes()
              }}
            />

            <RemoteReposSection
              node={props.node}
              sentence={sentence}
              onShared={(next, name) => {
                setList(next)
                setError(null)
                setNotice(i18n.t("kernel.nodeSessions.folders.sharedNotice", { name }))
                void refetchNodes()
              }}
              onClone={(url, name) => clone(url, name, false)}
            />

            <details
              ref={moreRef}
              data-testid="computer-folders-more"
              open={moreOpen()}
              onToggle={(e) => setMoreOpen(e.currentTarget.open)}
              class="group border-t border-border-subtle pt-4"
            >
              <summary class="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium text-text-secondary hover:text-text sm:min-h-0 [&::-webkit-details-marker]:hidden">
                <ChevronDown
                  size={14}
                  aria-hidden="true"
                  class="-rotate-90 transition-transform group-open:rotate-0"
                />
                {i18n.t("kernel.computers.folders.more")}
              </summary>
              <div class="mt-4 flex flex-col gap-8">
                <section data-testid="computer-folders-search-roots">
                  <h3 class={sectionHeading}>{i18n.t("kernel.computers.folders.searchTitle")}</h3>
                  <p class="mt-2 max-w-[60ch] text-[12.5px] leading-relaxed text-text-secondary">
                    {i18n.t("kernel.computers.folders.searchHint")}
                  </p>
                  <Show
                    when={current().search.roots.length > 0}
                    fallback={
                      <p
                        data-testid="computer-folders-search-empty"
                        class="mt-2 text-[13px] text-text-tertiary"
                      >
                        {i18n.t("kernel.nodeSessions.folders.searchEmpty")}
                      </p>
                    }
                  >
                    <ul class="mt-2 flex flex-col divide-y divide-border-subtle">
                      <For each={current().search.roots}>
                        {(path, index) => (
                          <li
                            data-testid="computer-folders-search-root"
                            class="flex items-center justify-between gap-3 py-1 text-[13px]"
                          >
                            <span class="flex min-w-0 flex-col">
                              <span class="truncate text-text" title={path}>
                                {current().search.display[index()] === "~"
                                  ? i18n.t("kernel.computers.folders.home")
                                  : (current().search.display[index()] ?? path)}
                              </span>
                              <Show when={current().search.missing.includes(path)}>
                                <span class="text-[12px] text-warning">
                                  {i18n.t("kernel.nodeSessions.sharedFolders.missing")}
                                </span>
                              </Show>
                            </span>
                            <button
                              type="button"
                              data-testid="computer-folders-search-root-remove"
                              disabled={busy()}
                              class={textButton}
                              onClick={() =>
                                void act(() => removeSearchRoot(api, props.node.id, path))
                              }
                            >
                              {i18n.t("kernel.nodeSessions.sharedFolders.remove")}
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <form
                    class="mt-3 flex flex-col gap-2 sm:flex-row"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (rootDraft().trim()) setConfirmingRoot(rootDraft().trim())
                    }}
                  >
                    <input
                      type="text"
                      data-testid="computer-folders-search-root-input"
                      aria-label={i18n.t("kernel.computers.folders.searchTitle")}
                      placeholder={i18n.t("kernel.nodeSessions.folders.searchPlaceholder")}
                      value={rootDraft()}
                      autocapitalize="off"
                      autocorrect="off"
                      spellcheck={false}
                      onInput={(e) => setRootDraft(e.currentTarget.value)}
                      class={`${target} w-full min-w-0 flex-1 rounded-sm border border-border bg-bg px-3 text-[14px] text-text`}
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      class={`w-full shrink-0 sm:w-auto ${target}`}
                      data-testid="computer-folders-search-root-add"
                      disabled={!rootDraft().trim() || busy()}
                    >
                      {i18n.t("kernel.nodeSessions.folders.searchAdd")}
                    </Button>
                    <Show when={local()?.pickDirectory}>
                      <Button
                        type="button"
                        variant="outline"
                        class={`w-full shrink-0 sm:w-auto ${target}`}
                        data-testid="computer-folders-search-root-pick"
                        disabled={busy()}
                        onClick={() => void pickPlace()}
                      >
                        {i18n.t("kernel.computers.folders.searchChoose")}
                      </Button>
                    </Show>
                  </form>
                </section>

                <Show when={local()?.setNodeRoot}>
                  <section data-testid="computer-node-root">
                    <h3 class={sectionHeading}>{i18n.t("kernel.computers.nodeRoot.title")}</h3>
                    <p class="mt-2 max-w-[60ch] text-[12.5px] leading-relaxed text-text-secondary">
                      {i18n.t("kernel.computers.nodeRoot.hint")}
                    </p>
                    <div class="mt-2 flex flex-wrap items-center gap-3">
                      <p data-testid="computer-node-root-path" class="text-[13px] text-text">
                        <span title={nodeRoot()?.path ?? ""}>
                          {folderName(nodeRoot()?.path ?? "")}
                        </span>
                        <Show when={nodeRoot()?.isDefault}>
                          <span class="ml-2 text-text-tertiary">
                            ({i18n.t("kernel.computers.nodeRoot.default")})
                          </span>
                        </Show>
                      </p>
                      <Show when={local()?.pickDirectory}>
                        <Button
                          variant="outline"
                          class={`w-auto shrink-0 ${target} sm:min-h-0`}
                          data-testid="computer-node-root-pick"
                          onClick={() => void pickNodeRoot()}
                        >
                          {i18n.t("kernel.computers.nodeRoot.change")}
                        </Button>
                      </Show>
                      <Show when={nodeRoot() && !nodeRoot()?.isDefault}>
                        <Button
                          variant="outline"
                          class={`w-auto shrink-0 ${target} sm:min-h-0`}
                          data-testid="computer-node-root-reset"
                          onClick={() => void changeNodeRoot(null)}
                        >
                          {i18n.t("kernel.computers.folders.backToDefault")}
                        </Button>
                      </Show>
                    </div>
                    <Show when={rootError()}>
                      {(message) => (
                        <p
                          data-testid="computer-node-root-error"
                          class="mt-2 text-[12.5px] font-medium text-warning"
                        >
                          {message()}
                        </p>
                      )}
                    </Show>
                  </section>
                </Show>
              </div>
            </details>

            <AddFolderDialog
              open={adding()}
              onOpenChange={setAdding}
              node={props.node}
              searchPlaces={current().search.display}
              initialQuery={props.initialQuery}
              canChoose={Boolean(local()?.pickDirectory && local()?.setSharedRoots)}
              onShare={share}
              onChoose={choose}
              onClone={(url, name, explicit) => void clone(url, name, explicit)}
              onChangeWhere={openWhere}
              onLookThere={() => {
                setAdding(false)
                setConfirmingRoot("~")
              }}
              sentence={sentence}
            />
          </>
        )}
      </Show>

      <Show when={error()}>
        {(message) => (
          <p
            role="alert"
            data-testid="computer-folders-action-error"
            class="text-[12.5px] font-medium text-warning"
          >
            {message()}
          </p>
        )}
      </Show>
      <Show when={notice()}>
        {(message) => (
          <p role="status" data-testid="computer-folders-notice" class="text-[12.5px] text-accent">
            {message()}
          </p>
        )}
      </Show>

      <Dialog
        open={confirmingRoot() !== null}
        onOpenChange={(open) => !open && !busy() && setConfirmingRoot(null)}
      >
        <Dialog.Content>
          <Show when={confirmingRoot()}>
            {(place) => (
              <div data-testid="computer-folders-search-root-confirm">
                <Dialog.Title>
                  {i18n.t("kernel.nodeSessions.folders.searchConfirmTitle", {
                    path: place(),
                    node: nodeName(),
                  })}
                </Dialog.Title>
                <Dialog.Description>
                  {i18n.t("kernel.nodeSessions.folders.searchConfirmBody", { node: nodeName() })}
                </Dialog.Description>
                <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    variant="ghost"
                    class={target}
                    data-testid="computer-folders-search-root-cancel"
                    onClick={() => setConfirmingRoot(null)}
                  >
                    {i18n.t("kernel.nodeSessions.confirm.cancel")}
                  </Button>
                  <Button
                    class={target}
                    data-testid="computer-folders-search-root-confirm-yes"
                    loading={busy()}
                    onClick={() => {
                      const path = place()
                      setConfirmingRoot(null)
                      void addRoot(path)
                    }}
                  >
                    {i18n.t("kernel.nodeSessions.folders.searchConfirmYes")}
                  </Button>
                </div>
              </div>
            )}
          </Show>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}
