// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Phase 16.6 — Containment around every kernel mount of a plugin-supplied
// component. A plugin crash renders a named, in-place fallback box; sibling
// kernel UI (settings nav, tab bar, command palette) stays interactive.
//
// Wrap at the mount site (not inside the plugin component itself) so the
// boundary survives the plugin's failure to render and surfaces the app name
// in the fallback for triage.
//
// A request refused by the rate limit (429) is not a crash: the part says so
// calmly and offers to try again, which mounts it afresh.
import { ErrorBoundary, type ParentComponent } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

export interface PluginMountBoundaryProps {
  appName: string
}

export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429
}

export const PluginMountBoundary: ParentComponent<PluginMountBoundaryProps> = (props) => {
  const i18n = useI18n()
  return (
    <ErrorBoundary
      fallback={(err, reset) =>
        isRateLimited(err) ? (
          <div
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-[13px] text-text-secondary"
            data-testid={`plugin-mount-busy-${props.appName}`}
          >
            <span>{i18n.t("kernel.pluginMount.rateLimited")}</span>
            <Button variant="ghost" onClick={reset}>
              {i18n.t("kernel.pluginMount.retry")}
            </Button>
          </div>
        ) : (
          <div
            class="rounded border border-danger bg-danger/10 p-3 text-sm text-danger"
            data-testid={`plugin-mount-error-${props.appName}`}
          >
            <strong>Plugin "{props.appName}" crashed:</strong>{" "}
            {err instanceof Error ? err.message : String(err)}
          </div>
        )
      }
    >
      {props.children}
    </ErrorBoundary>
  )
}
