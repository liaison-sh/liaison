// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The tools review: the last step of adding an MCP server, as a dialog the
// person completes before the server counts as added. It opens by itself once
// the sign-in or the connect succeeds (also when the person comes back from
// the sign-in tab), and when an admin opens a server whose tools nobody has
// reviewed yet (`toolsReviewedAt` is null).
//
//   - One click sets the connection default policy: "Allow reads, approve
//     changes" (gate_writes, recommended, preselected), "Every call needs
//     approval" (gate_all) or "Allow everything" (auto, with a warning).
//   - The tool list (ToolsTab) shows each tool's Read / Write badge from the
//     server's annotations and its effective decision under the choice above,
//     live before Done: its own override, else the default's, marked "default".
//   - Who can use it (an org server, for an MCP manager admin): Everyone,
//     preselected, or only some roles and people, in one compact row.
//   - Done saves the default policy (and the access) and marks the tools reviewed. Escape or the
//     close button keeps the connection's current default (nothing changes) and
//     also marks the review done, so it does not come back.
import { type Component, createEffect, createResource, createSignal, For, on, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  listConnectionTools,
  patchConnection,
  setConnectionAccess,
} from "~/modules/mcp-manager/api"
import { EVERYONE, McpAccessRow } from "~/modules/mcp-manager/McpAccessSection"
import { ToolsTab } from "~/modules/mcp-manager/tabs/ToolsTab"
import type {
  McpConnectionAccess,
  McpDefaultPolicy,
  McpToolSummary,
} from "~/modules/mcp-manager/types"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

interface Props {
  open: boolean
  connectionId: string
  serverName: string
  /** The connection's current default policy (what closing keeps). */
  currentPolicy: McpDefaultPolicy
  /** The tools to show; read from the server when left out. */
  tools?: McpToolSummary[]
  /** Per-tool choices need `mcp_manager:policy:write`; off for a personal server. */
  toolsEditable?: boolean
  /**
   * The server's slug when the dialog offers "Who can use it": an org server and
   * a person who may decide (`mcp_manager:connection:admin`). Left out otherwise.
   */
  accessSlug?: string
  /** `saved` is true after Done, false after Escape or the close button. */
  onClose: (saved: boolean) => void
}

const CHOICES: Array<{ value: McpDefaultPolicy; label: string; hint: string }> = [
  {
    value: "gate_writes",
    label: "kernel.mcpUi.reviewPolicyGateWrites",
    hint: "kernel.mcpUi.reviewPolicyGateWritesHint",
  },
  {
    value: "gate_all",
    label: "kernel.mcpUi.policyGateAll",
    hint: "kernel.mcpUi.reviewPolicyGateAllHint",
  },
  {
    value: "auto",
    label: "kernel.mcpUi.reviewPolicyAuto",
    hint: "kernel.mcpUi.reviewPolicyAutoWarn",
  },
]

const POLICY_LABEL_KEYS: Record<McpDefaultPolicy, string> = {
  auto: "kernel.mcpUi.policyAuto",
  gate_writes: "kernel.mcpUi.policyGateWrites",
  gate_all: "kernel.mcpUi.policyGateAll",
}

export const McpToolsReviewDialog: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  // Recommended and preselected: reads run, changes need approval.
  const [policy, setPolicy] = createSignal<McpDefaultPolicy>("gate_writes")
  // Everyone preselected, as a new org server is.
  const [access, setAccess] = createSignal<McpConnectionAccess>(EVERYONE)
  const [saving, setSaving] = createSignal(false)
  // The count, when the tools are not given (a server reopened from its page).
  const [held] = createResource(
    () => (props.open && !props.tools ? props.connectionId : null),
    (id) => listConnectionTools(api, id),
  )
  // Tools agents can use: an unavailable one (unconvertible schema) is not counted.
  const toolCount = () =>
    (props.tools ?? held.latest ?? []).filter((t) => !t.unavailableReason).length
  const [error, setError] = createSignal<string | null>(null)
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setPolicy("gate_writes")
          setAccess(EVERYONE)
          setError(null)
        }
      },
    ),
  )

  async function done(): Promise<void> {
    setSaving(true)
    setError(null)
    try {
      if (props.accessSlug) await setConnectionAccess(api, props.connectionId, access())
      await patchConnection(api, props.connectionId, {
        connectionDefaultPolicy: policy(),
        toolsReviewed: true,
      })
      props.onClose(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  function dismiss(): void {
    // The safe default stays: only the review is marked done.
    void patchConnection(api, props.connectionId, { toolsReviewed: true }).catch(() => {})
    props.onClose(false)
  }

  return (
    <Dialog open={props.open} onOpenChange={(open) => !open && dismiss()}>
      <Dialog.Content class="flex max-h-[85vh] w-full max-w-2xl flex-col">
        <div data-testid="mcp-tools-review" class="flex min-h-0 flex-col gap-4">
          <div class="flex items-start justify-between gap-3">
            <div>
              <Dialog.Title>
                {i18n.t("kernel.mcpUi.reviewTitle", { name: props.serverName })}
              </Dialog.Title>
              <Dialog.Description>
                <span data-testid="mcp-tools-review-count">
                  {i18n.t("kernel.mcpUi.reviewToolCount", { count: toolCount() })}
                </span>
              </Dialog.Description>
            </div>
            <Dialog.Close
              data-testid="mcp-tools-review-close"
              aria-label={i18n.t("kernel.mcpUi.reviewClose")}
              class="rounded-md px-2 py-1 text-text-secondary hover:bg-surface-hover"
            >
              ✕
            </Dialog.Close>
          </div>
          <fieldset class="m-0 flex flex-col gap-2 border-0 p-0" data-testid="mcp-review-policies">
            <legend class="mb-1 text-sm font-medium text-text">
              {i18n.t("kernel.mcpUi.connectionDefaultPolicy")}
            </legend>
            <For each={CHOICES}>
              {(c) => (
                <label
                  class="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm"
                  classList={{
                    "border-accent bg-accent-glow": policy() === c.value,
                    "border-border": policy() !== c.value,
                  }}
                >
                  <input
                    type="radio"
                    name="mcp-review-policy"
                    class="mt-1"
                    value={c.value}
                    checked={policy() === c.value}
                    data-testid={`mcp-review-policy-${c.value}`}
                    onChange={() => setPolicy(c.value)}
                  />
                  <span class="flex flex-col">
                    <span class="font-medium text-text">
                      {i18n.t(c.label)}
                      <Show when={c.value === "gate_writes"}>
                        <span class="ml-2 text-xs font-normal text-text-tertiary">
                          {i18n.t("kernel.mcpUi.reviewRecommended")}
                        </span>
                      </Show>
                    </span>
                    <span
                      class="text-xs"
                      classList={{
                        "text-error": c.value === "auto",
                        "text-text-secondary": c.value !== "auto",
                      }}
                    >
                      {i18n.t(c.hint)}
                    </span>
                  </span>
                </label>
              )}
            </For>
          </fieldset>
          <Show when={props.accessSlug} keyed>
            {(slug) => <McpAccessRow slug={slug} value={access()} onChange={setAccess} />}
          </Show>
          <div class="min-h-0 overflow-y-auto">
            <ToolsTab
              connectionId={props.connectionId}
              tools={props.tools}
              editable={props.toolsEditable !== false}
              defaultPolicy={policy()}
            />
          </div>
          <Show when={error()}>
            <div class="text-sm text-error" role="alert">
              {error()}
            </div>
          </Show>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <span class="text-xs text-text-tertiary" data-testid="mcp-tools-review-dismiss-hint">
              {i18n.t("kernel.mcpUi.reviewDismissHint", {
                policy: i18n.t(POLICY_LABEL_KEYS[props.currentPolicy]),
              })}
            </span>
            <Button
              data-testid="mcp-tools-review-done"
              disabled={saving()}
              onClick={() => void done()}
            >
              {i18n.t("kernel.mcpUi.done")}
            </Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog>
  )
}
