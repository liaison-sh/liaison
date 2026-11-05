// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T11 — Sub-run collapsed/expanded card. Rendered inline in the thread view
// when a message carries `metadata.kind === 'sub_run'`. The collapsed card
// shows agentType, label, status, and (when present) summary. Clicking the
// header toggles the inline `SubRunTranscript` (T12) view of the hidden
// thread, so the operator can drill into the sub-run's reasoning without
// leaving their primary thread.

import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import SubRunTranscript from "~/modules/threads/SubRunTranscript"
import { AgentGlyph } from "~/ui/AgentGlyph"

export interface SubRunMetadata {
  runId: string
  hiddenThreadId: string
  agentType: string
  label: string
  status: "queued" | "running" | "done" | "failed" | "cancelled"
  summary: string | null
  usage: {
    promptTokens: number
    completionTokens: number
    creditCost: string
  }
}

interface SubRunCardProps {
  subRun: SubRunMetadata
  expanded: boolean
  onToggle: () => void
  hasPendingApproval?: boolean
}

/** Catalog keys, translated where the status is drawn. */
const STATUS_LABEL: Record<SubRunMetadata["status"], string> = {
  queued: "kernel.subRunStatus.queued",
  running: "kernel.subRunStatus.running",
  done: "kernel.subRunStatus.done",
  failed: "kernel.subRunStatus.failed",
  cancelled: "kernel.subRunStatus.cancelled",
}

const STATUS_TONE: Record<SubRunMetadata["status"], string> = {
  queued: "bg-neutral-100 text-neutral-700",
  running: "bg-blue-100 text-blue-700",
  done: "bg-green-100 text-green-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-neutral-100 text-neutral-500",
}

const SubRunCard: Component<SubRunCardProps> = (props) => {
  const i18n = useI18n()
  return (
    <div
      data-testid="sub-run-card"
      data-run-id={props.subRun.runId}
      data-status={props.subRun.status}
      class="my-2 rounded-md border border-neutral-200 bg-neutral-50 p-3"
    >
      <button
        type="button"
        class="flex w-full items-center justify-between gap-2 text-left"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
      >
        <div class="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" class="text-base">
            <AgentGlyph />
          </span>
          <span class="truncate text-sm font-medium text-text-primary">
            {props.subRun.agentType}
          </span>
          <span class="text-text-tertiary" aria-hidden="true">
            ·
          </span>
          <span class="truncate text-sm text-text-secondary">{props.subRun.label}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span
            data-testid="sub-run-status-badge"
            class={`rounded px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${STATUS_TONE[props.subRun.status]}`}
          >
            {i18n.t(STATUS_LABEL[props.subRun.status])}
          </span>
          <Show when={props.hasPendingApproval}>
            <span
              data-testid="sub-run-pending-approval"
              class="rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-800"
            >
              {i18n.t("kernel.threadsUi.approvalPending")}
            </span>
          </Show>
          <span aria-hidden="true" class="text-text-tertiary">
            {props.expanded ? "▼" : "▶"}
          </span>
        </div>
      </button>
      <Show when={props.subRun.summary}>
        <div data-testid="sub-run-summary" class="mt-2 text-sm text-text-secondary">
          {props.subRun.summary}
        </div>
      </Show>
      <Show when={props.expanded}>
        <SubRunTranscript hiddenThreadId={props.subRun.hiddenThreadId} />
      </Show>
    </div>
  )
}

export default SubRunCard
