// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Two texts of a page, block by block (a line of its markdown): what one has that the
// other has not is marked, added in green, removed in red and struck through. Each
// block is drawn as the page draws it (headings, lists, bold, links), never as raw
// markdown: an image shows as a small picture (or its name when it cannot be read),
// a page link as "Page link" (its title may be one the reader cannot see). Blank
// separator lines are not drawn. Used by Page history and by "See both" in a conflict.

import { PAGE_TOKEN_RE } from "@liaison/shared"
import { type Component, createMemo, For, onCleanup, Show } from "solid-js"
import { diffStats, lineDiff } from "~/lib/line-diff"
import type { FileViewDeps } from "~/modules/editor/file-view"
import { useI18n } from "~/modules/i18n/i18n-context"
import { hydrateFileTokens } from "./hydrate-tokens"
import { renderMarkdown } from "./markdown"

export function diffOf(before: string, after: string) {
  const lines = lineDiff(before, after)
  return { lines, ...diffStats(lines) }
}

/** A fence line (```), drawn as the code marker it is, never as an empty code block. */
const FENCE = /^ {0,3}(```|~~~)/

export const TextDiff: Component<{
  before: string
  after: string
  /** How the page draws its files; without it an image shows its neutral label. */
  files?: FileViewDeps | null
  "data-testid"?: string
}> = (props) => {
  const i18n = useI18n()
  const label = () => `[${i18n.t("kernel.editor.pageLink")}]`
  const lines = createMemo(() =>
    lineDiff(props.before, props.after).filter((l) => l.text.trim() !== ""),
  )
  const draw = (el: HTMLElement, text: string) => {
    const source = text.replace(PAGE_TOKEN_RE, label())
    if (FENCE.test(source)) {
      el.textContent = source.trim()
      return
    }
    el.innerHTML = renderMarkdown(source)
    const stop = hydrateFileTokens(el, props.files ?? null, i18n.t("kernel.editor.fileToken"))
    onCleanup(stop)
  }
  return (
    <div
      data-testid={props["data-testid"]}
      class="overflow-hidden rounded-md border border-border-subtle text-[13px] leading-relaxed"
    >
      <For each={lines()}>
        {(line) => (
          <div
            data-diff={line.type}
            class="flex"
            classList={{
              "bg-success/10": line.type === "add",
              "bg-danger/10": line.type === "del",
              "text-text-secondary": line.type === "same",
            }}
          >
            <span
              class="w-5 shrink-0 select-none pt-1 text-center font-mono text-[12px]"
              classList={{
                "text-success": line.type === "add",
                "text-danger": line.type === "del",
              }}
              aria-hidden="true"
            >
              {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
            </span>
            <Show when={line.type === "add" || line.type === "del"} fallback={null}>
              <span class="sr-only">
                {i18n.t(line.type === "add" ? "knowledge.diff.added" : "knowledge.diff.removed")}
              </span>
            </Show>
            <div
              data-testid="history-diff-block"
              class="history-diff-block min-w-0 flex-1 break-words px-1 py-0.5"
              classList={{ "line-through decoration-danger/40": line.type === "del" }}
              ref={(el) => draw(el, line.text)}
            />
          </div>
        )}
      </For>
    </div>
  )
}

export default TextDiff
