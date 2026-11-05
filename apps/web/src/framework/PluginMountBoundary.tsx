// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16.6 — Containment around every kernel mount of a plugin-supplied
// component. A plugin crash renders a named, in-place fallback box; sibling
// kernel UI (settings nav, tab bar, command palette) stays interactive.
//
// Wrap at the mount site (not inside the plugin component itself) so the
// boundary survives the plugin's failure to render and surfaces the app name
// in the fallback for triage.
import { ErrorBoundary, type ParentComponent } from "solid-js"

export interface PluginMountBoundaryProps {
  appName: string
}

export const PluginMountBoundary: ParentComponent<PluginMountBoundaryProps> = (props) => (
  <ErrorBoundary
    fallback={(err) => (
      <div
        class="rounded border border-danger bg-danger/10 p-3 text-sm text-danger"
        data-testid={`plugin-mount-error-${props.appName}`}
      >
        <strong>Plugin "{props.appName}" crashed:</strong>{" "}
        {err instanceof Error ? err.message : String(err)}
      </div>
    )}
  >
    {props.children}
  </ErrorBoundary>
)
