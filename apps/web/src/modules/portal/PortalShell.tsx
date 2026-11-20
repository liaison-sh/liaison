// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The portal's frame: the org's name, a nav with only the pages that hold
// something shared, the person, and a footer with the org's notice and "Portal by
// Liaison". No dock, agent, tab, search, socket or notification: a client talks
// to people through requests, never to an agent.

import { type Component, For, type JSX, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { Branding } from "./portal-api"
import type { PortalDocument, PortalHome } from "./types"

export interface NavItem {
  id: "home" | "invoices" | "requests"
  path: string
}

/** The pages with something to show: a page with nothing shared has no nav item. */
export function navItems(home: PortalHome | null, _documents: PortalDocument[] | null): NavItem[] {
  const items: NavItem[] = [{ id: "home", path: "" }]
  if (!home) return items
  if ((home.invoices?.length ?? 0) > 0 || (home.upcoming?.length ?? 0) > 0) {
    items.push({ id: "invoices", path: "invoices" })
  }
  if (home.requestsOpen || (home.requests?.length ?? 0) > 0) {
    items.push({ id: "requests", path: "requests" })
  }
  return items
}

export const PortalShell: Component<{
  branding: Branding | null
  home: PortalHome | null
  documents: PortalDocument[] | null
  current: string
  go: (path: string) => void
  onSignOut: () => void
  children: JSX.Element
}> = (props) => {
  const i18n = useI18n()
  return (
    <div data-testid="portal-shell" class="flex min-h-screen flex-col bg-bg text-text">
      <header class="border-b border-border bg-surface">
        <div class="mx-auto flex w-full max-w-[880px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <p data-testid="portal-org" class="text-[15px] font-semibold">
            {props.branding?.name ?? i18n.t("portal.shell.fallbackOrg")}
          </p>
          <nav data-testid="portal-nav" class="flex flex-1 flex-wrap gap-1">
            <For each={navItems(props.home, props.documents)}>
              {(item) => (
                <button
                  type="button"
                  data-testid={`portal-nav-${item.id}`}
                  aria-current={props.current === item.path ? "page" : undefined}
                  class={
                    props.current === item.path
                      ? "rounded-md bg-surface-hover px-3 py-1.5 text-[13.5px] font-medium text-text"
                      : "rounded-md px-3 py-1.5 text-[13.5px] text-text-secondary hover:bg-surface-hover"
                  }
                  onClick={() => props.go(item.path)}
                >
                  {i18n.t(`portal.nav.${item.id}`)}
                </button>
              )}
            </For>
          </nav>
          <div class="flex items-center gap-3 text-[13px] text-text-secondary">
            <Show when={props.home?.me?.name}>
              {(n) => <span data-testid="portal-person">{n()}</span>}
            </Show>
            <button
              type="button"
              data-testid="portal-sign-out"
              class="rounded-md px-2 py-1 hover:bg-surface-hover"
              onClick={() => props.onSignOut()}
            >
              {i18n.t("portal.shell.signOut")}
            </button>
          </div>
        </div>
      </header>
      <main class="mx-auto w-full max-w-[880px] flex-1 px-4 py-6">{props.children}</main>
      <footer class="border-t border-border">
        <div class="mx-auto flex w-full max-w-[880px] flex-col gap-2 px-4 py-4 text-[12px] text-text-tertiary">
          <Show when={props.branding?.notice}>
            {(n) => (
              <p data-testid="portal-notice" class="whitespace-pre-line">
                {n()}
              </p>
            )}
          </Show>
          <p data-testid="portal-by">{i18n.t("portal.shell.by")}</p>
        </div>
      </footer>
    </div>
  )
}
