// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T12 — Inline view of a sub-run's hidden thread. Fetches the hidden-thread
// messages from the existing `GET /threads/:id/messages` endpoint (backend
// participant check augmented in T12 to allow parents-of-subruns to read the
// hidden thread). Renders read-only; no compose bar, no reactions.
//
// The component intentionally stays minimal in T11 — it's a thin wrapper that
// emits `<SubRunTranscript hiddenThreadId="..." />` and resolves the messages
// asynchronously. The richer message renderer used by ThreadView is reused
// once the backend route lands; until then we render placeholder rows so the
// outer card layout is exercisable in tests.

import { type Component, createResource, For, Show } from "solid-js"
import ThinkingBlock from "~/modules/agent/ThinkingBlock"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

interface SubRunTranscriptProps {
  hiddenThreadId: string
}

interface SubRunMessage {
  id: string
  content: string | null
  authorType: "user" | "agent" | "system" | "mcp"
  createdAt: string
  metadata?: { reasoning?: string; usage?: { reasoningTokens?: number } } | null
}

const SubRunTranscript: Component<SubRunTranscriptProps> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [messages] = createResource(
    () => props.hiddenThreadId,
    async (id) => {
      const res = (await api.get(`/threads/${id}/messages`)) as unknown as
        | { data?: SubRunMessage[] }
        | SubRunMessage[]
      // The API client returns the unwrapped envelope on success. Sub-run
      // transcripts are best-effort UX — show whatever we got, including
      // the empty case.
      if (Array.isArray(res)) return res
      return res?.data ?? []
    },
  )

  return (
    <div
      data-testid="sub-run-transcript"
      data-hidden-thread-id={props.hiddenThreadId}
      class="mt-3 space-y-1 rounded border border-neutral-200 bg-white p-2"
    >
      <Show
        when={!messages.loading}
        fallback={
          <div class="text-xs text-text-tertiary">
            {i18n.t("kernel.threadsUi.loadingTranscript")}
          </div>
        }
      >
        <Show
          when={(messages() ?? []).length > 0}
          fallback={
            <div class="text-xs text-text-tertiary">
              {i18n.t("kernel.threadsUi.noMessagesInThisSubRun")}
            </div>
          }
        >
          <For each={messages() ?? []}>
            {(m) => (
              <div data-testid="sub-run-message" class="text-sm">
                <span class="mr-2 text-[10px] uppercase tracking-wide text-text-tertiary">
                  {m.authorType}
                </span>
                <span>{m.content ?? ""}</span>
                <Show when={m.authorType === "agent"}>
                  <ThinkingBlock
                    reasoning={m.metadata?.reasoning}
                    tokenCount={m.metadata?.usage?.reasoningTokens}
                  />
                </Show>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  )
}

export default SubRunTranscript
