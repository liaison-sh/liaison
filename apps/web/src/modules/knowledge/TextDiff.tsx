// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two texts of a page, line by line: what one has that the other has not is
// marked. Used by Page history and by "See both" in a conflict. A page link is
// drawn as "Page link" (its title may be one the reader cannot see).

import { PAGE_TOKEN_RE } from "@liaison/shared"
import { type Component, createMemo, For } from "solid-js"
import { diffStats, lineDiff } from "~/lib/line-diff"
import { useI18n } from "~/modules/i18n/i18n-context"

export function diffOf(before: string, after: string) {
  const lines = lineDiff(before, after)
  return { lines, ...diffStats(lines) }
}

export const TextDiff: Component<{ before: string; after: string; "data-testid"?: string }> = (
  props,
) => {
  const i18n = useI18n()
  const label = () => `[${i18n.t("kernel.editor.pageLink")}]`
  const lines = createMemo(() => lineDiff(props.before, props.after))
  return (
    <div
      data-testid={props["data-testid"]}
      class="overflow-hidden rounded-md border border-border-subtle font-mono text-[12px] leading-relaxed"
    >
      <For each={lines()}>
        {(line) => (
          <div
            data-diff={line.type}
            class="flex"
            classList={{
              "bg-success/10 text-success": line.type === "add",
              "bg-danger/10 text-danger line-through decoration-danger/40": line.type === "del",
              "text-text-secondary": line.type === "same",
            }}
          >
            <span class="w-5 shrink-0 select-none text-center" aria-hidden="true">
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            <span class="min-w-0 whitespace-pre-wrap break-words px-1">
              {line.text.replace(PAGE_TOKEN_RE, label()) || " "}
            </span>
          </div>
        )}
      </For>
    </div>
  )
}

export default TextDiff
