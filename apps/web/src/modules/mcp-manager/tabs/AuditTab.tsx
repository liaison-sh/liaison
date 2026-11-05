// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { getConnectionAudit } from "~/modules/mcp-manager/api"
import { useApi } from "~/modules/shell/ApiContext"

interface Props {
  connectionId: string
}

export const AuditTab: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [decision, setDecision] = createSignal<string>("")
  const [rows] = createResource(
    () => ({ id: props.connectionId, decision: decision() }),
    (k) => getConnectionAudit(api, k.id, { decision: k.decision || undefined }),
  )

  return (
    <div class="space-y-3" data-testid="mcp-audit-tab">
      <div class="flex items-center gap-2">
        <label class="text-xs text-text-secondary">{i18n.t("kernel.mcpUi.decisionFilter")}</label>
        <select
          data-testid="mcp-audit-decision-filter"
          value={decision()}
          onChange={(e) => setDecision(e.currentTarget.value)}
        >
          <option value="">{i18n.t("kernel.mcpUi.auditAll")}</option>
          <option value="ok">{i18n.t("kernel.mcpUi.auditOk")}</option>
          <option value="denied">{i18n.t("kernel.mcpUi.auditDenied")}</option>
          <option value="gated">{i18n.t("kernel.mcpUi.auditGated")}</option>
          <option value="error">{i18n.t("kernel.mcpUi.auditError")}</option>
        </select>
      </div>

      <Show
        when={(rows() ?? []).length > 0}
        fallback={
          <div data-testid="mcp-audit-empty" class="text-sm text-text-secondary">
            {i18n.t("kernel.mcpUi.noAuditEvents")}
          </div>
        }
      >
        <table class="w-full text-xs" data-testid="mcp-audit-table">
          <thead>
            <tr class="border-b border-border">
              <th class="text-left">{i18n.t("kernel.mcpUi.colWhen")}</th>
              <th class="text-left">{i18n.t("kernel.mcpUi.colAction")}</th>
              <th class="text-left">{i18n.t("kernel.mcpUi.colActor")}</th>
              <th class="text-left">{i18n.t("kernel.mcpUi.colOutcome")}</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows() ?? []}>
              {(r) => (
                <tr data-testid={`mcp-audit-row-${r.id}`} class="border-b border-border-subtle">
                  <td>{new Date(r.timestamp).toISOString()}</td>
                  <td>{r.action}</td>
                  <td>{r.actorType}</td>
                  <td>{String((r.changes as any)?.outcome ?? "")}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  )
}
