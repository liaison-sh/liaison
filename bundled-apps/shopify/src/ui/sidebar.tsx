// SPDX-License-Identifier: FSL-1.1-ALv2
//
// ShopifySidebar — per-app navigation rail. Mounts inside the kernel's
// sidebar shell when a Shopify-owned tab is active (declared on every
// `views.tabTypes.<type>.sidebar`).
//
// Design language: kernel-aligned Linear-style nav. A small uppercase eyebrow
// (the app name + status dot), then a column of 5 section links. Active
// section gets a 2px accent rail on the left + brighter text; idle sections
// stay text-secondary, hover lifts to text. Icons are inline 14px stroked
// SVGs — no extra dep, hand-tuned to match lucide's drawn-stroke aesthetic
// without pulling the full library into the bundle.
//
// The sidebar uses plain `<a href="...">` for navigation. The kernel's
// SolidJS Router intercepts clicks on internal anchors and does SPA nav —
// the URL→tab-store effect then opens / activates the right tab. We patch
// `history.pushState` / `replaceState` once at mount so the sidebar can
// react to programmatic navigation as well as browser back/forward.
import { currentPath } from "@liaison/host"
import { createSignal, onCleanup, onMount, type Component, type JSX } from "solid-js"
import { onOutsideLinkClick } from "./external-link"

// ─────────────────────────────────────────────────────────────────────────
// URL reactivity. Bundled plugins can't import `@solidjs/router` (the kernel
// owns it), but the router pushes state via `history.pushState`. We
// monkey-patch once to fan a custom event the sidebar can listen to.
// ─────────────────────────────────────────────────────────────────────────
const NAV_EVENT = "liaison:shopify-sidebar:nav"
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

// ─────────────────────────────────────────────────────────────────────────
// Inline icons. 14px box, stroke 1.5, currentColor — matches lucide
// visually without pulling the package into the bundle.
// ─────────────────────────────────────────────────────────────────────────
type IconProps = { class?: string }
const baseSvg = "h-3.5 w-3.5 shrink-0"

function HomeIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M3 10.5L12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V10.5z" />
    </svg>
  )
}

function ReceiptIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 3v18l2-1.5 2 1.5 2-1.5 2 1.5 2-1.5 2 1.5 2-1.5V3z" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  )
}

function UsersIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function PackageIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" />
    </svg>
  )
}

function GlobeIcon(p: IconProps) {
  return (
    <svg
      class={`${baseSvg} ${p.class ?? ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Nav rows. The active-row affordance is a 2px accent rail on the left
// edge (matches the kernel's ThreadItem active treatment) + brighter
// text. Icons stay sized + colored to the row's text color so they read
// as part of the label, not as decoration.
// ─────────────────────────────────────────────────────────────────────────
interface NavLink {
  href: string
  label: string
  icon: (p: IconProps) => JSX.Element
  /** Optional secondary path prefixes that should also activate this link. */
  alsoActiveOn?: string[]
}

const LINKS: NavLink[] = [
  { href: "/shopify", label: "Home", icon: HomeIcon },
  {
    href: "/shopify/orders",
    label: "Orders",
    icon: ReceiptIcon,
    alsoActiveOn: ["/detail/shopify/draftOrder", "/detail/shopify/return", "/detail/shopify/refund"],
  },
  {
    href: "/shopify/customers",
    label: "Customers",
    icon: UsersIcon,
    alsoActiveOn: ["/detail/shopify/customer"],
  },
  {
    href: "/shopify/products",
    label: "Products",
    icon: PackageIcon,
    alsoActiveOn: ["/detail/shopify/product"],
  },
  {
    href: "/shopify/markets",
    label: "Markets",
    icon: GlobeIcon,
    alsoActiveOn: ["/detail/shopify/market"],
  },
]

function isActive(pathname: string, link: NavLink): boolean {
  if (link.href === "/shopify") {
    // Home is active ONLY on the exact /shopify path so deep links inside
    // the app don't make every section read as Home.
    return pathname === "/shopify" || pathname === "/shopify/"
  }
  if (pathname === link.href || pathname.startsWith(`${link.href}/`)) return true
  if (link.alsoActiveOn) {
    for (const prefix of link.alsoActiveOn) {
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return true
    }
  }
  return false
}

// ─────────────────────────────────────────────────────────────────────────
// ShopifySidebar — exposed via every Shopify tabType's `sidebar` field.
// ─────────────────────────────────────────────────────────────────────────
export const ShopifySidebar: Component = () => {
  const pathname = usePathname()

  return (
    <nav data-testid="shopify-sidebar" class="flex h-full min-h-0 flex-col">
      {/* Eyebrow — app identity + status dot */}
      <div class="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
          <span class="text-[12.5px] font-semibold text-text">Shopify</span>
        </div>
      </div>

      {/* Section nav */}
      <ul class="flex flex-col gap-0.5 px-2 py-3">
        {LINKS.map((link) => {
          const active = () => isActive(pathname(), link)
          return (
            <li>
              <a
                href={link.href}
                data-testid={`shopify-sidebar-link-${link.label.toLowerCase()}`}
                aria-current={active() ? "page" : undefined}
                class={`group flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px] transition-colors ${
                  active()
                    ? "bg-surface-active font-medium text-text"
                    : "text-text-secondary hover:bg-surface-hover hover:text-text"
                }`}
              >
                <link.icon
                  class={
                    active() ? "text-text" : "text-text-tertiary group-hover:text-text-secondary"
                  }
                />
                <span class="flex-1">{link.label}</span>
              </a>
            </li>
          )
        })}
      </ul>

      {/* Footer — discreet "Open in Shopify" anchor at the bottom of the
          sidebar so the operator never feels trapped inside Liaison if the
          kernel can't yet expose a particular admin operation. */}
      <div class="mt-auto border-t border-border-subtle px-4 py-3">
        <a
          href="https://admin.shopify.com"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => onOutsideLinkClick(e, "https://admin.shopify.com")}
          data-testid="shopify-sidebar-external"
          class="flex items-center justify-between text-[11px] text-text-tertiary transition-colors hover:text-text-secondary"
        >
          <span>Shopify admin</span>
          <span aria-hidden="true">↗</span>
        </a>
      </div>
    </nav>
  )
}
