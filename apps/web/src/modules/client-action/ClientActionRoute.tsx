// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `/a` route: the token page's lazy chunk behind its own boundary. A chunk
// that cannot load (offline, a deploy in progress) shows the page's own `down`
// frame with Try again, never the member app's error panel or its reload.

import { type Component, ErrorBoundary, lazy, Suspense } from "solid-js"
import { TokenFrame } from "./TokenFrame"

const ClientActionPage = lazy(() => import("./ClientActionPage"))

const ClientActionRoute: Component = () => (
  <ErrorBoundary
    fallback={(_err, reset) => (
      <main data-testid="client-action-chunk-down" class="min-h-screen bg-bg px-4 py-16 text-text">
        <TokenFrame
          facts={{ frame: "down", sender: null }}
          onAction={async () => {
            reset()
          }}
        />
      </main>
    )}
  >
    <Suspense>
      <ClientActionPage />
    </Suspense>
  </ErrorBoundary>
)

export default ClientActionRoute
