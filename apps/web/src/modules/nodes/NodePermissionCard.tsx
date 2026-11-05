// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A NODE CHAT'S PERMISSION PROMPT, decided where the owner is (P4 N-D T6b,
// S24, A24). On a desktop local session the prompt is a card in front of the
// person; a chat on their node is driven from the web or the phone, so the
// node relays the prompt (POST /api/nodes/jobs/:id/permission-requests) and it
// arrives here as an attention row: what is asked, by which agent, from which
// node, with Allow and Deny. Nobody answering for 10 minutes is a deny (the
// server says so, and the node again).
//
//   POST /api/nodes/permission-requests/:id/decision   { allow }

import type { AttentionItem } from "@liaison/shared"
import { Check, Server, X } from "lucide-solid"
import { type Component, createSignal, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { markAttentionRead } from "~/modules/shell/entity-opener"
import { addToast } from "~/modules/shell/toast-store"
import { createNow } from "~/primitives/createNow"

/** What a relayed prompt's row carries (permission-prompts.ts `nodePermission`). */
export interface NodePermissionPrompt {
  promptId: string
  jobId: string | null
  nodeName: string | null
  agentName: string | null
  toolName: string
  summary: string
  expiresAt: string | null
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null

/** The relayed prompt an attention row is, or null for any other row. */
export function nodePermissionPromptOf(item: AttentionItem): NodePermissionPrompt | null {
  if (item.kind !== "agent_notification") return null
  const raw = item.metadata?.nodePermission as Record<string, unknown> | undefined
  const promptId = str(raw?.promptId) ?? str(item.metadata?.nodePermissionPromptId)
  if (!raw || !promptId) return null
  return {
    promptId,
    jobId: str(raw.jobId),
    nodeName: str(raw.nodeName),
    agentName: str(raw.agentName),
    toolName: str(raw.toolName) ?? "",
    summary: typeof raw.summary === "string" ? raw.summary : "",
    expiresAt: str(raw.expiresAt),
  }
}

export const nodePermissionDecisionPath = (promptId: string) =>
  `/nodes/permission-requests/${encodeURIComponent(promptId)}/decision`

const NodePermissionCard: Component<{
  item: AttentionItem
  prompt: NodePermissionPrompt
  /** The owner's answer was recorded (the chat keeps a line saying so). */
  onDecided?: (allow: boolean) => void
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [submitting, setSubmitting] = createSignal(false)
  const [decided, setDecided] = createSignal<"allowed" | "denied" | null>(null)
  // The clock the owner is racing (A24: denied after 10 minutes): shown as
  // time left, not as a rule, so a prompt found late reads as late.
  const now = createNow(15_000)
  const expiryLine = (): string => {
    const at = props.prompt.expiresAt ? Date.parse(props.prompt.expiresAt) : Number.NaN
    if (!Number.isFinite(at)) return i18n.t("kernel.nodes.permissionCard.expires")
    const left = at - now()
    if (left <= 0) return i18n.t("kernel.nodes.permissionCard.expired")
    if (left < 60_000) return i18n.t("kernel.nodes.permissionCard.expiresUnderAMinute")
    return i18n.t("kernel.nodes.permissionCard.expiresIn", {
      minutes: String(Math.ceil(left / 60_000)),
    })
  }

  const title = () =>
    i18n.t("kernel.nodes.permissionCard.title", {
      agent: props.prompt.agentName ?? i18n.t("kernel.nodes.permissionCard.yourAgent"),
      node: props.prompt.nodeName ?? i18n.t("kernel.nodes.permissionCard.yourNode"),
      tool: props.prompt.toolName,
    })

  async function decide(allow: boolean) {
    if (submitting() || decided()) return
    setSubmitting(true)
    try {
      await api.post(nodePermissionDecisionPath(props.prompt.promptId), { allow })
      setDecided(allow ? "allowed" : "denied")
      props.onDecided?.(allow)
      markAttentionRead(api, props.item.app, props.item.entity, props.item.entityId)
    } catch (error) {
      const late = error instanceof ApiError && (error.status === 409 || error.status === 404)
      addToast({
        message: i18n.t(
          late ? "kernel.nodes.permissionCard.late" : "kernel.nodes.permissionCard.failed",
        ),
        type: late ? "info" : "error",
      })
      if (late) markAttentionRead(api, props.item.app, props.item.entity, props.item.entityId)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <li
      data-testid="node-permission-card"
      data-kind={props.item.kind}
      aria-label={i18n.t("kernel.nodes.permissionCard.label")}
      class="flex flex-wrap items-start gap-3 px-4 py-3"
    >
      <Server size={16} class="mt-0.5 shrink-0 text-text-tertiary" />
      <div class="flex min-w-[220px] flex-1 flex-col gap-1">
        <span class="text-[13px] font-medium text-text">{title()}</span>
        <Show when={props.prompt.summary}>
          <code
            data-testid="node-permission-detail"
            class="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-surface-hover px-1.5 py-1 font-mono text-[12px] text-text-secondary"
          >
            {props.prompt.summary}
          </code>
        </Show>
        <span data-testid="node-permission-expiry" class="text-[11.5px] text-text-tertiary">
          {expiryLine()}
        </span>
      </div>
      <Show
        when={decided()}
        fallback={
          <div class="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-testid="node-permission-deny"
              disabled={submitting()}
              onClick={() => void decide(false)}
              class="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12.5px] text-text-secondary transition-colors hover:bg-surface-hover disabled:opacity-50"
            >
              <X size={13} />
              {i18n.t("kernel.nodes.permissionCard.deny")}
            </button>
            <button
              type="button"
              data-testid="node-permission-allow"
              disabled={submitting()}
              onClick={() => void decide(true)}
              class="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12.5px] font-medium text-accent-foreground transition-colors hover:opacity-90 disabled:opacity-50"
            >
              <Check size={13} />
              {i18n.t("kernel.nodes.permissionCard.allow")}
            </button>
          </div>
        }
      >
        {(state) => (
          <span class="shrink-0 text-[12.5px] text-text-secondary">
            {i18n.t(
              state() === "allowed"
                ? "kernel.nodes.permissionCard.allowed"
                : "kernel.nodes.permissionCard.denied",
            )}
          </span>
        )}
      </Show>
    </li>
  )
}

export default NodePermissionCard
