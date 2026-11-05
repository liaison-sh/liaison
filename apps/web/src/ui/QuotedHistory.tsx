// SPDX-License-Identifier: FSL-1.1-ALv2
// QuotedHistory — the folded quoted tail under an email's visible reply, one
// UI for Mail and Tickets. Collapsed it is a single chip ("··· 12 earlier
// emails · 9 already in this thread"). Expanded it lists one row per earlier
// email: an email already in the thread links up to it ("In this thread ↑")
// instead of repeating, any other shows its text. "Show original" renders the
// raw tail through the surface's own renderer. A tail with no recognisable
// email boundaries (n = 0) keeps today's behaviour: a "•••" chip that expands
// to the raw tail.
//
// Presentation layer: no module imports, so copy arrives as `labels` and the
// raw render as `renderOriginal`.

import { type Component, createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { cn } from "~/lib/cn"
import {
  createQuoteCache,
  linkQuotedEntries,
  parseQuotedEntries,
  type QuotedEntry,
} from "~/lib/email-quote"

export interface QuotedHistoryLabels {
  /** Chip title, and the chip's whole label when no entries were found. */
  show: string
  hide: string
  loading: string
  /** "{n} earlier emails · {k} already in this thread". */
  summary: (count: number, linked: number) => string
  inThread: string
  inThreadLabel: string
  showOriginal: string
  hideOriginal: string
  unknownSender: string
}

export interface QuotedHistoryProps {
  /** The quoted tail: HTML when `mode` is "html", plain text when "text". */
  quoted: string
  mode: "html" | "text"
  /** Stable per-message key (the message id): caches the parsed entries
   *  across row remounts, validated by the tail's length and hash. */
  cacheKey: string
  /** The thread's other messages as plain text, to link entries already in it. */
  threadMessages: { id: string; text: string }[]
  onJump: (messageId: string) => void
  /** Renders the raw tail ("Show original", and the n = 0 expansion). */
  renderOriginal: (quoted: string) => JSX.Element
  labels: QuotedHistoryLabels
  /** Controlled expansion, for a surface whose rows remount (a re-fetched
   *  message replaces its row); uncontrolled when omitted. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Controlled "Show original" state, for the same reason as `open`: a row
   *  that remounts would otherwise drop back to the entry list. */
  originalOpen?: boolean
  onOriginalOpenChange?: (open: boolean) => void
  /** The chip shows the loading label and is disabled. */
  loading?: boolean
  /** Runs before expanding (e.g. fetching a server-trimmed body); resolving
   *  false keeps it collapsed. Without it, expanding is synchronous. */
  onExpand?: () => boolean | Promise<boolean>
  /** Test ids read `${testIdPrefix}-${part}-${testIdKey}` (parts: toggle,
   *  body, collapse, original, original-body; rows `row-<key>-<i>`). */
  testIdPrefix: string
  testIdKey: string
  class?: string
}

const entryCache = createQuoteCache<QuotedEntry[]>()

export const QuotedHistory: Component<QuotedHistoryProps> = (props) => {
  const [localOpen, setLocalOpen] = createSignal(false)
  const open = () => props.open ?? localOpen()
  const setOpen = (next: boolean): void => {
    setLocalOpen(next)
    props.onOpenChange?.(next)
  }
  const [localOriginal, setLocalOriginal] = createSignal(false)
  const original = () => props.originalOpen ?? localOriginal()
  const setOriginal = (next: boolean): void => {
    setLocalOriginal(next)
    props.onOriginalOpenChange?.(next)
  }
  const tid = (part: string) => `${props.testIdPrefix}-${part}-${props.testIdKey}`

  const entries = createMemo(() =>
    props.quoted
      ? entryCache.get(`${props.mode}:${props.cacheKey}`, props.quoted, () =>
          parseQuotedEntries(props.quoted, props.mode),
        )
      : [],
  )
  const links = createMemo(() => linkQuotedEntries(entries(), props.threadMessages))
  const linkedCount = () => links().filter((id) => id !== null).length

  function expand(): void {
    const result = props.onExpand?.()
    if (result instanceof Promise) {
      void result.then((ok) => {
        if (ok) setOpen(true)
      })
    } else if (result !== false) {
      setOpen(true)
    }
  }

  function collapse(): void {
    setOpen(false)
    setOriginal(false)
  }

  const linkButtonClass =
    "mt-1 text-xs text-text-tertiary underline decoration-dotted hover:text-text-secondary"

  return (
    <div class={cn("min-w-0", props.class)}>
      <Show
        when={open()}
        fallback={
          <button
            type="button"
            class="mt-2 inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface px-2.5 py-0.5 text-left text-xs text-text-secondary hover:bg-surface-hover hover:text-text disabled:opacity-60"
            data-testid={tid("toggle")}
            aria-expanded="false"
            disabled={props.loading}
            onClick={expand}
            title={props.labels.show}
            aria-label={entries().length === 0 ? props.labels.show : undefined}
          >
            <Show when={!props.loading} fallback={<span>{props.labels.loading}</span>}>
              <Show when={entries().length > 0} fallback={<span aria-hidden="true">•••</span>}>
                <span aria-hidden="true" class="font-semibold tracking-widest">
                  ···
                </span>
                <span class="min-w-0 truncate">
                  {props.labels.summary(entries().length, linkedCount())}
                </span>
              </Show>
            </Show>
          </button>
        }
      >
        <Show
          when={entries().length > 0}
          fallback={
            <>
              <div data-testid={tid("body")} class="mt-1">
                {props.renderOriginal(props.quoted)}
              </div>
              <button
                type="button"
                class={linkButtonClass}
                data-testid={tid("collapse")}
                onClick={collapse}
              >
                {props.labels.hide}
              </button>
            </>
          }
        >
          <div data-testid={tid("body")} class="mt-2 grid min-w-0 gap-1.5">
            <For each={entries()}>
              {(entry, i) => (
                <div
                  class="min-w-0 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs"
                  data-testid={`${props.testIdPrefix}-row-${props.testIdKey}-${i()}`}
                >
                  <div class="flex min-w-0 items-center gap-2">
                    <span class="whitespace-nowrap font-medium text-text">
                      {entry.sender || props.labels.unknownSender}
                    </span>
                    <span class="min-w-0 flex-1 truncate text-text-tertiary">
                      {entry.firstLine}
                    </span>
                    <Show when={entry.date}>
                      <span class="whitespace-nowrap font-mono text-[10.5px] text-text-tertiary">
                        {entry.date}
                      </span>
                    </Show>
                    <Show when={links()[i()]}>
                      {(messageId) => (
                        <button
                          type="button"
                          class="whitespace-nowrap rounded bg-accent-glow px-1.5 py-px text-[11px] text-accent hover:underline"
                          data-testid={`${props.testIdPrefix}-jump-${props.testIdKey}-${i()}`}
                          aria-label={props.labels.inThreadLabel}
                          onClick={() => props.onJump(messageId())}
                        >
                          {props.labels.inThread}
                        </button>
                      )}
                    </Show>
                  </div>
                  <Show when={!links()[i()] && entry.text}>
                    <div class="mt-1.5 whitespace-pre-wrap break-words text-text-secondary">
                      {entry.text}
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
          <div class="flex flex-wrap items-center gap-x-3">
            <button
              type="button"
              class={linkButtonClass}
              data-testid={tid("original")}
              aria-expanded={original()}
              onClick={() => setOriginal(!original())}
            >
              {original() ? props.labels.hideOriginal : props.labels.showOriginal}
            </button>
            <button
              type="button"
              class={linkButtonClass}
              data-testid={tid("collapse")}
              onClick={collapse}
            >
              {props.labels.hide}
            </button>
          </div>
          <Show when={original()}>
            <div data-testid={tid("original-body")} class="mt-1">
              {props.renderOriginal(props.quoted)}
            </div>
          </Show>
        </Show>
      </Show>
    </div>
  )
}
