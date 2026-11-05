// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ONE ANATOMY FOR EVERY ROW OF THE APPROVALS LIST that is not an agent's gated
// action: an access request (Grant / Deny, AccessRequestRow) and a routine run
// waiting for a private mailbox (Run now / Dismiss, RoutineMailboxWaitRow).
// They copy AttentionRow's approval row slot for slot, so the list reads as one:
//
//   desktop  40px kind rail | pill + title, summary lines (left rule), "by X ·
//            age" meta | deadline, primary, secondary, Details
//   phone    one title line (glyph, pill, title, details chevron), one meta line
//            with the deadline kept whole on the right, an optional wrapped
//            explanation, then the two decisions as equal 36px buttons
//
// Details expands the row's facts in place (DecisionDetailsCard), as an
// approval row expands its ApprovalCard; while it is open the card carries the
// decisions and the row's own pair stands down, so two live pairs never show.
// Only the label and the verbs change between kinds. Colour names the app,
// never urgency (calm UI): the deadline stays tertiary grey.

import type { Component, JSX } from "solid-js"
import { For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AppPill } from "~/modules/shell/AppPill"
import { shellTier } from "~/modules/shell/shell-tier"

type IconComponent = Component<{ size?: number; class?: string }>

export interface DecisionRowAction {
  label: string
  testid: string
  onClick: () => void
  icon?: IconComponent
  disabled?: boolean
}

export interface DecisionRowProps {
  testId: string
  kind: string
  ariaLabel?: string
  icon: IconComponent
  /** The kind pill: its app's colour (null reads neutral) and its words. */
  pill: { appId: string | null; label: string; testid?: string }
  title: string
  /** The summary lines under the title (desktop), each on its own line. */
  lines: string[]
  /** The phone's one explanation line, wrapped, never truncated. */
  compactLine?: string | null
  /** "by X", "age": the quiet meta line. */
  meta: string[]
  /** The phone's meta line, when it says more than `meta` (defaults to it). */
  compactMeta?: string[]
  metric?: string | null
  /** Shown instead of the two decisions (e.g. "Waiting for unlock"). */
  status?: string | null
  primary: DecisionRowAction
  secondary: DecisionRowAction
  expanded: boolean
  onToggle: () => void
  /** The facts card Details opens. */
  details: JSX.Element
  /** Full-width content under the row (the inline unlock panel). */
  footer?: JSX.Element
  attrs?: Record<string, string | undefined>
}

const ActionButton: Component<{ action: DecisionRowAction; primary: boolean; compact: boolean }> = (
  props,
) => {
  const Icon = () => {
    const I = props.action.icon
    return I ? <I size={12} /> : null
  }
  return (
    <button
      type="button"
      data-testid={props.action.testid}
      disabled={props.action.disabled}
      onClick={(e) => {
        e.stopPropagation()
        props.action.onClick()
      }}
      class={
        props.primary
          ? `flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 font-medium text-bg shadow-sm transition-colors hover:bg-accent-hover disabled:opacity-50 ${
              props.compact ? "h-9 flex-1 text-[13px]" : "py-1.5 text-[12.5px]"
            }`
          : `flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50 ${
              props.compact ? "h-9 flex-1 text-[13px]" : "py-1.5 text-[12.5px]"
            }`
      }
    >
      <Icon />
      {props.action.label}
    </button>
  )
}

export const DecisionRow: Component<DecisionRowProps> = (props) => {
  const i18n = useI18n()
  const compact = (): boolean => shellTier() === "phone"
  const Icon = () => {
    const I = props.icon
    return (
      <I
        size={14}
        class="text-text-tertiary transition-colors duration-150 group-hover/row:text-text-secondary"
      />
    )
  }
  const Pill = (p: { class: string }) => (
    <AppPill
      appId={props.pill.appId}
      testid={props.pill.testid ?? `${props.testId}-pill`}
      class={p.class}
    >
      {props.pill.label}
    </AppPill>
  )
  const Decisions = (p: { compact: boolean }) => (
    <Show
      when={!props.status}
      fallback={
        <span
          data-testid={`${props.testId}-status`}
          class="whitespace-nowrap rounded bg-surface-sunken px-2 py-0.5 text-[11px] text-text-secondary"
        >
          {props.status}
        </span>
      }
    >
      <ActionButton action={props.primary} primary compact={p.compact} />
      <ActionButton action={props.secondary} primary={false} compact={p.compact} />
    </Show>
  )
  const detailsLabel = () => i18n.t("kernel.homeRowDetails")

  return (
    <li
      class="group/row relative transition-colors hover:bg-surface-hover/50"
      classList={{
        "flex flex-col gap-1 px-3 py-2.5": compact(),
        "flex flex-wrap items-start gap-x-3 gap-y-2 py-3 pl-0 pr-4": !compact(),
      }}
      data-testid={props.testId}
      data-kind={props.kind}
      data-compact={compact() ? "true" : undefined}
      data-expanded={props.expanded ? "true" : "false"}
      aria-label={props.ariaLabel}
      {...props.attrs}
    >
      <Show
        when={compact()}
        fallback={
          <>
            <span
              aria-hidden="true"
              class="pointer-events-none absolute left-0 top-2 bottom-2 w-[2px] rounded-r bg-accent opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
            />
            <span class="flex h-5 w-10 shrink-0 items-center justify-center">
              <Icon />
            </span>
            <div class="flex min-w-[300px] flex-1 flex-col gap-1">
              <span
                data-testid={`${props.testId}-title`}
                class="line-clamp-2 text-[14px] font-medium leading-snug text-text"
              >
                <Pill class="mr-1.5 inline-block shrink-0 px-1.5 py-px align-middle text-[11.5px] font-semibold leading-tight" />
                {props.title}
              </span>
              <Show when={props.lines.length > 0}>
                <ul
                  data-testid={`${props.testId}-lines`}
                  class="flex flex-col gap-0.5 border-l-2 border-border pl-2.5 text-[12.5px] leading-snug text-text-secondary"
                >
                  <For each={props.lines}>{(line) => <li>{line}</li>}</For>
                </ul>
              </Show>
              <span
                data-testid={`${props.testId}-meta`}
                class="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-snug text-text-tertiary"
              >
                {props.meta.filter((m) => m !== "").join(" · ")}
              </span>
            </div>
            <div class="ml-auto flex w-full shrink-0 flex-wrap items-center justify-end gap-2 self-center pl-10 sm:w-auto sm:flex-nowrap sm:pl-0">
              <Show when={props.metric}>
                <span
                  data-testid={`${props.testId}-metric`}
                  class="shrink-0 font-mono text-[11px] tabular-nums text-text-tertiary"
                >
                  {props.metric}
                </span>
              </Show>
              <Show when={!props.expanded}>
                <Decisions compact={false} />
              </Show>
              <button
                type="button"
                data-testid={`${props.testId}-details`}
                aria-expanded={props.expanded}
                onClick={(e) => {
                  e.stopPropagation()
                  props.onToggle()
                }}
                class="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium text-text-tertiary transition-all duration-150 hover:bg-surface-hover hover:text-text-secondary"
              >
                <span
                  aria-hidden="true"
                  class="font-mono text-[10px] transition-transform duration-150"
                  classList={{ "rotate-90": props.expanded }}
                >
                  ›
                </span>
                {detailsLabel()}
              </button>
            </div>
            <Show when={props.expanded}>
              <div data-testid={`${props.testId}-expanded`} class="basis-full pl-10">
                {props.details}
              </div>
            </Show>
            <Show when={props.footer}>
              {(footer) => <div class="basis-full pl-10">{footer()}</div>}
            </Show>
          </>
        }
      >
        {/* The title wraps to a second line rather than truncating: on a
            phone "qualify-prospects waits for you" cut to "qualify-prospects
            waits…" hid who it waits for (owner ruling: nothing truncated in a
            way that hides meaning). Glyph, pill and chevron hold the first line. */}
        <div data-testid={`${props.testId}-title-line`} class="flex min-w-0 items-start gap-1.5">
          <span class="flex h-5 shrink-0 items-center">
            <Icon />
          </span>
          <Pill class="mt-px shrink-0 px-1.5 py-px text-[11px] font-semibold leading-tight" />
          <span
            data-testid={`${props.testId}-title`}
            class="line-clamp-2 min-w-0 flex-1 break-words text-[14px] font-medium leading-snug text-text"
            title={props.title}
          >
            {props.title}
          </span>
          <button
            type="button"
            data-testid={`${props.testId}-details`}
            aria-expanded={props.expanded}
            aria-label={detailsLabel()}
            onClick={(e) => {
              e.stopPropagation()
              props.onToggle()
            }}
            class="-mt-1 ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text-secondary"
          >
            <span
              aria-hidden="true"
              class="font-mono text-[13px] leading-none transition-transform duration-150"
              classList={{ "rotate-90": props.expanded }}
            >
              ›
            </span>
          </button>
        </div>
        <span
          data-testid={`${props.testId}-secondary`}
          class="flex min-w-0 items-center gap-1.5 text-[12px] leading-snug text-text-tertiary"
        >
          <span class="min-w-0 truncate">
            {(props.compactMeta ?? props.meta).filter((m) => m !== "").join(" · ")}
          </span>
          <Show when={props.metric}>
            <span data-testid={`${props.testId}-deadline`} class="shrink-0">
              {props.metric}
            </span>
          </Show>
        </span>
        <Show when={props.compactLine}>
          <span
            data-testid={`${props.testId}-explanation`}
            class="text-[12px] leading-snug text-text-secondary"
          >
            {props.compactLine}
          </span>
        </Show>
        <Show when={!props.expanded}>
          <div data-testid={`${props.testId}-actions`} class="mt-1 flex items-stretch gap-2">
            <Decisions compact />
          </div>
        </Show>
        <Show when={props.expanded}>
          <div data-testid={`${props.testId}-expanded`}>{props.details}</div>
        </Show>
        <Show when={props.footer}>{(footer) => footer()}</Show>
      </Show>
    </li>
  )
}

export interface DecisionFact {
  label: string
  value: string
  testid?: string
}

/**
 * The facts a Details opens, in ApprovalCard's anatomy: header (kind icon +
 * pill, handle right), title, subtitle, the facts, the technical details, the
 * provenance with its governing chip, then the decisions.
 */
export const DecisionDetailsCard: Component<{
  testId: string
  icon: IconComponent
  pill: { appId: string | null; label: string }
  handle?: string | null
  title: string
  subtitle?: string | null
  facts: DecisionFact[]
  technical?: string | null
  provenance?: string | null
  chip?: string | null
  actions?: JSX.Element
}> = (props) => {
  const i18n = useI18n()
  const Icon = () => {
    const I = props.icon
    return <I size={14} />
  }
  return (
    <div
      data-testid={props.testId}
      class="my-1 rounded-lg border border-border bg-elevated p-4 text-[13px]"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2 text-text-secondary">
          <Icon />
          <AppPill
            appId={props.pill.appId}
            class="min-w-0 truncate px-1.5 py-px text-[11px] font-semibold leading-tight"
          >
            {props.pill.label}
          </AppPill>
        </div>
        <Show when={props.handle}>
          <span class="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-[10px] text-text-tertiary">
            {props.handle}
          </span>
        </Show>
      </div>
      <div class="mt-2 font-medium text-text">{props.title}</div>
      <Show when={props.subtitle}>
        <div class="mt-0.5 text-text-secondary">{props.subtitle}</div>
      </Show>
      <dl class="mt-2 flex flex-col gap-1 text-text-secondary">
        <For each={props.facts}>
          {(fact) => (
            <div class="flex flex-wrap gap-x-1.5" data-testid={fact.testid}>
              <dt class="font-medium text-text">{fact.label}</dt>
              <dd class="m-0 min-w-0 break-words">{fact.value}</dd>
            </div>
          )}
        </For>
      </dl>
      <Show when={props.technical}>
        <details class="mt-3">
          <summary class="cursor-pointer text-[11px] uppercase tracking-wide text-text-tertiary">
            {i18n.t("kernel.approvalsUi.technicalDetails")}
          </summary>
          <code class="mt-1 block break-all font-mono text-[11.5px] text-text-secondary">
            {props.technical}
          </code>
        </details>
      </Show>
      <Show when={props.provenance || props.chip}>
        <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-text-tertiary">
          <Show when={props.provenance}>
            <span>{props.provenance}</span>
          </Show>
          <Show when={props.chip}>
            <span class="rounded bg-surface-sunken px-1.5 py-px text-[10px]">{props.chip}</span>
          </Show>
        </div>
      </Show>
      <Show when={props.actions}>
        <div class="mt-3 flex gap-2">{props.actions}</div>
      </Show>
    </div>
  )
}

/** The card's decision pair: the row's own two (`<testid>-in-card`). */
export const DecisionCardActions: Component<{
  primary: DecisionRowAction
  secondary: DecisionRowAction
}> = (props) => (
  <>
    <ActionButton
      action={{ ...props.primary, testid: `${props.primary.testid}-in-card` }}
      primary
      compact={false}
    />
    <ActionButton
      action={{ ...props.secondary, testid: `${props.secondary.testid}-in-card` }}
      primary={false}
      compact={false}
    />
  </>
)
