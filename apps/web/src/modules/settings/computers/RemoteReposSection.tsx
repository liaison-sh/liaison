// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FIND REPOS I CAN ACCESS (S3, S6, S7, S16), inline in a computer's Folders
// tab: the computer asks its own signed-in GitHub CLI (gh) and GitLab CLI
// (glab) which repositories the account can reach. A repository already on
// the computer and shared says Shared; on the computer but not shared, Share;
// not on it, Clone and share (the tab's clone, which shares on success: the
// list is then asked again; a failed clone says why on its row). A
// tool missing or signed out says so with the command to run there; never a
// raw error. A computer without the op says to update Liaison there.

import type { NodeFolderList } from "@liaison/shared"
import { createMemo, createSignal, For, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { relativeTime } from "~/lib/relative-time"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { NodeSummary } from "~/modules/nodes/node-api"
import {
  nodeRemoteRepos,
  type RemoteRepo,
  type RemoteRepos,
  shareNodeFolder,
} from "~/modules/nodes/node-folders-api"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

const target = "min-h-[44px]"
const textButton = `${target} shrink-0 px-2 text-[12.5px] text-text-secondary underline-offset-2 hover:text-text hover:underline disabled:opacity-50 sm:min-h-0`

/** At most this many rows on screen; the filter finds the rest. */
const SHOWN = 200

type Remotes =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; remotes: RemoteRepos }

const codeOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? err.code : typeof err === "string" ? err : undefined

const LOGIN: Record<string, string> = { gh: "gh auth login", glab: "glab auth login" }

export function RemoteReposSection(props: {
  node: NodeSummary
  /** The folder list after a share, for the tab above. */
  onShared: (list: NodeFolderList, name: string) => void
  /**
   * The tab's clone (it follows the clone and says how it went): resolves
   * null once cloned and shared, else the sentence for why not.
   */
  onClone: (url: string, name: string) => Promise<string | null>
  sentence: (err: unknown, name?: string) => string
}) {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()
  const [state, setState] = createSignal<Remotes>({ status: "idle" })
  const [filter, setFilter] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  const [cloned, setCloned] = createSignal<string[]>([])
  const [rowError, setRowError] = createSignal<{ key: string; message: string } | null>(null)

  const say = (err: unknown, name = "") =>
    codeOf(err) === "failed"
      ? t("kernel.nodeSessions.folders.nodeOutdated")
      : props.sentence(err, name)

  async function run(): Promise<void> {
    setState({ status: "loading" })
    setRowError(null)
    try {
      setState({ status: "ready", remotes: await nodeRemoteRepos(api, props.node.id) })
    } catch (err) {
      setState({ status: "error", message: say(err) })
    }
  }

  const ready = () => {
    const s = state()
    return s.status === "ready" ? s.remotes : null
  }
  const nameOf = (repo: RemoteRepo) => repo.fullName.split("/").pop() || repo.fullName
  const keyOf = (repo: RemoteRepo) => `${repo.host}/${repo.fullName}`

  const matching = createMemo(() => {
    const q = filter().trim().toLowerCase()
    const repos = ready()?.repos ?? []
    return q ? repos.filter((r) => r.fullName.toLowerCase().includes(q)) : repos
  })

  async function share(repo: RemoteRepo): Promise<void> {
    const id = repo.local?.candidateId
    const current = ready()
    if (!id || !current || busy()) return
    setBusy(keyOf(repo))
    setRowError(null)
    try {
      const list = await shareNodeFolder(api, props.node.id, id)
      setState({
        status: "ready",
        remotes: {
          ...current,
          repos: current.repos.map((r) =>
            r === repo && r.local
              ? { ...r, local: { ...r.local, shared: true, candidateId: null } }
              : r,
          ),
        },
      })
      props.onShared(list, nameOf(repo))
    } catch (err) {
      const code = codeOf(err)
      // The id was used or forgotten: read the list again, quietly.
      if (code === "candidate_unknown" || code === "ShareNotIssued") {
        try {
          setState({ status: "ready", remotes: await nodeRemoteRepos(api, props.node.id) })
        } catch (again) {
          setRowError({ key: keyOf(repo), message: say(again, nameOf(repo)) })
        }
      } else {
        setRowError({ key: keyOf(repo), message: say(err, nameOf(repo)) })
      }
    } finally {
      setBusy(null)
    }
  }

  async function clone(repo: RemoteRepo): Promise<void> {
    const key = keyOf(repo)
    setRowError(null)
    setCloned((c) => [...c, key])
    const failure = await props.onClone(repo.cloneUrl, nameOf(repo))
    setCloned((c) => c.filter((k) => k !== key))
    if (failure) setRowError({ key, message: failure })
    else await run()
  }

  /** What each tool needs, said only when it is not usable. */
  const toolLines = () => {
    const sources = ready()?.sources ?? []
    const anyOk = sources.some((s) => s.state === "ok")
    return sources.filter(
      (s) => s.state === "signed_out" || s.state === "failed" || (s.state === "missing" && !anyOk),
    )
  }

  return (
    <section data-testid="remote-repos" data-status={state().status}>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <h2 class="text-[15px] font-medium text-text">
            {t("kernel.computers.folders.remotes.title")}
          </h2>
          <p class="mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-text-secondary">
            {t("kernel.computers.folders.remotes.hint", { node: props.node.name })}
          </p>
        </div>
        <Button
          variant="outline"
          class={`w-full shrink-0 sm:w-auto ${target} sm:min-h-0`}
          data-testid="remote-repos-run"
          loading={state().status === "loading"}
          onClick={() => void run()}
        >
          {state().status === "ready"
            ? t("kernel.computers.folders.remotes.again")
            : t("kernel.computers.folders.remotes.run")}
        </Button>
      </div>

      <Show when={state().status === "loading"}>
        <p
          role="status"
          data-testid="remote-repos-loading"
          class="mt-3 text-[12.5px] text-text-tertiary"
        >
          {t("kernel.computers.folders.remotes.loading", { node: props.node.name })}
        </p>
      </Show>

      <Show when={state().status === "error" ? (state() as { message: string }).message : null}>
        {(message) => (
          <div data-testid="remote-repos-error" class="mt-3 flex flex-wrap items-center gap-3">
            <p class="text-[12.5px] text-text-secondary">{message()}</p>
            <Button
              variant="outline"
              class={`w-auto shrink-0 ${target} sm:min-h-0`}
              data-testid="remote-repos-retry"
              onClick={() => void run()}
            >
              {t("kernel.computers.retry")}
            </Button>
          </div>
        )}
      </Show>

      <Show when={ready()}>
        {(result) => (
          <div class="mt-3 flex flex-col gap-2">
            <For each={toolLines()}>
              {(source) => (
                <div
                  data-testid={`remote-repos-source-${source.tool}`}
                  data-state={source.state}
                  class="flex flex-col gap-1 text-[12.5px] text-text-secondary"
                >
                  <p>
                    {t(`kernel.computers.folders.remotes.source.${source.tool}.${source.state}`, {
                      node: props.node.name,
                    })}
                  </p>
                  <Show when={source.state === "signed_out" || source.state === "missing"}>
                    <code
                      data-testid={`remote-repos-login-${source.tool}`}
                      class="self-start rounded-sm bg-surface-hover px-1.5 py-0.5 font-mono text-[12px] text-text"
                    >
                      {LOGIN[source.tool]}
                    </code>
                  </Show>
                </div>
              )}
            </For>

            <Show when={result().repos.length > 0}>
              <input
                type="search"
                data-testid="remote-repos-filter"
                aria-label={t("kernel.computers.folders.remotes.filter")}
                placeholder={t("kernel.computers.folders.remotes.filter")}
                value={filter()}
                autocapitalize="off"
                autocorrect="off"
                spellcheck={false}
                onInput={(e) => setFilter(e.currentTarget.value)}
                class={`${target} w-full min-w-0 rounded-sm border border-border bg-bg px-3 text-[14px] text-text sm:min-h-9`}
              />
              <ul class="flex flex-col divide-y divide-border-subtle border-y border-border-subtle">
                <For each={matching().slice(0, SHOWN)}>
                  {(repo) => {
                    const rowState = () =>
                      repo.local?.shared
                        ? "shared"
                        : repo.local
                          ? "local"
                          : cloned().includes(keyOf(repo))
                            ? "cloning"
                            : "remote"
                    return (
                      <li
                        data-testid="remote-repos-row"
                        data-state={rowState()}
                        class="flex flex-col gap-1 py-2"
                      >
                        <div class="flex items-center gap-3">
                          <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate text-[13px] font-medium text-text">
                              {repo.fullName}
                            </span>
                            <span class="flex flex-wrap gap-x-2 text-[12px] text-text-tertiary">
                              <span>{repo.host}</span>
                              <Show when={repo.private}>
                                <span>{t("kernel.computers.folders.remotes.private")}</span>
                              </Show>
                              <Show when={repo.pushedAt}>
                                {(at) => <span>{relativeTime(at(), i18n.locale())}</span>}
                              </Show>
                              <Show when={repo.local}>
                                {(l) => <span class="truncate">{l().display}</span>}
                              </Show>
                            </span>
                          </span>
                          <Show when={rowState() === "shared"}>
                            <span
                              data-testid="remote-repos-shared"
                              class="shrink-0 text-[12px] text-text-tertiary"
                            >
                              {t("kernel.computers.folders.remotes.shared")}
                            </span>
                          </Show>
                          <Show when={rowState() === "local"}>
                            <Show
                              when={repo.local?.candidateId}
                              fallback={
                                <span class="shrink-0 text-[12px] text-text-tertiary">
                                  {t("kernel.computers.folders.remotes.onComputer")}
                                </span>
                              }
                            >
                              <button
                                type="button"
                                data-testid="remote-repos-share"
                                class={textButton}
                                disabled={busy() !== null}
                                onClick={() => void share(repo)}
                              >
                                {t("kernel.computers.folders.remotes.share")}
                              </button>
                            </Show>
                          </Show>
                          <Show when={rowState() === "remote"}>
                            <button
                              type="button"
                              data-testid="remote-repos-clone"
                              class={textButton}
                              onClick={() => void clone(repo)}
                            >
                              {t("kernel.computers.folders.remotes.clone")}
                            </button>
                          </Show>
                          <Show when={rowState() === "cloning"}>
                            <span class="shrink-0 text-[12px] text-text-tertiary">
                              {t("kernel.computers.folders.remotes.cloneStarted")}
                            </span>
                          </Show>
                        </div>
                        <Show when={rowError()?.key === keyOf(repo) ? rowError()?.message : null}>
                          {(message) => (
                            <p
                              data-testid="remote-repos-row-error"
                              class="text-[12px] text-text-secondary"
                            >
                              {message()}
                            </p>
                          )}
                        </Show>
                      </li>
                    )
                  }}
                </For>
              </ul>
              <Show when={matching().length > SHOWN}>
                <p data-testid="remote-repos-more" class="text-[12px] text-text-tertiary">
                  {t("kernel.computers.folders.remotes.more", {
                    shown: SHOWN,
                    total: matching().length,
                  })}
                </p>
              </Show>
            </Show>
            <Show
              when={result().repos.length === 0 && result().sources.some((s) => s.state === "ok")}
            >
              <p data-testid="remote-repos-empty" class="text-[12.5px] text-text-tertiary">
                {t("kernel.computers.folders.remotes.empty")}
              </p>
            </Show>
            <Show when={result().dropped > 0}>
              <p data-testid="remote-repos-dropped" class="text-[12px] text-text-tertiary">
                {t("kernel.computers.folders.remotes.dropped", { count: result().dropped })}
              </p>
            </Show>
          </div>
        )}
      </Show>
    </section>
  )
}
