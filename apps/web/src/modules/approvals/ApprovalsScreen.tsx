// SPDX-License-Identifier: FSL-1.1-ALv2
//
// M2-1 T12. The approvals queue as a screen of its own: the decisions waiting
// on this person, one full width card each, newest deadline first in the
// summary line so the screen answers "how long have I got" before it is
// scrolled.
//
// The card itself is `ApprovalCard`, unchanged: this screen owns the list, the
// title and the collapse a decided card leaves behind, nothing about how an
// approval is rendered or decided. The approvals list's two other kinds are
// listed here too, in the rows Home shows (AttentionRow): an access request
// the person can grant (Grant / Deny) and a run of their own routine waiting
// for their private mailbox (Run now / Dismiss). Everything that waits on the
// person is in one list, the same one Home's Approvals card and badge count.
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import {
  collapseMailboxWaits,
  isExpiredMailboxWait,
} from "~/modules/agent/routine-mailbox-wait-item"
import ApprovalCard, { minutesLeft } from "~/modules/approvals/ApprovalCard"
import { decidableByMe, loadDecidableByMe } from "~/modules/approvals/approvals-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import AttentionRow from "~/modules/shell/AttentionRow"
import { formatShortDuration, rowLocaleFrom } from "~/modules/shell/attention-row-format"
import { attentionStore } from "~/modules/shell/attention-store"
import {
  ensureBrandingLoaded,
  ensureSignedInOrgNameLoaded,
  orgName,
} from "~/modules/shell/branding-store"
import { currentHomeViewer } from "~/modules/shell/home-action-count"

/** How long a decided card keeps its place while it collapses. */
export const COLLAPSE_MS = 220

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches
  } catch {
    return false
  }
}

/** The soonest deadline among the pending rows, in whole minutes. */
export function soonestDeadlineMinutes(
  rows: ReadonlyArray<{ expiresAt?: string }>,
  now: number,
): number | null {
  let soonest: number | null = null
  for (const row of rows) {
    const minutes = minutesLeft(row.expiresAt, now)
    if (minutes === null) continue
    if (soonest === null || minutes < soonest) soonest = minutes
  }
  return soonest
}

export const ApprovalsScreen: Component = () => {
  const i18n = useI18n()
  const api = useApi()
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(tick))
  onMount(() => {
    void ensureBrandingLoaded()
    // The signed-in org, which is what this header names. Public branding
    // answers for the DEPLOYMENT and is only the logged-out fallback.
    void ensureSignedInOrgNameLoaded(() => api.get("/org"))
  })

  void loadDecidableByMe(api)

  const rows = createMemo(() => decidableByMe())
  // Access requests the person can grant, and runs of their own routines
  // waiting for their private mailbox: the same attention rows Home's
  // approvals list shows (homeApprovalItems' rules), the lapsed waits gone.
  const waits = createMemo(() => {
    const viewer = currentHomeViewer()
    return collapseMailboxWaits(
      attentionStore.items.filter((item) =>
        item.kind === "scope_request"
          ? viewer.canGrantAccess
          : item.kind === "routine_mailbox_wait" && !isExpiredMailboxWait(item, now()),
      ),
    )
  })

  // Ids still on screen although the store has dropped them: a decided card
  // collapses in place so the next one rises into the gap instead of jumping.
  const [collapsing, setCollapsing] = createStore<Record<string, boolean>>({})
  const [displayed, setDisplayed] = createSignal<ReturnType<typeof decidableByMe>>([])
  let previous: ReturnType<typeof decidableByMe> = []
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  onCleanup(() => {
    for (const t of timers.values()) clearTimeout(t)
  })

  createEffect(() => {
    const current = rows()
    const currentIds = new Set(current.map((r) => r.id))
    const merged = [...current]
    const leaving: string[] = []
    previous.forEach((row, index) => {
      if (currentIds.has(row.id)) return
      if (!timers.has(row.id)) leaving.push(row.id)
      merged.splice(Math.min(index, merged.length), 0, row)
    })
    if (leaving.length > 0) {
      const wait = prefersReducedMotion() ? 0 : COLLAPSE_MS
      setCollapsing(
        produce((s) => {
          for (const id of leaving) s[id] = true
        }),
      )
      for (const id of leaving) {
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id)
            setCollapsing(id, false)
            previous = previous.filter((r) => r.id !== id)
            setDisplayed(previous)
          }, wait),
        )
      }
    }
    previous = merged
    setDisplayed(merged)
  })

  // The header reads its deadline with the SAME humanised formatter the rows
  // use. Raw minutes turned a three day deadline into "3913 min", a figure
  // nobody can price against a row that says "3d" right underneath it.
  const summary = () => {
    const soonest = soonestDeadlineMinutes(rows(), now())
    return soonest === null
      ? i18n.t("kernel.approvalsNoExpiry")
      : i18n.t("kernel.approvalsNextExpiry", {
          value: formatShortDuration(soonest * 60, rowLocaleFrom(i18n)),
        })
  }

  return (
    <div class="flex h-full min-h-0 flex-col overflow-y-auto pb-6" data-testid="approvals-screen">
      <div class="flex shrink-0 flex-col gap-0.5 px-4 pb-2 pt-3">
        <div class="flex items-baseline gap-2">
          <h1 class="text-[28px] font-bold leading-tight text-text">
            {i18n.t("kernel.approvalsTitle")}
          </h1>
          <span class="text-[15px] tabular-nums text-text-tertiary" data-testid="approvals-count">
            {rows().length + waits().length}
          </span>
        </div>
        <p class="text-[13px] text-text-secondary" data-testid="approvals-summary">
          {summary()}
        </p>
        {/* K2: this root screen hides the phone top bar entirely (it owns its
            own large title), so the workspace name that bar used to carry
            moves here, as a small muted line under the title — the same
            placement `ChatsScreen` uses. */}
        <Show when={orgName()}>
          {(name) => (
            <p data-testid="approvals-title-org" class="truncate text-[12px] text-text-secondary">
              {name()}
            </p>
          )}
        </Show>
      </div>

      <Show when={waits().length > 0}>
        <ul
          class="mx-3 mb-2 flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-surface"
          data-testid="approvals-other-kinds"
        >
          <For each={waits()}>{(item) => <AttentionRow item={item} />}</For>
        </ul>
      </Show>
      <Show
        when={displayed().length > 0 || waits().length > 0}
        fallback={
          <p
            class="px-4 py-8 text-center text-[15px] text-text-secondary"
            data-testid="approvals-empty"
          >
            {i18n.t("kernel.approvalsEmpty")}
          </p>
        }
      >
        <div class="flex flex-col px-3">
          <For each={displayed()}>
            {(row) => (
              <div
                data-testid={`approvals-item-${row.id}`}
                data-collapsing={collapsing[row.id] ? "true" : "false"}
                class={`overflow-hidden transition-[max-height,opacity] duration-200 ease-in motion-reduce:transition-none ${
                  collapsing[row.id] ? "max-h-0 opacity-0" : "max-h-[1200px] opacity-100"
                }`}
              >
                <ApprovalCard requestId={row.id} />
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export default ApprovalsScreen
