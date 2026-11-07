// SPDX-License-Identifier: FSL-1.1-ALv2
import { useLocation, useNavigate } from "@solidjs/router"
import { ChevronLeft } from "lucide-solid"
import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onMount,
  Show,
  Suspense,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  areManifestAppsSettled,
  getConnectorApps,
  getSettingsSections,
} from "~/framework/app-registry"
import { PluginMountBoundary } from "~/framework/PluginMountBoundary"
import { canAccessScope, userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { capLimitMessage } from "~/modules/settings/cap-limit-message"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { useTabIsActive } from "~/modules/shell/TabVisibilityContext"
import { addToast } from "~/modules/shell/toast-store"
import { ScrollFade } from "~/ui/ScrollFade"
import { orgAppsStore } from "./app-management/org-apps-store"
import { popSettingsSection, pushedSection } from "./phone-settings-nav"
import {
  aliasTargetPath,
  connectorSettingsPath,
  resolveSettingsAlias,
  withQuery,
} from "./settings-aliases"
import { SettingsPageActiveContext } from "./settings-page-active"
import { canAccessSettingsSection } from "./visible-settings-sections"
import { YouScreen } from "./YouScreen"
import { isAdminHref } from "./you-screen-model"

export { useSettingsPageActive } from "./settings-page-active"

/** The query keys an OAuth callback sends back when the provider refused. */
const OAUTH_ERROR_PARAMS = ["oauth_error", "oauth_error_description"] as const

function withoutOAuthError(search: string): string {
  const params = new URLSearchParams(search)
  for (const key of OAUTH_ERROR_PARAMS) params.delete(key)
  const q = params.toString()
  return q ? `?${q}` : ""
}

interface SettingsLayoutProps {
  entityId: string
}

// _props is intentionally unused — tab system passes entityId but settings uses URL-based routing internally
const SettingsLayout: Component<SettingsLayoutProps> = (_props) => {
  const i18n = useI18n()
  const location = useLocation()
  const navigate = useNavigate()

  // Apps admins: the workspace's apps, for the Apps rows of apps turned Off
  // (the manifests feed omits them) and the management controls.
  const api = useOptionalApi()
  onMount(() => {
    if (api && canAccessScope("kernel:apps:admin")) {
      void orgAppsStore.ensureLoaded(api).catch(() => {})
    }
  })

  const sections = createMemo(() => [...getSettingsSections()].sort((a, b) => a.order - b.order))

  const visibleSections = createMemo(() => sections().filter(canAccessSettingsSection))

  const fallbackSection = createMemo(
    () =>
      visibleSections().find((section) => section.group === "user") ??
      visibleSections().find((section) => section.group === "app") ??
      visibleSections()[0] ??
      null,
  )

  function sectionMatches(
    section: ReturnType<typeof getSettingsSections>[number],
    pathname: string,
  ): boolean {
    if (section.href === pathname) return true
    if (section.aliases?.includes(pathname)) return true
    if (section.preserveActiveOnSubpaths && pathname.startsWith(`${section.href}/`)) return true
    return false
  }

  // A connector has no app page: its card on Connectors is its page (S11), so
  // `/settings/apps/<connector>` (the App store's link, a bookmark) opens it there.
  function connectorAppOf(pathname: string): string | null {
    const match = /^\/settings\/apps\/([^/]+)\/?$/.exec(pathname)
    if (!match) return null
    const app = decodeURIComponent(match[1])
    if (getConnectorApps().some((c) => c.appId === app)) return app
    return orgAppsStore.app(app)?.kind === "connector" ? app : null
  }

  // A former path (settings-aliases.ts) is replaced by its new home, unless a
  // registered page still answers it: an app that has not moved to its
  // declarative page yet keeps its former pages.
  const aliasTarget = createMemo(() => {
    const pathname = location.pathname
    if (sections().some((s) => sectionMatches(s, pathname))) return null
    const search = withoutOAuthError(location.search)
    const connector = connectorAppOf(pathname)
    if (connector) return withQuery(connectorSettingsPath(connector), search)
    return resolveSettingsAlias(pathname, search)
  })

  /** The path the page is resolved against: the alias target, else the URL. */
  const effectivePath = createMemo(() => {
    const target = aliasTarget()
    return target ? aliasTargetPath(target) : location.pathname
  })

  // A path no registered section claims may belong to a manifest app whose
  // section registers after first paint (a deep link or reload on
  // /settings/<app>). Hold it, with no redirect and no no-access notice, until
  // the first manifest sync settles; redirecting earlier sends every app
  // settings deep link to Profile for good. An app turned Off is absent from
  // that feed: an apps admin's row for it comes from the workspace's app list,
  // so for them the path is held until that list's first load finished too.
  const awaitingAppSection = createMemo(() => {
    if (sections().some((s) => sectionMatches(s, effectivePath()))) return false
    if (!areManifestAppsSettled()) return true
    if (!canAccessScope("kernel:apps:admin")) return false
    if (!orgAppsStore.settled()) return true
    // An app just turned Off: the feed dropped its page before its Off row
    // registered. The workspace still has it, so its row is on its way.
    const app = /^\/settings\/apps\/([^/]+)/.exec(effectivePath())?.[1]
    const orgApp = app ? orgAppsStore.app(decodeURIComponent(app)) : undefined
    return !!orgApp && orgApp.status !== "removed" && orgApp.kind !== "connector"
  })

  const activeHref = createMemo(() => {
    const path = effectivePath()
    // Prefer the most specific match: try sub-path-aware sections first.
    const exact = sections().find((s) => s.href === path)
    if (exact && canAccessSettingsSection(exact)) return exact.href
    // A former path of a section is that section; the redirect below then
    // replaces the URL with its current one.
    const renamed = sections().find((s) => s.aliases?.includes(path))
    if (renamed && canAccessSettingsSection(renamed)) return renamed.href
    const sub = sections()
      .filter((s) => s.preserveActiveOnSubpaths)
      .sort((a, b) => b.href.length - a.href.length)
      .find((s) => sectionMatches(s, path))
    if (sub && canAccessSettingsSection(sub)) return sub.href
    if (awaitingAppSection()) return null
    return fallbackSection()?.href ?? null
  })

  const activeSection = createMemo(() => {
    const href = activeHref()
    if (!href) return null
    return visibleSections().find((s) => s.href === href) ?? null
  })

  const resolvedSubComponent = createMemo(() => {
    const section = activeSection()
    if (!section?.resolveRoute) return null
    const sub = section.resolveRoute(effectivePath())
    return sub ?? null
  })

  const isTabActive = useTabIsActive()

  // An OAuth callback that failed comes back to a settings URL with
  // `oauth_error` (+ `oauth_error_description`). Say so, then drop the two
  // params so a reload does not say it again.
  createEffect(
    on(
      () => location.search,
      (search) => {
        if (!isTabActive()) return
        const params = new URLSearchParams(search)
        const error = params.get("oauth_error")
        if (!error) return
        const description = params.get("oauth_error_description")
        // An org cap refusal is told in the reader's language (cap-limit-message.ts).
        const capped = capLimitMessage((k, p) => i18n.t(k, p), error)
        addToast({
          message: capped
            ? capped
            : description
              ? i18n.t("kernel.nav.oauthErrorWithDescription", { error, description })
              : i18n.t("kernel.nav.oauthError", { error }),
          type: "error",
        })
        navigate(`${location.pathname}${withoutOAuthError(search)}`, { replace: true })
      },
    ),
  )

  // Redirect a former path to its new home, and to the fallback when the
  // active section is inaccessible or unknown. Skip redirect when the current
  // path is a sub-path of the active section (e.g. /settings/admin/users/:id
  // stays on the Users section).
  createEffect(
    on([activeHref, aliasTarget], ([href, target]) => {
      if (!isTabActive()) return
      if (!href) return
      if (target && aliasTargetPath(target) === effectivePath()) {
        const path = effectivePath()
        if (
          path === href ||
          (path.startsWith(`${href}/`) && activeSection()?.preserveActiveOnSubpaths)
        ) {
          navigate(target, { replace: true })
          return
        }
      }
      if (location.pathname === href) return
      if (location.pathname.startsWith(`${href}/`)) {
        const sec = activeSection()
        if (sec?.preserveActiveOnSubpaths) return
      }
      navigate(href, { replace: true })
    }),
  )

  // Keep-alive rendering: each settings page is mounted on first visit, then
  // shown/hidden via CSS. Prevents remount cycles that cause infinite API
  // re-fetches (same pattern as MainPanel tab keep-alive).
  // Keyed by userId so that switching users clears the visited set.
  let visitedUserId = userFromToken()?.userId ?? ""
  let visited = new Set<string>()

  function getVisited(): Set<string> {
    const uid = userFromToken()?.userId ?? ""
    if (uid !== visitedUserId) {
      visitedUserId = uid
      visited = new Set()
    }
    return visited
  }

  // ── Phone: a push stack rooted on the You screen ───────────────────
  //
  // `pushedSection` carries what the URL cannot: the Profile section's href IS
  // `/settings`, so "at the root" and "looking at Profile" share a pathname.
  // Reaching a section from the navigator sheet changes the pathname instead,
  // and both count as pushed.
  const phone = () => shellTier() === "phone"
  const atYouRoot = () => phone() && pushedSection() === null && location.pathname === "/settings"

  createEffect(
    on(pushedSection, (href) => {
      if (!phone() || !href) return
      if (location.pathname !== href) navigate(href)
    }),
  )

  function backToYou(): void {
    popSettingsSection()
    if (location.pathname !== "/settings") navigate("/settings")
  }

  // An admin section is a TABLE. At phone width it is warned about, never
  // hidden: a blank page or a suppressed table makes the surface unreachable
  // on the only device the viewer has with them.
  const [dismissedNotices, setDismissedNotices] = createSignal<string[]>([])
  const showAdminNotice = () => {
    const href = activeHref()
    if (!phone() || !href) return false
    if (dismissedNotices().includes(href)) return false
    return isAdminHref(sections(), href)
  }

  return (
    <Show when={!atYouRoot()} fallback={<YouScreen />}>
      <div class="flex min-h-0 flex-1 flex-col">
        <Show when={phone()}>
          <button
            type="button"
            data-testid="settings-phone-back"
            aria-label={i18n.t("kernel.youTitle")}
            onClick={backToYou}
            class="flex min-h-11 shrink-0 items-center gap-1 px-2 text-[15px] text-text-secondary hover:bg-surface-hover"
          >
            <ChevronLeft size={20} />
            {i18n.t("kernel.youTitle")}
          </button>
        </Show>
        <Show when={showAdminNotice()}>
          <div
            data-testid="settings-admin-notice"
            class="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-2.5 text-[13px] text-text-secondary"
          >
            <span class="min-w-0 flex-1">{i18n.t("kernel.youAdminBestOnLargerScreen")}</span>
            <button
              type="button"
              data-testid="settings-admin-continue"
              onClick={() => setDismissedNotices((list) => [...list, activeHref() ?? ""])}
              class="shrink-0 rounded-md border border-border px-2.5 py-1 text-[13px] text-text hover:bg-surface-hover"
            >
              {i18n.t("kernel.youAdminContinueAnyway")}
            </button>
          </div>
        </Show>
        <ScrollFade
          class="min-h-0 flex-1"
          scrollClass={phone() ? "px-4 py-4" : "px-8 pt-8 pb-dock-runway [--dock-pad-base:2rem]"}
          fadeColor="var(--color-bg)"
        >
          <div data-testid="settings-content" class="mx-auto w-full max-w-xl">
            <For each={visibleSections()}>
              {(section) => {
                const isActive = () => {
                  const active = activeHref() === section.href
                  if (active) getVisited().add(section.href)
                  return active
                }
                const wasVisited = () => isActive() || getVisited().has(section.href)

                return (
                  <Show when={wasVisited()}>
                    <div style={{ display: isActive() ? "block" : "none" }}>
                      <SettingsPageActiveContext.Provider value={isActive}>
                        <Suspense>
                          <PluginMountBoundary appName={section.appId ?? "kernel"}>
                            <Dynamic
                              component={
                                (isActive() && resolvedSubComponent()) || section.component
                              }
                            />
                          </PluginMountBoundary>
                        </Suspense>
                      </SettingsPageActiveContext.Provider>
                    </div>
                  </Show>
                )
              }}
            </For>
            <Show when={!activeHref() && !awaitingAppSection()}>
              <div class="rounded-lg border border-border bg-surface px-4 py-3 text-sm text-text-secondary">
                {i18n.t("kernel.settingsUi.youDoNotHaveAccessTo")}
              </div>
            </Show>
          </div>
        </ScrollFade>
      </div>
    </Show>
  )
}

export default SettingsLayout
