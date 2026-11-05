// SPDX-License-Identifier: FSL-1.1-ALv2

import { ChevronLeft, PanelLeft } from "lucide-solid"
import {
  type Component,
  ErrorBoundary,
  For,
  type JSX,
  Match,
  onMount,
  type ParentComponent,
  Show,
  Suspense,
  Switch,
  splitProps,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import {
  areManifestAppsSettled,
  getPhoneHeader,
  getPhoneTopBarHidden,
  getTabType,
  tabDisplayLabel,
  tabTypeRegistryVersion,
} from "~/framework/app-registry"
import { isAppUnavailable } from "~/framework/unavailable-apps"
import { isAppAccessLostError } from "~/lib/api-error"
import { cn } from "~/lib/cn"
import { isStaleChunkError, recoverFromStaleChunk } from "~/lib/stale-chunk"
import { DemoHost } from "~/modules/demo/DemoHost"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AppUnavailableNotice } from "~/modules/shell/AppUnavailableNotice"
import { appIdOfTabType, isSystemAppId } from "~/modules/shell/app-color"
import { ensureBrandingLoaded, orgName } from "~/modules/shell/branding-store"
import { ConnectionUnstableNotice } from "~/modules/shell/ConnectionUnstableNotice"
import { OfflineBanner } from "~/modules/shell/OfflineBanner"
import { activeSidebarComponent, openPhoneNavigator } from "~/modules/shell/phone-navigator-store"
import { ServerPauseNotice } from "~/modules/shell/ServerPauseNotice"
import { TabBar } from "~/modules/shell/TabBar"
import { TabVisibilityProvider } from "~/modules/shell/TabVisibilityContext"
import { TabLoadingBar, TabSuspenseFallback } from "~/modules/shell/tab-loading"
import { hasTabBeenActive, promoteActiveTab, tabStore } from "~/modules/shell/tab-store"
import { createPushNav } from "~/primitives/createPushNav"

/**
 * The phone tier's top bar. Kept in its own component so `createPushNav`,
 * which needs router context, is only created at phone tier.
 *
 * It used to be a back chevron and nothing else, and on a list route it was an
 * empty 93pt band: no screen title, no workspace name, nothing on any screen
 * saying which server this is. At phone width there is no sidebar and no tab
 * strip to carry either, so both live here: the active tab's own label, which
 * is the thread or screen the user is looking at, and the deployment's name
 * from the public branding read. Both truncate rather than wrap, and the title
 * gets the room.
 */
/** The app an app-qualified tab type (`invoicing:home`) belongs to; null for a kernel type. */
function appOfTabType(type: string): string | null {
  if (!type.includes(":")) return null
  const appId = appIdOfTabType(type)
  return isSystemAppId(appId) ? null : appId
}

const PhoneTopBar: Component = () => {
  const i18n = useI18n()
  const pushNav = createPushNav()
  onMount(() => {
    // Only the PUBLIC branding read (the demo flag, and the pre-login fallback
    // name). The signed-in org's own name is session state loaded once in
    // `startup.ts`: read here it raced the attentionStore api registration and
    // lost, leaving the bar printing the deployment's name for the whole
    // session.
    void ensureBrandingLoaded()
  })
  const activeTab = () => tabStore.tabs.find((tab) => tab.id === tabStore.activeTabId)
  const activeLabel = (): string => {
    tabTypeRegistryVersion()
    const active = activeTab()
    if (!active) return i18n.t("kernel.home")
    // The stored label is English ("Home", "Mail", "Settings"): a tab type with
    // a fixed name is renamed from the catalog here, exactly as the tab strip
    // does, so the phone header is not the one English word left on the screen.
    const label = tabDisplayLabel(i18n.t, active)
    return label?.trim() ? label : i18n.t("kernel.home")
  }
  // F4: a tab type may own the bar's content. The thread type does (title,
  // agent state, actions), and it is resolved HERE through the registry rather
  // than from the route, so every other tab type keeps the plain label bar and
  // the shell learns nothing about threads.
  //
  // G1: a MANIFEST tab type (tickets, ...) cannot carry a `phoneHeader`
  // component on its own registration — that field is JSON in a manifest, and
  // a component reference cannot travel through JSON — so it attaches one at
  // runtime via `registerAppPhoneHeader`, checked here as the fallback.
  const headerSlot = () => {
    tabTypeRegistryVersion()
    const tab = activeTab()
    if (!tab) return undefined
    return getTabType(tab.type)?.phoneHeader ?? getPhoneHeader(tab.type)
  }
  // F3: a root screen that owns a large title of its own (Chats, Work) hides
  // this bar ENTIRELY rather than customizing its content — see
  // `hidePhoneTopBar` on the registry entry (or its runtime-attached
  // equivalent, `registerAppPhoneTopBarHidden`, for a manifest tab type). A
  // back control never applies here either: a root screen with no detail
  // pushed over it has nothing to go back to.
  const hidePhoneTopBar = () => {
    tabTypeRegistryVersion()
    const tab = activeTab()
    if (!tab) return false
    return (getTabType(tab.type)?.hidePhoneTopBar ?? false) || getPhoneTopBarHidden(tab.type)
  }
  return (
    <Show when={!hidePhoneTopBar()}>
      {/* The right gutter is the phone chrome's own 16px, not the bar's 4px:
          without it the workspace name ends flush against the screen edge. A
          registered header owns the whole bar and places its own trailing
          control, so it keeps the tight padding it was drawn for. */}
      <div
        class={cn(
          "flex shrink-0 items-center gap-1 border-b border-border py-1 pl-1",
          headerSlot() ? "pr-1" : "pr-4",
        )}
      >
        {/* K1: when a tab type registers a phone header, that component owns
          the ENTIRE bar, including its own back control (see
          `TicketPhoneHeader`, `ThreadPhoneHeader`) — the shell must not also
          render one, or the screen shows two back controls stacked. */}
        <Show when={pushNav.detailOpen() && !headerSlot()}>
          <button
            type="button"
            data-testid="main-panel-back"
            aria-label={i18n.t("kernel.back")}
            onClick={() => pushNav.popDetail()}
            class="flex min-h-11 shrink-0 items-center gap-0.5 rounded-md pl-1 pr-1.5 text-text-secondary hover:bg-surface-hover"
          >
            <ChevronLeft size={20} />
            <Show when={pushNav.backLabel()}>
              {(label) => (
                <span data-testid="main-panel-back-label" class="max-w-24 truncate text-[14px]">
                  {label()}
                </span>
              )}
            </Show>
          </button>
        </Show>
        {/* The navigator: at phone width the shell has no sidebar column, so the
          tab type's REGISTERED sidebar (mail folders, settings sections,
          knowledge collections) is reached from here and nowhere else. Hidden
          for a tab type that registers none, so the control never opens an
          empty sheet. */}
        {/* Not on a screen that owns the bar: a thread's nav bar is back, title
          and actions, and its registered sidebar is the conversation list the
          Chats seat and the back control already lead to. */}
        <Show when={activeSidebarComponent() && !headerSlot()}>
          <button
            type="button"
            data-testid="phone-navigator-opener"
            aria-label={i18n.t("kernel.toggleSidebar")}
            onClick={() => openPhoneNavigator()}
            class="flex min-h-11 min-w-11 items-center justify-center rounded-md text-text-secondary hover:bg-surface-hover"
          >
            <PanelLeft size={20} />
          </button>
        </Show>
        <Show
          when={headerSlot()}
          fallback={
            <>
              <h1
                data-testid="phone-top-bar-title"
                class="min-w-0 flex-1 truncate px-1 text-[15px] font-semibold text-text"
              >
                {activeLabel()}
              </h1>
              <Show when={orgName()}>
                {(name) => (
                  <span
                    data-testid="phone-top-bar-org"
                    class="max-w-[40%] shrink-0 truncate text-[12px] text-text-secondary"
                  >
                    {name()}
                  </span>
                )}
              </Show>
            </>
          }
          keyed
        >
          {(header) => <Dynamic component={header} entityId={activeTab()?.entityId ?? ""} />}
        </Show>
      </div>
    </Show>
  )
}

interface MainPanelProps {
  tier?: "desktop" | "tablet" | "phone"
  style?: JSX.CSSProperties
}

export const MainPanel: ParentComponent<MainPanelProps> = (props) => {
  const i18n = useI18n()
  const [local, _rest] = splitProps(props, ["style"])
  // Phone tier is single pane: the tab strip is a desktop affordance, and a
  // detail route gets a back control that runs real browser back navigation,
  // so a device back gesture behaves identically.
  const isPhone = () => props.tier === "phone"
  return (
    <main
      data-testid="main-panel"
      // `relative` is the chat dock's anchor: the dock is rendered as this
      // panel's last child and positions itself against this cell's bottom
      // right corner, not the viewport's.
      class="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-bg"
      // The dock is anchored to this cell's bottom right corner and reserves
      // no band: the page keeps its full height (dock-store.ts DOCK_STRIP_HEIGHT).
      style={local.style}
    >
      <Show when={!isPhone()} fallback={<PhoneTopBar />}>
        <TabBar />
      </Show>
      {/* Above the content and below whichever bar the tier drew, so it reads
          as part of the app rather than as something over it. It renders
          nothing at all while the device is online, and nothing ever at
          desktop tier (OfflineBanner.tsx). */}
      <OfflineBanner />
      {/* While a VPN or network filter keeps cutting the live connection
          seconds after it opens: what is going on and what fixes it
          (ConnectionUnstableNotice.tsx). Nothing otherwise. */}
      <ConnectionUnstableNotice />
      {/* A few seconds waiting on the server: "Liaison is updating" when the
          server said it is restarting, else a neutral connection line
          (ServerPauseNotice.tsx). Nothing otherwise. */}
      <ServerPauseNotice />
      {/* The demo's standing banner, the seed's honest state, the model-key
          invitation and the expired takeover. Renders nothing at all unless the
          SERVER said this is a demo deployment (branding-store.demoMode). */}
      <DemoHost />
      {/* A real content edit inside the active tab (text input, contenteditable
          composer, form control) promotes it from ephemeral preview to a
          permanent tab. `input`/`change` bubble from descendants and fire only
          on genuine mutation — not on reading, scrolling, or clicking — which is
          exactly the "interacted" signal. Inactive tabs are display:none, so the
          event can only originate from the active tab. */}
      <div
        data-testid="tab-content-area"
        class="relative z-0 flex-1 overflow-hidden"
        onInput={promoteActiveTab}
        onChange={promoteActiveTab}
      >
        <TabLoadingBar />
        <For each={tabStore.tabs}>
          {(tab) => {
            const isActive = () => tabStore.activeTabId === tab.id
            // Lazy first-mount (B2): a rehydrated background tab's component
            // subtree is not created at all until its first activation — the
            // wrapper div always renders (stable layout/testids/data-tab-active
            // for TabBar and e2e probing) but the reactive content underneath
            // only appears once `hasTabBeenActive` latches, so N-1 hidden tabs
            // cost zero network/CPU at boot instead of mounting eagerly.
            const everActive = () => hasTabBeenActive(tab.id)
            return (
              <div
                class="absolute inset-0 flex flex-col"
                data-tab-active={isActive() ? "true" : "false"}
                style={{ display: isActive() ? "flex" : "none" }}
              >
                <Show when={everActive()}>
                  <TabVisibilityProvider value={isActive} tabId={tab.id}>
                    <ErrorBoundary
                      fallback={(err, reset) => {
                        // A tab body is a lazy() dynamic import of a hashed
                        // asset, and a deploy replaces every asset. A session
                        // that predates the deploy asks for a file that is gone,
                        // and `reset` cannot help: it re-runs the same import
                        // against the same missing URL. Reload instead, once
                        // (ticket-10193). If the reload already happened,
                        // recoverFromStaleChunk returns false and we fall
                        // through to a message that names the real cause.
                        // The app was restricted away or turned Off while its page
                        // was open (S19, S20): its next request is refused before
                        // the shell's resync lands. Say so calmly, not "Something
                        // went wrong" with the raw error (MGT-11).
                        if (isAppAccessLostError(err)) return <AppUnavailableNotice />
                        const stale = isStaleChunkError(err)
                        if (recoverFromStaleChunk(err)) return null
                        return (
                          <div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                            <p class="text-sm text-text-secondary">
                              {stale
                                ? i18n.t("kernel.staleChunkNeedsReload")
                                : i18n.t("kernel.somethingWentWrongInThisTab")}
                            </p>
                            <p class="max-w-md text-xs text-text-tertiary">{String(err)}</p>
                            <button
                              type="button"
                              onClick={() => (stale ? location.reload() : reset())}
                              class="rounded-sm border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover"
                            >
                              {stale
                                ? i18n.t("kernel.reloadPage")
                                : i18n.t("kernel.shellUi.tryAgain")}
                            </button>
                          </div>
                        )
                      }}
                    >
                      <Suspense fallback={<TabSuspenseFallback tabId={tab.id} />}>
                        <Show
                          when={(() => {
                            // Track the registry version so this re-evaluates when
                            // an app's manifest registers its tab types after load
                            // (late-loading manifests are normal, so this must stay
                            // reactive, not throw).
                            tabTypeRegistryVersion()
                            return getTabType(tab.type)?.component
                          })()}
                          fallback={
                            // A tab restored from storage whose app is absent from the
                            // manifests (restricted, Off or removed) never gets its type
                            // registered: once the manifests settled, it says why (MGT-11);
                            // until then its app may still be loading.
                            <Switch
                              fallback={
                                <div class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                                  <p class="text-sm text-text-secondary">
                                    {i18n.t("kernel.somethingWentWrongInThisTab")}
                                  </p>
                                  <p class="max-w-md text-xs text-text-tertiary">
                                    {i18n.t("kernel.shellUi.unknownTabType")}
                                    {tab.type}
                                    {i18n.t("kernel.shellUi.noComponentIsRegisteredForIt")}
                                  </p>
                                </div>
                              }
                            >
                              <Match
                                when={
                                  appOfTabType(tab.type) &&
                                  (isAppUnavailable(appOfTabType(tab.type) ?? undefined) ||
                                    areManifestAppsSettled())
                                }
                              >
                                <AppUnavailableNotice />
                              </Match>
                              <Match when={appOfTabType(tab.type)}>
                                <TabSuspenseFallback tabId={tab.id} />
                              </Match>
                            </Switch>
                          }
                          keyed
                        >
                          {(component) => (
                            <Show
                              when={getTabType(tab.type)?.appId}
                              fallback={<Dynamic component={component} entityId={tab.entityId} />}
                            >
                              {/* App-supplied pages get a default scroll container: the shell is
                                  overflow-hidden all the way down, and unlike kernel pages (which
                                  each own their scroll, see Home.tsx) plugin pages routinely render
                                  taller-than-viewport content with no overflow handling, leaving the
                                  tab unscrollable. Pages that size themselves h-full and scroll
                                  internally still fill this container and never overflow it, so
                                  their own scroll regions keep working. */}
                              {/* Block (NOT flex): as a flex column, the page root became a
                                  shrinkable flex item and compressed to the viewport instead of
                                  overflowing — the exact squash this wrapper exists to fix. In a
                                  block container the root's height is content-driven; h-full /
                                  min-h-full pages still resolve against the wrapper's definite
                                  (flex-1) height. */}
                              {/* The bottom reserve: an app page cannot know what the shell floats
                                  over the panel's bottom right corner (the round Chats opener at
                                  tablet), so its footer actions (an invoice's Download PDF) ended
                                  under it. The wrapper keeps that band clear
                                  (--shell-dock-clearance, Shell.tsx; 0 on the phone and at
                                  desktop, where the dock's bar is anchored flush to the corner),
                                  and an h-full page resolves against the space above it. The band
                                  is reserved HERE, once: data-dock-reserved zeroes the clearance
                                  for the page (index.css), so a composer that pads itself by it
                                  (the chat's, a session's) does not stack a second band on top. */}
                              <div
                                class="min-h-0 flex-1 overflow-y-auto"
                                style={{ "padding-bottom": "var(--shell-dock-clearance, 0px)" }}
                                data-dock-reserved=""
                                data-testid="app-tab-scroll"
                              >
                                {/* An app Off or restricted away (S19, S20) keeps its routes so a
                                    deep link lands somewhere that says why, rather than
                                    on its page or on "unknown tab type". */}
                                <Show
                                  when={!isAppUnavailable(getTabType(tab.type)?.appId)}
                                  fallback={<AppUnavailableNotice />}
                                >
                                  <Dynamic component={component} entityId={tab.entityId} />
                                </Show>
                              </div>
                            </Show>
                          )}
                        </Show>
                      </Suspense>
                    </ErrorBoundary>
                  </TabVisibilityProvider>
                </Show>
              </div>
            )
          }}
        </For>
      </div>
      {/* Shell-supplied overlays anchored to this cell (the chat dock). */}
      {props.children}
    </main>
  )
}
