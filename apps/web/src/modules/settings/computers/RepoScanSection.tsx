// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SCAN FOR REPOS (S1, S2, S16), inline in a computer's Folders tab: the
// computer walks the places Add a folder looks in and answers the git
// repositories it found. They show as a checklist: shared ones ticked and
// fixed, ones that cannot be shared fixed with the reason, the rest to tick.
// Share selected shares every ticked row in one request; a row the computer
// refused says why. A computer without the scan says to update Liaison there.

import type { NodeFolderList } from "@liaison/shared"
import { createSignal, For, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { NodeSummary } from "~/modules/nodes/node-api"
import {
  type RepoScan,
  scanNodeRepos,
  shareManyNodeFolders,
} from "~/modules/nodes/node-folders-api"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { placesLabel } from "./computer-model"

const target = "min-h-[44px]"

type Scan =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "error"; message: string }
  | { status: "ready"; scan: RepoScan }

const codeOf = (err: unknown): string | undefined =>
  err instanceof ApiError ? err.code : typeof err === "string" ? err : undefined

export function RepoScanSection(props: {
  node: NodeSummary
  /** The folder list after a share, for the tab above. */
  onShared: (list: NodeFolderList, names: string[]) => void
  /** The tab's sentence for a refusal code; `{{name}}` is the folder. */
  sentence: (err: unknown, name?: string) => string
}) {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()
  const [scan, setScan] = createSignal<Scan>({ status: "idle" })
  const [picked, setPicked] = createSignal<string[]>([])
  const [refused, setRefused] = createSignal<Record<string, string>>({})
  const [sharing, setSharing] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  /** An older computer answers `failed` for an op it does not know (S16). */
  const say = (err: unknown, name = "") =>
    codeOf(err) === "failed"
      ? t("kernel.nodeSessions.folders.nodeOutdated")
      : props.sentence(err, name)

  async function run(quiet = false): Promise<void> {
    if (!quiet) setScan({ status: "scanning" })
    setError(null)
    try {
      const answer = await scanNodeRepos(api, props.node.id)
      setScan({ status: "ready", scan: answer })
      setPicked([])
      if (!quiet) setRefused({})
    } catch (err) {
      setScan({ status: "error", message: say(err) })
    }
  }

  const ready = () => {
    const s = scan()
    return s.status === "ready" ? s.scan : null
  }

  function toggle(id: string, on: boolean): void {
    setPicked((p) => (on ? [...p.filter((x) => x !== id), id] : p.filter((x) => x !== id)))
  }

  async function shareSelected(): Promise<void> {
    const ids = picked()
    const current = ready()
    if (!current || ids.length === 0 || sharing()) return
    setSharing(true)
    setError(null)
    try {
      const answer = await shareManyNodeFolders(api, props.node.id, ids)
      const refusedIds = new Map(answer.refused.map((r) => [r.candidateId, r.code]))
      const names: string[] = []
      const nextRefused: Record<string, string> = {}
      const candidates = current.candidates.map((c) => {
        if (!c.candidateId || !ids.includes(c.candidateId)) return c
        const code = refusedIds.get(c.candidateId)
        if (code) {
          nextRefused[c.display] = say(code, c.name)
          return c
        }
        names.push(c.name)
        return { ...c, shared: true, candidateId: null }
      })
      setScan({ status: "ready", scan: { ...current, candidates } })
      setPicked([])
      setRefused(nextRefused)
      props.onShared(answer.list, names)
    } catch (err) {
      const code = codeOf(err)
      // A used or forgotten id (a double click, a scan from long ago): read again, quietly.
      if (code === "candidate_unknown" || code === "ShareNotIssued") await run(true)
      else setError(say(err))
    } finally {
      setSharing(false)
    }
  }

  const reason = (refusal: string | null) =>
    t(`kernel.computers.folders.scan.refusal.${refusal ?? "outside_search"}`)

  return (
    <section data-testid="repo-scan" data-status={scan().status}>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div class="min-w-0">
          <h2 class="text-[15px] font-medium text-text">
            {t("kernel.computers.folders.scan.title", { node: props.node.name })}
          </h2>
          <p class="mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-text-secondary">
            {t("kernel.computers.folders.scan.hint", { node: props.node.name })}
          </p>
        </div>
        <Button
          variant="outline"
          class={`w-full shrink-0 sm:w-auto ${target} sm:min-h-0`}
          data-testid="repo-scan-run"
          loading={scan().status === "scanning"}
          disabled={sharing()}
          onClick={() => void run()}
        >
          {scan().status === "ready"
            ? t("kernel.computers.folders.scan.again")
            : t("kernel.computers.folders.scan.run")}
        </Button>
      </div>

      <Show when={scan().status === "scanning"}>
        <p
          role="status"
          data-testid="repo-scan-scanning"
          class="mt-3 text-[12.5px] text-text-tertiary"
        >
          {t("kernel.computers.folders.scan.scanning", { node: props.node.name })}
        </p>
      </Show>

      <Show when={scan().status === "error" ? (scan() as { message: string }).message : null}>
        {(message) => (
          <div data-testid="repo-scan-error" class="mt-3 flex flex-wrap items-center gap-3">
            <p class="text-[12.5px] text-text-secondary">{message()}</p>
            <Button
              variant="outline"
              class={`w-auto shrink-0 ${target} sm:min-h-0`}
              data-testid="repo-scan-retry"
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
            <Show when={result().searchRoots === 0}>
              <p data-testid="repo-scan-no-roots" class="text-[12.5px] text-text-secondary">
                {t("kernel.nodeSessions.folders.noSearchRoots")}
              </p>
            </Show>
            <Show when={result().searchRoots > 0 && result().candidates.length === 0}>
              <p data-testid="repo-scan-empty" class="text-[12.5px] text-text-tertiary">
                {t("kernel.computers.folders.scan.empty")}
              </p>
            </Show>
            <Show when={result().candidates.length > 0}>
              <ul class="flex flex-col divide-y divide-border-subtle border-y border-border-subtle">
                <For each={result().candidates}>
                  {(repo) => {
                    const id = () => repo.candidateId
                    const fixed = () => repo.shared || !repo.shareable || !id()
                    return (
                      <li
                        data-testid="repo-scan-row"
                        data-shared={String(repo.shared)}
                        class="flex items-center gap-3 py-2"
                      >
                        <label
                          class={`flex min-w-0 flex-1 items-center gap-3 ${target} sm:min-h-0`}
                        >
                          <input
                            type="checkbox"
                            data-testid="repo-scan-check"
                            class="h-4 w-4 shrink-0 accent-accent"
                            checked={
                              repo.shared || (id() !== null && picked().includes(id() as string))
                            }
                            disabled={fixed() || sharing()}
                            onChange={(e) => toggle(id() as string, e.currentTarget.checked)}
                          />
                          <span class="flex min-w-0 flex-col">
                            <span class="truncate text-[13px] font-medium text-text">
                              {repo.name}
                            </span>
                            <span class="truncate text-[12px] text-text-tertiary">
                              {repo.display}
                            </span>
                          </span>
                        </label>
                        <Show
                          when={refused()[repo.display]}
                          fallback={
                            <Show
                              when={repo.shared}
                              fallback={
                                <Show when={!repo.shareable}>
                                  <span
                                    data-testid="repo-scan-reason"
                                    class="max-w-[24ch] shrink-0 text-right text-[12px] text-text-tertiary"
                                  >
                                    {reason(repo.refusal)}
                                  </span>
                                </Show>
                              }
                            >
                              <span class="shrink-0 text-[12px] text-text-tertiary">
                                {t("kernel.computers.folders.scan.shared")}
                              </span>
                            </Show>
                          }
                        >
                          {(message) => (
                            <span
                              data-testid="repo-scan-refused"
                              class="max-w-[30ch] shrink-0 text-right text-[12px] text-text-secondary"
                            >
                              {message()}
                            </span>
                          )}
                        </Show>
                      </li>
                    )
                  }}
                </For>
              </ul>
              <div class="flex flex-wrap items-center gap-3">
                <Button
                  class={`w-full shrink-0 sm:w-auto ${target} sm:min-h-0`}
                  data-testid="repo-scan-share"
                  disabled={picked().length === 0}
                  loading={sharing()}
                  onClick={() => void shareSelected()}
                >
                  {t("kernel.computers.folders.scan.shareSelected", { count: picked().length })}
                </Button>
              </div>
            </Show>
            <Show when={result().partial}>
              <p data-testid="repo-scan-partial" class="text-[12px] text-text-tertiary">
                {t("kernel.computers.folders.scan.partial")}
              </p>
            </Show>
            <Show when={result().denied.length > 0}>
              <p data-testid="repo-scan-denied" class="text-[12px] text-text-tertiary">
                {t("kernel.computers.folders.scan.denied", {
                  node: props.node.name,
                  places: placesLabel(result().denied),
                })}
              </p>
            </Show>
          </div>
        )}
      </Show>

      <Show when={error()}>
        {(message) => (
          <p
            role="alert"
            data-testid="repo-scan-share-error"
            class="mt-2 text-[12.5px] text-text-secondary"
          >
            {message()}
          </p>
        )}
      </Show>
    </section>
  )
}
