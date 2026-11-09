// SPDX-License-Identifier: FSL-1.1-ALv2
//
// BoxtalSidebar — per-app navigation rail for the Boxtal bundled app.
// Mounts inside the kernel's sidebar shell when any Boxtal-owned tab is active
// (declared on every `views.tabTypes.<type>.sidebar` entry of the manifest).
//
// Structure mirrors InvoicingSidebar exactly:
//   ─── Shipments ─── (Shipping worklist [badge], In transit, Delivered, All
//        shipments) — the one worklist (To prepare and Ready to ship together,
//        filtered on the page) + the full list.
//   ─── Returns ─── (Returns [badge]) — inbound parcels needing handling.
//   ─── Catalog ─── (Packages & products) — the box/product reference data.
//   ─── Admin ─── (Settings)
//
// The top CTA is a "Refresh" primary button (re-pulls the queue counts — the
// to-prepare queue itself is computed live from the invoicing app on read).
//
// Badge data source. Counts load once on mount from the app's own
// `queue_counts` tool → { to_prepare, ready, returns }. The to-prepare badge
// carries a warning tone when > 0 so an operator notices the backlog at a
// glance. All counts fall back to 0 on any error (try/catch).
//
// Design language mirrors InvoicingSidebar: small uppercase eyebrow, column of
// section links with a 2px accent rail on the active row, 14px stroked SVG
// icons inline (no lucide dep). Styles only with kernel theme tokens.
import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  Show,
  type Component,
  type JSX,
} from "solid-js"
import { app, currentPath } from "@liaison/host"
import { Button } from "./kit"

// ─────────────────────────────────────────────────────────────────────────
// URL reactivity (same pattern as InvoicingSidebar — bundled plugins cannot
// import `@solidjs/router`; the kernel pushes via history.pushState and we
// monkey-patch once to fan a custom nav event).
// ─────────────────────────────────────────────────────────────────────────
const NAV_EVENT = "liaison:boxtal-sidebar:nav"
let patched = false
function installHistoryPatch(): void {
  if (patched) return
  patched = true
  // biome-ignore lint/suspicious/noExplicitAny: window patching
  const w = window as any
  const origPush = w.history.pushState.bind(w.history)
  const origReplace = w.history.replaceState.bind(w.history)
  w.history.pushState = (...args: unknown[]) => {
    const r = origPush(...args)
    w.dispatchEvent(new Event(NAV_EVENT))
    return r
  }
  w.history.replaceState = (...args: unknown[]) => {
    const r = origReplace(...args)
    w.dispatchEvent(new Event(NAV_EVENT))
    return r
  }
}

export function usePathname() {
  const [path, setPath] = createSignal(currentPath())
  onMount(() => {
    installHistoryPatch()
    const onChange = () => setPath(currentPath())
    window.addEventListener("popstate", onChange)
    window.addEventListener(NAV_EVENT, onChange)
    onCleanup(() => {
      window.removeEventListener("popstate", onChange)
      window.removeEventListener(NAV_EVENT, onChange)
    })
  })
  return path
}

// ─────────────────────────────────────────────────────────────────────────
// Inline icons — 14px box, stroke 1.5, currentColor. Matches the kernel's
// lucide icon visual weight without adding a runtime dep to the bundle.
// ─────────────────────────────────────────────────────────────────────────
type IconProps = { class?: string }
const baseSvg = "h-3.5 w-3.5 shrink-0"

function TruckIcon(p: IconProps) {
  return (
    <svg class={`${baseSvg} ${p.class ?? ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M1 3h13v13H1z" />
      <path d="M14 8h4l3 3v5h-7z" />
      <circle cx="5.5" cy="18.5" r="1.5" />
      <circle cx="17.5" cy="18.5" r="1.5" />
    </svg>
  )
}

function ReturnIcon(p: IconProps) {
  return (
    <svg class={`${baseSvg} ${p.class ?? ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 6 6v2" />
    </svg>
  )
}

function BoxIcon(p: IconProps) {
  return (
    <svg class={`${baseSvg} ${p.class ?? ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 8l-9-5-9 5 9 5 9-5z" />
      <path d="M3 8v8l9 5 9-5V8" />
      <path d="M12 13v8" />
    </svg>
  )
}

function GearIcon(p: IconProps) {
  return (
    <svg class={`${baseSvg} ${p.class ?? ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01A1.65 1.65 0 0 0 9 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Nav rows.
// ─────────────────────────────────────────────────────────────────────────
interface NavLink {
  href: string
  label: string
  slug: string
}

// Active-row detection. A link is active when the pathname matches exactly,
// is a sub-path, or — for query-scoped links — when the full path+search
// starts with the href (so /boxtal/shipments?status=in-transit lights up
// without also lighting "All shipments").
/** The one shipping worklist's href. The retired /boxtal/queue/to-prepare and /boxtal/queue/ready
 *  routes still open it with a filter preset (worklist-logic.ts worklistFilterForRoute). */
export const WORKLIST_HREF = "/boxtal/queue/worklist"

/** The worklist row is the active one on every queue route, retired ones included. */
export function isWorklistActive(pathname: string): boolean {
  const bare = pathname.split("?")[0] ?? ""
  return bare === "/boxtal/queue" || bare.startsWith("/boxtal/queue/")
}

export function isActive(pathname: string, href: string): boolean {
  if (href.includes("?")) return pathname === href || pathname.startsWith(href)
  // Bare path links must NOT match when a query string is present — the query
  // belongs to a sibling query-scoped link ("All shipments" was lighting up
  // together with "Delivered" on /boxtal/shipments?status=delivered).
  const qi = pathname.indexOf("?")
  const bare = qi === -1 ? pathname : pathname.slice(0, qi)
  if (bare === href) return qi === -1
  return bare.startsWith(`${href}/`)
}

// ─────────────────────────────────────────────────────────────────────────
// Counts loader. Pulls the three queue badge counts from the app's own
// `queue_counts` tool. Falls back to all-zero on any error.
// ─────────────────────────────────────────────────────────────────────────
type QueueCounts = { to_prepare: number; ready: number; returns: number }

async function loadCounts(): Promise<QueueCounts> {
  try {
    const res = await app.invokeTool<Partial<QueueCounts>>("queue_counts", {})
    return {
      to_prepare: res?.to_prepare ?? 0,
      ready: res?.ready ?? 0,
      returns: res?.returns ?? 0,
    }
  } catch (err) {
    // Badges degrade to zero (a sidebar can't render an error panel), but the
    // failure must stay diagnosable — log it instead of silently zeroing.
    console.error("boxtal sidebar: queue_counts failed", err)
    return { to_prepare: 0, ready: 0, returns: 0 }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Badge refresh coalescing. Opening the page fires a BURST of pushState /
// replaceState calls (tab open, url pattern, filter/selection state), and
// installHistoryPatch dispatches NAV_EVENT on every one of them. Naively
// re-fetching queue_counts per event deadlocked the sandbox pool in prod
// (5 concurrent queue_counts calls, 22ms apart, twice per five page opens).
// This controller collapses a burst into at most one backend call:
//   - route gate: the badges are org-wide, so a replaceState that only
//     changes filter/selection state (same pathname) triggers nothing
//   - burst debounce: nav events arriving within debounceMs coalesce
//   - single flight: never two fetches at once; a refresh requested while
//     one is in flight is coalesced into ONE trailing refresh once it lands
// Exported (and scheduler-injectable) so tests can drive it with a manual
// clock instead of real timers — see sidebar.test.tsx.
export interface NavRefreshController {
  /** Immediate, ungated fetch — the initial mount load. */
  fetchNow: () => void
  /** Debounced, route-gated, single-flight-coalesced nav-triggered fetch. */
  notify: () => void
  dispose: () => void
}

export function createNavRefreshController(opts: {
  fetch: () => Promise<void>
  getPathname: () => string
  debounceMs?: number
  schedule?: (cb: () => void, ms: number) => number
  cancel?: (id: number) => void
}): NavRefreshController {
  const debounceMs = opts.debounceMs ?? 250
  const schedule = opts.schedule ?? ((cb, ms) => setTimeout(cb, ms) as unknown as number)
  const cancel = opts.cancel ?? ((id: number) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>))

  let lastFetchedPathname: string | null = null
  let inFlight = false
  let trailingRequested = false
  let debounceTimer: number | undefined
  let disposed = false

  // Single flight: any notify()/fetchNow() that lands while a fetch is
  // already in progress just flags trailingRequested and returns. The
  // in-progress call's own loop below runs ONE extra pass once it settles,
  // coalescing any number of requests that arrived mid-flight.
  const runFetch = async () => {
    if (inFlight) {
      trailingRequested = true
      return
    }
    inFlight = true
    try {
      do {
        trailingRequested = false
        await opts.fetch()
      } while (trailingRequested && !disposed)
    } finally {
      // Release the flight slot even if the fetch rejects. Without this a single
      // rejection would wedge the controller closed and the badges would never
      // refresh again for the life of the tab.
      inFlight = false
    }
  }

  return {
    fetchNow: () => {
      lastFetchedPathname = opts.getPathname()
      void runFetch()
    },
    notify: () => {
      if (disposed) return
      if (debounceTimer !== undefined) cancel(debounceTimer)
      debounceTimer = schedule(() => {
        debounceTimer = undefined
        if (disposed) return
        const current = opts.getPathname()
        if (current === lastFetchedPathname) return // filter/selection-only churn, no new counts
        lastFetchedPathname = current
        void runFetch()
      }, debounceMs)
    },
    dispose: () => {
      disposed = true
      if (debounceTimer !== undefined) cancel(debounceTimer)
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Refresh CTA — top primary button. The to-prepare queue is COMPUTED live
// from the invoicing app on every read (there is no sync job to trigger —
// the previous "Sync invoices" label invoked a `sync_invoices` tool that
// never existed and silently failed). Refresh re-pulls the queue counts.
// ─────────────────────────────────────────────────────────────────────────
function SyncCta() {
  const [busy, setBusy] = createSignal(false)
  const onRefresh = () => {
    if (busy()) return
    setBusy(true)
    // NAV_EVENT drives the badge reload (see BoxtalSidebar.onMount).
    window.dispatchEvent(new Event(NAV_EVENT))
    setBusy(false)
  }
  return (
    <Button
      variant="primary"
      testid="boxtal-sidebar-sync"
      disabled={busy()}
      onClick={onRefresh}
      class="px-2.5 py-1 text-[12px]"
    >
      Refresh
    </Button>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Section header — small uppercase eyebrow above each block.
// ─────────────────────────────────────────────────────────────────────────
function SectionHeader(p: { label: string; icon?: (ip: IconProps) => JSX.Element }) {
  return (
    <div class="mt-3 flex items-center gap-2 px-3 pb-1 text-[10.5px] uppercase tracking-wider text-text-tertiary">
      {p.icon ? <p.icon /> : null}
      <span>{p.label}</span>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Row — single nav link. Active rows carry a 2px accent rail. An optional
// badge sits on the right; a `warn` flag tints it warning (used by the
// to-prepare backlog).
// ─────────────────────────────────────────────────────────────────────────
function Row(p: {
  href: string
  label: string
  slug: string
  pathname: string
  badge?: number
  warn?: boolean
  /** Overrides the href match (the worklist row lights on every queue route). */
  isActive?: (pathname: string) => boolean
}) {
  const active = () => (p.isActive ?? ((path: string) => isActive(path, p.href)))(p.pathname)
  const showBadge = () => typeof p.badge === "number" && p.badge > 0
  return (
    <li>
      <a
        href={p.href}
        data-testid={`boxtal-sidebar-link-${p.slug}`}
        aria-current={active() ? "page" : undefined}
        class={`flex items-center gap-2 rounded-md px-3 py-1 text-[12.5px] transition-colors ${
          active()
            ? "bg-surface-active font-medium text-text"
            : "text-text-secondary hover:bg-surface-hover hover:text-text"
        }`}
      >
        <span class="flex-1 truncate">{p.label}</span>
        <Show when={showBadge()}>
          <span
            data-testid={`boxtal-sidebar-badge-${p.slug}`}
            class={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${
              p.warn
                ? "bg-warning-glow text-warning"
                : "bg-surface text-text-secondary"
            }`}
          >
            {p.badge}
          </span>
        </Show>
      </a>
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// BoxtalSidebar — exposed via every Boxtal tabType's `sidebar` field in
// app.manifest.json#views.tabTypes.
// ─────────────────────────────────────────────────────────────────────────
export const BoxtalSidebar: Component = () => {
  const pathname = usePathname()
  const [toPrepareCount, setToPrepareCount] = createSignal(0)
  const [readyCount, setReadyCount] = createSignal(0)
  const [returnsCount, setReturnsCount] = createSignal(0)

  // Initial fetch + re-fetch on nav events (badges should reflect the
  // freshest count when the user switches tabs or runs a sync).
  const refresh = async () => {
    const c = await loadCounts()
    setToPrepareCount(c.to_prepare)
    setReadyCount(c.ready)
    setReturnsCount(c.returns)
  }
  onMount(() => {
    const controller = createNavRefreshController({
      fetch: refresh,
      getPathname: () => currentPath().replace(/\?.*$/, ""),
    })
    controller.fetchNow()
    const onNav = () => controller.notify()
    window.addEventListener(NAV_EVENT, onNav)
    onCleanup(() => {
      window.removeEventListener(NAV_EVENT, onNav)
      controller.dispose()
    })
  })

  // Track pathname re-renders for tests that drive history.pushState.
  createEffect(() => {
    void pathname()
  })

  return (
    <nav data-testid="boxtal-sidebar" class="flex h-full min-h-0 flex-col">
      {/* Eyebrow — app identity + Sync invoices CTA */}
      <div class="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          <span class="text-[12.5px] font-semibold text-text">Boxtal</span>
        </div>
        <SyncCta />
      </div>

      {/* Search */}
      <div class="border-b border-border-subtle px-3 py-2">
        <input
          type="search"
          placeholder="Search shipments…"
          data-testid="boxtal-sidebar-search"
          class="w-full rounded-md border border-border-subtle bg-surface px-2 py-1 text-[12.5px] text-text placeholder:text-text-tertiary focus:border-accent focus:outline-none"
        />
      </div>

      {/* Sections */}
      <div class="flex-1 overflow-y-auto px-2 pb-3">
        <SectionHeader label="Shipments" icon={TruckIcon} />
        <ul class="flex flex-col gap-0.5">
          {/* ONE row for the ONE shipping worklist (Queues.tsx): To prepare and Ready to ship are
              its filters, on the page, not two sidebar entries. Its badge is the work waiting in
              both, tinted while orders still need a label. */}
          <Row
            href={WORKLIST_HREF}
            label="Shipping worklist"
            slug="worklist"
            pathname={pathname()}
            isActive={isWorklistActive}
            badge={toPrepareCount() + readyCount()}
            warn={toPrepareCount() > 0}
          />
          <Row
            href="/boxtal/shipments?status=in-transit"
            label="In transit"
            slug="in-transit"
            pathname={pathname()}
          />
          <Row
            href="/boxtal/shipments?status=delivered"
            label="Delivered"
            slug="delivered"
            pathname={pathname()}
          />
          <Row
            href="/boxtal/shipments"
            label="All shipments"
            slug="all-shipments"
            pathname={pathname()}
          />
        </ul>

        <SectionHeader label="Returns" icon={ReturnIcon} />
        <ul class="flex flex-col gap-0.5">
          <Row
            href="/boxtal/returns"
            label="Returns"
            slug="returns"
            pathname={pathname()}
            badge={returnsCount()}
          />
        </ul>

        <SectionHeader label="Catalog" icon={BoxIcon} />
        <ul class="flex flex-col gap-0.5">
          <Row
            href="/boxtal/catalog"
            label="Packages & products"
            slug="catalog"
            pathname={pathname()}
          />
        </ul>

        <SectionHeader label="Admin" icon={GearIcon} />
        <ul class="flex flex-col gap-0.5">
          <Row
            href="/settings/apps/boxtal"
            label="Settings"
            slug="settings"
            pathname={pathname()}
          />
        </ul>
      </div>

      {/* Footer — discrete identity strip + connection status dot */}
      <div class="mt-auto border-t border-border-subtle px-4 py-2">
        <div class="flex items-center justify-between text-[10.5px] text-text-tertiary">
          <span class="flex items-center gap-1.5">
            <BoxIcon />
            <span>Boxtal v0.1</span>
          </span>
          <span
            class="h-1.5 w-1.5 rounded-full bg-success"
            data-testid="boxtal-sidebar-status-dot"
            aria-hidden="true"
          />
        </div>
      </div>
    </nav>
  )
}
