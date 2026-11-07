// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE APP BUILDER TAB (`/apps/builder/:draftId`). A toolbar at the top (title,
// app name, Check, Preview, Publish, Discard), then the panes: the kept versions
// with their build status (each with Restore), the files of the shown version
// as read-only code, the last check's errors with file and line, the preview
// form (an entry and its params as JSON, inline) with the last result and its
// logs, and the version's interface in the sandboxed frame.
//
// The interface never runs in this page: it is handed to the same sandboxed
// frame every outside app gets (isolated-app.tsx, opaque origin, no session),
// served by the draft's own frame route, and its tool calls go to the
// read-only preview.
//
// Publishing needs kernel:apps:admin (and kernel:apps:build). An admin publishes
// here after a confirm; anyone else is told the agent can ask for approval.
import {
  type Component,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { isolatedFrameUrl, isolatedView } from "~/framework/isolated-app"
import { ApiError } from "~/lib/api-error"
import { hasScope, inWrappedShell } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Skeleton } from "~/ui/Skeleton"
import {
  type BuildError,
  type BuilderApi,
  type CheckResult,
  checkDraft,
  type DraftBuild,
  type DraftDetail,
  discardDraft,
  draftUiSource,
  getDraft,
  listVersions,
  orderedFileNames,
  type PreviewResult,
  parseParams,
  previewDraft,
  previewEntries,
  publishDraft,
  restoreVersion,
  uiComponents,
} from "./builder-client"
import { rememberDraftTitle } from "./builder-store"

const K = "kernel.appBuilder"

/** Whether this person may publish from the tab (the REST route's own gate). */
export function canPublishHere(): boolean {
  return hasScope("kernel:apps:admin") && hasScope("kernel:apps:build")
}

export type BuildState = "none" | "ok" | "failed"

export function buildState(build: DraftBuild | null | undefined): BuildState {
  if (!build) return "none"
  return build.ok && build.typecheck?.ok !== false ? "ok" : "failed"
}

function errorText(err: unknown): string {
  return err instanceof ApiError || err instanceof Error ? err.message : String(err)
}

const ErrorList: Component<{ errors: BuildError[]; testId: string }> = (props) => (
  <ul data-testid={props.testId} class="space-y-1">
    <For each={props.errors}>
      {(e) => (
        <li data-testid="builder-error" class="text-[12.5px] text-text-secondary">
          <Show when={e.file}>
            <span data-testid="builder-error-at" class="mr-1.5 font-mono text-text-tertiary">
              {e.file}
              {e.line ? `:${e.line}` : ""}
            </span>
          </Show>
          {e.message}
        </li>
      )}
    </For>
  </ul>
)

const Pane: Component<{ title: string; testId: string; children: JSX.Element }> = (props) => (
  <section
    data-testid={props.testId}
    class="min-w-0 rounded-lg border border-border-subtle bg-surface p-3"
  >
    <h2 class="mb-2 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
      {props.title}
    </h2>
    {props.children}
  </section>
)

export const BuilderView: Component<{ entityId: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi() as unknown as BuilderApi
  const [shownN, setShownN] = createSignal<number | undefined>(undefined)
  const [reload, setReload] = createSignal(0)
  const [busy, setBusy] = createSignal<string | null>(null)
  const [check, setCheck] = createSignal<CheckResult | null>(null)
  const [preview, setPreview] = createSignal<PreviewResult | null>(null)
  const [previewOpen, setPreviewOpen] = createSignal(false)
  const [entryKey, setEntryKey] = createSignal("")
  const [paramsText, setParamsText] = createSignal("{}")
  const [paramsInvalid, setParamsInvalid] = createSignal(false)
  const [confirm, setConfirm] = createSignal<"publish" | "discard" | null>(null)
  const [publishNote, setPublishNote] = createSignal<string | null>(null)
  const [actionError, setActionError] = createSignal<string | null>(null)
  const [file, setFile] = createSignal<string | null>(null)

  const [detail] = createResource(
    () => ({ id: props.entityId, n: shownN(), tick: reload() }),
    async ({ id, n }) => {
      try {
        const d = await getDraft(api, id, n)
        rememberDraftTitle(id, d.draft.title)
        return { ok: true as const, detail: d }
      } catch (err) {
        const missing = err instanceof ApiError && (err.status === 404 || err.status === 403)
        return { ok: false as const, missing }
      }
    },
  )
  const [versions] = createResource(
    () => ({ id: props.entityId, tick: reload() }),
    ({ id }) => listVersions(api, id).catch(() => []),
  )
  const loaded = (): DraftDetail | null => {
    const r = detail()
    return r?.ok ? r.detail : null
  }
  const discarded = () => loaded()?.draft.status === "discarded"
  const files = () => loaded()?.version.files ?? {}
  const fileNames = createMemo(() => orderedFileNames(files()))
  const shownFile = () => {
    const f = file()
    return f && f in files() ? f : (fileNames()[0] ?? null)
  }
  const entries = createMemo(() => previewEntries(files()))
  const selectedEntry = () => {
    const key = entryKey()
    return entries().find((e) => `${e.kind}:${e.name}` === key) ?? entries()[0] ?? null
  }
  // The errors shown: this session's check of the shown version, else the stored build's.
  const shownErrors = (): { checked: boolean; ok: boolean; errors: BuildError[] } | null => {
    const v = loaded()?.version
    if (!v) return null
    const c = check()
    if (c && c.n === v.n) {
      return { checked: true, ok: c.ok, errors: [...c.errors, ...(c.typecheck?.errors ?? [])] }
    }
    if (!v.build) return null
    return {
      checked: true,
      ok: buildState(v.build) === "ok",
      errors: [...(v.build.errors ?? []), ...(v.build.typecheck?.errors ?? [])],
    }
  }

  const act = async (name: string, run: () => Promise<void>) => {
    if (busy()) return
    setBusy(name)
    setActionError(null)
    try {
      await run()
    } catch (err) {
      setActionError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const runCheck = () =>
    act("check", async () => {
      const v = loaded()?.version
      setCheck(await checkDraft(api, props.entityId, v?.n))
      setReload((t) => t + 1)
    })

  const runPreview = () => {
    const parsed = parseParams(paramsText())
    setParamsInvalid(!parsed.ok)
    const entry = selectedEntry()
    if (!parsed.ok || !entry) return
    void act("preview", async () => {
      setPreview(
        await previewDraft(api, props.entityId, {
          n: loaded()?.version.n,
          entry,
          params: parsed.params,
        }),
      )
    })
  }

  const publishClicked = () => {
    setPublishNote(null)
    if (!canPublishHere()) {
      setPublishNote(i18n.t(`${K}.publishNeedsAdmin`))
      return
    }
    setConfirm("publish")
  }

  const runPublish = () =>
    act("publish", async () => {
      const r = await publishDraft(api, props.entityId, loaded()?.version.n)
      setConfirm(null)
      setPublishNote(i18n.t(`${K}.published`, { app: r.appName, version: r.appVersion }))
      setReload((t) => t + 1)
    })

  const runDiscard = () =>
    act("discard", async () => {
      await discardDraft(api, props.entityId)
      setConfirm(null)
      addToast({ type: "info", message: i18n.t(`${K}.discarded`) })
      setReload((t) => t + 1)
    })

  const runRestore = (n: number) =>
    act(`restore-${n}`, async () => {
      await restoreVersion(api, props.entityId, n)
      setShownN(undefined)
      setReload((t) => t + 1)
    })

  // The interface, framed: rebuilt for each version that has one.
  const Frame = createMemo(() => {
    const d = loaded()
    if (!d?.preview) return null
    const components = uiComponents(d.version.files)
    const exportName = components[0]
    if (!exportName) return null
    const n = d.version.n
    const draftId = d.draft.id
    const frameUrl = inWrappedShell()
      ? isolatedFrameUrl()
      : new URL(d.preview.frameUrl, window.location.href).href
    if (!frameUrl) return null
    return isolatedView({
      app: d.appName,
      exportName,
      bundleUrl: new URL(d.preview.uiUrl, window.location.href).href,
      frameUrl,
      loadSource: () => draftUiSource(api, draftId, n),
      host: () => ({
        // A draft has no routes of its own, and its tools run as previews only.
        fetch: () => Promise.reject(new Error("a draft has no routes")),
        invokeTool: async (_app, tool, args) => {
          const r = await previewDraft(api, draftId, {
            n,
            entry: { kind: "tool", name: tool },
            params: args,
          })
          setPreview(r)
          if (!r.ok) throw new Error(r.error?.message ?? "preview failed")
          return r.result
        },
        openConnect: () => Promise.reject(new Error("a draft has no connections")),
      }),
    })
  })

  return (
    <section data-testid="builder-view" class="flex h-full min-h-0 min-w-0 flex-col">
      <header
        data-testid="builder-toolbar"
        class="flex flex-wrap items-center gap-2 border-b border-border-subtle px-4 py-2.5"
      >
        <div class="min-w-0 flex-1">
          <h1 data-testid="builder-title" class="truncate text-[14px] font-semibold text-text">
            {loaded()?.draft.title ?? ""}
          </h1>
          <Show when={loaded()}>
            {(d) => (
              <p
                data-testid="builder-app-name"
                class="truncate font-mono text-[11px] text-text-tertiary"
              >
                {d().appName} · v{d().version.n}
                <Show when={d().draft.status !== "draft"}>
                  {" · "}
                  <span data-testid="builder-status" data-status={d().draft.status}>
                    {i18n.t(`${K}.status.${d().draft.status}`)}
                  </span>
                </Show>
              </p>
            )}
          </Show>
        </div>
        <Show when={loaded() && !discarded()}>
          <Button
            variant="outline"
            size="sm"
            data-testid="builder-check"
            disabled={busy() !== null}
            onClick={() => void runCheck()}
          >
            {busy() === "check" ? i18n.t(`${K}.checking`) : i18n.t(`${K}.check`)}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="builder-preview"
            aria-pressed={previewOpen()}
            onClick={() => setPreviewOpen((o) => !o)}
          >
            {i18n.t(`${K}.preview`)}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="builder-publish"
            disabled={busy() !== null}
            onClick={publishClicked}
          >
            {i18n.t(`${K}.publish`)}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="builder-discard"
            disabled={busy() !== null}
            onClick={() => setConfirm("discard")}
          >
            {i18n.t(`${K}.discard`)}
          </Button>
        </Show>
      </header>

      <Show when={confirm()}>
        {(which) => (
          <div
            data-testid={`builder-confirm-${which()}`}
            class="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface px-4 py-2 text-[12.5px] text-text-secondary"
          >
            <span class="min-w-0 flex-1">
              {which() === "publish"
                ? i18n.t(`${K}.confirmPublish`, {
                    app: loaded()?.appName ?? "",
                    n: loaded()?.version.n ?? 0,
                  })
                : i18n.t(`${K}.confirmDiscard`)}
            </span>
            <Button
              size="sm"
              variant={which() === "publish" ? "default" : "danger"}
              data-testid={`builder-confirm-${which()}-yes`}
              disabled={busy() !== null}
              onClick={() => void (which() === "publish" ? runPublish() : runDiscard())}
            >
              {which() === "publish" ? i18n.t(`${K}.publish`) : i18n.t(`${K}.discard`)}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="builder-confirm-cancel"
              onClick={() => setConfirm(null)}
            >
              {i18n.t(`${K}.cancel`)}
            </Button>
          </div>
        )}
      </Show>
      <Show when={publishNote()}>
        <p
          data-testid="builder-publish-note"
          class="border-b border-border-subtle px-4 py-2 text-[12.5px] text-text-secondary"
        >
          {publishNote()}
        </p>
      </Show>
      <Show when={actionError()}>
        <p
          data-testid="builder-action-error"
          class="border-b border-border-subtle px-4 py-2 text-[12.5px] text-text-secondary"
        >
          {actionError()}
        </p>
      </Show>

      <div class="@container min-h-0 flex-1 overflow-y-auto p-4">
        <Switch>
          <Match when={detail.loading && !detail()}>
            <div data-testid="builder-loading" class="space-y-3">
              <Skeleton class="h-24 w-full" />
              <Skeleton class="h-24 w-full" />
            </div>
          </Match>
          <Match when={detail() && !detail()?.ok}>
            <p
              data-testid="builder-not-found"
              class="py-8 text-center text-[13px] text-text-tertiary"
            >
              {(detail() as { missing?: boolean })?.missing
                ? i18n.t(`${K}.notFound`)
                : i18n.t(`${K}.loadFailed`)}
            </p>
          </Match>
          <Match when={loaded()}>
            {(d) => (
              <div class="grid grid-cols-1 gap-3 @3xl:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
                <div class="space-y-3">
                  <Pane title={i18n.t(`${K}.versions`)} testId="builder-versions">
                    <ul class="space-y-1">
                      <For each={versions() ?? []}>
                        {(v) => (
                          <li
                            data-testid={`builder-version-${v.n}`}
                            data-build={buildState(v.build)}
                            class="flex items-center gap-2 text-[12.5px]"
                          >
                            <button
                              type="button"
                              data-testid={`builder-version-open-${v.n}`}
                              class="min-w-0 flex-1 truncate text-left"
                              classList={{
                                "font-semibold text-text": v.n === d().version.n,
                                "text-text-secondary hover:text-text": v.n !== d().version.n,
                              }}
                              onClick={() => setShownN(v.n)}
                            >
                              v{v.n}
                              <Show when={v.message}>
                                <span class="ml-1.5 text-text-tertiary">{v.message}</span>
                              </Show>
                            </button>
                            <span
                              data-testid={`builder-version-build-${v.n}`}
                              class="shrink-0 text-[11px] text-text-tertiary"
                            >
                              {i18n.t(`${K}.build.${buildState(v.build)}`)}
                            </span>
                            <Show when={v.n !== d().draft.latestVersion && !discarded()}>
                              <Button
                                variant="ghost"
                                size="sm"
                                data-testid={`builder-restore-${v.n}`}
                                disabled={busy() !== null}
                                onClick={() => void runRestore(v.n)}
                              >
                                {i18n.t(`${K}.restore`)}
                              </Button>
                            </Show>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Pane>
                  <Pane title={i18n.t(`${K}.files`)} testId="builder-files">
                    <ul class="space-y-0.5">
                      <For each={fileNames()}>
                        {(name) => (
                          <li>
                            <button
                              type="button"
                              data-testid={`builder-file-${name}`}
                              aria-pressed={shownFile() === name}
                              class="w-full truncate text-left font-mono text-[12px]"
                              classList={{
                                "text-text": shownFile() === name,
                                "text-text-secondary hover:text-text": shownFile() !== name,
                              }}
                              onClick={() => setFile(name)}
                            >
                              {name}
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Pane>
                </div>

                <div class="min-w-0 space-y-3">
                  <Pane title={i18n.t(`${K}.checkTitle`)} testId="builder-check-pane">
                    <Show
                      when={shownErrors()}
                      fallback={
                        <p data-testid="builder-no-build" class="text-[12.5px] text-text-tertiary">
                          {i18n.t(`${K}.noBuild`)}
                        </p>
                      }
                    >
                      {(s) => (
                        <Show
                          when={!s().ok}
                          fallback={
                            <p
                              data-testid="builder-build-ok"
                              class="text-[12.5px] text-text-secondary"
                            >
                              {i18n.t(`${K}.buildOk`)}
                            </p>
                          }
                        >
                          <ErrorList errors={s().errors} testId="builder-build-errors" />
                        </Show>
                      )}
                    </Show>
                  </Pane>

                  <Show when={previewOpen()}>
                    <Pane title={i18n.t(`${K}.previewTitle`)} testId="builder-preview-form">
                      <Show
                        when={entries().length > 0}
                        fallback={
                          <p
                            class="text-[12.5px] text-text-tertiary"
                            data-testid="builder-no-entries"
                          >
                            {i18n.t(`${K}.noEntries`)}
                          </p>
                        }
                      >
                        <label
                          class="mb-1 block text-[12px] text-text-secondary"
                          for="builder-entry"
                        >
                          {i18n.t(`${K}.entry`)}
                        </label>
                        <select
                          id="builder-entry"
                          data-testid="builder-preview-entry"
                          class="mb-2 h-8 w-full rounded-md border border-border bg-bg px-2 text-[13px]"
                          value={
                            selectedEntry()
                              ? `${selectedEntry()?.kind}:${selectedEntry()?.name}`
                              : ""
                          }
                          onChange={(e) => setEntryKey(e.currentTarget.value)}
                        >
                          <For each={entries()}>
                            {(e) => (
                              <option value={`${e.kind}:${e.name}`}>
                                {i18n.t(`${K}.kind.${e.kind}`)} · {e.name}
                              </option>
                            )}
                          </For>
                        </select>
                        <label
                          class="mb-1 block text-[12px] text-text-secondary"
                          for="builder-params"
                        >
                          {i18n.t(`${K}.params`)}
                        </label>
                        <textarea
                          id="builder-params"
                          data-testid="builder-preview-params"
                          class="mb-2 h-24 w-full rounded-md border border-border bg-bg p-2 font-mono text-[12px]"
                          spellcheck={false}
                          value={paramsText()}
                          onInput={(e) => setParamsText(e.currentTarget.value)}
                        />
                        <Show when={paramsInvalid()}>
                          <p
                            data-testid="builder-params-invalid"
                            class="mb-2 text-[12px] text-text-secondary"
                          >
                            {i18n.t(`${K}.paramsInvalid`)}
                          </p>
                        </Show>
                        <Button
                          size="sm"
                          variant="outline"
                          data-testid="builder-preview-run"
                          disabled={busy() !== null}
                          onClick={runPreview}
                        >
                          {busy() === "preview" ? i18n.t(`${K}.running`) : i18n.t(`${K}.run`)}
                        </Button>
                      </Show>
                    </Pane>
                  </Show>

                  <Show when={preview()}>
                    {(p) => (
                      <Pane title={i18n.t(`${K}.resultTitle`)} testId="builder-preview-result">
                        <p
                          data-testid="builder-preview-outcome"
                          data-ok={p().ok ? "true" : "false"}
                          class="mb-2 text-[12px] text-text-tertiary"
                        >
                          {p().entry.name} ·{" "}
                          {p().ok ? i18n.t(`${K}.resultOk`) : i18n.t(`${K}.resultFailed`)} ·{" "}
                          {p().durationMs} ms
                          <Show when={p().neverPublished}> · {i18n.t(`${K}.neverPublished`)}</Show>
                        </p>
                        <Show
                          when={p().ok}
                          fallback={
                            <p
                              data-testid="builder-preview-error"
                              class="mb-2 text-[12.5px] text-text-secondary"
                            >
                              {p().error?.message ?? ""}
                            </p>
                          }
                        >
                          <pre
                            data-testid="builder-preview-value"
                            class="mb-2 max-h-64 overflow-auto rounded-md bg-bg p-2 font-mono text-[12px] text-text"
                          >
                            {JSON.stringify(p().result ?? null, null, 2)}
                          </pre>
                        </Show>
                        <h3 class="mb-1 text-[12px] font-medium text-text-secondary">
                          {i18n.t(`${K}.logs`)}
                        </h3>
                        <Show
                          when={p().logs.length > 0}
                          fallback={
                            <p
                              data-testid="builder-preview-no-logs"
                              class="text-[12px] text-text-tertiary"
                            >
                              {i18n.t(`${K}.noLogs`)}
                            </p>
                          }
                        >
                          <ul data-testid="builder-preview-logs" class="space-y-0.5">
                            <For each={p().logs}>
                              {(line) => (
                                <li
                                  data-testid="builder-preview-log"
                                  data-level={line.level}
                                  class="font-mono text-[11.5px] text-text-secondary"
                                >
                                  <span class="mr-1.5 text-text-tertiary">{line.level}</span>
                                  {line.message}
                                </li>
                              )}
                            </For>
                          </ul>
                        </Show>
                      </Pane>
                    )}
                  </Show>

                  <Pane title={i18n.t(`${K}.code`)} testId="builder-code">
                    <Show when={shownFile()}>
                      {(name) => (
                        <pre
                          data-testid="builder-code-view"
                          data-file={name()}
                          class="max-h-[32rem] overflow-auto rounded-md bg-bg p-2 font-mono text-[12px] leading-relaxed text-text"
                        >
                          {files()[name()]}
                        </pre>
                      )}
                    </Show>
                  </Pane>

                  <Show when={Frame()}>
                    {(View) => (
                      <Pane title={i18n.t(`${K}.interface`)} testId="builder-ui-preview">
                        <div class="h-80">
                          <Dynamic component={View()} />
                        </div>
                      </Pane>
                    )}
                  </Show>
                </div>
              </div>
            )}
          </Match>
        </Switch>
      </div>
    </section>
  )
}

export default BuilderView
