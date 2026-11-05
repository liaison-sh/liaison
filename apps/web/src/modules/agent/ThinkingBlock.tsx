// SPDX-License-Identifier: FSL-1.1-ALv2
import { Brain, ChevronRight } from "lucide-solid"
import { marked } from "marked"
import { createMemo, createSignal, Show } from "solid-js"
import { sanitizeHtml } from "~/lib/sanitize"
import { useI18n } from "~/modules/i18n/i18n-context"

interface ThinkingBlockProps {
  /** Accumulated reasoning/thinking text (full text or a provider summary). May be empty. */
  reasoning?: string
  /** True while reasoning deltas are still arriving — auto-expands as "Thinking…". */
  streaming?: boolean
  /** Reasoning token count — lets the block show even when no readable text is emitted. */
  tokenCount?: number
  /** Provider only emitted a summary (OpenAI/Google) rather than full reasoning. */
  summary?: boolean
}

/**
 * Minimal, discrete-but-clear thinking block. Shows a live "Thinking" label
 * while reasoning streams, collapsed by default; the user can open it to read
 * the reasoning. Degrades across every provider shape:
 *   - full / summary text → expandable body (summary hint when applicable)
 *   - tokens only (encrypted/redacted reasoning) → static label, no body
 *   - nothing at all → renders nothing
 */
export default function ThinkingBlock(props: ThinkingBlockProps) {
  const i18n = useI18n()
  const text = () => props.reasoning?.trim() ?? ""
  const hasText = () => text().length > 0
  const visible = () => hasText() || !!props.streaming || (props.tokenCount ?? 0) > 0

  // Collapsed by default, even while streaming; once the user clicks, respect their choice.
  const [manual, setManual] = createSignal<boolean | null>(null)
  const expanded = createMemo(() => manual() ?? false)

  return (
    <Show when={visible()}>
      <div class="my-1" data-testid="thinking-block">
        <button
          type="button"
          disabled={!hasText()}
          onClick={() => hasText() && setManual(!expanded())}
          aria-expanded={expanded()}
          class="flex items-center gap-1.5 rounded px-1 py-0.5 text-[11px] font-medium text-text-tertiary transition-colors hover:text-text-secondary disabled:cursor-default disabled:hover:text-text-tertiary"
        >
          <Brain
            size={12}
            class="shrink-0"
            classList={{ "animate-pulse text-accent": props.streaming }}
          />
          <span>{props.streaming ? i18n.t("kernel.thinking") : i18n.t("kernel.thought")}</span>
          <Show when={props.summary && hasText()}>
            <span class="text-text-tertiary/70">· {i18n.t("kernel.thoughtSummary")}</span>
          </Show>
          <Show when={hasText()}>
            <ChevronRight
              size={11}
              class="shrink-0 transition-transform"
              classList={{ "rotate-90": expanded() }}
            />
          </Show>
        </button>
        <Show when={expanded() && hasText()}>
          <div
            class="prose-thread prose-thinking mt-0.5 border-l-2 border-border-subtle pl-2.5 leading-relaxed"
            innerHTML={sanitizeHtml(marked.parse(text(), { async: false }) as string)}
          />
        </Show>
      </div>
    </Show>
  )
}
