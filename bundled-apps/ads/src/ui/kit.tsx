// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Meta Ads UI kit: the shared primitive set from @liaison/app-ui/kit plus the
// ads-only surfaces (Money, StatusBadge, AdPreviewDrawer, Stat) and the ads
// default test ids on ConfirmDialog.
//
// Bundling rule: explicit props only, NO `{...rest}` spread onto a host
// element. A spread makes Solid's DOM compiler emit a `mergeProps` import from
// `solid-js/web` that the freeze bundler can't resolve, so the UI bundle fails
// to load. Every primitive below lists its props.
import {
  Badge,
  Button,
  cx,
  Segmented,
  ConfirmDialog as SharedConfirmDialog,
} from "@liaison/app-ui/kit"
import { type Component, type JSX, Show } from "solid-js"
import { type BadgeTone, effectiveStatusTone, formatMoney, type MetaIssue } from "./ui-logic"

export { Badge, Button, Card, cx, EmptyState, PageHeader, SectionLabel } from "@liaison/app-ui/kit"
export { type BadgeTone, formatMoney }

// ── Money ─────────────────────────────────────────────────────────────────────
export const Money: Component<{
  value: number | string | null | undefined
  currency?: string
  emphasis?: boolean
  class?: string
}> = (props) => (
  <span
    class={cx(
      "font-mono tabular-nums whitespace-nowrap",
      props.emphasis ? "text-text font-medium" : "text-text",
      props.class,
    )}
  >
    {formatMoney(props.value as number | string | null, props.currency)}
  </span>
)

// ── StatusBadge — delivery status dot + label (effective_status truth) ────────
export const StatusBadge: Component<{
  effectiveStatus: string
  class?: string
  testid?: string
}> = (props) => {
  const tone = () => effectiveStatusTone(props.effectiveStatus)
  return (
    <Badge tone={tone()} dot testid={props.testid ?? "ads-status-badge"} class={props.class}>
      {props.effectiveStatus}
    </Badge>
  )
}

// ── ConfirmDialog: the shared modal with the ads overlay test id ─────────────
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
}> = (props) => (
  <SharedConfirmDialog
    open={props.open}
    title={props.title}
    body={props.body}
    confirmLabel={props.confirmLabel}
    danger={props.danger}
    busy={props.busy}
    onConfirm={props.onConfirm}
    onCancel={props.onCancel}
    testid={props.testid ?? "ads-confirm-dialog"}
  />
)

// ── AdPreviewDrawer — right-side placement preview drawer ────────────────────
export const AdPreviewDrawer: Component<{
  open: boolean
  title: string
  iframeSrc: string | null
  fallbackThumb: string | null
  adsManagerUrl: string | null
  placement: string
  placements: { value: string; label: string }[]
  onPlacement: (v: string) => void
  onClose: () => void
  busy?: boolean
  testid?: string
}> = (props) => (
  <Show when={props.open}>
    <div
      data-testid={props.testid ?? "ads-ad-preview-drawer"}
      class="fixed inset-y-0 right-0 z-40 flex w-[420px] flex-col border-l border-border bg-elevated shadow-2xl"
    >
      {/* Header */}
      <div class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <span class="text-[13px] font-semibold text-text">{props.title}</span>
        <Button variant="ghost" onClick={props.onClose} ariaLabel="Close preview">
          ✕
        </Button>
      </div>

      {/* Placement toggle */}
      <div class="border-b border-border-subtle px-4 py-2">
        <Segmented
          options={props.placements}
          value={props.placement}
          onChange={props.onPlacement}
          testidPrefix="ads-preview-placement"
          ariaLabel="Ad placement"
        />
      </div>

      {/* Preview area */}
      <div class="flex flex-1 flex-col items-center justify-center overflow-auto p-4">
        <Show when={props.busy}>
          <span class="text-text-tertiary text-[12px]">Loading preview…</span>
        </Show>
        <Show when={!props.busy}>
          <Show
            when={props.iframeSrc}
            fallback={
              <div class="flex flex-col items-center gap-3">
                <Show when={props.fallbackThumb}>
                  {(thumb) => (
                    <img
                      src={thumb()}
                      alt="Ad creative thumbnail"
                      class="max-h-48 rounded-md border border-border object-contain"
                    />
                  )}
                </Show>
                <Show when={props.adsManagerUrl}>
                  {(url) => (
                    <a
                      href={url()}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-[12px] text-accent hover:underline"
                    >
                      View in Ads Manager ↗
                    </a>
                  )}
                </Show>
                <Show when={!props.fallbackThumb && !props.adsManagerUrl}>
                  <p class="text-[12px] text-text-tertiary">No preview available</p>
                </Show>
              </div>
            }
          >
            {(src) => (
              /* allow-scripts only: Meta previews are cross-origin facebook.com; allow-same-origin would relax the sandbox with no benefit */
              <iframe
                sandbox="allow-scripts"
                src={src()}
                class="h-full min-h-[400px] w-full rounded-md border border-border"
                title={`Ad preview: ${props.title}`}
              />
            )}
          </Show>
        </Show>
      </div>
    </div>
  </Show>
)

// ── Stat — one KPI cell: small uppercase label ABOVE, value below ────────────
// Every stat row on the dashboard composes this so labels and values never
// render inline-jammed ("SPEND€1,028.34") and all cells share one baseline:
// the label is its own block line, and the value line has a fixed height and
// line-height so numeric and text fallbacks align across columns.
export const Stat: Component<{
  label: string
  testid?: string
  class?: string
  children: JSX.Element
}> = (props) => (
  <div data-testid={props.testid} class={cx("flex min-w-0 flex-col gap-0.5", props.class)}>
    <span class="block text-[10.5px] font-medium uppercase tracking-wider text-text-tertiary">
      {props.label}
    </span>
    <div class="flex h-6 items-baseline gap-2 text-[18px] leading-6">{props.children}</div>
  </div>
)

// ── MetaIssueNote ────────────────────────────────────────────────────────────
// The one rendering of a Meta outcome (throttled, refused, rejected, still
// building): its plain sentence, and a Retry only where retrying can help.
export const MetaIssueNote: Component<{
  issue: MetaIssue
  onRetry?: () => void
  testid?: string
  class?: string
}> = (props) => (
  <div
    data-testid={props.testid}
    data-meta-issue={props.issue.kind}
    role={props.issue.tone === "error" ? "alert" : "status"}
    class={cx(
      "text-[12.5px]",
      props.issue.tone === "error" ? "text-error" : "text-text-tertiary",
      props.class,
    )}
  >
    <span>{props.issue.text}</span>
    <Show when={props.issue.retry && props.onRetry}>
      <button
        type="button"
        class="ml-2 text-accent underline hover:text-accent-hover"
        onClick={() => props.onRetry?.()}
      >
        Retry
      </button>
    </Show>
  </div>
)
