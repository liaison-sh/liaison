// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AgreementsSidebar: the app's rail, mounted by the kernel beside any agreements tab.
// "New agreement" on top, then Documents (all, then one row per kind that has any) and
// Follow up (waiting on a signature, ending or renewing soon), each with its count.
import { app, currentPath } from "@liaison/host"
import { type Component, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { go, paths } from "./host"
import { tr } from "./i18n"
import { type AgreementBrief, KIND_GROUPS, sidebarCounts } from "./model"

const NAV_EVENT = "liaison:agreements-sidebar:nav"
let patched = false
function installHistoryPatch(): void {
  if (patched) return
  patched = true
  const w = window as any
  for (const name of ["pushState", "replaceState"]) {
    const orig = w.history[name].bind(w.history)
    w.history[name] = (...args: unknown[]) => {
      const r = orig(...args)
      w.dispatchEvent(new Event(NAV_EVENT))
      return r
    }
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

const ROW = "flex items-center gap-2 rounded-md px-2.5 py-[5px] text-[12.5px] transition-colors"
const IDLE = "text-text-secondary hover:bg-surface-hover hover:text-text"
const ACTIVE = "bg-surface-active font-medium text-text"

function Row(p: { slug: string; label: string; count?: number; active: boolean }) {
  const href = () => paths.list(p.slug)
  return (
    <li>
      <a
        href={href()}
        data-testid={`agreements-sidebar-${p.slug}`}
        aria-current={p.active ? "page" : undefined}
        class={`${ROW} ${p.active ? ACTIVE : IDLE}`}
        onClick={(e) => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
          e.preventDefault()
          go(href())
        }}
      >
        <span class="min-w-0 flex-1 truncate">{p.label}</span>
        <Show when={(p.count ?? 0) > 0}>
          <span class="rounded bg-bg px-1.5 py-px text-[10.5px] tabular-nums text-text-secondary">
            {p.count}
          </span>
        </Show>
      </a>
    </li>
  )
}

const Eyebrow: Component<{ label: string }> = (props) => (
  <div class="px-3.5 pb-1 pt-3.5 text-[10.5px] uppercase tracking-[0.07em] text-text-tertiary">
    {props.label}
  </div>
)

export const AgreementsSidebar: Component = () => {
  const path = usePathname()
  const [rows] = app.createResource<AgreementBrief[]>(async () => {
    try {
      const out = await app.invokeTool<{ items?: AgreementBrief[] }>("home_load", {})
      return out?.items ?? []
    } catch {
      return []
    }
  })
  const counts = () => sidebarCounts(rows() ?? [], new Date().toISOString().slice(0, 10))
  const active = (slug: string) => {
    const p = path()
    return slug === "all" ? p === "/agreements" || p === "/agreements/" : p === paths.list(slug)
  }
  return (
    <nav data-testid="agreements-sidebar" class="flex h-full min-h-0 flex-col">
      <div class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <span class="text-[12.5px] font-semibold text-text">{tr("Agreements")}</span>
        <button
          type="button"
          data-testid="agreements-sidebar-new"
          class="rounded-md px-2 py-0.5 text-[12px] text-text-secondary hover:bg-surface-hover hover:text-text"
          onClick={() => go(paths.create())}
        >
          {tr("+ New agreement")}
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto pb-2">
        <Eyebrow label={tr("Documents")} />
        <ul class="flex flex-col gap-px px-2">
          <Row slug="all" label={tr("All")} count={counts().all} active={active("all")} />
          <For each={KIND_GROUPS.filter((g) => (counts()[g.slug] ?? 0) > 0)}>
            {(g) => (
              <Row
                slug={g.slug}
                label={tr(g.label)}
                count={counts()[g.slug]}
                active={active(g.slug)}
              />
            )}
          </For>
        </ul>
        <Eyebrow label={tr("Follow up")} />
        <ul class="flex flex-col gap-px px-2">
          <Row
            slug="waiting"
            label={tr("Waiting on a signature")}
            count={counts().waiting}
            active={active("waiting")}
          />
          <Row
            slug="ending"
            label={tr("Ending or renewing soon")}
            count={counts().ending}
            active={active("ending")}
          />
        </ul>
      </div>
    </nav>
  )
}
