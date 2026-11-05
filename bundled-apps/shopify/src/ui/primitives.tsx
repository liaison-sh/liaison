// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shared visual primitives for the Shopify plugin UI.
//
// Originally lived inline inside `settings.tsx` and `panels/index.tsx`; lifted
// here so the new sidebar + home surfaces can reuse the same Chip / Section /
// StatusPill / KeyValueRow / PanelShell language without redefining tokens.
//
// Design language: kernel-aligned refined minimalism (Linear-inspired). Dense
// 11–13px type, hairline borders, restrained accent usage, tabular numerals
// for any quantity, money, or identifier. No emojis, no gradients, no shadows.
import { For, Show, type JSX } from "solid-js"
import { app } from "@liaison/host"
import { loadShopDomain, statusLabel } from "./list-helpers"

// ─────────────────────────────────────────────────────────────────────────
// Chip — small inline label with tone variants.
// ─────────────────────────────────────────────────────────────────────────
export type ChipTone = "muted" | "accent" | "success" | "warning" | "danger"

export function Chip(props: { tone?: ChipTone; children: JSX.Element }) {
  const tone = props.tone ?? "muted"
  const cls =
    tone === "accent"
      ? "bg-accent-subtle text-accent border-accent-border"
      : tone === "success"
        ? "bg-success-glow text-success border-success-border"
        : tone === "warning"
          ? "bg-warning-glow text-warning border-warning-border"
          : tone === "danger"
            ? "bg-error-glow text-error border-error-border"
            : "bg-surface text-text-secondary border-border"
  return (
    <span
      class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {props.children}
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// StatusPill — semantic mapper for Shopify-ish status strings to a Chip.
// Maps "fulfilled / paid / completed / active" → success; "pending / open /
// in_progress / running" → warning; anything else → muted. The LABEL is always
// `statusLabel`: the raw enum ("PARTIALLY_FULFILLED") is never printed.
// ─────────────────────────────────────────────────────────────────────────
export function StatusPill(props: { status?: string | null }) {
  const s = (props.status ?? "").toLowerCase()
  const tone: ChipTone =
    s === "fulfilled" || s === "paid" || s === "completed" || s === "active"
      ? "success"
      : s === "pending" || s === "open" || s === "in_progress" || s === "running"
        ? "warning"
        : "muted"
  return (
    <Show when={props.status}>
      <Chip tone={tone}>{statusLabel(props.status)}</Chip>
    </Show>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Section — labelled section header + slot. The section title is an eyebrow
// (uppercase, tracked) so it disappears into the layout when not needed.
// ─────────────────────────────────────────────────────────────────────────
export function Section(props: { title: string; testid?: string; children: JSX.Element }) {
  return (
    <section data-testid={props.testid} class="flex flex-col gap-2">
      <h3 class="text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
        {props.title}
      </h3>
      {props.children}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// KeyValueRow — a label/value row used inside summary cards.
// ─────────────────────────────────────────────────────────────────────────
export function KeyValueRow(props: { label: string; value: JSX.Element }) {
  return (
    <div class="flex items-baseline justify-between gap-3 text-xs">
      <span class="text-text-tertiary">{props.label}</span>
      <span class="truncate text-right font-medium text-text">{props.value}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// PanelShell — vertical scroll container with consistent padding. Used by
// the entity detail panels so they all match the kernel's tab content area.
// ─────────────────────────────────────────────────────────────────────────
export function PanelShell(props: { testid: string; children: JSX.Element }) {
  return (
    <section
      data-testid={props.testid}
      class="flex min-h-full flex-col gap-4 bg-bg p-5 text-sm text-text"
    >
      {props.children}
    </section>
  )
}

export function PanelLoading(props: { testid: string }) {
  return (
    <div
      data-testid={props.testid}
      class="flex h-full items-center justify-center text-xs text-text-tertiary"
    >
      Loading…
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// PanelHeader — consistent title + subtitle + chip row at the top of a
// detail panel.
// ─────────────────────────────────────────────────────────────────────────
export interface PanelHeaderProps {
  title: string
  subtitle?: string | null
  market?: string | null
  currency?: string | null
  status?: string | null
}

export function PanelHeader(props: PanelHeaderProps) {
  return (
    <header class="flex flex-col gap-2 border-b border-border-subtle pb-3">
      <div class="flex items-baseline justify-between gap-2">
        <h2 class="truncate text-base font-semibold text-text">{props.title}</h2>
        <StatusPill status={props.status} />
      </div>
      <Show when={props.subtitle}>
        <p class="text-xs text-text-secondary">{props.subtitle}</p>
      </Show>
      <Show when={props.market || props.currency}>
        <div class="flex flex-wrap gap-1.5">
          <Show when={props.market}>
            <Chip>{props.market!}</Chip>
          </Show>
          <Show when={props.currency}>
            <Chip>{props.currency!}</Chip>
          </Show>
        </div>
      </Show>
    </header>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Empty — empty-state row used by tables / lists. Stays calm — single line,
// tertiary text.
// ─────────────────────────────────────────────────────────────────────────
export function Empty(props: { children: JSX.Element; testid?: string }) {
  return (
    <p
      data-testid={props.testid}
      class="px-4 py-8 text-center text-xs text-text-tertiary"
    >
      {props.children}
    </p>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// useShopDomain — resolve the connected store's full myshopify domain once
// per mount via the `home_load` probe. Returns null while loading or on error
// so the UI degrades gracefully (links fall back to a generic admin host).
//
// Detail panels are host-mounted plugin components: the host (DetailTab) does
// not know the real shop, so each panel resolves it itself through the
// `@liaison/host` bridge — the same path the list/home views already use.
// Centralised here so panels and lists share one resolver instead of three.
// ─────────────────────────────────────────────────────────────────────────
//
// The home_load probe is coalesced at MODULE scope (see `loadShopDomain` in
// ./list-helpers) so the home tab, all four list views, and every detail panel
// that needs the store domain share a SINGLE network round-trip instead of each
// issuing its own home_load bundle (the N+1 the deep review flagged).
export function useShopDomain() {
  // app.createResource wraps the SAME `loadShopDomain()` module-scope-coalesced
  // probe (see ./list-helpers) — every caller still shares the one in-flight
  // home_load round-trip; this only adds resync-bus + stale-tab revalidation
  // on top, it doesn't change the coalescing.
  const [domain] = app.createResource<string | null>(() => loadShopDomain())
  return domain
}

// ─────────────────────────────────────────────────────────────────────────
// Re-export For / Show so consumer files don't need to import twice.
// ─────────────────────────────────────────────────────────────────────────
export { For, Show }
