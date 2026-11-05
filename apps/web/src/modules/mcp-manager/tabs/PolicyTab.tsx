// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  getConnection,
  listToolPolicies,
  patchConnection,
  patchToolPolicy,
} from "~/modules/mcp-manager/api"
import type {
  McpAgentVisibility,
  McpDefaultPolicy,
  McpRoleOverride,
  McpToolDecision,
} from "~/modules/mcp-manager/types"
import { useApi } from "~/modules/shell/ApiContext"

interface Props {
  connectionId: string
  /** Told after the connection default changed (the tool rows beside it follow it). */
  onDefaultPolicyChange?: (policy: McpDefaultPolicy) => void
}

interface RoleRow {
  id: string
  name: string
}

/**
 * Sentinel tool name used to store connection-wide role overrides on
 * `mcp_tool_policy`. Mirrors `CONNECTION_WIDE_TOOL_NAME` in the backend repo —
 * editing this row from the table below grants a role auto/gate/deny treatment
 * across every tool exposed by the connection. The resolver in
 * `apps/api/src/apps/mcp-manager/repo.ts` consults the per-tool row first and
 * falls back to this one, so per-tool overrides still tighten the broader
 * role grant.
 */
const CONNECTION_WIDE_TOOL_NAME = "*"

const DECISIONS: McpToolDecision[] = ["auto", "gate", "deny"]

/** Each connection default policy in words. */
const POLICY_LABEL_KEYS: Record<McpDefaultPolicy, string> = {
  auto: "kernel.mcpUi.policyAuto",
  gate_writes: "kernel.mcpUi.policyGateWrites",
  gate_all: "kernel.mcpUi.policyGateAll",
}

export const PolicyTab: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [conn, { refetch }] = createResource(() => getConnection(api, props.connectionId))

  return (
    <Show when={conn()} keyed>
      {(c) => (
        <div class="space-y-4">
          <div>
            <label class="block text-sm font-medium text-text">
              {i18n.t("kernel.mcpUi.connectionDefaultPolicy")}
            </label>
            <div class="mt-2 space-y-1" data-testid="mcp-policy-default-radios">
              {(["auto", "gate_writes", "gate_all"] as McpDefaultPolicy[]).map((p) => (
                <label class="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="default-policy"
                    value={p}
                    checked={c.connectionDefaultPolicy === p}
                    data-testid={`mcp-policy-radio-${p}`}
                    onChange={async () => {
                      await patchConnection(api, c.id, { connectionDefaultPolicy: p })
                      await refetch()
                      props.onDefaultPolicyChange?.(p)
                    }}
                  />
                  {i18n.t(POLICY_LABEL_KEYS[p])}
                </label>
              ))}
            </div>
          </div>

          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="mcp-policy-agent-visibility"
              checked={c.agentVisibility === "discoverable"}
              onChange={async (e) => {
                const v: McpAgentVisibility = e.currentTarget.checked ? "discoverable" : "hidden"
                await patchConnection(api, c.id, { agentVisibility: v })
                await refetch()
              }}
            />
            <label>{i18n.t("kernel.mcpUi.discoverable")}</label>
          </div>

          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="mcp-policy-expose-gateway"
              checked={c.exposeViaGateway}
              onChange={async (e) => {
                await patchConnection(api, c.id, { exposeViaGateway: e.currentTarget.checked })
                await refetch()
              }}
            />
            <label>{i18n.t("kernel.mcpUi.exposeGateway")}</label>
          </div>

          <Show when={c.ownershipScope === "org"}>
            <RoleOverridesEditor connectionId={c.id} />
          </Show>
        </div>
      )}
    </Show>
  )
}

/**
 * Per-role policy overrides editor — org-shared connections only.
 *
 * Renders a small editable table backed by the connection-wide row on
 * `mcp_tool_policy` (toolName sentinel = "*"). Each row is { roleId, decision }.
 * Roles are fetched once from `/admin/roles`; the active set is loaded from the
 * existing `*` policy row's `roleOverrides` JSONB column. Add/remove and edit
 * actions write the full `roleOverrides` array back via `patchToolPolicy` so
 * the backend can replace the row atomically (review I15).
 */
const RoleOverridesEditor: Component<{ connectionId: string }> = (props) => {
  const i18n = useI18n()
  const api = useApi()

  const [rolesRes] = createResource(async () => {
    const res = (await api.get("/admin/roles")) as RoleRow[] | { data?: RoleRow[] }
    return (Array.isArray(res) ? res : (res?.data ?? [])) as RoleRow[]
  })

  const [overrides, setOverrides] = createStore<McpRoleOverride[]>([])
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  // Load any existing connection-wide row's role overrides so the table starts
  // populated. listToolPolicies returns every row for the connection — pick
  // the sentinel one and seed the local store.
  const [, { refetch: refetchPolicies }] = createResource(
    () => props.connectionId,
    async (id) => {
      const rows = await listToolPolicies(api, id)
      const wide = rows.find((r) => r.toolName === CONNECTION_WIDE_TOOL_NAME)
      setOverrides(wide?.roleOverrides ?? [])
      return rows
    },
  )

  async function persist(next: McpRoleOverride[]): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      await patchToolPolicy(api, props.connectionId, {
        toolName: CONNECTION_WIDE_TOOL_NAME,
        // overrideDecision stays null — the connection-wide row only carries
        // role overrides; the per-connection default policy is set above by
        // the radios and applies when no role override matches the caller.
        overrideDecision: null,
        roleOverrides: next,
      })
      await refetchPolicies()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  function addRow(): void {
    const roles = rolesRes() ?? []
    const used = new Set(overrides.map((o) => o.roleId))
    const next = roles.find((r) => !used.has(r.id))
    if (!next) return
    const updated: McpRoleOverride[] = [...overrides, { roleId: next.id, decision: "auto" }]
    setOverrides(updated)
    void persist(updated)
  }

  function removeRow(idx: number): void {
    const updated = overrides.filter((_, i) => i !== idx)
    setOverrides(updated)
    void persist(updated)
  }

  function updateRow(idx: number, patch: Partial<McpRoleOverride>): void {
    setOverrides(
      produce((draft) => {
        if (patch.roleId !== undefined) draft[idx].roleId = patch.roleId
        if (patch.decision !== undefined) draft[idx].decision = patch.decision
      }),
    )
    void persist(overrides)
  }

  return (
    <div
      data-testid="mcp-policy-role-overrides"
      class="rounded border border-border bg-surface px-3 py-3"
    >
      <div class="mb-1 flex items-center justify-between">
        <div class="text-sm font-medium">{i18n.t("kernel.mcpUi.roleOverrides")}</div>
        <Show when={saving()}>
          <span class="text-xs text-text-secondary" data-testid="mcp-policy-role-overrides-saving">
            {i18n.t("kernel.common.saving")}
          </span>
        </Show>
      </div>
      <p class="mb-2 text-xs text-text-secondary">{i18n.t("kernel.mcpUi.roleOverridesHint")}</p>

      <Show when={error()}>
        {(msg) => (
          <p class="mb-2 text-xs text-text-secondary" data-testid="mcp-policy-role-overrides-error">
            {msg()}
          </p>
        )}
      </Show>

      <Show
        when={overrides.length > 0}
        fallback={
          <p class="text-xs text-text-secondary" data-testid="mcp-policy-role-overrides-empty">
            {i18n.t("kernel.mcpUi.noRoleOverrides")}
          </p>
        }
      >
        <table class="w-full text-sm" data-testid="mcp-policy-role-overrides-table">
          <thead>
            <tr class="border-b border-border-subtle">
              <th class="py-1 text-left font-medium text-text-secondary">
                {i18n.t("kernel.mcpUi.colRole")}
              </th>
              <th class="py-1 text-left font-medium text-text-secondary">
                {i18n.t("kernel.mcpUi.colDecision")}
              </th>
              <th class="py-1" />
            </tr>
          </thead>
          <tbody>
            <For each={overrides}>
              {(row, idx) => {
                const roles = (): RoleRow[] => rolesRes() ?? []
                const otherSelected = (): Set<string> =>
                  new Set(overrides.filter((_, i) => i !== idx()).map((o) => o.roleId))
                return (
                  <tr
                    class="border-b border-border-subtle"
                    data-testid={`mcp-policy-role-row-${row.roleId}`}
                  >
                    <td class="py-1 pr-2">
                      <select
                        data-testid={`mcp-policy-role-select-${idx()}`}
                        value={row.roleId}
                        onChange={(e) => updateRow(idx(), { roleId: e.currentTarget.value })}
                      >
                        <For each={roles()}>
                          {(r) => (
                            <option
                              value={r.id}
                              disabled={r.id !== row.roleId && otherSelected().has(r.id)}
                            >
                              {r.name}
                            </option>
                          )}
                        </For>
                      </select>
                    </td>
                    <td class="py-1 pr-2">
                      <select
                        data-testid={`mcp-policy-role-decision-${idx()}`}
                        value={row.decision}
                        onChange={(e) =>
                          updateRow(idx(), {
                            decision: e.currentTarget.value as McpToolDecision,
                          })
                        }
                      >
                        <For each={DECISIONS}>{(d) => <option value={d}>{d}</option>}</For>
                      </select>
                    </td>
                    <td class="py-1 text-right">
                      <button
                        type="button"
                        class="text-xs text-text-secondary hover:text-text"
                        data-testid={`mcp-policy-role-remove-${idx()}`}
                        onClick={() => removeRow(idx())}
                      >
                        {i18n.t("kernel.common.remove")}
                      </button>
                    </td>
                  </tr>
                )
              }}
            </For>
          </tbody>
        </table>
      </Show>

      <div class="mt-2">
        <button
          type="button"
          class="text-xs text-text-secondary hover:text-text disabled:opacity-50"
          data-testid="mcp-policy-role-add"
          disabled={
            (rolesRes() ?? []).length === 0 || overrides.length >= (rolesRes() ?? []).length
          }
          onClick={addRow}
        >
          {i18n.t("kernel.mcpUi.addRoleOverride")}
        </button>
      </div>
    </div>
  )
}
