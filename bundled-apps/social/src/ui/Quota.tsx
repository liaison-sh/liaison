// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SocialQuota: the API quota block of the declarative settings page
// (manifest `settings`, section "API quota"). A read-only computed view of
// `quota_status`: the YouTube units used today as a line and a meter, the watch
// polls deferred once the budget is spent, and each platform's stored
// rate-limit state as readable lines (never raw JSON). Connections and monitor
// terms are declarative blocks the kernel renders.

import { app } from "@liaison/host"
import { type Component, For, Show } from "solid-js"
import { Button } from "./kit"

export interface YoutubeQuotaView {
  day: string | null
  resetsAt: string | null
  cap: number
  consumed: number
  remaining: number
  deferred: number
  exhaustedUntil: string | null
}

export interface QuotaInfo {
  youtube: YoutubeQuotaView | null
  rateLimits: Array<{ platform: string; rateLimit: Record<string, unknown> }>
}

/** True when the YouTube budget is spent or watch polls were deferred. */
export function quotaExhausted(q: QuotaInfo | null | undefined): boolean {
  const y = q?.youtube
  if (!y) return false
  return y.exhaustedUntil !== null || y.consumed >= y.cap || y.deferred > 0
}

const units = new Intl.NumberFormat("en-US")

/** The YouTube readout line: "1,499 of 9,000 units today". */
export function youtubeQuotaLine(y: YoutubeQuotaView): string {
  return `${units.format(y.consumed)} of ${units.format(y.cap)} units today`
}

function platformName(p: string): string {
  return p === "facebook" ? "Facebook" : p === "instagram" ? "Instagram" : p
}

/** A stored value as words: nested objects become "key value" pairs, never JSON. */
function readableValue(v: unknown): string {
  if (v === null || v === undefined) return "none"
  if (Array.isArray(v)) return v.map(readableValue).join(", ")
  if (typeof v === "object") {
    return Object.entries(v as Record<string, unknown>)
      .map(([k, inner]) => `${k.replace(/_/g, " ")} ${readableValue(inner)}`)
      .join(", ")
  }
  return String(v)
}

/** One platform's stored rate-limit state as a readable line. */
export function rateLimitLine(r: { platform: string; rateLimit: Record<string, unknown> }): string {
  return `${platformName(r.platform)} rate limit: ${readableValue(r.rateLimit)}`
}

async function loadQuota(): Promise<QuotaInfo | null> {
  try {
    return await app.invokeTool<QuotaInfo>("quota_status", {})
  } catch {
    return null
  }
}

export const SocialQuota: Component = () => {
  const [quota, { refetch }] = app.createResource(loadQuota)
  return (
    <div data-testid="social-quota" class="flex flex-col gap-2 text-[12.5px] text-text-secondary">
      <Show when={quotaExhausted(quota())}>
        <div
          data-testid="social-quota-banner"
          class="rounded-md border border-warning bg-warning-glow px-3 py-2 text-warning"
        >
          YouTube daily quota reached: {quota()?.youtube?.deferred ?? 0} watch polls deferred until
          the quota resets.
        </div>
      </Show>
      <Show
        when={quota() && (quota()!.youtube || quota()!.rateLimits.length > 0)}
        fallback={
          <span class="text-[12px] text-text-tertiary">
            {quota.loading ? "Loading…" : "No quota data."}
          </span>
        }
      >
        <Show when={quota()!.youtube}>
          <div data-testid="social-quota-readout">
            YouTube: {youtubeQuotaLine(quota()!.youtube!)}
          </div>
          <div
            role="meter"
            aria-label="YouTube units used today"
            aria-valuemin={0}
            aria-valuemax={quota()!.youtube!.cap}
            aria-valuenow={quota()!.youtube!.consumed}
            data-testid="social-quota-meter"
            class="h-1.5 w-full max-w-[320px] overflow-hidden rounded-full bg-surface-hover"
          >
            <div
              class="h-full rounded-full bg-accent"
              style={{
                width: `${Math.min(100, quota()!.youtube!.cap > 0 ? (quota()!.youtube!.consumed / quota()!.youtube!.cap) * 100 : 0)}%`,
              }}
            />
          </div>
          <Show when={quota()!.youtube!.deferred > 0}>
            <div data-testid="social-quota-deferred">
              {quota()!.youtube!.deferred} watch polls deferred
            </div>
          </Show>
        </Show>
        <For each={quota()!.rateLimits}>
          {(r) => <div data-testid={`social-quota-rate-${r.platform}`}>{rateLimitLine(r)}</div>}
        </For>
      </Show>
      <div>
        <Button
          variant="secondary"
          testid="social-quota-refresh"
          disabled={quota.loading}
          onClick={() => void refetch()}
        >
          <span aria-busy={quota.loading}>{quota.loading ? "Refreshing…" : "Refresh"}</span>
        </Button>
      </div>
    </div>
  )
}
