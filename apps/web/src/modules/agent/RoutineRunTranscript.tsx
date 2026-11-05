// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * ONE RUN OF A ROUTINE, READ WHERE THE ROUTINE LIVES.
 *
 * A routine's runs all write into its output thread, which is a run log, not a
 * chat room: it stays out of Channels and Direct messages. This pane is where
 * a run is read instead, on the agent page under the routine that ran: the
 * run's own slice of the thread (`GET /agent/routines/:id/runs/:runId/messages`),
 * read only, each message drawn with the same pieces the chat view uses (the
 * markdown renderer and the agent's tool activity). "Open the full log" still
 * opens the whole thread by its id for the rare reader who wants every run.
 */
import { ChevronLeft } from "lucide-solid"
import { type Component, createResource, For, Show } from "solid-js"
import { formatDateTime } from "~/lib/relative-time"
import AgentActivity from "~/modules/agent/AgentActivity"
import { runStatusLabel } from "~/modules/agent/routine-status-copy"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { createMentionDelegate, renderContent } from "~/modules/shell/markdown-content"
import { openTab } from "~/modules/shell/tab-store"
import type { Message } from "~/modules/threads/message-store"
import Chip from "./Chip"
import { formatRunDuration, runTone, runTriggerLabel } from "./routine-run-copy"
import { loadRoutineRunTranscript } from "./routines-store"

interface Props {
  routineId: string
  routineName: string
  runId: string
  /** The routine's kind, which names the trigger of a run that did not record one. */
  routineKind?: string | null
  onBack: () => void
}

const RoutineRunTranscript: Component<Props> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const mentionDelegate = createMentionDelegate(api as any)
  const [transcript] = createResource(
    () => [props.routineId, props.runId] as const,
    ([routineId, runId]) => loadRoutineRunTranscript(api as any, routineId, runId),
  )

  function openFullLog() {
    const threadId = transcript()?.outputThreadId
    if (!threadId) return
    openTab({ type: "kernel:thread", entityId: threadId, label: props.routineName })
  }

  return (
    <div data-testid="routine-run-transcript" class="flex h-full flex-col">
      <div class="flex items-center gap-2 border-b border-border-subtle px-6 py-3">
        <button
          type="button"
          data-testid="routine-run-back"
          onClick={() => props.onBack()}
          class="flex min-h-8 items-center gap-1 rounded-md px-1 text-[13px] text-text-secondary transition-colors hover:bg-surface-hover"
        >
          <ChevronLeft size={14} />
          {i18n.t("kernel.agentForms.backToRoutine")}
        </button>
        <Show when={transcript()?.outputThreadId}>
          <button
            type="button"
            data-testid="routine-run-full-log"
            onClick={openFullLog}
            class="ml-auto rounded-md border border-border-subtle px-3 py-1 text-[12px] text-text-tertiary transition-colors hover:bg-surface-hover"
          >
            {i18n.t("kernel.agentForms.openFullLog")}
          </button>
        </Show>
      </div>

      <div class="min-h-0 flex-1 overflow-auto px-6 py-4">
        <Show
          when={!transcript.loading}
          fallback={
            <p class="text-[13px] text-text-tertiary">
              {i18n.t("kernel.agentForms.runTranscriptLoading")}
            </p>
          }
        >
          <Show
            when={!transcript.error && transcript()}
            fallback={
              <p data-testid="routine-run-error" class="text-[13px] text-amber-500">
                {i18n.t("kernel.agentForms.runTranscriptFailed")}
              </p>
            }
          >
            {(t) => (
              <>
                <h2 class="text-[15px] font-medium text-text">{props.routineName}</h2>
                <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-text-tertiary">
                  <span data-testid="routine-run-time">
                    {formatDateTime(t().run.startedAt ?? t().run.ranAt, i18n.locale())}
                  </span>
                  <Show when={runTriggerLabel(i18n.t, t().run, props.routineKind)}>
                    {(label) => <Chip data-testid="routine-run-trigger">{label()}</Chip>}
                  </Show>
                  <Show when={formatRunDuration(t().run.durationMs, i18n.locale())}>
                    {(d) => <span data-testid="routine-run-duration">{d()}</span>}
                  </Show>
                  <Chip tone={runTone(t().run.status)} data-testid="routine-run-outcome">
                    {runStatusLabel(i18n.t, t().run.status)}
                  </Chip>
                </div>
                <Show when={t().run.errorMessage}>
                  <p class="mt-2 text-[12px] text-amber-500">{t().run.errorMessage}</p>
                </Show>

                <ol class="mt-4 flex flex-col gap-4">
                  <For
                    each={t().messages}
                    fallback={
                      <li class="text-[13px] text-text-tertiary">
                        {i18n.t("kernel.agentForms.runNoTranscript")}
                      </li>
                    }
                  >
                    {(m) => <TranscriptMessage message={m} mentionDelegate={mentionDelegate} />}
                  </For>
                </ol>
              </>
            )}
          </Show>
        </Show>
      </div>
    </div>
  )
}

const TranscriptMessage: Component<{
  message: Message
  mentionDelegate: (e: MouseEvent) => void
}> = (props) => {
  const i18n = useI18n()
  const isAgent = () => props.message.authorType === "agent"
  const toolCalls = () => props.message.metadata?.toolCalls ?? []
  return (
    <li data-testid={`routine-run-message-${props.message.id}`} class="flex flex-col gap-1">
      <div class="flex items-baseline gap-2">
        <span class="text-[13px] font-medium text-text">{props.message.authorName}</span>
        <span class="text-[11px] text-text-tertiary">
          {formatDateTime(props.message.createdAt, i18n.locale(), { timeStyle: "short" })}
        </span>
      </div>
      <Show when={isAgent() && toolCalls().length > 0}>
        <AgentActivity
          toolCalls={toolCalls()}
          reasoning={props.message.metadata?.reasoning}
          reasoningTokens={props.message.metadata?.usage?.reasoningTokens}
          timeline={props.message.metadata?.timeline}
        />
      </Show>
      <Show when={!props.message.deletedAt && props.message.content}>
        {(content) => (
          <div class="text-[13px] text-text">{renderContent(content(), props.mentionDelegate)}</div>
        )}
      </Show>
    </li>
  )
}

export default RoutineRunTranscript
