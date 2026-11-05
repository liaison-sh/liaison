// SPDX-License-Identifier: FSL-1.1-ALv2

import { useLocation } from "@solidjs/router"
import type { JSX } from "solid-js"
import {
  type Component,
  createEffect,
  ErrorBoundary,
  onCleanup,
  Show,
  Suspense,
  splitProps,
} from "solid-js"
import { Dynamic } from "solid-js/web"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  activeSidebarComponent,
  activeSidebarTitle,
  closePhoneNavigator,
  phoneNavigatorOpen,
} from "~/modules/shell/phone-navigator-store"
import { ACTIVITY_RAIL_WIDTH, TABLET_DRAWER_WIDTH } from "~/modules/shell/shell-tier"
import { tabStore } from "~/modules/shell/tab-store"
import { closeTabletSidebar, tabletSidebarOpen } from "~/modules/shell/tablet-sidebar-store"
import { OverlaySheet } from "~/ui/OverlaySheet"

interface SidebarProps {
  tier: "desktop" | "tablet" | "phone"
  style?: JSX.CSSProperties
}

export const Sidebar: Component<SidebarProps> = (props) => {
  const i18n = useI18n()
  const [local, forwarded] = splitProps(props, ["tier"])

  // Tablet has no room for an inline sidebar column beside the content: the
  // narrowest app sidebar still needs ~90px for its own rows on top of the
  // 48px rail. The tablet sidebar is therefore a drawer, opened from the
  // activity bar. It slides in BESIDE the rail and covers only the content
  // area, so the rail it was opened from stays put and stays usable.
  const drawerOpen = () => local.tier === "tablet" && tabletSidebarOpen()

  const tierClass = () => (drawerOpen() || local.tier === "phone" ? "h-full w-full" : "")

  const activeSidebar = activeSidebarComponent

  // The phone navigator is a SHEET, so it has to close itself on navigation:
  // picking a mail folder or a settings section is the whole reason the sheet
  // was opened, and a sheet still covering the screen afterwards hides the
  // result. Both gestures are observable here — a folder re-opens the mail
  // singleton under a new entityId (a new active tab id), a settings section
  // is a router push (a new pathname) — so one effect over the pair covers
  // every module without any of them writing navigation code of its own.
  // This is phone-only: `useLocation()` needs a Router context, so a desktop
  // Sidebar rendered without one (e.g. in isolation) would throw, and the
  // effect has no reason to run on every desktop tab switch either.
  if (local.tier === "phone") {
    const location = useLocation()
    createEffect<string | null>((previous) => {
      const key = `${tabStore.activeTabId ?? ""}|${location.pathname}`
      if (previous !== null && previous !== key) closePhoneNavigator()
      return key
    }, null)
  }

  // Don't render the <aside> at all when the active tab declares no sidebar
  // — pairs with Shell's grid-template-columns 0px so the layout reclaims the
  // space cleanly (no leftover border, no "no sidebar" placeholder).
  // Open, the tablet drawer is an overlay over the content, not an inline
  // column: it goes through OverlaySheet so it inherits the focus trap, the
  // Escape handler and the touch close control rather than re-deriving any of
  // them. A drawer with no way back out is the same trap as a sheet with none.
  // The sheet stays MOUNTED at tablet tier and is opened and closed through its
  // `open` prop, like every other sheet in the shell. Unmounting it on close
  // skips the dialog's own teardown: the focus it moved inside is never handed
  // back to the control that opened the drawer, and the viewer is dropped on
  // document.body with the next Tab starting from the top of the page.
  // Phone tier: the same registered sidebar, in a bottom sheet opened from
  // PhoneTopBar's navigator control. Like the tablet drawer it stays MOUNTED
  // and is driven by `open`, so the sheet hands focus back to the opener.
  const withDrawer = (inner: JSX.Element): JSX.Element => {
    if (local.tier === "tablet") {
      return (
        <OverlaySheet
          open={drawerOpen()}
          onClose={() => closeTabletSidebar()}
          variant="side"
          offsetLeft={ACTIVITY_RAIL_WIDTH}
          width={TABLET_DRAWER_WIDTH}
          // A tap on the rail is not "dismiss the drawer": it is a request to
          // show a DIFFERENT app's sidebar in it (or, on the app you are
          // already in, to close it). The rail decides which; the drawer must
          // still be standing when it does.
          keepOpenOutside={(target) => target.closest("[data-activity-rail]") !== null}
          closeLabel={i18n.t("kernel.close")}
        >
          {inner}
        </OverlaySheet>
      )
    }
    if (local.tier === "phone") {
      // Picking the ALREADY-ACTIVE target (e.g. the mail folder you are already
      // in) fires no navigation at all — tabStore.activeTabId and the URL are
      // unchanged — so the navigation-effect backstop below never runs and the
      // sheet is left covering the result. A capture-phase click handler on the
      // sheet content closes on ANY activation (a click that lands on a button,
      // a link, or anything with an interactive role), whether or not it ends
      // up changing the route. It is capture-phase so it observes the click
      // before the row's own handler can stop propagation.
      const onSheetActivationCapture = (e: MouseEvent): void => {
        const target = e.target
        if (!(target instanceof Element)) return
        if (target.closest('button, a, [role="button"], [role="menuitem"]')) {
          closePhoneNavigator()
        }
      }
      // Solid has no `onClickCapture` JSX prop (that is a React convention):
      // a capture-phase listener needs a real `addEventListener(..., true)`,
      // attached through a ref so it runs before the target's own handler,
      // including one that calls `stopPropagation()`.
      let sheetContentEl: HTMLDivElement | undefined
      const attachCapture = (el: HTMLDivElement): void => {
        sheetContentEl = el
        el.addEventListener("click", onSheetActivationCapture, true)
      }
      onCleanup(() => sheetContentEl?.removeEventListener("click", onSheetActivationCapture, true))
      return (
        <OverlaySheet
          open={phoneNavigatorOpen()}
          onClose={() => closePhoneNavigator()}
          variant="bottom"
          title={activeSidebarTitle()}
          closeLabel={i18n.t("kernel.close")}
        >
          <div class="contents" ref={attachCapture}>
            {inner}
          </div>
        </OverlaySheet>
      )
    }
    return inner
  }

  return (
    <Show when={activeSidebar()}>
      {withDrawer(
        <aside
          data-testid="sidebar"
          class={`flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-border bg-surface ${tierClass()}`}
          style={forwarded.style}
        >
          <ErrorBoundary
            fallback={(err, reset) => (
              <div class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
                <p class="text-sm text-text-secondary">{i18n.t("kernel.sidebarError")}</p>
                <p class="max-w-[200px] text-xs text-text-tertiary">{String(err)}</p>
                <button
                  type="button"
                  onClick={reset}
                  class="rounded-sm border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-hover"
                >
                  {i18n.t("kernel.shellUi.tryAgain")}
                </button>
              </div>
            )}
          >
            {/* The sidebar scrolls here when its content outgrows the column. An in-page
                sidebar fills this box and scrolls its own list, so nothing changes for it;
                a framed one (an outside app's sidebar) grows to its content's height and
                could not be scrolled at all inside the clipped aside. */}
            <div data-testid="sidebar-scroll" class="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <Suspense>
                <Show when={activeSidebar()}>
                  {(SidebarComponent) => <Dynamic component={SidebarComponent()} />}
                </Show>
              </Suspense>
            </div>
          </ErrorBoundary>
        </aside>,
      )}
    </Show>
  )
}
