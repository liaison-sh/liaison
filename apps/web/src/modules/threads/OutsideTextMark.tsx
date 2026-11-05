// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The outside-text globe: shown beside a conversation's name while the conversation is marked
// (its agent read text written outside the organisation, so its writes and sends wait for a
// person: `threads.tainted`). Neutral, like the header's other chips (calm UI). Pressing it opens a
// small menu saying what that means and what marked it (GET /threads/:id/outside-text), with
// "Clear the mark", which acts at once: the person clicking is the one who would approve the clear
// (POST /threads/:id/outside-text/clear). The globe pulses when an action of the agent parks
// because of the mark (outside-text-pulse.ts).
import { Globe } from "lucide-solid"
import { type Component, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { hasScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import { addToast } from "~/modules/shell/toast-store"
import { outsideTextPulseCount } from "~/modules/threads/outside-text-pulse"
import { setThreadTainted } from "~/modules/threads/thread-store"
import { PopupMenu } from "~/ui/PopupMenu"

/** One source of the mark, as GET /threads/:id/outside-text lists it. */
export interface OutsideTextSourceView {
  rowId: string | null
  at: string | null
  /** The tool that read it, or "summary" for an earlier summary of outside text. */
  source: string
  ref: Record<string, string>
  excerpt: string | null
}

interface OutsideTextMarkPayload {
  marked: boolean
  clearedAt: string | null
  sources: OutsideTextSourceView[]
  omitted: number
}

/** Where the approval settings live (AI > Agent behavior > Outside content). */
export const OUTSIDE_TEXT_SETTINGS_PATH = "/settings/ai/agent-behavior"
/** Who may open them: the settings page's own gate. */
const SETTINGS_SCOPE = "kernel:org:admin"
/** How long one pulse lasts: three 0.5 s beats (index.css `outside-text-pulse`). */
export const OUTSIDE_TEXT_PULSE_MS = 1500

interface OutsideTextMarkProps {
  threadId: string
  /** The conversation is marked now; nothing renders otherwise. */
  marked: boolean
  /** "label": the globe with "Outside text" (the Chats header). "icon": the globe alone, the
   *  label as its hint (the dock window's narrow header). */
  variant: "label" | "icon"
}

const OutsideTextMark: Component<OutsideTextMarkProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [open, setOpen] = createSignal(false)
  const [details, setDetails] = createSignal<OutsideTextMarkPayload | null>(null)
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [clearing, setClearing] = createSignal(false)
  const [pulsing, setPulsing] = createSignal(false)

  let pulseTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(pulseTimer))
  createEffect(
    on(
      () => outsideTextPulseCount(props.threadId),
      (count, previous) => {
        if (previous === undefined || count === previous) return
        clearTimeout(pulseTimer)
        // Off then on, so a second park restarts the animation instead of being swallowed.
        setPulsing(false)
        queueMicrotask(() => setPulsing(true))
        pulseTimer = setTimeout(() => setPulsing(false), OUTSIDE_TEXT_PULSE_MS)
      },
    ),
  )

  async function load(): Promise<void> {
    setLoadFailed(false)
    try {
      setDetails(await api.get<OutsideTextMarkPayload>(`/threads/${props.threadId}/outside-text`))
    } catch {
      setLoadFailed(true)
    }
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next)
    if (next) {
      setDetails(null)
      void load()
    }
  }

  async function handleClear(): Promise<void> {
    if (clearing()) return
    setClearing(true)
    try {
      await api.post(`/threads/${props.threadId}/outside-text/clear`)
      setThreadTainted(props.threadId, false)
      addToast({ message: i18n.t("kernel.outsideText.cleared"), type: "success" })
    } catch {
      addToast({ message: i18n.t("kernel.outsideText.clearFailed"), type: "error" })
    } finally {
      setClearing(false)
    }
  }

  function openSettings(): void {
    openTab({
      type: "kernel:settings",
      entityId: "settings",
      label: i18n.t("kernel.common.settings"),
      routePath: OUTSIDE_TEXT_SETTINGS_PATH,
    })
  }

  const label = () => i18n.t("kernel.outsideText.label")

  function sourceName(src: OutsideTextSourceView): string {
    return src.source === "summary" ? i18n.t("kernel.outsideText.summarySource") : src.source
  }

  function sourceRef(src: OutsideTextSourceView): string | null {
    const ref = src.ref.url ?? src.ref.query ?? src.ref.path ?? Object.values(src.ref)[0]
    return ref ?? src.excerpt
  }

  function sourceTime(src: OutsideTextSourceView): string | null {
    if (!src.at) return null
    const at = new Date(src.at)
    if (Number.isNaN(at.getTime())) return null
    return at.toLocaleString(i18n.locale(), { dateStyle: "short", timeStyle: "short" })
  }

  return (
    <Show when={props.marked}>
      <PopupMenu open={open()} onOpenChange={handleOpenChange}>
        <PopupMenu.Trigger
          data-testid="outside-text-mark"
          aria-label={label()}
          title={props.variant === "icon" ? label() : undefined}
          class={cn(
            "flex shrink-0 items-center gap-1 rounded-md border border-border-subtle text-text-secondary transition-colors hover:bg-surface-hover hover:text-text",
            props.variant === "label" ? "h-5 px-1.5 text-[11.5px]" : "h-7 w-7 justify-center",
            pulsing() && "outside-text-pulse",
          )}
        >
          <Globe size={props.variant === "label" ? 12 : 14} aria-hidden="true" />
          <Show when={props.variant === "label"}>
            <span>{label()}</span>
          </Show>
        </PopupMenu.Trigger>
        <PopupMenu.Content
          class="w-80 max-w-[calc(100vw-2rem)]"
          aria-label={i18n.t("kernel.outsideText.menuTitle")}
          data-testid="outside-text-menu"
        >
          <div class="px-3 pt-1.5 pb-2">
            <div class="text-[13px] font-semibold text-text">
              {i18n.t("kernel.outsideText.menuTitle")}
            </div>
            <p class="mt-1 text-[12px] leading-[1.45] text-text-secondary">
              {i18n.t("kernel.outsideText.explainer")}
            </p>
          </div>
          <div class="px-3 pb-2" data-testid="outside-text-sources">
            <div class="mb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
              {i18n.t("kernel.outsideText.sourcesHeading")}
            </div>
            <Show
              when={details()}
              fallback={
                <div class="text-[12px] text-text-tertiary">
                  {loadFailed()
                    ? i18n.t("kernel.outsideText.sourcesFailed")
                    : i18n.t("kernel.outsideText.sourcesLoading")}
                </div>
              }
            >
              {(d) => (
                <Show
                  when={d().sources.length > 0}
                  fallback={
                    <div class="text-[12px] text-text-tertiary">
                      {i18n.t("kernel.outsideText.sourcesEmpty")}
                    </div>
                  }
                >
                  <ul class="flex max-h-40 flex-col gap-1.5 overflow-y-auto">
                    <For each={d().sources}>
                      {(src) => (
                        <li class="min-w-0 text-[12px]" data-testid="outside-text-source">
                          <div class="flex min-w-0 items-baseline justify-between gap-2">
                            <span class="truncate font-medium text-text-secondary">
                              {sourceName(src)}
                            </span>
                            <Show when={sourceTime(src)}>
                              {(time) => (
                                <span class="shrink-0 text-[11px] text-text-tertiary">
                                  {time()}
                                </span>
                              )}
                            </Show>
                          </div>
                          <Show when={sourceRef(src)}>
                            {(ref) => (
                              <div class="truncate text-text-tertiary" title={ref()}>
                                {ref()}
                              </div>
                            )}
                          </Show>
                        </li>
                      )}
                    </For>
                    <Show when={d().omitted > 0}>
                      <li class="text-[11.5px] text-text-tertiary">
                        {i18n.t("kernel.outsideText.sourcesMore", { count: d().omitted })}
                      </li>
                    </Show>
                  </ul>
                </Show>
              )}
            </Show>
          </div>
          <PopupMenu.Separator />
          <PopupMenu.Item
            data-testid="outside-text-clear"
            disabled={clearing()}
            textValue={i18n.t("kernel.outsideText.clear")}
            onSelect={() => void handleClear()}
          >
            <div class="flex min-w-0 flex-col">
              <span class="text-text">{i18n.t("kernel.outsideText.clear")}</span>
              <span class="text-[11.5px] leading-[1.4] text-text-tertiary">
                {i18n.t("kernel.outsideText.clearHelp")}
              </span>
            </div>
          </PopupMenu.Item>
          <Show when={hasScope(SETTINGS_SCOPE)}>
            <PopupMenu.Item
              data-testid="outside-text-settings"
              textValue={i18n.t("kernel.outsideText.settings")}
              onSelect={openSettings}
            >
              <div class="flex min-w-0 flex-col">
                <span class="text-text">{i18n.t("kernel.outsideText.settings")}</span>
                <span class="text-[11.5px] leading-[1.4] text-text-tertiary">
                  {i18n.t("kernel.outsideText.settingsHelp")}
                </span>
              </div>
            </PopupMenu.Item>
          </Show>
        </PopupMenu.Content>
      </PopupMenu>
    </Show>
  )
}

export default OutsideTextMark
