// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `/portal` routes: the client portal's lazy chunk behind its own boundary.
// A chunk that cannot load (offline, a deploy in progress) shows the portal's own
// "not available right now" page with Try again, never the member app's error
// panel or its reload.

import { type Component, ErrorBoundary, lazy, Suspense } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"

const PortalRoot = lazy(() => import("./PortalRoot"))

const PortalDown: Component<{ retry: () => void }> = (props) => {
  const i18n = useI18n()
  return (
    <main data-testid="portal-chunk-down" class="min-h-screen bg-bg px-4 py-16 text-text">
      <section class="mx-auto w-full max-w-[420px] rounded-xl border border-border bg-surface px-5 py-6">
        <p class="text-[14px]">{i18n.t("portal.states.down")}</p>
        <button
          type="button"
          data-testid="portal-chunk-retry"
          class="mt-4 min-h-[44px] rounded-md bg-accent px-4 text-[14px] font-medium text-accent-foreground"
          onClick={() => props.retry()}
        >
          {i18n.t("portal.states.retry")}
        </button>
      </section>
    </main>
  )
}

const PortalRoute: Component = () => (
  <ErrorBoundary fallback={(_err, reset) => <PortalDown retry={reset} />}>
    <Suspense>
      <PortalRoot />
    </Suspense>
  </ErrorBoundary>
)

export default PortalRoute
