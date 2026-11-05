// SPDX-License-Identifier: FSL-1.1-ALv2
//
// @liaison/app-ui/kit: the shared, calm, Linear-charcoal primitive set every
// bundled app surface composes from (ads, boxtal, invoicing, kpi, monitoring,
// pennylane, social). Bundled apps can't import the kernel's apps/web/src/ui
// primitives (purity guard), so this is the plugin design layer. It styles
// ONLY with the kernel's shared Tailwind theme tokens (the charcoal palette +
// radius/text scales in apps/web/src/styles/theme.css, which scans this file
// through its `@source` list), so every app stays visually identical to the
// kernel shell.
//
// Principles: quiet surfaces, one accent, generous spacing, tabular figures,
// status as tinted badges (never raw enum text), real form controls. Restraint
// over decoration.
//
// Every optional prop renders nothing when omitted, so an app that never passes
// it gets exactly the markup its former local copy produced.
//
// Bundling rule: explicit props only, NO `{...rest}` spread onto a host
// element. A spread makes Solid's DOM compiler emit a `mergeProps` import from
// `solid-js/web` that the freeze bundler can't resolve, so the UI bundle fails
// to load. Every primitive below lists its props.
import { type Component, For, type JSX, Show } from "solid-js"

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ")
}

// ── Badge ────────────────────────────────────────────────────────────────────
export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "error" | "muted"

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-surface text-text-secondary border-border",
  accent: "bg-accent-tint text-accent border-accent-border",
  success: "bg-success-glow text-success border-success-border",
  warning: "bg-warning-glow text-warning border-warning-border",
  error: "bg-error-glow text-error border-error-border",
  muted: "bg-transparent text-text-tertiary border-border-subtle",
}

const DOT_TONE: Record<BadgeTone, string> = {
  neutral: "bg-text-secondary",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  muted: "bg-text-tertiary",
}

/** The status-dot background class for a tone (the dot a `dot` Badge shows). */
export const badgeDotClass = (tone: BadgeTone): string => DOT_TONE[tone]

export const Badge: Component<{
  tone?: BadgeTone
  dot?: boolean
  class?: string
  children: JSX.Element
  testid?: string
  /** Emitted as `data-variant` (e2e hook); omitted attribute when unset. */
  variant?: string
}> = (props) => (
  <span
    data-testid={props.testid}
    data-variant={props.variant}
    class={cx(
      "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-none",
      BADGE_TONE[props.tone ?? "neutral"],
      props.class,
    )}
  >
    <Show when={props.dot}>
      <span class={cx("h-1.5 w-1.5 shrink-0 rounded-full", DOT_TONE[props.tone ?? "neutral"])} />
    </Show>
    {props.children}
  </span>
)

// ── Form controls ────────────────────────────────────────────────────────────
export const inputClass =
  "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12.5px] text-text " +
  "placeholder:text-text-tertiary transition-colors outline-none " +
  "focus:border-accent-border focus:ring-2 focus:ring-accent-tint " +
  "disabled:cursor-not-allowed disabled:opacity-55"

// Label + control. Vertical, with an uppercase eyebrow that matches section
// headers.
export const Field: Component<{
  label: string
  children: JSX.Element
  hint?: string
  error?: boolean
  class?: string
}> = (props) => (
  <label class={cx("flex flex-col gap-1.5", props.class)}>
    <span
      class={cx(
        "text-[10.5px] font-medium uppercase tracking-wider",
        props.error ? "text-error" : "text-text-tertiary",
      )}
    >
      {props.label}
    </span>
    {props.children}
    <Show when={props.hint}>
      <span class="text-[11px] text-text-tertiary">{props.hint}</span>
    </Show>
  </label>
)

// ── Button ────────────────────────────────────────────────────────────────────
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-bg hover:bg-accent-hover border border-transparent",
  secondary:
    "border border-border bg-surface text-text hover:bg-surface-hover hover:border-border-strong",
  ghost: "border border-transparent text-text-secondary hover:bg-surface-hover hover:text-text",
  danger: "border border-error-border bg-transparent text-error hover:bg-error-glow",
}

export const Button: Component<{
  variant?: ButtonVariant
  testid?: string
  class?: string
  onClick?: (e: MouseEvent) => void
  disabled?: boolean
  type?: "button" | "submit"
  title?: string
  ariaLabel?: string
  children: JSX.Element
}> = (props) => (
  <button
    type={props.type ?? "button"}
    data-testid={props.testid}
    disabled={props.disabled}
    title={props.title}
    aria-label={props.ariaLabel}
    onClick={props.onClick}
    class={cx(
      "inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium",
      "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent-tint",
      "disabled:cursor-not-allowed disabled:opacity-50",
      BUTTON_VARIANT[props.variant ?? "secondary"],
      props.class,
    )}
  >
    {props.children}
  </button>
)

// ── Segmented control (filter affordance) ────────────────────────────────────
export function Segmented<T extends string>(props: {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  testidPrefix?: string
  ariaLabel?: string
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={props.ariaLabel}
      class="inline-flex items-center gap-0.5 rounded-lg border border-border-subtle bg-surface p-0.5"
    >
      <For each={props.options}>
        {(opt) => {
          const active = () => props.value === opt.value
          return (
            <button
              type="button"
              data-testid={props.testidPrefix ? `${props.testidPrefix}-${opt.value}` : undefined}
              aria-pressed={active()}
              onClick={() => props.onChange(opt.value)}
              class={cx(
                "rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
                active()
                  ? "bg-elevated text-text shadow-[0_1px_2px_rgba(0,0,0,0.25)]"
                  : "text-text-tertiary hover:text-text-secondary",
              )}
            >
              {opt.label}
            </button>
          )
        }}
      </For>
    </div>
  )
}

// ── ConfirmDialog ─────────────────────────────────────────────────────────────
// Hand-rolled modal (no Kobalte, no portal: the freeze bundler resolves only a
// narrow solid-js surface). `testid` names the overlay; the confirm button is
// always `confirm-dialog-confirm-btn`, the cancel button carries `cancelTestid`
// only when given.
export const ConfirmDialog: Component<{
  open: boolean
  title: string
  body?: string
  confirmLabel: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  testid?: string
  cancelTestid?: string
}> = (props) => (
  <Show when={props.open}>
    {/* Fixed overlay: prefers-reduced-motion, no transition, visibility only */}
    <div
      data-testid={props.testid}
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div class="w-full max-w-sm rounded-xl border border-border bg-elevated p-5 shadow-xl">
        <h2 id="confirm-dialog-title" class="text-[14px] font-semibold text-text">
          {props.title}
        </h2>
        <Show when={props.body}>
          <p class="mt-2 text-[12.5px] text-text-secondary">{props.body}</p>
        </Show>
        <div class="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={props.onCancel}
            disabled={props.busy}
            testid={props.cancelTestid}
          >
            Cancel
          </Button>
          <Button
            variant={props.danger ? "danger" : "primary"}
            onClick={props.onConfirm}
            disabled={props.busy}
            testid="confirm-dialog-confirm-btn"
          >
            {props.busy ? "…" : props.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  </Show>
)

// ── Layout atoms ──────────────────────────────────────────────────────────────
export const SectionLabel: Component<{ class?: string; children: JSX.Element }> = (props) => (
  <div
    class={cx("text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary", props.class)}
  >
    {props.children}
  </div>
)

export const Card: Component<{ class?: string; children: JSX.Element; testid?: string }> = (
  props,
) => (
  <div
    data-testid={props.testid}
    class={cx("rounded-lg border border-border-subtle bg-surface", props.class)}
  >
    {props.children}
  </div>
)

// Page scaffold: a header row (title + count + subtitle + actions) over a
// scroll region, so every app's headers align pixel-for-pixel.
/**
 * A pane's own header: its name, an optional count and subtitle, and its
 * actions.
 *
 * At phone width the kernel shell ALREADY draws the pane's name in its header
 * bar, so an app that also draws it says the same word twice down the screen
 * ("Dashboard" over "Dashboard"). Every first party app builds its header
 * here, so the rule lives here: the title group is hidden below the shell's
 * 640px phone tier, and a header with nothing but a title gets out of the way
 * entirely rather than leave an empty ruled bar behind. A header carrying
 * ACTIONS keeps its bar, because those have nowhere else to go.
 */
export const PageHeader: Component<{
  title: string
  count?: number
  subtitle?: string
  actions?: JSX.Element
  testid?: string
}> = (props) => (
  <header
    data-testid={props.testid}
    data-phone-header={props.actions ? "actions" : "hidden"}
    class={cx(
      "flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3",
      !props.actions && "max-sm:hidden",
    )}
  >
    <div data-page-title class="flex items-baseline gap-2.5 max-sm:hidden">
      <h1 class="text-[14px] font-semibold text-text">{props.title}</h1>
      <Show when={props.count !== undefined}>
        <span class="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-text-secondary">
          {props.count}
        </span>
      </Show>
      <Show when={props.subtitle}>
        <span class="text-[12px] text-text-tertiary">{props.subtitle}</span>
      </Show>
    </div>
    <Show when={props.actions}>
      <div class="flex items-center gap-2">{props.actions}</div>
    </Show>
  </header>
)

// Dense table head cell: uppercase eyebrow, right-alignable.
export const Th: Component<{
  class?: string
  right?: boolean
  /** Tooltip, for a header whose label is a glyph and needs naming. */
  title?: string
  /** "tight" swaps the roomy default padding for the DENSE grid padding, so a
   *  header lines up with a dense body cell instead of setting a wider column
   *  than its own content needs. It REPLACES the padding rather than adding to
   *  it: two padding utilities on the same element are resolved by stylesheet
   *  order, not class order, so appending px-1.5 to px-3 is a coin flip. */
  pad?: "tight"
  children: JSX.Element
}> = (props) => (
  <th
    title={props.title}
    class={cx(
      props.pad === "tight" ? "px-1.5 py-1" : "px-3 py-2",
      "text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary",
      props.right ? "text-right" : "text-left",
      props.class,
    )}
  >
    {props.children}
  </th>
)

export const EmptyState: Component<{
  icon?: JSX.Element
  title?: string
  children: JSX.Element
  testid?: string
}> = (props) => (
  <div
    data-testid={props.testid}
    class="flex flex-1 flex-col items-center justify-center gap-2.5 px-6 py-16 text-center"
  >
    <Show when={props.icon}>
      <div class="text-text-tertiary opacity-50">{props.icon}</div>
    </Show>
    <Show when={props.title}>
      <p class="text-[13px] font-medium text-text-secondary">{props.title}</p>
    </Show>
    <p class="max-w-xs text-[12px] text-text-tertiary">{props.children}</p>
  </div>
)
