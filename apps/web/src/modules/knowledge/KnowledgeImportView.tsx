// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE KNOWLEDGE IMPORT TAB (`knowledge:import`): a Notion export (Markdown &
// CSV, one zip or a zip of zips) into folders and pages. A tab, not a dialog:
// the agent stays reachable while a person reads the preview.
//
//   Upload   how to export, then the zip; a PDF, a web page or anything not a
//            zip is refused here, before any upload.
//   Preview  the server reads the whole upload as the person would import it,
//            writing nothing: folders, pages, files, size against the storage
//            left, and every item that will not come across, grouped. "Who can
//            see these pages" (Only me by default) is part of the preview: the
//            server dedups per person for Only me and per organisation for a
//            shared import, so another choice is checked again.
//   Import   the run acts as the person; its progress is read from the server,
//            so the tab can be closed and reopened (the person's newest Notion
//            run comes back) and a run put back in the queue by a restart goes on.
//   Report   what was made, every item that did not come across (searchable,
//            copyable; a count never hides an item: those past the server's
//            caps are counted as such), then Undo with an inline confirm, and
//            what Undo kept and why.
//
// Without `kernel:imports:run` the tab says so and who to ask.

import { Check, Copy, FileUp, Search } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js"
import { createStore } from "solid-js/store"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { hasScope, userFromToken } from "~/modules/auth/auth-store"
import { formatBytes } from "~/modules/files/file-icons"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type ImportRun, importRunStore } from "~/modules/imports/import-run-store"
import { ImportUploadInterruptedError, uploadImportFile } from "~/modules/imports/upload-client"
import { useApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { openTab } from "~/modules/shell/tab-store"
import { Button } from "~/ui/Button"
import { ScrollFade } from "~/ui/ScrollFade"
import { getKnowledgeDocument } from "./knowledge-api"
import { knowledgeStore, loadCollectionsTree, loadKnowledgeHome } from "./knowledge-store"
import {
  type Access,
  type Counts,
  dismissedRun,
  dismissRun,
  type LossItem,
  type LossSummary,
  lossInputOf,
  type NotionPreview,
  pickResumableRun,
  precheckFile,
  previewNotion,
  previewRefusal,
  type Refusal,
  recentRuns,
  refusalOfError,
  startNotion,
  summarizeLosses,
} from "./notion-import"

const FINAL = new Set(["done", "failed", "cancelled", "undone"])
const ACTIVE = new Set(["queued", "running", "undoing"])
const POLL_MS = 2000
/** The server refuses to start a preview past this share of refused records. */
const MAX_REFUSED = 0.05
const QUIET = { suppressGlobalError: true } as const

type Phase = "upload" | "uploading" | "reading" | "preview" | "run"

interface UndoKept {
  name: string
  reason: string
}
interface UndoResult {
  deleted: number
  kept: UndoKept[]
  otherKept: number
}

interface ImportState {
  phase: Phase
  file: { name: string; size: number; id: string } | null
  percent: number
  access: Access
  preview: NotionPreview | null
  checking: boolean
  refusal: Refusal | null
  error: string | null
  runId: string | null
  undo: UndoResult | null
  /** The server's recent runs were read once this session. */
  resumed: boolean
}

const initial = (): ImportState => ({
  phase: "upload",
  file: null,
  percent: 0,
  access: "private",
  preview: null,
  checking: false,
  refusal: null,
  error: null,
  runId: null,
  undo: null,
  resumed: false,
})

/** Uploads stopped after their retries, by file: choosing the file again resumes them. */
const interrupted = new Map<string, string>()
const fileKey = (f: File) => `${f.name}\u0000${f.size}\u0000${f.lastModified}`

// One import screen per session, kept while the tab is closed and reopened.
const [state, setState] = createStore<ImportState>(initial())

/** Back to a fresh upload (tests, sign-out). */
export function resetKnowledgeImport(): void {
  interrupted.clear()
  setState(initial())
}

onSessionTeardown(resetKnowledgeImport)

const KnowledgeImportView: Component<{ entityId?: string }> = () => {
  const i18n = useI18n()
  const api = useApi()
  const t = i18n.t
  const phone = () => shellTier() === "phone"
  const canImport = () => hasScope("kernel:imports:run") && hasScope("kernel:imports:read")
  const userId = () => userFromToken()?.userId ?? ""
  const [storageLeftGb, setStorageLeftGb] = createSignal<number | null>(null)
  let input: HTMLInputElement | undefined

  // A reopened tab finds the person's newest Notion run (progress or report).
  onMount(() => {
    if (!canImport() || state.resumed || state.phase !== "upload") return
    setState("resumed", true)
    void recentRuns(api)
      .then((rows) => {
        const run = pickResumableRun(rows ?? [], userId(), dismissedRun(userId()))
        if (run && state.phase === "upload") {
          setState({ phase: "run", runId: run.id })
          void importRunStore.reload(api, run.id).catch(() => undefined)
        }
      })
      .catch(() => undefined)
  })

  // Storage left, for those who may read the org's usage (admins); others see none.
  onMount(() => {
    if (!hasScope("kernel:org:admin")) return
    void api
      .get<{ storageGb?: { used: number; limit: number | null } }>("/org/usage", QUIET)
      .then((u) => {
        const s = u?.storageGb
        if (s && typeof s.limit === "number" && s.limit > 0) {
          setStorageLeftGb(Math.max(0, s.limit - s.used))
        }
      })
      .catch(() => undefined)
  })

  const run = (): ImportRun | undefined =>
    state.runId ? importRunStore.getById(state.runId) : undefined

  // While a run moves, read it again; the `import_run` event re-reads it too.
  createEffect(() => {
    const r = run()
    const id = state.runId
    if (!id || (r && !ACTIVE.has(r.status))) return
    const timer = setInterval(
      () => void importRunStore.reload(api, id).catch(() => undefined),
      POLL_MS,
    )
    onCleanup(() => clearInterval(timer))
  })

  // A finished run refreshes the tree and the home feed once.
  let refreshedFor: string | null = null
  createEffect(() => {
    const r = run()
    if (!r || !FINAL.has(r.status) || refreshedFor === r.id) return
    refreshedFor = r.id
    void loadCollectionsTree(api).catch(() => undefined)
    void loadKnowledgeHome(api).catch(() => undefined)
  })

  async function onFile(file: File | undefined): Promise<void> {
    if (!file) return
    setState({ refusal: null, error: null, preview: null })
    const refused = await precheckFile(file)
    if (refused) {
      setState("refusal", refused)
      return
    }
    setState({ phase: "uploading", percent: 0, file: { name: file.name, size: file.size, id: "" } })
    let fileId: string
    try {
      fileId = await uploadImportFile(api, file, {
        resumeId: interrupted.get(fileKey(file)),
        onProgress: (f) => setState("percent", Math.round(f * 100)),
      })
      interrupted.delete(fileKey(file))
    } catch (err) {
      if (err instanceof ImportUploadInterruptedError) interrupted.set(fileKey(file), err.uploadId)
      setState({ phase: "upload", error: t("knowledge.notionImport.uploadFailed") })
      return
    }
    setState("file", "id", fileId)
    await readPreview("reading")
  }

  /** Read the upload for the chosen audience; a refusal goes back to the upload step. */
  async function readPreview(as: "reading" | "checking"): Promise<void> {
    const f = state.file
    if (!f?.id) return
    if (as === "reading") setState("phase", "reading")
    else setState("checking", true)
    try {
      const p = await previewNotion(api, f.id, state.access)
      const refused = previewRefusal(p.counts, p.named.entries)
      if (refused) setState({ phase: "upload", refusal: refused, preview: null })
      else setState({ phase: "preview", preview: p })
    } catch (err) {
      setState({ phase: "upload", refusal: refusalOfError(err), preview: null })
    } finally {
      setState("checking", false)
    }
  }

  function chooseAccess(a: Access): void {
    if (a === state.access) return
    setState("access", a)
    void readPreview("checking")
  }

  async function onStart(): Promise<void> {
    const p = state.preview
    if (!p) return
    setState({ error: null, checking: true })
    try {
      const started = await startNotion(api, p.previewId)
      setState({ phase: "run", runId: started.runId, undo: null })
      await importRunStore.reload(api, started.runId).catch(() => undefined)
    } catch {
      setState("error", t("knowledge.notionImport.startFailed"))
    } finally {
      setState("checking", false)
    }
  }

  function another(): void {
    if (state.runId) dismissRun(userId(), state.runId)
    setState({ ...initial(), resumed: true })
  }

  const steps = () => {
    const r = run()
    const at =
      state.phase === "run" ? (r && FINAL.has(r.status) ? 4 : 3) : state.phase === "preview" ? 2 : 1
    return [
      "knowledge.notionImport.stepUpload",
      "knowledge.notionImport.stepPreview",
      "knowledge.notionImport.stepImport",
      "knowledge.notionImport.stepReport",
    ].map((key, i) => ({ label: t(key), current: at === i + 1, n: i + 1 }))
  }

  return (
    <ScrollFade class="min-h-0 flex-1" fadeColor="var(--color-bg)">
      <div
        data-testid="knowledge-import"
        class={
          phone()
            ? "w-full px-4 pt-4 pb-dock-runway"
            : "mx-auto w-full max-w-2xl px-8 pt-10 pb-dock-runway"
        }
      >
        <header class="mb-6">
          <h1 class="text-[15px] font-medium text-text">{t("knowledge.notionImport.title")}</h1>
          <Show when={canImport()}>
            <ol
              class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px]"
              data-testid="knowledge-import-steps"
            >
              <For each={steps()}>
                {(s) => (
                  <li
                    aria-current={s.current ? "step" : undefined}
                    class={s.current ? "font-medium text-text" : "text-text-tertiary"}
                  >
                    {s.n}. {s.label}
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </header>

        <Show
          when={canImport()}
          fallback={
            <p data-testid="knowledge-import-no-scope" class="text-[13px] text-text-secondary">
              {t("knowledge.notionImport.noScope")}
            </p>
          }
        >
          <Switch>
            <Match when={state.phase === "upload"}>
              <UploadStep
                refusal={state.refusal}
                error={state.error}
                onPick={() => input?.click()}
                onDrop={(f) => void onFile(f)}
                phone={phone()}
              />
            </Match>
            <Match when={state.phase === "uploading"}>
              <p
                role="status"
                data-testid="knowledge-import-uploading"
                class="text-[13px] text-text"
              >
                {t("knowledge.notionImport.uploading", {
                  name: state.file?.name ?? "",
                  percent: state.percent,
                })}
              </p>
              <Bar percent={state.percent} />
            </Match>
            <Match when={state.phase === "reading"}>
              <p role="status" data-testid="knowledge-import-reading" class="text-[13px] text-text">
                {t("knowledge.notionImport.reading")}
              </p>
              <Bar />
            </Match>
            <Match when={state.phase === "preview" && state.preview}>
              {(p) => (
                <PreviewStep
                  preview={p()}
                  file={state.file}
                  access={state.access}
                  checking={state.checking}
                  error={state.error}
                  storageLeftGb={storageLeftGb()}
                  phone={phone()}
                  onAccess={chooseAccess}
                  onBack={another}
                  onStart={() => void onStart()}
                />
              )}
            </Match>
            <Match when={state.phase === "run"}>
              <Show when={run()} fallback={<Bar />}>
                {(r) => (
                  <RunStep
                    run={r()}
                    total={totalOf(state.preview?.counts)}
                    undo={state.undo}
                    phone={phone()}
                    onUndone={(u) => setState("undo", u)}
                    onAnother={another}
                  />
                )}
              </Show>
            </Match>
          </Switch>
          <input
            ref={input}
            type="file"
            accept=".zip,application/zip"
            class="hidden"
            data-testid="knowledge-import-file"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0]
              e.currentTarget.value = ""
              void onFile(f)
            }}
          />
        </Show>
      </div>
    </ScrollFade>
  )
}

function totalOf(counts: Counts | undefined): number | null {
  if (!counts) return null
  let n = 0
  for (const c of Object.values(counts)) n += c.created
  return n
}

const Bar: Component<{ percent?: number }> = (props) => (
  <div
    class="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-active"
    role="progressbar"
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={props.percent}
  >
    <div
      class={`h-full rounded-full bg-accent transition-[width] duration-200 ${props.percent === undefined ? "w-1/3 animate-pulse" : ""}`}
      style={props.percent === undefined ? undefined : { width: `${props.percent}%` }}
    />
  </div>
)

const SECTION = "mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary"

const UploadStep: Component<{
  refusal: Refusal | null
  error: string | null
  phone: boolean
  onPick: () => void
  onDrop: (f: File | undefined) => void
}> = (props) => {
  const { t } = useI18n()
  const [over, setOver] = createSignal(false)
  return (
    <div data-testid="knowledge-import-upload">
      <h2 class={SECTION}>{t("knowledge.notionImport.howTitle")}</h2>
      <ol class="mb-5 list-decimal space-y-1 pl-5 text-[13px] text-text-secondary">
        <li>{t("knowledge.notionImport.how1")}</li>
        <li>{t("knowledge.notionImport.how2")}</li>
        <li>{t("knowledge.notionImport.how3")}</li>
      </ol>
      <Show when={props.refusal}>
        {(r) => (
          <p
            role="alert"
            data-testid="knowledge-import-refusal"
            data-reason={r()}
            class="mb-3 rounded-md border border-border-subtle px-3 py-2 text-[13px] text-text"
          >
            {t(`knowledge.notionImport.refusal.${r()}`)}
          </p>
        )}
      </Show>
      <Show when={props.error}>
        <p role="alert" data-testid="knowledge-import-error" class="mb-3 text-[13px] text-text">
          {props.error}
        </p>
      </Show>
      <div
        data-testid="knowledge-import-drop"
        class={`flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-10 text-center ${over() ? "border-accent" : "border-border-strong"}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          props.onDrop(e.dataTransfer?.files?.[0])
        }}
      >
        <FileUp size={24} class="text-text-tertiary" />
        <Show when={!props.phone}>
          <span class="text-[13px] text-text">{t("knowledge.notionImport.dropHint")}</span>
        </Show>
        <Button
          variant="outline"
          size={props.phone ? "md" : "sm"}
          class={props.phone ? "min-h-11" : ""}
          data-testid="knowledge-import-choose"
          onClick={props.onPick}
        >
          {t("knowledge.notionImport.choose")}
        </Button>
      </div>
      <p class="mt-3 text-[12px] text-text-tertiary">{t("knowledge.notionImport.nothingYet")}</p>
    </div>
  )
}

const Card: Component<{ n: number | string; label: string; testid: string }> = (props) => (
  <div
    class="rounded-md border border-border-subtle bg-surface px-3 py-2"
    data-testid={props.testid}
  >
    <div class="text-[18px] font-semibold text-text">{props.n}</div>
    <div class="text-[12px] text-text-tertiary">{props.label}</div>
  </div>
)

const ACCESS: Access[] = ["private", "view", "edit"]
const ACCESS_KEY: Record<Access, string> = { private: "Private", view: "View", edit: "Edit" }

const PreviewStep: Component<{
  preview: NotionPreview
  file: { name: string; size: number } | null
  access: Access
  checking: boolean
  error: string | null
  storageLeftGb: number | null
  phone: boolean
  onAccess: (a: Access) => void
  onBack: () => void
  onStart: () => void
}> = (props) => {
  const i18n = useI18n()
  const t = i18n.t
  const doc = () =>
    props.preview.counts["knowledge.document"] ?? { created: 0, skipped: 0, failed: 0 }
  const col = () =>
    props.preview.counts["knowledge.collection"] ?? { created: 0, skipped: 0, failed: 0 }
  const skipped = () => doc().skipped + col().skipped
  const summary = createMemo(() =>
    summarizeLosses({
      ...props.preview.named,
      errors: props.preview.errors,
      failed: doc().failed + col().failed,
    }),
  )
  const leftBytes = () =>
    props.storageLeftGb === null ? null : props.storageLeftGb * 1024 * 1024 * 1024
  const tooManyRefused = () => props.preview.errorRate > MAX_REFUSED
  const nothingNew = () => doc().created === 0 && col().created === 0
  return (
    <div data-testid="knowledge-import-preview">
      <p class="mb-3 text-[13px] text-text-secondary">
        {t("knowledge.notionImport.previewIntro", {
          name: props.file?.name ?? "",
          size: formatBytes(props.file?.size ?? 0),
        })}
      </p>
      <div class={`mb-3 grid grid-cols-2 gap-2 ${props.phone ? "" : "sm:grid-cols-4"}`}>
        <Card
          n={col().created}
          label={t("knowledge.notionImport.folders")}
          testid="knowledge-import-count-folders"
        />
        <Card
          n={doc().created}
          label={t("knowledge.notionImport.pages")}
          testid="knowledge-import-count-pages"
        />
        <Card
          n={props.preview.named.filesToCopy}
          label={t("knowledge.notionImport.files")}
          testid="knowledge-import-count-files"
        />
        <Card
          n={skipped()}
          label={t("knowledge.notionImport.alreadyThere")}
          testid="knowledge-import-count-skipped"
        />
      </div>
      <Show when={leftBytes()}>
        {(left) => (
          <p class="mb-5 text-[12.5px] text-text-secondary" data-testid="knowledge-import-storage">
            {t("knowledge.notionImport.storageLeft", { left: formatBytes(left()) })}
            <Show when={(props.file?.size ?? 0) > left()}>
              {" "}
              {t("knowledge.notionImport.storageShort")}
            </Show>
          </p>
        )}
      </Show>

      <h2 class={`mt-5 ${SECTION}`}>{t("knowledge.notionImport.willNotCome")}</h2>
      <Losses
        summary={summary()}
        emptyKey="knowledge.notionImport.allComes"
        testid="knowledge-import-preview-losses"
      />

      <fieldset class="mb-5 mt-6" data-testid="knowledge-import-access" disabled={props.checking}>
        <legend class={SECTION}>{t("knowledge.notionImport.whoTitle")}</legend>
        <For each={ACCESS}>
          {(a) => (
            <label
              class={`flex cursor-pointer items-start gap-2 rounded-md px-2 py-2 hover:bg-surface-hover ${props.phone ? "min-h-11" : ""}`}
            >
              <input
                type="radio"
                name="knowledge-import-access"
                value={a}
                class="mt-[3px] shrink-0"
                checked={props.access === a}
                data-testid={`knowledge-import-access-${a}`}
                onChange={() => props.onAccess(a)}
              />
              <span class="min-w-0 flex-1 text-[13px] text-text">
                {t(`knowledge.notionImport.who${ACCESS_KEY[a]}`)}
                <span class="block text-[12px] text-text-tertiary">
                  {t(`knowledge.notionImport.who${ACCESS_KEY[a]}Help`)}
                </span>
              </span>
            </label>
          )}
        </For>
        <Show when={props.checking}>
          <p
            role="status"
            data-testid="knowledge-import-checking"
            class="mt-1 text-[12px] text-text-tertiary"
          >
            {t("knowledge.notionImport.checking")}
          </p>
        </Show>
      </fieldset>

      <Show when={tooManyRefused()}>
        <p role="alert" data-testid="knowledge-import-too-many" class="mb-3 text-[13px] text-text">
          {t("knowledge.notionImport.tooManyRefused", {
            percent: Math.round(props.preview.errorRate * 1000) / 10,
          })}
        </p>
      </Show>
      <Show when={nothingNew()}>
        <p data-testid="knowledge-import-nothing-new" class="mb-3 text-[13px] text-text-secondary">
          {t("knowledge.notionImport.nothingNew")}
        </p>
      </Show>
      <Show when={props.error}>
        <p role="alert" data-testid="knowledge-import-error" class="mb-3 text-[13px] text-text">
          {props.error}
        </p>
      </Show>
      <div
        class={`flex flex-wrap items-center gap-2 ${props.phone ? "flex-col-reverse items-stretch" : ""}`}
      >
        <Button
          variant="ghost"
          size={props.phone ? "md" : "sm"}
          class={props.phone ? "min-h-11" : ""}
          data-testid="knowledge-import-back"
          onClick={props.onBack}
        >
          {t("knowledge.notionImport.chooseAnother")}
        </Button>
        <Button
          size={props.phone ? "md" : "sm"}
          class={props.phone ? "min-h-11" : ""}
          data-testid="knowledge-import-start"
          disabled={props.checking || tooManyRefused() || nothingNew()}
          onClick={props.onStart}
        >
          {doc().created === 1
            ? t("knowledge.notionImport.importOnePage")
            : t("knowledge.notionImport.importPages", { count: doc().created })}
        </Button>
      </div>
    </div>
  )
}

/** Every item that did not come across, by group; search and copy. */
const Losses: Component<{ summary: LossSummary; emptyKey: string; testid: string }> = (props) => {
  const { t } = useI18n()
  const [query, setQuery] = createSignal("")
  const [copied, setCopied] = createSignal(false)
  const itemText = (it: LossItem): string => {
    const detail = it.params
      ? t("knowledge.notionImport.rowsPastDetail", it.params)
      : (it.detail ?? "")
    return [it.where, detail].filter(Boolean).join(": ")
  }
  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase()
    return props.summary.groups
      .map((g) => ({
        ...g,
        items: q
          ? g.items.filter((it) =>
              `${t(`knowledge.notionImport.group.${g.group}`)} ${itemText(it)}`
                .toLowerCase()
                .includes(q),
            )
          : g.items,
      }))
      .filter((g) => g.items.length > 0)
  })
  async function copy(): Promise<void> {
    const lines: string[] = []
    for (const g of props.summary.groups) {
      lines.push(t(`knowledge.notionImport.group.${g.group}`))
      for (const it of g.items) lines.push(`  ${itemText(it)}`)
    }
    if (props.summary.notListed > 0) {
      lines.push(t("knowledge.notionImport.notListed", { count: props.summary.notListed }))
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // No clipboard (an insecure origin): the list stays on screen to select by hand.
    }
  }
  return (
    <div data-testid={props.testid} data-total={props.summary.total}>
      <Show
        when={props.summary.total > 0}
        fallback={
          <p data-testid={`${props.testid}-none`} class="mb-5 text-[13px] text-text-secondary">
            {t(props.emptyKey)}
          </p>
        }
      >
        <Show when={props.summary.listed > 5}>
          <div class="mb-2 flex flex-wrap items-center gap-2">
            <label class="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border-subtle bg-surface px-2 py-1">
              <Search size={13} class="shrink-0 text-text-tertiary" />
              <input
                type="search"
                aria-label={t("knowledge.notionImport.search")}
                placeholder={t("knowledge.notionImport.search")}
                data-testid={`${props.testid}-search`}
                class="min-w-0 flex-1 bg-transparent text-[13px] text-text outline-none"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </label>
          </div>
        </Show>
        <ul class="mb-3 flex flex-col gap-2">
          <For each={filtered()}>
            {(g) => (
              <li
                class="rounded-md border border-border-subtle px-3 py-2 text-[13px] text-text"
                data-testid={`${props.testid}-group-${g.group}`}
              >
                {t(`knowledge.notionImport.group.${g.group}`)}{" "}
                <span class="text-text-tertiary">({g.items.length})</span>
                <ul class="mt-1 flex flex-col gap-0.5 text-[12px] text-text-tertiary">
                  <For each={g.items}>{(it) => <li class="break-words">{itemText(it)}</li>}</For>
                </ul>
              </li>
            )}
          </For>
        </ul>
        <Show when={filtered().length === 0}>
          <p class="mb-3 text-[12px] text-text-tertiary">{t("knowledge.notionImport.noMatch")}</p>
        </Show>
        <Show when={props.summary.notListed > 0}>
          <p
            class="mb-3 text-[12.5px] text-text-secondary"
            data-testid={`${props.testid}-not-listed`}
          >
            {t("knowledge.notionImport.notListed", { count: props.summary.notListed })}
          </p>
        </Show>
        <Button
          variant="ghost"
          size="sm"
          data-testid={`${props.testid}-copy`}
          onClick={() => void copy()}
        >
          <Show when={copied()} fallback={<Copy size={13} />}>
            <Check size={13} />
          </Show>
          {copied() ? t("knowledge.notionImport.copied") : t("knowledge.notionImport.copy")}
        </Button>
      </Show>
    </div>
  )
}

const RunStep: Component<{
  run: ImportRun
  total: number | null
  undo: UndoResult | null
  phone: boolean
  onUndone: (u: UndoResult) => void
  onAnother: () => void
}> = (props) => {
  const i18n = useI18n()
  const t = i18n.t
  const api = useApi()
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string | null>(null)
  const counts = () => props.run.counts ?? {}
  const created = (kind: string) => counts()[kind]?.created ?? 0
  const done = () => {
    let n = 0
    for (const c of Object.values(counts())) n += c.created + c.skipped + c.failed
    return n
  }
  const report = () => props.run.report ?? {}
  const summary = createMemo(() =>
    summarizeLosses(lossInputOf(report(), props.run.errors ?? [], counts())),
  )
  const final = () => FINAL.has(props.run.status) && props.run.status !== "undone"
  const btn = () => (props.phone ? "min-h-11" : "")

  async function onUndo(): Promise<void> {
    setConfirming(false)
    setBusy(true)
    setFailure(null)
    try {
      const out = await importRunStore.undo(api, props.run.id)
      props.onUndone(await keptOf(out))
    } catch {
      setFailure(t("knowledge.notionImport.undoFailed"))
    } finally {
      setBusy(false)
    }
  }

  /** Name each kept page and folder; the rest is counted. */
  async function keptOf(out: { deleted: number; refused: unknown[] }): Promise<UndoResult> {
    const kept: UndoKept[] = []
    let otherKept = 0
    await loadCollectionsTree(api).catch(() => undefined)
    for (const raw of out.refused ?? []) {
      const r = raw as { table?: string; id?: string; reason?: string }
      const reason = t(`knowledge.notionImport.keptReason.${r.reason ?? "still_referenced"}`)
      if (r.table?.endsWith("documents") && r.id) {
        const name = await getKnowledgeDocument(api, r.id)
          .then(
            (d) => (d as { title?: string }).title || t("knowledge.notionImport.keptPageHidden"),
          )
          .catch(() => t("knowledge.notionImport.keptPageHidden"))
        kept.push({ name, reason })
      } else if (r.table?.endsWith("collections") && r.id) {
        kept.push({ name: folderName(r.id) ?? t("knowledge.notionImport.keptPageHidden"), reason })
      } else otherKept++
    }
    return { deleted: out.deleted ?? 0, kept, otherKept }
  }

  return (
    <div data-testid="knowledge-import-run" data-status={props.run.status}>
      <Switch>
        <Match when={ACTIVE.has(props.run.status)}>
          <div role="status" data-testid="knowledge-import-progress">
            <p class="text-[13px] text-text">
              {props.run.status === "queued"
                ? t("knowledge.notionImport.queued")
                : props.run.status === "undoing"
                  ? t("knowledge.notionImport.undoing")
                  : props.total
                    ? t("knowledge.notionImport.running", { done: done(), total: props.total })
                    : t("knowledge.notionImport.runningNoTotal", { done: done() })}
            </p>
            <Bar
              percent={
                props.total && props.run.status === "running"
                  ? Math.min(100, Math.round((done() / props.total) * 100))
                  : undefined
              }
            />
            <p class="mt-3 text-[12px] text-text-tertiary">
              {t("knowledge.notionImport.leaveHint")}
            </p>
          </div>
        </Match>
        <Match when={props.run.status === "undone"}>
          <UndoneReport run={props.run} undo={props.undo} />
          <div class="mt-4 flex flex-wrap gap-2">
            <Button
              size="sm"
              class={btn()}
              data-testid="knowledge-import-another"
              onClick={props.onAnother}
            >
              {t("knowledge.notionImport.another")}
            </Button>
          </div>
        </Match>
        <Match when={final()}>
          <div data-testid="knowledge-import-report">
            <p class="mb-4 text-[13px] text-text" data-testid="knowledge-import-report-title">
              {props.run.status === "done"
                ? t("knowledge.notionImport.doneTitle")
                : props.run.status === "failed"
                  ? t("knowledge.notionImport.failedTitle")
                  : t("knowledge.notionImport.cancelledTitle")}{" "}
              <Show
                when={summary().total > 0}
                fallback={
                  <span data-testid="knowledge-import-everything">
                    {t("knowledge.notionImport.everythingCame")}
                  </span>
                }
              >
                <span data-testid="knowledge-import-lost-count">
                  {summary().total === 1
                    ? t("knowledge.notionImport.lostCountOne")
                    : t("knowledge.notionImport.lostCount", { count: summary().total })}
                </span>
              </Show>
            </p>
            <div class={`mb-5 grid grid-cols-2 gap-2 ${props.phone ? "" : "sm:grid-cols-4"}`}>
              <Card
                n={created("knowledge.collection")}
                label={t("knowledge.notionImport.folders")}
                testid="knowledge-import-made-folders"
              />
              <Card
                n={created("knowledge.document")}
                label={t("knowledge.notionImport.pages")}
                testid="knowledge-import-made-pages"
              />
              <Card
                n={Number(report().filesCopied) || 0}
                label={t("knowledge.notionImport.filesCopied")}
                testid="knowledge-import-made-files"
              />
              <Card
                n={Number(report().linksResolved) || 0}
                label={t("knowledge.notionImport.linksResolved")}
                testid="knowledge-import-made-links"
              />
            </div>
            <Show when={summary().total > 0}>
              <h2 class={SECTION}>{t("knowledge.notionImport.willNotCome")}</h2>
              <Losses
                summary={summary()}
                emptyKey="knowledge.notionImport.everythingCame"
                testid="knowledge-import-report-losses"
              />
            </Show>
            <div class="mt-5 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                class={btn()}
                data-testid="knowledge-import-open"
                onClick={() =>
                  openTab({
                    type: "knowledge:home",
                    entityId: "knowledge-home",
                    label: t("kernel.nav.knowledge"),
                  })
                }
              >
                {t("knowledge.notionImport.openKnowledge")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class={btn()}
                data-testid="knowledge-import-another"
                onClick={props.onAnother}
              >
                {t("knowledge.notionImport.another")}
              </Button>
            </div>
            <div
              class="mt-6 border-t border-border-subtle pt-4"
              data-testid="knowledge-import-undo-section"
            >
              <Show
                when={hasScope("kernel:imports:undo")}
                fallback={
                  <p
                    class="text-[12.5px] text-text-secondary"
                    data-testid="knowledge-import-undo-no-scope"
                  >
                    {t("knowledge.notionImport.undoNoScope")}
                  </p>
                }
              >
                <Show
                  when={confirming()}
                  fallback={
                    <Button
                      variant="outline"
                      size="sm"
                      class={btn()}
                      disabled={busy()}
                      data-testid="knowledge-import-undo"
                      onClick={() => setConfirming(true)}
                    >
                      {busy()
                        ? t("knowledge.notionImport.undoing")
                        : t("knowledge.notionImport.undo")}
                    </Button>
                  }
                >
                  <p class="mb-2 text-[13px] text-text-secondary">
                    {t("knowledge.notionImport.undoConfirm")}
                  </p>
                  <div class="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      class={btn()}
                      data-testid="knowledge-import-undo-confirm"
                      onClick={() => void onUndo()}
                    >
                      {t("knowledge.notionImport.undoConfirmAction")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class={btn()}
                      data-testid="knowledge-import-undo-cancel"
                      onClick={() => setConfirming(false)}
                    >
                      {t("knowledge.notionImport.undoCancel")}
                    </Button>
                  </div>
                </Show>
              </Show>
              <Show when={failure()}>
                <p
                  role="alert"
                  class="mt-2 text-[13px] text-text"
                  data-testid="knowledge-import-undo-error"
                >
                  {failure()}
                </p>
              </Show>
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  )
}

/** After Undo: how many went, and each page or folder kept, with why. */
const UndoneReport: Component<{ run: ImportRun; undo: UndoResult | null }> = (props) => {
  const { t } = useI18n()
  const fromRow = (): UndoResult | null => {
    const u = props.run.report?.undo as { deleted?: number; refused?: unknown[] } | undefined
    if (!u) return null
    return { deleted: u.deleted ?? 0, kept: [], otherKept: (u.refused ?? []).length }
  }
  const result = () => props.undo ?? fromRow()
  return (
    <div data-testid="knowledge-import-undone">
      <p class="mb-3 text-[13px] text-text">
        {t("knowledge.notionImport.undoneTitle", { count: result()?.deleted ?? 0 })}{" "}
        <Show when={result() && result()!.kept.length === 0 && result()!.otherKept === 0}>
          {t("knowledge.notionImport.undoneAll")}
        </Show>
      </p>
      <Show when={(result()?.kept.length ?? 0) > 0}>
        <h2 class={SECTION}>{t("knowledge.notionImport.keptTitle")}</h2>
        <ul
          class="mb-3 flex flex-col gap-1 text-[13px] text-text"
          data-testid="knowledge-import-kept"
        >
          <For each={result()?.kept ?? []}>
            {(k) => (
              <li>
                {k.name}
                <span class="text-text-tertiary">: {k.reason}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={(result()?.otherKept ?? 0) > 0}>
        <p class="text-[12.5px] text-text-secondary" data-testid="knowledge-import-kept-other">
          {t("knowledge.notionImport.keptOther", { count: result()?.otherKept ?? 0 })}
        </p>
      </Show>
    </div>
  )
}

function folderName(id: string): string | undefined {
  const find = (nodes: typeof knowledgeStore.collectionsTree): string | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n.name
      const below = find(n.children)
      if (below) return below
    }
    return undefined
  }
  return find(knowledgeStore.collectionsTree)
}

export default KnowledgeImportView
