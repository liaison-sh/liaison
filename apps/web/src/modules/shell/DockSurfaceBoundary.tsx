// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The guard every conversation surface OUTSIDE the tab system renders behind:
// the desktop dock strip's tabs and roster panel, and the tablet Chats sheet.
//
// Why it exists. A shell tab body sits inside MainPanel's per-tab
// <ErrorBoundary> + <Suspense fallback=…>, so a tab that throws or suspends
// costs that tab and nothing else. The dock and the sheet are rendered by the
// Shell itself, outside MainPanel, and had NEITHER. The nearest boundary above
// them is App's root <Suspense>, which carries no fallback at all: in Solid a
// suspended boundary with no fallback renders NOTHING, so one pending resource
// read inside a dock conversation (the composer's model chip reads the credits
// balance during render) blanked the ENTIRE document. Under a 429 the read
// stays pending for as long as the rate limiter says, which is exactly the
// white page seen after opening a conversation from Tickets, from an agent
// page, or from the phone ticket list.
//
// The boundary is deliberately local and always renders something: a surface
// that is still loading shows a loading line, one that threw shows a panel with
// a retry, and the shell around it never goes away.
import { type Component, ErrorBoundary, type JSX, Suspense } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"

interface DockSurfaceBoundaryProps {
  children: JSX.Element
}

export const DockSurfaceBoundary: Component<DockSurfaceBoundaryProps> = (props) => {
  const i18n = useI18n()
  return (
    <ErrorBoundary
      fallback={(err, reset) => (
        <div
          data-testid="dock-surface-error"
          class="flex h-full min-h-0 flex-col items-center justify-center gap-2 p-4 text-center"
        >
          <p class="text-[13px] text-text-secondary">{i18n.t("kernel.somethingWentWrong")}</p>
          <p class="max-w-full truncate text-[11px] text-text-tertiary">{String(err)}</p>
          <button
            type="button"
            onClick={reset}
            class="rounded-sm border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-hover"
          >
            {i18n.t("kernel.common.retry")}
          </button>
        </div>
      )}
    >
      {/* A REAL fallback, never `undefined`: this is the whole point of the
          boundary. Rendering nothing here would only move the blank page from
          the document to the dock tab. */}
      <Suspense
        fallback={
          <div
            data-testid="dock-surface-loading"
            class="flex h-full min-h-0 items-center justify-center p-4 text-[12.5px] text-text-tertiary"
          >
            {i18n.t("kernel.loading")}
          </div>
        }
      >
        {props.children}
      </Suspense>
    </ErrorBoundary>
  )
}
