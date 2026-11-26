// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Page history: every text the page had, newest first, with who wrote it and
// when; one is compared with the current page and can be restored (a restore is
// a new version, so nothing is lost by it). Shown in place of the page, in its
// tab; on a phone the list sits above the text.

import { Zap } from "lucide-solid"
import { type Component, createMemo, createResource, createSignal, For, Show } from "solid-js"
import type { ApiClient } from "~/lib/api-client"
import { relativeTime } from "~/lib/relative-time"
import type { FileViewDeps } from "~/modules/editor/file-view"
import { useI18n } from "~/modules/i18n/i18n-context"
import { shellTier } from "~/modules/shell/shell-tier"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import {
  getKnowledgeVersion,
  type KnowledgeVersionItem,
  listKnowledgeVersions,
} from "./knowledge-api"
import { diffOf, TextDiff } from "./TextDiff"

const CURRENT = "current"

export interface PageHistoryProps {
  api: ApiClient
  docId: string
  /** The signed-in person (their versions read "you"). */
  me: string | null
  current: { title: string; body: string }
  onRestore: (version: KnowledgeVersionItem) => Promise<boolean>
  onClose: () => void
  /** How the page draws its files, so a compared image shows as a picture. */
  files?: FileViewDeps | null
}

/** "Amina Cherif", "Agent of Amina Cherif", or "Someone". */
export function versionAuthor(
  v: Pick<KnowledgeVersionItem, "authorType" | "authorName">,
  t: (key: string, params?: Record<string, string>) => string,
): string {
  const name = v.authorName ?? t("knowledge.autosave.someone")
  return v.authorType === "agent" ? t("knowledge.autosave.agentOf", { name }) : name
}

const KIND_KEYS: Partial<Record<KnowledgeVersionItem["kind"], string>> = {
  baseline: "knowledge.autosave.kindBaseline",
  import: "knowledge.autosave.kindImport",
  restore: "knowledge.autosave.kindRestore",
  unapplied: "knowledge.autosave.kindUnapplied",
}

export const PageHistory: Component<PageHistoryProps> = (props) => {
  const i18n = useI18n()
  const phone = () => shellTier() === "phone"
  const [list] = createResource(
    () => props.docId,
    (id) => listKnowledgeVersions(props.api, id),
  )
  const [selected, setSelected] = createSignal<string>(CURRENT)
  const [confirming, setConfirming] = createSignal(false)
  const [restoring, setRestoring] = createSignal(false)

  const versions = () => list() ?? []
  /** The newest version that was the page's text (not a text kept aside). */
  const previousApplied = () => versions().find((v) => v.kind !== "unapplied")
  const selectedItem = () => versions().find((v) => v.id === selected()) ?? null

  // The text compared with the current page: the selected version, or for the
  // current page the version before its last change.
  const compareId = () => {
    if (selected() !== CURRENT) return selected()
    const applied = versions().filter((v) => v.kind !== "unapplied")
    return applied[1]?.id ?? null
  }
  const [compared] = createResource(compareId, (vid) =>
    getKnowledgeVersion(props.api, props.docId, vid),
  )
  const diff = createMemo(() => {
    const other = compared()
    if (!other) return null
    return diffOf(other.body, props.current.body)
  })

  const when = (iso: string) => relativeTime(iso, i18n.locale(), { style: "long" }) || iso

  const restore = async () => {
    const v = selectedItem()
    if (!v) return
    setRestoring(true)
    try {
      if (await props.onRestore(v)) setConfirming(false)
    } finally {
      setRestoring(false)
    }
  }

  const item = (
    id: string,
    label: string,
    at: string | null,
    note: string | null,
    agent: boolean,
    current: boolean,
  ) => (
    <button
      type="button"
      data-testid="history-version"
      data-version-id={id}
      aria-pressed={selected() === id}
      onClick={() => setSelected(id)}
      class="flex min-h-11 w-full flex-col items-start gap-0.5 border-l-2 px-4 py-2 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover"
      classList={{
        "border-accent bg-surface-active": selected() === id,
        "border-transparent": selected() !== id,
      }}
    >
      <span class="flex items-center gap-1.5 text-[13px] text-text">
        <Show when={agent}>
          <Zap size={12} class="text-text-tertiary" />
        </Show>
        {label}
        <Show when={current}>
          <span class="rounded bg-surface-hover px-1.5 text-[12px] text-text-secondary">
            {i18n.t("knowledge.autosave.current")}
          </span>
        </Show>
      </span>
      <Show when={at}>
        <span class="text-[12px] text-text-tertiary">{at}</span>
      </Show>
      <Show when={note}>
        <span class="text-[12px] text-text-secondary">{note}</span>
      </Show>
    </button>
  )

  return (
    <div data-testid="page-history" class="flex h-full flex-col">
      <div class="flex shrink-0 items-center justify-between gap-3 border-b border-border-subtle px-4 py-2.5">
        <div class="flex min-w-0 flex-col gap-0.5">
          <h1 class="truncate text-[15px] font-semibold text-text">{props.current.title}</h1>
          <span class="text-[12px] text-text-tertiary">{i18n.t("knowledge.autosave.history")}</span>
        </div>
        <Button variant="outline" size="sm" data-testid="history-close" onClick={props.onClose}>
          {i18n.t("knowledge.autosave.historyBack")}
        </Button>
      </div>
      <div class="flex min-h-0 flex-1" classList={{ "flex-col": phone() }}>
        <div class="min-h-0 min-w-0 flex-1 overflow-y-auto" classList={{ "order-2": phone() }}>
          <div class={phone() ? "px-4 py-4" : "mx-auto max-w-2xl px-8 py-8"}>
            <Show when={list.error}>
              <p role="alert" class="text-xs text-danger">
                {i18n.t("knowledge.autosave.historyLoadFailed")}
              </p>
            </Show>
            <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-border-subtle bg-surface px-3 py-2 text-[12.5px] text-text">
              <span data-testid="history-summary" class="min-w-0 flex-1 basis-60">
                <Show when={selectedItem()} fallback={i18n.t("knowledge.autosave.historyCurrent")}>
                  {(v) =>
                    i18n.t("knowledge.autosave.historyFrom", {
                      name: versionAuthor(v(), i18n.t),
                      when: when(v().createdAt),
                      adds: String(diff()?.added ?? 0),
                      dels: String(diff()?.removed ?? 0),
                    })
                  }
                </Show>
              </span>
              <Show when={selectedItem()}>
                <Button size="sm" data-testid="history-restore" onClick={() => setConfirming(true)}>
                  {i18n.t("knowledge.autosave.restoreVersion")}
                </Button>
              </Show>
            </div>
            <Show
              when={selected() === CURRENT && !compareId()}
              fallback={
                <Show when={compared()}>
                  {(other) => (
                    <TextDiff
                      data-testid="history-diff"
                      before={other().body}
                      after={props.current.body}
                      files={props.files}
                    />
                  )}
                </Show>
              }
            >
              <TextDiff
                data-testid="history-diff"
                before=""
                after={props.current.body}
                files={props.files}
              />
            </Show>
          </div>
        </div>
        <aside
          aria-label={i18n.t("knowledge.autosave.versions")}
          class="shrink-0 overflow-y-auto border-border bg-surface py-2"
          classList={{
            "order-1 max-h-44 w-full border-b": phone(),
            "w-[clamp(220px,24vw,300px)] border-l": !phone(),
          }}
        >
          <div class="px-4 pb-1.5 pt-1 text-[12px] font-semibold text-text-tertiary">
            {i18n.t("knowledge.autosave.versions")}
          </div>
          {item(CURRENT, props.current.title, null, null, false, true)}
          <For each={versions()}>
            {(v) => {
              const key = KIND_KEYS[v.kind]
              return item(
                v.id,
                versionAuthor(v, i18n.t),
                when(v.createdAt),
                key ? i18n.t(key) : null,
                v.authorType === "agent",
                false,
              )
            }}
          </For>
          <Show when={list() && versions().length === 0}>
            <p class="px-4 py-2 text-[12px] text-text-tertiary">
              {i18n.t("knowledge.autosave.historyEmpty")}
            </p>
          </Show>
        </aside>
      </div>
      <Dialog open={confirming()} onOpenChange={(open) => !open && setConfirming(false)}>
        <Dialog.Content>
          <Dialog.Title>{i18n.t("knowledge.autosave.restoreConfirmTitle")}</Dialog.Title>
          <Dialog.Description>{i18n.t("knowledge.autosave.restoreConfirmBody")}</Dialog.Description>
          <div class="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {i18n.t("kernel.common.cancel")}
            </Button>
            <Button
              data-testid="history-restore-confirm"
              loading={restoring()}
              onClick={() => void restore()}
            >
              {i18n.t("knowledge.autosave.restore")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
      <span class="hidden">{previousApplied()?.id}</span>
    </div>
  )
}

export default PageHistory
