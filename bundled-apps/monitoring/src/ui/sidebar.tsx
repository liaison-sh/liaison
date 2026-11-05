// SPDX-License-Identifier: FSL-1.1-ALv2
//
// MonitoringSidebar — per-app navigation rail, mounted by the kernel when a
// monitoring tab is active. Two sections: "Incidents" (Overview with the live
// count, Acknowledged, Resolved) and "Sources", one row per alert source in
// the configured order (hue square + monogram, label, count badge; urgent
// sources get a shield on an error-tinted square and a faint error wash; a
// quiet source shows a green check and a dimmed label). The "Sources" eyebrow
// carries a gear for admins (the app's settings page). The footer links to the
// configured detailed-monitoring page. Rows update live on incident changes.
import { app, currentPath, navigate } from "@liaison/host"
import { type Component, createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { IncidentsSummaryWithConfig } from "../lib/summarize"
import { tr } from "./i18n"
import { cx } from "./kit"
import { onMonitoringChange, SourceSquare, URGENT_WASH } from "./source-glyph"
import { rememberSourceLabels } from "./tab-labels"
import { badgeKind, buildSourceViews, decodeSourceId, type SourceView, sourcePath, statusPath } from "./sources"

// URL reactivity (same pattern as Boxtal/Invoicing sidebars — bundled plugins
// cannot import @solidjs/router; the kernel pushes via history.pushState and
// we monkey-patch once to fan a custom nav event).
const NAV_EVENT = "liaison:monitoring-sidebar:nav"
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

function usePathname() {
  const [path, setPath] = createSignal(currentPath().replace(/\?.*$/, ""))
  onMount(() => {
    installHistoryPatch()
    const onChange = () => setPath(currentPath().replace(/\?.*$/, ""))
    window.addEventListener("popstate", onChange)
    window.addEventListener(NAV_EVENT, onChange)
    onCleanup(() => {
      window.removeEventListener("popstate", onChange)
      window.removeEventListener(NAV_EVENT, onChange)
    })
  })
  return path
}

/** True when `path` is one of this app's routes. */
export function isMonitoringPath(path: string): boolean {
  return path === "/monitoring" || path.startsWith("/monitoring/")
}

/**
 * The route the active-row highlight reads. In the page, the window's own
 * path (it follows every navigation, including the dashboard's). When the
 * sidebar is drawn in its own frame, the window path is the frame's document
 * and names no monitoring route; the host gives a sidebar no route, so the
 * last row this sidebar navigated to stands in, and nothing is highlighted
 * before the first click.
 */
export function activeRoute(windowPath: string, lastNavigated: string | null): string | null {
  return isMonitoringPath(windowPath) ? windowPath : lastNavigated
}

/**
 * A sidebar row click. The row keeps its href (middle-click, open in a new
 * tab, screen readers), but a plain left click goes through the host
 * navigate: when the sidebar is drawn in its own frame, following the href
 * would load the path inside the frame instead of opening the tab.
 */
export function onRowClick(
  e: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented" | "preventDefault">,
  path: string,
  go: (path: string) => void,
): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  go(path)
}

const ROW =
  "relative flex items-center gap-[9px] rounded-md px-2.5 py-[5px] text-[12.5px] transition-colors"
const ROW_IDLE = "text-text-secondary hover:bg-surface-hover hover:text-text"
const ROW_ACTIVE = "bg-surface-active font-medium text-text"

const COUNT = "rounded px-1.5 py-px text-[10.5px] font-medium tabular-nums"
const COUNT_KIND = {
  critical: "bg-error text-white",
  warning: "bg-warning-glow text-warning",
  neutral: "bg-bg text-text-secondary",
} as const

const Eyebrow: Component<{ label: string; children?: unknown }> = (props) => (
  <div class="flex items-center justify-between pb-1 pl-3.5 pr-3 pt-3.5 text-[10.5px] uppercase tracking-[0.07em] text-text-tertiary">
    <span>{props.label}</span>
    {props.children as never}
  </div>
)

const NavIcon: Component<{ kind: "overview" | "ack" | "resolved" }> = (props) => (
  <span class="grid w-3.5 place-items-center text-text-tertiary" aria-hidden="true">
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <Show when={props.kind === "overview"}>
        <circle cx="8" cy="8" r="5.5" />
        <circle cx="8" cy="8" r="2" />
      </Show>
      <Show when={props.kind === "ack"}>
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 2.5v11" />
      </Show>
      <Show when={props.kind === "resolved"}>
        <path d="M3 8.5l3 3 7-7" />
      </Show>
    </svg>
  </span>
)

function NavRow(p: {
  href: string
  label: string
  slug: string
  active: boolean
  icon: "overview" | "ack" | "resolved"
  count?: number
  kind?: keyof typeof COUNT_KIND
  go: (path: string) => void
}) {
  return (
    <li>
      <a
        href={p.href}
        onClick={(e) => onRowClick(e, p.href, p.go)}
        data-testid={`monitoring-sidebar-link-${p.slug}`}
        aria-current={p.active ? "page" : undefined}
        class={cx(ROW, p.active ? ROW_ACTIVE : ROW_IDLE)}
      >
        <NavIcon kind={p.icon} />
        <span class="min-w-0 flex-1 truncate">{p.label}</span>
        <Show when={(p.count ?? 0) > 0}>
          <span data-testid={`monitoring-sidebar-badge-${p.slug}`} class={cx(COUNT, COUNT_KIND[p.kind ?? "neutral"])}>
            {p.count}
          </span>
        </Show>
      </a>
    </li>
  )
}

function SourceRow(p: { source: SourceView; active: boolean; go: (path: string) => void }) {
  const kind = () => badgeKind(p.source)
  const quiet = () => kind() === "clear"
  return (
    <li>
      <a
        href={sourcePath(p.source.source)}
        onClick={(e) => onRowClick(e, sourcePath(p.source.source), p.go)}
        title={p.source.label === p.source.source ? p.source.source : `${p.source.label} (${p.source.source})`}
        data-testid={`monitoring-sidebar-source-${p.source.source}`}
        data-urgent={p.source.urgent ? "true" : undefined}
        aria-current={p.active ? "page" : undefined}
        class={cx(
          ROW,
          p.active ? ROW_ACTIVE : ROW_IDLE,
          p.source.urgent && URGENT_WASH,
        )}
      >
        <SourceSquare source={p.source} size="sm" />
        <span class={cx("min-w-0 flex-1 truncate", quiet() && !p.active && "text-text-tertiary")}>{p.source.label}</span>
        <Show
          when={!quiet()}
          fallback={
            <span class="text-[11px] text-success" data-testid={`monitoring-sidebar-source-clear-${p.source.source}`} aria-label={tr("All clear")}>
              ✓
            </span>
          }
        >
          <span
            data-testid={`monitoring-sidebar-source-badge-${p.source.source}`}
            data-kind={kind()}
            class={cx(COUNT, COUNT_KIND[kind() === "clear" ? "neutral" : (kind() as keyof typeof COUNT_KIND)])}
          >
            {p.source.live}
          </span>
        </Show>
      </a>
    </li>
  )
}

export const MonitoringSidebar: Component = () => {
  const windowPath = usePathname()
  const [lastNavigated, setLastNavigated] = createSignal<string | null>(null)
  const go = (path: string) => {
    setLastNavigated(path)
    navigate(path)
  }
  const pathname = () => activeRoute(windowPath(), lastNavigated()) ?? ""

  const [summary, { refetch }] = createResource<IncidentsSummaryWithConfig | undefined>(async () => {
    try {
      const res = await app.invokeTool<{ data: IncidentsSummaryWithConfig }>("incidents_summary", {})
      return res?.data
    } catch (err) {
      // Badges degrade to empty; keep the failure diagnosable.
      console.error("monitoring sidebar: incidents_summary failed", err)
      return undefined
    }
  })
  onMonitoringChange(() => void refetch())

  const sources = createMemo(() => {
    const s = summary.latest
    const views = s ? buildSourceViews(s) : []
    rememberSourceLabels(views)
    return views
  })
  const critical = () => (summary.latest?.open.critical ?? 0) > 0
  const activeSource = createMemo(() => {
    const m = /^\/monitoring\/source\/([^/]+)/.exec(pathname())
    return m?.[1] ? decodeSourceId(m[1]) : null
  })

  return (
    <nav data-testid="monitoring-sidebar" class="flex h-full min-h-0 flex-col">
      <div class="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        <span
          class={cx("h-1.5 w-1.5 rounded-full", critical() ? "animate-pulse bg-error" : "bg-success")}
          aria-hidden="true"
        />
        <span class="text-[12.5px] font-semibold text-text">{tr("Monitoring")}</span>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto pb-2">
        <Eyebrow label={tr("Incidents")} />
        <ul class="flex flex-col gap-px px-2">
          <NavRow
            href="/monitoring"
            label={tr("Overview")}
            slug="dashboard"
            icon="overview"
            go={go}
            active={pathname() === "/monitoring" || pathname() === "/monitoring/"}
            count={summary.latest?.open.total}
            kind={critical() ? "critical" : (summary.latest?.open.warning ?? 0) > 0 ? "warning" : "neutral"}
          />
          <NavRow
            href={statusPath("acknowledged")}
            label={tr("Acknowledged")}
            slug="acknowledged"
            icon="ack"
            go={go}
            active={pathname() === statusPath("acknowledged")}
            count={summary.latest?.acknowledged}
          />
          <NavRow
            href={statusPath("resolved")}
            label={tr("Resolved")}
            slug="resolved"
            icon="resolved"
            go={go}
            active={pathname() === statusPath("resolved")}
          />
        </ul>

        <Eyebrow label={tr("Sources")}>
          <Show when={summary.latest?.canConfigure}>
            <button
              type="button"
              data-testid="monitoring-sources-settings-open"
              title={tr("Manage sources")}
              aria-label={tr("Manage sources")}
              onClick={() => navigate("/settings/apps/monitoring")}
              class="grid h-5 w-5 place-items-center rounded text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
              </svg>
            </button>
          </Show>
        </Eyebrow>
        <Show
          when={sources().length > 0}
          fallback={
            <p class="px-3.5 py-1 text-[11.5px] text-text-tertiary" data-testid="monitoring-sidebar-sources-empty">
              {summary.loading && !summary.latest ? "" : tr("No source yet")}
            </p>
          }
        >
          <ul class="flex flex-col gap-px px-2" data-testid="monitoring-sidebar-sources">
            <For each={sources()}>{(s) => <SourceRow source={s} active={activeSource() === s.source} go={go} />}</For>
          </ul>
        </Show>
      </div>

      <Show when={summary.latest?.monitoringUrl}>
        {(url) => (
          <div class="border-t border-border-subtle p-2">
            <a
              href={url()}
              target="_blank"
              rel="noopener"
              data-testid="monitoring-sidebar-detailed-link"
              class={cx(ROW, ROW_IDLE)}
            >
              <span class="grid w-3.5 place-items-center text-text-tertiary" aria-hidden="true">↗</span>
              <span class="min-w-0 flex-1 truncate">{tr("Detailed monitoring")}</span>
            </a>
          </div>
        )}
      </Show>

    </nav>
  )
}
