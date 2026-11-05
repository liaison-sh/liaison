// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SocialSidebar — per-app navigation rail. Mounts in the kernel sidebar shell
// when any Social-owned tab is active (declared on every
// `views.tabTypes.<type>.sidebar`). Sections: Inbox (Findings + new badge,
// Awaiting approval badge), Messages (open DMs badge), Watched, Admin (Settings).
// Badge counts load from the app's own `counts` tool on mount + nav events.
import { createEffect, createSignal, onCleanup, onMount, Show, type Component, type JSX } from "solid-js"
import { app, currentPath } from "@liaison/host"

const NAV_EVENT = "liaison:social-sidebar:nav"
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

type Counts = { findings_new: number; awaiting_approval: number; open_dms: number }

async function loadCounts(): Promise<Counts> {
  try {
    const res = await app.invokeTool<Partial<Counts>>("counts", {})
    return {
      findings_new: res?.findings_new ?? 0,
      awaiting_approval: res?.awaiting_approval ?? 0,
      open_dms: res?.open_dms ?? 0,
    }
  } catch {
    return { findings_new: 0, awaiting_approval: 0, open_dms: 0 }
  }
}

function SectionHeader(p: { label: string }) {
  return (
    <div class="mt-3 flex items-center gap-2 px-3 pb-1 text-[10.5px] uppercase tracking-wider text-text-tertiary">
      <span>{p.label}</span>
    </div>
  )
}

function Row(p: { href: string; label: string; slug: string; pathname: string; badge?: number; warn?: boolean }): JSX.Element {
  const active = () => isActive(p.pathname, p.href)
  const showBadge = () => typeof p.badge === "number" && p.badge > 0
  return (
    <li>
      <a
        href={p.href}
        data-testid={`social-sidebar-link-${p.slug}`}
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
            data-testid={`social-sidebar-badge-${p.slug}`}
            class={`rounded px-1.5 py-0.5 text-[10.5px] font-medium ${
              p.warn ? "bg-warning-glow text-warning" : "bg-surface text-text-secondary"
            }`}
          >
            {p.badge}
          </span>
        </Show>
      </a>
    </li>
  )
}

export const SocialSidebar: Component = () => {
  const pathname = usePathname()
  const [findingsNew, setFindingsNew] = createSignal(0)
  const [awaiting, setAwaiting] = createSignal(0)
  const [openDms, setOpenDms] = createSignal(0)

  const refresh = async () => {
    const c = await loadCounts()
    setFindingsNew(c.findings_new)
    setAwaiting(c.awaiting_approval)
    setOpenDms(c.open_dms)
  }
  onMount(() => {
    void refresh()
    const onNav = () => void refresh()
    window.addEventListener(NAV_EVENT, onNav)
    onCleanup(() => window.removeEventListener(NAV_EVENT, onNav))
  })
  createEffect(() => {
    void pathname()
  })

  return (
    <nav data-testid="social-sidebar" class="flex h-full min-h-0 flex-col">
      <div class="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          <span class="text-[12.5px] font-semibold text-text">Social</span>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto px-2 pb-3">
        <SectionHeader label="Inbox" />
        <ul class="flex flex-col gap-0.5">
          <Row href="/social/findings" label="Findings" slug="findings" pathname={pathname()} badge={findingsNew()} warn={findingsNew() > 0} />
          <Row href="/social/findings?status=awaiting_approval" label="Awaiting approval" slug="awaiting" pathname={pathname()} badge={awaiting()} warn={awaiting() > 0} />
        </ul>

        <SectionHeader label="Messages" />
        <ul class="flex flex-col gap-0.5">
          <Row href="/social/messages" label="Messages" slug="messages" pathname={pathname()} badge={openDms()} />
        </ul>

        <SectionHeader label="Monitoring" />
        <ul class="flex flex-col gap-0.5">
          <Row href="/social/watched" label="Watched" slug="watched" pathname={pathname()} />
        </ul>

        <SectionHeader label="Admin" />
        <ul class="flex flex-col gap-0.5">
          <Row href="/settings/apps/social" label="Settings" slug="settings" pathname={pathname()} />
        </ul>
      </div>

      <div class="mt-auto border-t border-border-subtle px-4 py-2">
        <div class="flex items-center justify-between text-[10.5px] text-text-tertiary">
          <span>Social v0.1</span>
          <span class="h-1.5 w-1.5 rounded-full bg-success" data-testid="social-sidebar-status-dot" aria-hidden="true" />
        </div>
      </div>
    </nav>
  )
}
