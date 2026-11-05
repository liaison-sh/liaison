// SPDX-License-Identifier: FSL-1.1-ALv2

import { AlertTriangle, Check, ChevronDown } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  getBulkUiCustomForm,
  getBulkUiSelection,
  getManifestBulkAction,
  getManifestBulkActions,
  type ManifestBulkAction,
} from "~/framework/app-registry"
import { PluginMountBoundary } from "~/framework/PluginMountBoundary"
import { cn } from "~/lib/cn"
import { apiUrl } from "~/lib/env"
import { accessToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { PopupMenu } from "~/ui/PopupMenu"
import { AutoForm } from "./auto-form"

const MAX_ERROR_ROWS = 3

/** Flex gap between the toolbar's children (`gap-3`). */
const TOOLBAR_GAP = 12
/** Horizontal room the bar never gets: its `max-w-[calc(100vw-2rem)]` gutter
 *  plus its own `px-4` padding and 1px borders. */
const TOOLBAR_CHROME = 32 + 34

const CHIP_CLASS =
  "shrink-0 whitespace-nowrap rounded-full bg-surface px-3 py-1 text-xs font-medium text-text"

/**
 * How many of the declared actions fit inline, in declaration order, the rest
 * going to the More menu. Same idea as the chat dock's capacity: measured
 * widths against the room the viewport leaves, never a line wrap.
 */
export function fitBulkActions(
  available: number,
  countWidth: number,
  chipWidths: number[],
  moreWidth: number,
): number {
  let used = countWidth
  for (const w of chipWidths) used += TOOLBAR_GAP + w
  if (used <= available) return chipWidths.length
  used = countWidth + TOOLBAR_GAP + moreWidth
  let fit = 0
  for (const w of chipWidths) {
    if (used + TOOLBAR_GAP + w > available) break
    used += TOOLBAR_GAP + w
    fit++
  }
  return fit
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

function bulkAuthHeaders(): Record<string, string> {
  const token = accessToken()
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

interface BulkActionToolbarProps {
  app: string
  viewId: string
}

type ToolbarState = "resting" | "expanded" | "processing" | "outcome"

interface OutcomeState {
  ok: boolean
  succeeded: number
  failed: number
  errors: Array<{ id?: string; message?: string }>
}

const MAX_SELECTION = 100

export const BulkActionToolbar: Component<BulkActionToolbarProps> = (props) => {
  const i18n = useI18n()
  const isTabActive = useTabIsActive()
  const selection = createMemo(() => {
    const reg = getBulkUiSelection(props.app, props.viewId)
    return reg?.accessor() ?? []
  })
  const selectionApi = () => getBulkUiSelection(props.app, props.viewId)
  const manifestActions = createMemo(() => getManifestBulkActions(props.app) ?? {})

  const [state, setState] = createSignal<ToolbarState>("resting")
  const [activeAction, setActiveAction] = createSignal<string | null>(null)
  const [formValues, setFormValues] = createSignal<Record<string, string>>({})
  const [error, setError] = createSignal<string | null>(null)
  const [overLimitIds, setOverLimitIds] = createSignal<string[] | null>(null)
  const [outcome, setOutcome] = createSignal<OutcomeState | null>(null)
  const [moreOpen, setMoreOpen] = createSignal(false)

  // Inline capacity. Until measured (and in jsdom, where nothing has a
  // width) every action is inline.
  const [viewportWidth, setViewportWidth] = createSignal(
    typeof window !== "undefined" ? window.innerWidth : 0,
  )
  const [inlineCount, setInlineCount] = createSignal(Number.POSITIVE_INFINITY)
  let countRef: HTMLSpanElement | undefined
  let measureRef: HTMLDivElement | undefined
  let moreMeasureRef: HTMLSpanElement | undefined

  createEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener("resize", onResize)
    onCleanup(() => window.removeEventListener("resize", onResize))
  })

  createEffect(() => {
    const width = viewportWidth()
    const count = Object.keys(manifestActions()).length
    // The count label's width follows the number; the measured nodes only
    // exist in the resting state.
    void selection().length
    if (state() !== "resting") return
    if (!measureRef || !countRef || !moreMeasureRef || width <= 0) return
    const chips = Array.from(measureRef.querySelectorAll<HTMLElement>("[data-bulk-measure-chip]"))
    const chipWidths = chips.slice(0, count).map((el) => el.getBoundingClientRect().width)
    if (chipWidths.every((w) => w === 0)) {
      setInlineCount(Number.POSITIVE_INFINITY)
      return
    }
    setInlineCount(
      fitBulkActions(
        width - TOOLBAR_CHROME,
        countRef.getBoundingClientRect().width,
        chipWidths,
        moreMeasureRef.getBoundingClientRect().width,
      ),
    )
  })

  const inlineActions = createMemo(() => Object.entries(manifestActions()).slice(0, inlineCount()))
  const overflowActions = createMemo(() => Object.entries(manifestActions()).slice(inlineCount()))

  function resetForm() {
    setActiveAction(null)
    setFormValues({})
    setError(null)
    setOverLimitIds(null)
    setState("resting")
  }

  function handleEscape(e: KeyboardEvent) {
    if (!isTabActive()) return
    if (e.key !== "Escape") return
    if (state() === "expanded") {
      resetForm()
      return
    }
    if (state() === "resting" && selection().length > 0) {
      selectionApi()?.clear()
    }
  }

  createEffect(() => {
    if (selection().length === 0 && state() !== "outcome") {
      setActiveAction(null)
      setFormValues({})
      setError(null)
      setState("resting")
    }
  })

  createEffect(() => {
    document.addEventListener("keydown", handleEscape)
    onCleanup(() => document.removeEventListener("keydown", handleEscape))
  })

  function chipDisabled(_action: string, decl: ManifestBulkAction): boolean {
    const min = decl.minSelection ?? 1
    return selection().length < min
  }

  function selectAction(action: string) {
    setActiveAction(action)
    // Seed enum shared-fields with their first option so a submit without
    // touching the dropdown still sends a valid value (e.g. closedReason).
    const decl = getManifestBulkAction(props.app, action)
    const initial: Record<string, string> = {}
    for (const field of decl?.sharedFields ?? []) {
      const opts = decl?.fieldSpecs?.[field]?.enum
      if (opts && opts.length > 0) initial[field] = opts[0]!
    }
    setFormValues(initial)
    setError(null)
    setState("expanded")
  }

  async function submit() {
    const action = activeAction()
    if (!action) return
    const decl = getManifestBulkAction(props.app, action)
    if (!decl) return
    const ids = selection()
    if (ids.length > MAX_SELECTION) {
      setError("Too many selected: the limit is 100")
      setOverLimitIds(ids)
      setState("expanded")
      return
    }
    const idempotencyKey = crypto.randomUUID()
    // Drop empty shared fields so optional tool params (e.g. closedReason)
    // fall back to their server-side defaults instead of failing validation.
    const params = Object.fromEntries(Object.entries(formValues()).filter(([, v]) => v !== ""))
    const payload: Record<string, unknown> = {
      ids,
      idempotencyKey,
      params,
    }
    setState("processing")
    setError(null)
    try {
      const res = await fetch(apiUrl(`/apps/${props.app}/bulk/${action}`), {
        method: "POST",
        headers: bulkAuthHeaders(),
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError(body?.error?.message ?? `Request failed (${res.status})`)
        setState("expanded")
        return
      }
      const body = await res.json()
      const succeeded = Number(body?.data?.succeeded ?? 0)
      const failed = Number(body?.data?.failed ?? 0)
      const errors = (Array.isArray(body?.data?.errors) ? body.data.errors : []) as Array<{
        id?: string
        message?: string
      }>
      setOutcome({ ok: true, succeeded, failed, errors })
      setState("outcome")
      // Signal listeners (e.g. TicketsInbox' reload hook) that a bulk action
      // completed, so app-specific lists can refresh ahead of the next WS tick.
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("bulk:dispatch-complete", {
            detail: { app: props.app, action, succeeded, failed },
          }),
        )
      }
      window.setTimeout(() => {
        setOutcome(null)
        resetForm()
        selectionApi()?.clear()
      }, 3000)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed")
      setState("expanded")
    }
  }

  function useFirst100() {
    const ids = overLimitIds()
    if (!ids) return
    const first = ids.slice(0, MAX_SELECTION)
    const api = selectionApi()
    if (api?.replace) {
      api.replace(first)
      setError(null)
      setOverLimitIds(null)
      return
    }
    setError("This list cannot clip selection automatically. Clear selection and choose 100 items.")
  }

  return (
    <Show when={selection().length > 0 || state() === "outcome"}>
      <div
        role="toolbar"
        aria-label={i18n.t("kernel.shellUi.bulkActionsFor", { count: selection().length })}
        data-testid="bulk-toolbar"
        // Sits above the phone tab bar and the floating Chats opener, and above
        // the home indicator: the shell publishes what to clear (Shell.tsx,
        // shellOverlayInsets). Outside a shell both fall back to 0 and this is
        // the plain 1.5rem float.
        style={{
          bottom:
            "calc(env(safe-area-inset-bottom, 0px) + var(--shell-bottom-bar, 0px) + max(1.5rem, calc(var(--shell-fab-clearance, 0px) + 0.5rem)))",
        }}
        class={cn(
          // w-max + a viewport cap: a box centred with left-1/2 otherwise
          // shrink-wraps to half the viewport and its labels wrap.
          "fixed left-1/2 z-40 w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 transform",
          "flex items-center gap-3 rounded-full border border-border bg-elevated/95 px-4 py-2 shadow-popover backdrop-blur-md",
          // Never transition geometry: a viewport change moves the toolbar (its
          // bottom clearance follows the shell tier) and must land at once,
          // not glide over the tab bar while the overflow menu re-measures.
          "transition-[border-radius,background-color,border-color] duration-150",
          state() === "outcome" && outcome() && outcome()!.errors.length > 0 && "rounded-xl py-2.5",
        )}
      >
        <span
          ref={countRef}
          class="shrink-0 whitespace-nowrap text-xs text-text-secondary"
          data-testid="bulk-selection-count"
        >
          <span class="font-mono text-text">{selection().length}</span>{" "}
          {i18n.t("kernel.shellUi.selected")}
        </span>
        <Show when={state() === "resting"}>
          {/* Invisible twin of the full row: the widths the fit is computed from. */}
          <div
            ref={measureRef}
            aria-hidden="true"
            class="pointer-events-none invisible absolute top-0 left-0 flex gap-3"
          >
            <For each={Object.values(manifestActions())}>
              {(decl) => (
                <span data-bulk-measure-chip class={cn(CHIP_CLASS, "inline-block")}>
                  {decl.label}
                </span>
              )}
            </For>
            <span ref={moreMeasureRef} class={cn(CHIP_CLASS, "inline-flex items-center gap-1")}>
              {i18n.t("kernel.moreBulkActions")}
              <ChevronDown size={12} />
            </span>
          </div>
          <For each={inlineActions()}>
            {([action, decl]) => (
              <button
                type="button"
                class={cn(CHIP_CLASS, "hover:bg-surface-hover disabled:opacity-50")}
                data-testid={`bulk-action-${action}`}
                disabled={chipDisabled(action, decl)}
                onClick={() => selectAction(action)}
              >
                {decl.label}
              </button>
            )}
          </For>
          <Show when={overflowActions().length > 0}>
            <PopupMenu open={moreOpen()} onOpenChange={setMoreOpen}>
              <PopupMenu.Trigger
                class={cn(CHIP_CLASS, "inline-flex items-center gap-1 hover:bg-surface-hover")}
                aria-label={i18n.t("kernel.moreBulkActionsLabel")}
                data-testid="bulk-more-trigger"
              >
                {i18n.t("kernel.moreBulkActions")}
                <ChevronDown size={12} aria-hidden />
              </PopupMenu.Trigger>
              <PopupMenu.Content aria-label={i18n.t("kernel.moreBulkActionsLabel")}>
                <For each={overflowActions()}>
                  {([action, decl]) => (
                    <PopupMenu.Item
                      data-testid={`bulk-overflow-${action}`}
                      disabled={chipDisabled(action, decl)}
                      class="whitespace-nowrap"
                      onSelect={() => {
                        setMoreOpen(false)
                        selectAction(action)
                      }}
                    >
                      {decl.label}
                    </PopupMenu.Item>
                  )}
                </For>
              </PopupMenu.Content>
            </PopupMenu>
          </Show>
        </Show>
        <Show when={state() === "expanded" && activeAction()}>
          {(action) => {
            const decl = () => getManifestBulkAction(props.app, action()) as ManifestBulkAction
            const customForm = () =>
              decl().customForm ? getBulkUiCustomForm(props.app, action()) : undefined
            return (
              <div class="flex items-center gap-2" data-testid="bulk-form">
                <Show
                  when={customForm()}
                  fallback={
                    <AutoForm
                      fields={decl().sharedFields ?? []}
                      specs={decl().fieldSpecs}
                      values={formValues()}
                      onChange={(field, value) =>
                        setFormValues((prev) => ({ ...prev, [field]: value }))
                      }
                    />
                  }
                >
                  {(Form) => (
                    <PluginMountBoundary appName={props.app}>
                      <Dynamic
                        component={Form()}
                        ids={selection()}
                        onSubmit={(params: Record<string, unknown>) => {
                          setFormValues(params as Record<string, string>)
                          void submit()
                        }}
                        onCancel={() => resetForm()}
                      />
                    </PluginMountBoundary>
                  )}
                </Show>
                {/* A custom form owns its submit and cancel (it hands its params
                    to onSubmit); a second Apply here would post empty params. */}
                <Show when={!customForm()}>
                  <button
                    type="button"
                    class="shrink-0 whitespace-nowrap rounded bg-accent px-3 py-1 text-xs font-medium text-bg"
                    data-testid="bulk-submit"
                    onClick={() => void submit()}
                  >
                    {i18n.t("kernel.common.apply")}
                  </button>
                  <button
                    type="button"
                    class="shrink-0 whitespace-nowrap rounded border border-border px-3 py-1 text-xs text-text-secondary"
                    data-testid="bulk-cancel"
                    onClick={() => resetForm()}
                  >
                    {i18n.t("kernel.common.cancel")}
                  </button>
                </Show>
              </div>
            )
          }}
        </Show>
        <Show when={state() === "processing"}>
          <span class="text-xs text-text-secondary" data-testid="bulk-processing">
            {i18n.t("kernel.shellUi.processing")} {selection().length}…
          </span>
        </Show>
        <Show when={state() === "outcome" && outcome()}>
          {(o) => (
            <div class="flex flex-col gap-1.5" data-testid="bulk-outcome">
              <div class="flex items-center gap-1.5 text-xs">
                <span
                  class={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-[3px] font-medium",
                    o().succeeded > 0
                      ? "border border-success-border bg-success-glow text-success"
                      : "border border-border-subtle text-text-tertiary",
                  )}
                  data-testid="bulk-outcome-succeeded"
                >
                  <Check size={11} stroke-width={2.5} aria-hidden />
                  {o().succeeded} {i18n.t("kernel.shellUi.done")}
                </span>
                <span
                  class={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-[3px] font-medium",
                    o().failed > 0
                      ? "border border-error-border bg-error-glow text-error"
                      : "border border-border-subtle text-text-tertiary",
                  )}
                  data-testid="bulk-outcome-failed"
                >
                  <AlertTriangle size={11} stroke-width={2.5} aria-hidden />
                  {o().failed} {i18n.t("kernel.shellUi.failed2")}
                </span>
              </div>
              <Show when={o().errors.length > 0}>
                <ul
                  class="flex max-w-[26rem] flex-col gap-[3px] text-[11px] leading-snug"
                  data-testid="bulk-outcome-errors"
                  aria-label={i18n.t("kernel.perItemFailures")}
                >
                  <For each={o().errors.slice(0, MAX_ERROR_ROWS)}>
                    {(err) => (
                      <li
                        class={cn(
                          "flex items-baseline gap-2 rounded border border-error-border/60 bg-error-glow px-2 py-1",
                        )}
                        data-testid={err.id ? `bulk-outcome-error-${err.id}` : undefined}
                      >
                        <Show when={err.id}>
                          {(id) => (
                            <span
                              class="shrink-0 font-mono text-[10px] text-text-tertiary"
                              title={id()}
                            >
                              {shortId(id())}
                              <span class="sr-only">{id()}</span>
                            </span>
                          )}
                        </Show>
                        <span class="truncate text-text-secondary" title={err.message ?? "failed"}>
                          {err.message ?? i18n.t("kernel.shellUi.failed")}
                        </span>
                      </li>
                    )}
                  </For>
                  <Show when={o().errors.length > MAX_ERROR_ROWS}>
                    <li class="px-2 text-[10px] text-text-tertiary">
                      +{o().errors.length - MAX_ERROR_ROWS} {i18n.t("kernel.shellUi.more")}
                    </li>
                  </Show>
                </ul>
              </Show>
            </div>
          )}
        </Show>
        <Show when={state() !== "outcome" && error()}>
          {(msg) => (
            <span class="text-xs text-error" data-testid="bulk-error" role="alert">
              {msg()}
            </span>
          )}
        </Show>
        <Show when={overLimitIds()}>
          <button
            type="button"
            class="rounded border border-border px-3 py-1 text-xs text-text-secondary hover:bg-surface-hover"
            data-testid="bulk-use-first-100"
            onClick={useFirst100}
          >
            {i18n.t("kernel.shellUi.useFirst100")}
          </button>
        </Show>
      </div>
    </Show>
  )
}
