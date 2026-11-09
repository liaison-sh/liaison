// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Queues: the shipping worklist, ONE page, ONE table (ticket-10508).
//
// An order goes from To prepare (no label yet), to Label bought, to Packed and fulfilled, in the
// same table, with its State on every row and a filter on top (All, or one state). The rows:
//
// - To prepare: the order-prep rows (PrepGrid.tsx), orders that still need a label, with their
//   quote and offer picking, the paid-shipping comparison and the label approval card.
// - Bought labels (ReadyRows.tsx): every label the carrier has not collected yet, the print
//   station. Print label + invoice, tick the parcel packed (which fulfils the Shopify order), or
//   attach the pair to a ticket reply.
//
// The retired /boxtal/queue/to-prepare and /boxtal/queue/ready routes open this same page with
// their filter preset.
//
// It composes ONLY the shared Boxtal kit (kit.tsx) and styles with the kernel's charcoal theme
// tokens, so it reads pixel-for-pixel like invoicing.
import { type Component, createEffect, createMemo, createSignal, For, on, Show } from "solid-js"
import { currentPath } from "@liaison/host"
import { cx } from "./kit"
import { PrepGrid } from "./PrepGrid"
import { createReadyWorklist, ReadyUnpackDialog } from "./ReadyRows"
import { usePathname } from "./sidebar"
import { WORKLIST_FILTERS, type WorklistFilter, worklistFilterCounts, worklistFilterForRoute } from "./worklist-logic"

// ── Router — pick the queue from props.queueId or the URL last segment ─────────
function queueIdFromLocation(): string {
  try {
    const segs = currentPath().replace(/\?.*$/, "").split("/").filter(Boolean)
    return segs[segs.length - 1] ?? ""
  } catch {
    return ""
  }
}

/** Pick the live queue id. The URL is the source of truth: the sidebar rows
 *  navigate via history.pushState and NOTHING updates the singleton tab's
 *  entityId on in-tab navigation, so props.entityId only reflects the queue
 *  the tab was FIRST opened on. `pathname` must be the REACTIVE pathname
 *  signal value (usePathname), never a one-shot window.location read: a plain
 *  read froze the first-mounted queue forever (Ready to ship rendered the
 *  To-prepare grid). Props are the fallback for tests/direct mounts. */
export function resolveQueueId(
  pathname: string | undefined,
  entityId?: string,
  queueId?: string,
): string {
  if (pathname) {
    const segs = (pathname.split("?")[0] ?? "").split("/").filter(Boolean)
    // Only trust the URL when it is actually a queue route; the tab can stay
    // mounted while another tab's URL is active.
    const qIdx = segs.indexOf("queue")
    const queueSeg = qIdx >= 0 ? segs[qIdx + 1] : undefined
    if (queueSeg) return queueSeg
  }
  return entityId ?? queueId ?? queueIdFromLocation()
}

/** The one shipping worklist: one table of every order and bought label, one filter over it. */
export const ShippingWorklist: Component<{ initialFilter: WorklistFilter }> = (props) => {
  const [filter, setFilter] = createSignal<WorklistFilter>(props.initialFilter)
  // A sidebar click on another route lands here with a new preset: follow it. Through a memo, so
  // a URL change that leaves the preset as it was (the prep grid writing its own query state)
  // never resets the filter the operator picked.
  const preset = createMemo(() => props.initialFilter)
  createEffect(on(preset, (f) => setFilter(f), { defer: true }))
  // The bought labels live here, alive under every filter: the filter bar counts (Ready to ship,
  // To pack, Packed) come from them whichever route opened the page.
  const ready = createReadyWorklist()
  const counts = createMemo(() => worklistFilterCounts(ready.all()))
  const count = (f: WorklistFilter): number | null =>
    f === "ready" || f === "to_pack" || f === "packed" ? counts()[f] : null
  const filterBar = (
    <div
      role="toolbar"
      aria-label="Filter the shipping worklist"
      data-testid="boxtal-worklist-filter"
      class="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2"
    >
      <For each={WORKLIST_FILTERS}>
        {(f) => (
          <button
            type="button"
            data-testid={`boxtal-worklist-filter-${f.id}`}
            aria-pressed={filter() === f.id}
            onClick={() => setFilter(f.id)}
            class={cx(
              "rounded-md px-2 py-1 text-[12px] transition-colors outline-none",
              "focus-visible:ring-2 focus-visible:ring-accent-tint",
              filter() === f.id ? "bg-surface-active text-text" : "text-text-secondary hover:bg-surface-hover",
            )}
          >
            {f.label}
            <Show when={count(f.id) != null}>
              <span class="ml-1 tabular-nums text-text-tertiary">{count(f.id)}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  )
  return (
    <div data-testid="boxtal-worklist" class="flex h-full min-h-0 flex-col">
      <ReadyUnpackDialog ready={ready} />
      <PrepGrid ready={ready} filter={filter()} filterBar={filterBar} onClearFilter={() => setFilter("all")} />
    </div>
  )
}

export const BoxtalQueue: Component<{ queueId?: string; entityId?: string }> = (props) => {
  const pathname = usePathname()
  const which = (): string => resolveQueueId(pathname(), props.entityId, props.queueId)
  const search = (): string => {
    const p = pathname() ?? ""
    const i = p.indexOf("?")
    return i >= 0 ? p.slice(i) : ""
  }
  return <ShippingWorklist initialFilter={worklistFilterForRoute(which(), search())} />
}
