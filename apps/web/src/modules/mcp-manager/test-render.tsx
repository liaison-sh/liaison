// SPDX-License-Identifier: FSL-1.1-ALv2
// Shared render helper for mcp-manager component tests. Wraps in Router +
// ApiProvider so ApiContext (which uses useNavigate) can mount.
import { Route, Router } from "@solidjs/router"
import { render } from "@solidjs/testing-library"
import type { Component, JSX } from "solid-js"
import { ApiProvider } from "~/modules/shell/ApiContext"

export function renderInApp(child: Component<{}>): ReturnType<typeof render> {
  const Inner: Component = () => <ApiProvider>{child({}) as JSX.Element}</ApiProvider>
  return render(() => (
    <Router>
      <Route path="*" component={Inner} />
    </Router>
  ))
}
