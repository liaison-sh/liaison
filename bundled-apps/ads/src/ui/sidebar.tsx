// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal, onCleanup, onMount, Show, type Component, type JSX } from "solid-js"
import { app, currentPath } from "@liaison/host"
import { APP_VERSION_LABEL } from "./ui-logic"

// Shared global history patch guard — prevents social + meta-ads double-wrapping pushState.
declare global {
  interface Window {
    __liaisonHistoryPatched?: boolean
  }
}

const NAV_EVENT = "liaison:ads-sidebar:nav"

function installHistoryPatch(): void {
  if (window.__liaisonHistoryPatched) return
  window.__liaisonHistoryPatched = true
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

function isActive(pathname: string, href: string): boolean {
  const qi = pathname.indexOf("?")
  const bare = qi === -1 ? pathname : pathname.slice(0, qi)
  return bare === href || bare.startsWith(`${href}/`)
}

function SectionHeader(p: { label: string }): JSX.Element {
  return (
    <div class="mt-3 flex items-center gap-2 px-3 pb-1 text-[10.5px] uppercase tracking-wider text-text-tertiary">
      <span>{p.label}</span>
    </div>
  )
}

function Row(p: { href: string; label: string; slug: string; pathname: string; badge?: number }): JSX.Element {
  const active = () => isActive(p.pathname, p.href)
  const showBadge = () => typeof p.badge === "number" && p.badge > 0
  return (
    <li>
      <a
        href={p.href}
        data-testid={`ads-sidebar-link-${p.slug}`}
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
            data-testid="ads-sidebar-counts"
            class="rounded px-1.5 py-0.5 text-[10.5px] font-medium bg-surface text-text-secondary"
          >
            {p.badge}
          </span>
        </Show>
      </a>
    </li>
  )
}

type MetaCounts = { active: number; paused: number; total: number }

let lastCountsFetch = 0
const COUNT_THROTTLE_MS = 5_000

async function loadCounts(): Promise<MetaCounts | null> {
  if (Date.now() - lastCountsFetch < COUNT_THROTTLE_MS) return null
  lastCountsFetch = Date.now()
  try {
    return await app.invokeTool<MetaCounts>("counts", {})
  } catch {
    return null
  }
}

export const MetaAdsSidebar: Component = () => {
  const pathname = usePathname()
  const [total, setTotal] = createSignal<number | undefined>(undefined)

  const refresh = async () => {
    const c = await loadCounts()
    if (c !== null) setTotal(c.total)
  }

  onMount(() => {
    void refresh()
    const onNav = () => void refresh()
    window.addEventListener(NAV_EVENT, onNav)
    // Also refresh on back/forward (popstate) so the counts badge updates
    // when the user navigates with browser history buttons. meta-ads only —
    // we do NOT touch social's sidebar.
    window.addEventListener("popstate", onNav)
    onCleanup(() => {
      window.removeEventListener(NAV_EVENT, onNav)
      window.removeEventListener("popstate", onNav)
    })
  })

  return (
    <nav data-testid="ads-sidebar" class="flex h-full min-h-0 flex-col">
      <div class="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          <span class="text-[12.5px] font-semibold text-text">Ads</span>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto px-2 pb-3">
        <ul class="flex flex-col gap-0.5">
          <Row href="/ads/dashboard" label="Dashboard" slug="dashboard" pathname={pathname()} />
          <Row href="/ads/guide" label="Guide" slug="guide" pathname={pathname()} />
        </ul>

        <SectionHeader label="Campaigns" />
        <ul class="flex flex-col gap-0.5">
          <Row href="/ads/campaigns" label="Campaigns" slug="campaigns" pathname={pathname()} badge={total()} />
        </ul>

        <SectionHeader label="Creatives" />
        <ul class="flex flex-col gap-0.5">
          <Row href="/ads/ads" label="Ads" slug="ads" pathname={pathname()} />
        </ul>

        <SectionHeader label="Audiences" />
        <ul class="flex flex-col gap-0.5">
          <Row href="/ads/audiences" label="Audiences" slug="audiences" pathname={pathname()} />
        </ul>

      </div>

      <div class="mt-auto border-t border-border-subtle px-4 py-2">
        <div class="flex items-center justify-between text-[10.5px] text-text-tertiary">
          <span data-testid="ads-sidebar-version">{APP_VERSION_LABEL}</span>
          <span class="h-1.5 w-1.5 rounded-full bg-success" data-testid="ads-sidebar-status-dot" aria-hidden="true" />
        </div>
      </div>
    </nav>
  )
}
