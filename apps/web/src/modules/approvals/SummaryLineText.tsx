// SPDX-License-Identifier: FSL-1.1-ALv2
// One approval summary line as a person reads it: the platform's words as
// text, and any outside text the summarizer quoted (an import's sample
// record, fenced for the agent) as a visible quote, never as plain words that
// could pass for the platform's own.

import { type Component, For } from "solid-js"
import { quotedParts } from "~/lib/approval-summary-lines"
import { useI18n } from "~/modules/i18n/i18n-context"

export const SummaryLineText: Component<{
  line: string
  /** Applied to the platform's words only (e.g. turning @ref tokens into names). */
  format?: (text: string) => string
}> = (props) => {
  const i18n = useI18n()
  return (
    <For each={quotedParts(props.line)}>
      {(part, i) =>
        part.quoted ? (
          <>
            {i() > 0 ? " " : ""}
            <q
              data-testid="approval-line-quote"
              class="rounded border-l-2 border-border bg-surface-hover px-1.5 font-mono text-[0.92em] text-text-secondary before:content-none after:content-none"
              title={i18n.t("kernel.approvalQuote.label")}
            >
              <span class="sr-only">{i18n.t("kernel.approvalQuote.label")}: </span>
              {part.text}
            </q>
          </>
        ) : (
          <>
            {i() > 0 ? " " : ""}
            {props.format ? props.format(part.text) : part.text}
          </>
        )
      }
    </For>
  )
}
