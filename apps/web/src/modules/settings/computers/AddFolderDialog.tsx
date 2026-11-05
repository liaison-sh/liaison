// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ADD A FOLDER TO <computer>: find it by name in the places the computer
// looks in (the node's lookup; partial and refused places said), then Add,
// which still asks first and says that agents can read and change its files.
// Or, on the computer itself, choose it with the native picker; or clone a
// repository there with the computer's own git login. The searched places
// are named, with a link to change them.
//
// The dialog checks and confirms; the Folders tab runs the change (share,
// pick, clone) and shows its result.

import { nodeCloneDefaultName, nodeCloneNameOk, nodeCloneUrlOk } from "@liaison/shared"
import { X } from "lucide-solid"
import { type Component, createEffect, createSignal, For, on, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { NodeSummary } from "~/modules/nodes/node-api"
import {
  type FolderLookup,
  type FoundFolder,
  findNodeFolder,
} from "~/modules/nodes/node-folders-api"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { osKey, placesLabel } from "./computer-model"

const target = "min-h-[44px]"
const input = `${target} w-full min-w-0 rounded-sm border border-border bg-bg px-3 text-[14px] text-text`

type View =
  | { kind: "find" }
  | { kind: "confirm"; folder: FoundFolder }
  | { kind: "clone"; url: string; name: string; explicit: boolean }

export interface AddFolderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  node: NodeSummary
  /** The places the computer looks in, as it shows them (`~`, `~/Documents`). */
  searchPlaces: readonly string[]
  /** A name to search for at once (a blocked card's "Fix it"). */
  initialQuery?: string | null
  /** The native picker is there: this computer, in the desktop app. */
  canChoose: boolean
  /** Shares a found folder: true once it is added, else the refusal in words. */
  onShare: (folder: FoundFolder) => Promise<true | string>
  /** Opens the picker and adds what was chosen: true added, false cancelled, else the refusal. */
  onChoose: () => Promise<boolean | string>
  /** Starts a clone (the tab follows it). */
  onClone: (url: string, name: string, explicit: boolean) => void
  /** "Change where it looks": the tab opens that setting. */
  onChangeWhere: () => void
  /** "Also look there": the home folder, chosen explicitly (the tab asks first). */
  onLookThere: () => void
  /** Turns a refusal into a sentence. */
  sentence: (err: unknown, name?: string) => string
}

export const AddFolderDialog: Component<AddFolderDialogProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [view, setView] = createSignal<View>({ kind: "find" })
  const [query, setQuery] = createSignal(props.initialQuery ?? "")
  const [searching, setSearching] = createSignal(false)
  const [found, setFound] = createSignal<FolderLookup | null>(null)
  const [searchedFor, setSearchedFor] = createSignal("")
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [cloneUrl, setCloneUrl] = createSignal("")
  const [cloneName, setCloneName] = createSignal("")
  const nodeName = () => props.node.name

  async function search(): Promise<void> {
    const q = query().trim()
    if (!q || searching()) return
    setSearching(true)
    setError(null)
    setFound(null)
    try {
      setFound(await findNodeFolder(api, props.node.id, q))
      setSearchedFor(q)
    } catch (err) {
      setError(props.sentence(err, q))
    } finally {
      setSearching(false)
    }
  }

  // Opened with a name (or opened again): search for it at once.
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) {
          setView({ kind: "find" })
          setError(null)
          return
        }
        if (props.initialQuery && !found()) {
          setQuery(props.initialQuery)
          void search()
        }
      },
    ),
  )

  async function share(folder: FoundFolder): Promise<void> {
    setBusy(true)
    const done = await props.onShare(folder)
    setBusy(false)
    if (done === true) {
      props.onOpenChange(false)
      return
    }
    setError(done)
    setView({ kind: "find" })
  }

  async function choose(): Promise<void> {
    setBusy(true)
    setError(null)
    const done = await props.onChoose()
    setBusy(false)
    if (done === true) props.onOpenChange(false)
    else if (typeof done === "string") setError(done)
  }

  /** Checks the URL and name here first (the server and the node check them again). */
  function askClone(): void {
    setError(null)
    const url = cloneUrl().trim()
    const name = cloneName().trim()
    if (!nodeCloneUrlOk(url)) {
      setError(i18n.t("kernel.nodeSessions.folders.clone.urlRefused"))
      return
    }
    const folder = name || nodeCloneDefaultName(url)
    if (!nodeCloneNameOk(folder)) {
      setError(i18n.t("kernel.nodeSessions.folders.clone.nameRefused"))
      return
    }
    setView({ kind: "clone", url, name: folder, explicit: Boolean(name) })
  }

  const deniedNote = (places: string[]) =>
    i18n.t(`kernel.computers.add.denied.${osKey(props.node.os)}`, {
      node: nodeName(),
      places: placesLabel(places),
    })

  const placesRead = () =>
    props.searchPlaces
      .map((p) => (p === "~" ? i18n.t("kernel.computers.add.homeFolder") : p))
      .join(", ")

  return (
    <Dialog open={props.open} onOpenChange={(open) => !busy() && props.onOpenChange(open)}>
      <Dialog.Content class="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto p-5 sm:p-6">
        <div data-testid="add-folder-dialog" data-view={view().kind}>
          <Show when={view().kind === "find"}>
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <Dialog.Title>
                  {i18n.t("kernel.computers.add.title", { node: nodeName() })}
                </Dialog.Title>
                <Dialog.Description>{i18n.t("kernel.computers.add.body")}</Dialog.Description>
              </div>
              <Dialog.Close
                data-testid="add-folder-close"
                aria-label={i18n.t("kernel.computers.add.close")}
                class="-mr-2 -mt-2 flex size-11 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-surface-hover hover:text-text"
              >
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
            </div>

            <form
              class="mt-5 flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void search()
              }}
            >
              <label for="add-folder-query" class="text-[13px] font-medium text-text">
                {i18n.t("kernel.computers.add.find")}
              </label>
              <div class="flex flex-col gap-2 sm:flex-row">
                <input
                  id="add-folder-query"
                  type="search"
                  data-testid="add-folder-query"
                  placeholder={i18n.t("kernel.nodeSessions.folders.findPlaceholder")}
                  value={query()}
                  maxLength={100}
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  class={`${input} flex-1`}
                />
                <Button
                  type="submit"
                  variant="outline"
                  class={`w-full shrink-0 sm:w-auto ${target}`}
                  data-testid="add-folder-search"
                  loading={searching()}
                  disabled={!query().trim()}
                >
                  {i18n.t("kernel.nodeSessions.folders.findButton")}
                </Button>
              </div>
            </form>

            <Show when={found()}>
              {(result) => (
                <div class="mt-3 flex flex-col gap-2">
                  <Show
                    when={result().searchRoots > 0}
                    fallback={
                      <p
                        data-testid="add-folder-no-places"
                        class="text-[13px] leading-relaxed text-text-secondary"
                      >
                        {i18n.t("kernel.nodeSessions.folders.noSearchRoots")}
                      </p>
                    }
                  >
                    <Show when={result().denied.length > 0}>
                      <p
                        role="alert"
                        data-testid="add-folder-denied"
                        class="text-[12.5px] leading-relaxed text-warning"
                      >
                        {deniedNote(result().denied)}
                      </p>
                    </Show>
                    <Show when={result().skippedProtected}>
                      <p
                        data-testid="add-folder-skipped"
                        class="text-[12.5px] leading-relaxed text-text-secondary"
                      >
                        {i18n.t("kernel.computers.add.skipped")}{" "}
                        <button
                          type="button"
                          data-testid="add-folder-look-there"
                          class="text-accent underline-offset-2 hover:underline"
                          onClick={() => props.onLookThere()}
                        >
                          {i18n.t("kernel.computers.add.lookThere")}
                        </button>
                      </p>
                    </Show>
                    <Show when={result().partial}>
                      <p data-testid="add-folder-partial" class="text-[12.5px] text-text-secondary">
                        {i18n.t("kernel.nodeSessions.folders.partial")}
                      </p>
                    </Show>
                    <Show
                      when={result().candidates.length > 0}
                      fallback={
                        <p
                          data-testid="add-folder-not-found"
                          class="text-[13px] text-text-secondary"
                        >
                          {i18n.t("kernel.nodeSessions.folders.notFound", { name: searchedFor() })}
                        </p>
                      }
                    >
                      <ul class="flex flex-col divide-y divide-border-subtle rounded-md border border-border-subtle">
                        <For each={result().candidates}>
                          {(folder) => (
                            <li
                              data-testid="add-folder-candidate"
                              class="flex items-center justify-between gap-3 px-3 py-2"
                            >
                              <span class="flex min-w-0 flex-col">
                                <span class="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                                  <span class="truncate font-medium text-text">{folder.name}</span>
                                  <Show when={folder.isRepo}>
                                    <span class="text-[12px] text-text-tertiary">
                                      {i18n.t("kernel.computers.folders.repo")}
                                    </span>
                                  </Show>
                                </span>
                                <span class="truncate text-[12px] text-text-tertiary">
                                  {folder.display}
                                </span>
                              </span>
                              <Show
                                when={!folder.shared && folder.shareable}
                                fallback={
                                  <span class="shrink-0 px-2 text-[12.5px] text-text-tertiary">
                                    {folder.shared
                                      ? i18n.t("kernel.computers.add.already")
                                      : i18n.t("kernel.computers.add.cannot")}
                                  </span>
                                }
                              >
                                <Button
                                  variant="outline"
                                  class={`w-auto shrink-0 ${target} sm:min-h-0`}
                                  data-testid={`add-folder-add-${folder.name}`}
                                  onClick={() => setView({ kind: "confirm", folder })}
                                >
                                  {i18n.t("kernel.computers.add.add")}
                                </Button>
                              </Show>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </Show>
                </div>
              )}
            </Show>

            <p
              data-testid="add-folder-places"
              class="mt-3 text-[12.5px] leading-relaxed text-text-secondary"
            >
              <Show
                when={props.searchPlaces.length > 0}
                fallback={i18n.t("kernel.computers.add.searchedNowhere")}
              >
                {i18n.t("kernel.computers.add.searched", { places: placesRead() })}
              </Show>{" "}
              <button
                type="button"
                data-testid="add-folder-change-where"
                class="text-accent underline-offset-2 hover:underline"
                onClick={() => props.onChangeWhere()}
              >
                {i18n.t("kernel.computers.add.changeWhere")}
              </button>
            </p>

            <Show when={error()}>
              {(message) => (
                <p
                  role="alert"
                  data-testid="add-folder-error"
                  class="mt-3 text-[12.5px] font-medium text-warning"
                >
                  {message()}
                </p>
              )}
            </Show>

            <div class="my-5 flex items-center gap-3 text-[12px] text-text-tertiary">
              <span class="h-px flex-1 bg-border-subtle" />
              {i18n.t("kernel.computers.add.or")}
              <span class="h-px flex-1 bg-border-subtle" />
            </div>

            <div class="flex flex-col gap-5">
              <Show when={props.canChoose}>
                <div
                  data-testid="add-folder-choose-section"
                  class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div class="min-w-0">
                    <p class="text-[13px] font-medium text-text">
                      {i18n.t("kernel.computers.add.choose", { node: nodeName() })}
                    </p>
                    <p class="text-[12px] text-text-secondary">
                      {i18n.t("kernel.computers.add.chooseHint")}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    class={`w-full shrink-0 sm:w-auto ${target}`}
                    data-testid="add-folder-choose"
                    loading={busy()}
                    onClick={() => void choose()}
                  >
                    {i18n.t("kernel.computers.add.chooseButton")}
                  </Button>
                </div>
              </Show>

              <form
                class="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  askClone()
                }}
              >
                <label for="add-folder-clone-url" class="text-[13px] font-medium text-text">
                  {i18n.t("kernel.nodeSessions.folders.clone.title")}
                </label>
                <p class="text-[12px] text-text-secondary">
                  {i18n.t("kernel.nodeSessions.folders.clone.hint", { node: nodeName() })}
                </p>
                <input
                  id="add-folder-clone-url"
                  // Text, not url: the browser would refuse scp-like git@host:path.
                  type="text"
                  inputmode="url"
                  data-testid="add-folder-clone-url"
                  placeholder={i18n.t("kernel.nodeSessions.folders.clone.urlPlaceholder")}
                  value={cloneUrl()}
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck={false}
                  onInput={(e) => setCloneUrl(e.currentTarget.value)}
                  class={input}
                />
                <div class="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    data-testid="add-folder-clone-name"
                    aria-label={i18n.t("kernel.nodeSessions.folders.clone.name")}
                    placeholder={i18n.t("kernel.nodeSessions.folders.clone.namePlaceholder")}
                    value={cloneName()}
                    maxLength={100}
                    autocapitalize="off"
                    autocorrect="off"
                    spellcheck={false}
                    onInput={(e) => setCloneName(e.currentTarget.value)}
                    class={`${input} flex-1`}
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    class={`w-full shrink-0 sm:w-auto ${target}`}
                    data-testid="add-folder-clone-submit"
                    disabled={!cloneUrl().trim()}
                  >
                    {i18n.t("kernel.nodeSessions.folders.clone.button")}
                  </Button>
                </div>
              </form>
            </div>
          </Show>

          <Show when={view().kind === "confirm" && (view() as { folder: FoundFolder }).folder}>
            {(folder) => (
              <div data-testid="add-folder-confirm">
                <Dialog.Title>
                  {i18n.t("kernel.nodeSessions.folders.confirmTitle", { name: folder().name })}
                </Dialog.Title>
                <Dialog.Description>
                  {i18n.t("kernel.nodeSessions.folders.confirmBody", {
                    node: nodeName(),
                    path: folder().display,
                  })}
                </Dialog.Description>
                <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    variant="ghost"
                    class={target}
                    data-testid="add-folder-confirm-cancel"
                    disabled={busy()}
                    onClick={() => setView({ kind: "find" })}
                  >
                    {i18n.t("kernel.nodeSessions.confirm.cancel")}
                  </Button>
                  <Button
                    class={target}
                    data-testid="add-folder-confirm-add"
                    loading={busy()}
                    onClick={() => void share(folder())}
                  >
                    {i18n.t("kernel.computers.add.add")}
                  </Button>
                </div>
              </div>
            )}
          </Show>

          <Show when={view().kind === "clone" && (view() as Extract<View, { kind: "clone" }>)}>
            {(pending) => (
              <div data-testid="add-folder-clone-confirm">
                <Dialog.Title>
                  {i18n.t("kernel.nodeSessions.folders.clone.confirmTitle", {
                    name: pending().name,
                    node: nodeName(),
                  })}
                </Dialog.Title>
                <Dialog.Description>
                  {i18n.t("kernel.nodeSessions.folders.clone.confirmBody", {
                    url: pending().url,
                    name: pending().name,
                    node: nodeName(),
                  })}
                </Dialog.Description>
                <div class="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <Button
                    variant="ghost"
                    class={target}
                    data-testid="add-folder-clone-cancel"
                    onClick={() => setView({ kind: "find" })}
                  >
                    {i18n.t("kernel.nodeSessions.confirm.cancel")}
                  </Button>
                  <Button
                    class={target}
                    data-testid="add-folder-clone-confirm-yes"
                    onClick={() => {
                      const p = pending()
                      props.onClone(p.url, p.name, p.explicit)
                      setCloneUrl("")
                      setCloneName("")
                      props.onOpenChange(false)
                    }}
                  >
                    {i18n.t("kernel.nodeSessions.folders.clone.button")}
                  </Button>
                </div>
              </div>
            )}
          </Show>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
