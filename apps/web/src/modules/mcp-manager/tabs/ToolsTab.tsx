// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A server's tools with what agents may do with each: Allowed (auto), Needs
// approval (gate) or Off (deny). Used by the add flow's last step (the tools the
// first dial found) and by the server page (the tools Liaison holds for it).
// Each tool carries a Read / Write badge from the server's own annotations.
//
// Every row shows the tool's EFFECTIVE decision: its own override when one is
// set, else what the connection default gives it, marked "default". The
// default's decision per tool comes from the API (`defaultDecisions`, computed
// by default-policy.ts, the rule the per-call decision applies), so the tools
// review shows the default being chosen before it is saved. Picking the
// decision a tool already gets from the default writes nothing; "Reset to
// default" removes a tool's override, and "Reset all to default" removes every
// one in one request (PUT /policy/bulk). The connection default itself is the
// bulk choice: it is set above the list, never as one override per tool.
import { type Component, createMemo, createResource, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  bulkSetToolPolicies,
  listConnectionTools,
  listToolPolicies,
  patchToolPolicy,
} from "~/modules/mcp-manager/api"
import type {
  McpDecisionSource,
  McpDefaultPolicy,
  McpToolDecision,
  McpToolSummary,
} from "~/modules/mcp-manager/types"
import { useApi } from "~/modules/shell/ApiContext"

/** Sentinel tool name used for connection-wide role overrides — must not appear in the per-tool list. */
const CONNECTION_WIDE_TOOL_NAME = "*"

const DECISION_LABEL: Record<McpToolDecision, string> = {
  auto: "kernel.mcpUi.decisionAuto",
  gate: "kernel.mcpUi.decisionGate",
  deny: "kernel.mcpUi.decisionDeny",
}

const CHOICES: Array<{ value: McpToolDecision; label: string }> = (
  ["auto", "gate", "deny"] as const
).map((value) => ({ value, label: DECISION_LABEL[value] }))

interface Props {
  connectionId: string
  /** The tools to show; read from the server when left out. */
  tools?: McpToolSummary[]
  /**
   * Whether the person may set per-tool choices (`mcp_manager:policy:write`).
   * Off, the list shows the tools and their Read / Write badges only.
   */
  editable?: boolean
  /**
   * The connection default the rows follow: the tools review passes the choice
   * being made (rows follow it live, before it is saved), the server page the
   * saved one. Left out, a row uses the decision the API computed.
   */
  defaultPolicy?: McpDefaultPolicy
}

/** A tool's decision and where it comes from; `decision` null when unknown. */
interface Effective {
  decision: McpToolDecision | null
  source: McpDecisionSource
}

export const ToolsTab: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [policies, { mutate, refetch }] = createResource(() =>
    listToolPolicies(api, props.connectionId),
  )
  const [held] = createResource(
    () => (props.tools ? null : props.connectionId),
    (id) => listConnectionTools(api, id),
  )

  // The given tools, else the ones the server holds, else any tool a saved
  // choice names (a server not reached since a restart still shows those).
  const effectiveTools = createMemo<McpToolSummary[]>(() => {
    if (props.tools) return props.tools
    const fromServer = held.latest ?? []
    if (fromServer.length > 0) return fromServer
    return (policies.latest ?? [])
      .filter((p) => p.toolName !== CONNECTION_WIDE_TOOL_NAME && p.overrideDecision !== null)
      .map((p) => ({ name: p.toolName }))
  })

  // `.latest` and no Suspense: the rows draw at once and the choices fill in.
  const decisionOf = (tool: string): McpToolDecision | null =>
    policies.latest?.find((p) => p.toolName === tool)?.overrideDecision ?? null
  /** The override, else the connection default's decision for this tool. */
  const effectiveOf = (t: McpToolSummary): Effective => {
    const override = decisionOf(t.name)
    if (override !== null) return { decision: override, source: "override" }
    const policy = props.defaultPolicy
    if (policy && t.defaultDecisions)
      return { decision: t.defaultDecisions[policy], source: "default" }
    if (!policy && t.source === "default" && t.effectiveDecision) {
      return { decision: t.effectiveDecision, source: "default" }
    }
    return { decision: null, source: "default" }
  }
  const loading = () => effectiveTools().length === 0 && (held.loading || policies.loading)

  const editable = () => props.editable !== false

  // A tool Liaison could not register (its input schema does not convert) is listed
  // apart, as Unavailable with the reason: agents never see it, so it has no decision.
  const usable = () => effectiveTools().filter((t) => !t.unavailableReason)
  const unavailable = () => effectiveTools().filter((t) => t.unavailableReason)

  const overridden = () => usable().filter((t) => decisionOf(t.name) !== null)

  /** Every override removed in one request; the tools then follow the default. */
  async function resetAll(): Promise<void> {
    const names = overridden().map((t) => t.name)
    if (names.length === 0) return
    mutate((rows) => (rows ?? []).filter((p) => !names.includes(p.toolName)))
    try {
      await bulkSetToolPolicies(
        api,
        props.connectionId,
        names.map((toolName) => ({ toolName, overrideDecision: null })),
      )
    } finally {
      await refetch()
    }
  }

  async function write(tool: string, next: McpToolDecision | null): Promise<void> {
    // Shown at once; the refetch below settles it to what the server holds.
    mutate((rows) => {
      const rest = (rows ?? []).filter((p) => p.toolName !== tool)
      return [...rest, { toolName: tool, overrideDecision: next, roleOverrides: null }]
    })
    try {
      await patchToolPolicy(api, props.connectionId, { toolName: tool, overrideDecision: next })
    } finally {
      await refetch()
    }
  }

  /** A decision the tool already has (its override, or the default's) writes nothing. */
  function choose(t: McpToolSummary, decision: McpToolDecision): void {
    if (effectiveOf(t).decision === decision) return
    void write(t.name, decision)
  }

  return (
    <Show
      when={effectiveTools().length > 0}
      fallback={
        <Show
          when={!loading()}
          fallback={
            <div data-testid="mcp-tools-loading" class="text-sm text-text-secondary">
              {i18n.t("kernel.mcpUi.loadingTools")}
            </div>
          }
        >
          <div data-testid="mcp-tools-empty" class="text-sm text-text-secondary">
            {i18n.t("kernel.mcpUi.noToolsYet")}
          </div>
        </Show>
      }
    >
      <div class="flex flex-col">
        <Show when={editable() && overridden().length > 0}>
          <div class="mb-2 flex flex-wrap gap-2" data-testid="mcp-tools-bulk">
            <button
              type="button"
              data-testid="mcp-tools-bulk-reset"
              class="rounded-md border border-border px-2.5 py-1 text-xs text-text-secondary hover:bg-surface-hover"
              onClick={() => void resetAll()}
            >
              {i18n.t("kernel.mcpUi.bulkReset")}
            </button>
          </div>
        </Show>
        <div
          class="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface"
          data-testid="mcp-tools-table"
        >
          <For each={usable()}>
            {(t) => (
              <div
                data-testid={`mcp-tool-row-${t.name}`}
                class="flex flex-wrap items-center gap-3 px-3.5 py-2.5"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-[12.5px] text-text">{t.name}</span>
                    <span
                      data-testid={`mcp-tool-kind-${t.name}`}
                      data-kind={t.readOnly ? "read" : "write"}
                      class="rounded border border-border px-1.5 text-[10.5px] text-text-tertiary"
                    >
                      {i18n.t(t.readOnly ? "kernel.mcpUi.kindRead" : "kernel.mcpUi.kindWrite")}
                    </span>
                  </div>
                  <Show when={t.description}>
                    <div class="line-clamp-2 text-xs text-text-secondary">{t.description}</div>
                  </Show>
                  <div
                    class="flex items-center gap-2 text-[11px] text-text-tertiary"
                    data-testid={`mcp-tool-effective-${t.name}`}
                    data-decision={effectiveOf(t).decision ?? ""}
                    data-source={effectiveOf(t).source}
                  >
                    <Show
                      when={effectiveOf(t).decision}
                      fallback={i18n.t("kernel.mcpUi.followsDefault")}
                    >
                      {(d) => (
                        <span>
                          {i18n.t(
                            effectiveOf(t).source === "override"
                              ? "kernel.mcpUi.effectiveOverride"
                              : "kernel.mcpUi.effectiveDefault",
                            { decision: i18n.t(DECISION_LABEL[d()]) },
                          )}
                        </span>
                      )}
                    </Show>
                    <Show when={editable() && effectiveOf(t).source === "override"}>
                      <button
                        type="button"
                        data-testid={`mcp-tool-reset-${t.name}`}
                        class="underline hover:text-text"
                        onClick={() => void write(t.name, null)}
                      >
                        {i18n.t("kernel.mcpUi.resetTool")}
                      </button>
                    </Show>
                  </div>
                </div>
                <Show when={editable()}>
                  <fieldset
                    aria-label={i18n.t("kernel.mcpUi.policyFor", { tool: t.name })}
                    class="m-0 inline-flex min-w-0 flex-none overflow-hidden rounded-md border border-border p-0"
                  >
                    <For each={CHOICES}>
                      {(c) => (
                        <button
                          type="button"
                          aria-pressed={effectiveOf(t).decision === c.value}
                          data-testid={`mcp-tool-policy-${t.name}-${c.value}`}
                          data-source={
                            effectiveOf(t).decision === c.value ? effectiveOf(t).source : undefined
                          }
                          class="px-2.5 py-1 text-xs"
                          classList={{
                            // An override is set on this tool; a default is shown, quieter.
                            "bg-accent-glow text-accent font-medium":
                              effectiveOf(t).decision === c.value &&
                              effectiveOf(t).source === "override",
                            "bg-surface-hover text-text":
                              effectiveOf(t).decision === c.value &&
                              effectiveOf(t).source === "default",
                            "text-text-secondary hover:bg-surface-hover":
                              effectiveOf(t).decision !== c.value,
                          }}
                          onClick={() => choose(t, c.value)}
                        >
                          {i18n.t(c.label)}
                        </button>
                      )}
                    </For>
                  </fieldset>
                </Show>
              </div>
            )}
          </For>
          <For each={unavailable()}>
            {(t) => (
              <div
                data-testid={`mcp-tool-row-${t.name}`}
                data-unavailable="true"
                class="flex flex-wrap items-center gap-3 px-3.5 py-2.5"
              >
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2">
                    <span class="font-mono text-[12.5px] text-text-secondary">{t.name}</span>
                    <span
                      data-testid={`mcp-tool-unavailable-${t.name}`}
                      class="rounded border border-border px-1.5 text-[10.5px] text-text-tertiary"
                    >
                      {i18n.t("kernel.mcpUi.toolUnavailable")}
                    </span>
                  </div>
                  <div
                    class="text-[11px] text-text-tertiary"
                    data-testid={`mcp-tool-unavailable-reason-${t.name}`}
                  >
                    {i18n.t("kernel.mcpUi.toolUnavailableReason", {
                      reason: t.unavailableReason ?? "",
                    })}
                  </div>
                </div>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
  )
}
