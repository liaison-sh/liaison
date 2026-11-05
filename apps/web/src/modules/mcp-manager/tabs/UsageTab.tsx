// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createResource, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { getConnectionUsage } from "~/modules/mcp-manager/api"
import { billingMode } from "~/modules/settings/BillingState"
import { useApi } from "~/modules/shell/ApiContext"

interface Props {
  connectionId: string
}

export const UsageTab: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  // Usage is managed-only. On self-hosted return null entirely (per §11.2).
  if (billingMode() !== "managed") {
    return null
  }
  const [usage] = createResource(() =>
    getConnectionUsage(api, props.connectionId, { window: "24h" }),
  )

  return (
    <Show when={usage()} keyed>
      {(u) => (
        <div data-testid="mcp-usage-tab" class="space-y-4">
          <div class="grid grid-cols-3 gap-3">
            <div
              data-testid="mcp-usage-kpi-calls"
              class="rounded-lg border border-border bg-surface p-3"
            >
              <div class="text-xs text-text-secondary">{i18n.t("kernel.mcpUi.calls24h")}</div>
              <div class="text-xl font-semibold">{u.calls}</div>
            </div>
            <div
              data-testid="mcp-usage-kpi-errors"
              class="rounded-lg border border-border bg-surface p-3"
            >
              <div class="text-xs text-text-secondary">{i18n.t("kernel.mcpUi.errors24h")}</div>
              <div class="text-xl font-semibold">{u.errors}</div>
            </div>
            <div
              data-testid="mcp-usage-kpi-p95"
              class="rounded-lg border border-border bg-surface p-3"
            >
              <div class="text-xs text-text-secondary">{i18n.t("kernel.mcpUi.p95")}</div>
              <div class="text-xl font-semibold">
                {i18n.t("kernel.mcpUi.latencyMs", { ms: u.p95LatencyMs })}
              </div>
            </div>
          </div>
          <div data-testid="mcp-usage-sparkline" class="h-12 rounded bg-surface" />
          <div>
            <div class="text-xs text-text-secondary">{i18n.t("kernel.mcpUi.topTools")}</div>
            <ul class="mt-1 text-sm">
              <For each={u.topTools}>
                {(t) => (
                  <li>
                    {t.toolName}: {t.calls}
                  </li>
                )}
              </For>
            </ul>
          </div>
        </div>
      )}
    </Show>
  )
}
