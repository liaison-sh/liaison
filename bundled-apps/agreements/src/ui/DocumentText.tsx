// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A draft's text as the reader will read it: headings, paragraphs, articles with their
// computed numbers, and the other blocks (parties, recitals, tables, the signature block)
// named, never dropped. Read only: the editor writes, this shows.
import { type Component, For, Match, Show, Switch } from "solid-js"
import { tr } from "./i18n"
import { type AgreementSource, articleNumbers, blocksOf, layoutOf, type SourceBlock } from "./model"

const BLOCK_NAME: Record<string, string> = {
  parties: "The parties",
  recitals: "Recitals",
  table: "A table",
  signature_block: "The signature block",
  annex: "An annex",
  definitions: "Definitions",
  toc: "Table of contents",
  list: "A list",
  image: "A picture",
  spacer: "A space",
  repeat: "A repeated part",
}

function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

export function articleLabel(number: string | null, layout: string, level: number): string {
  if (!number) return ""
  return level === 1 && layout === "legal" ? tr("Article {{n}}", { n: number }) : number
}

export const DocumentText: Component<{ source: AgreementSource | null }> = (props) => {
  const blocks = () => blocksOf(props.source)
  const numbers = () => articleNumbers(blocks())
  const layout = () => layoutOf(props.source)
  return (
    <article
      data-testid="agreement-document-text"
      data-layout={layout()}
      class={`flex flex-col gap-3 rounded-sm border border-border bg-bg px-6 py-6 text-[13px] leading-relaxed text-text ${layout() === "legal" ? "font-serif text-justify" : ""}`}
    >
      <Show when={blocks().length === 0}>
        <p class="text-text-tertiary">{tr("The document has no text yet.")}</p>
      </Show>
      <For each={blocks()}>
        {(b: SourceBlock, i) => (
          <Switch>
            <Match when={b.type === "heading"}>
              <h3
                class={
                  Number(b.level ?? 1) === 1
                    ? "text-[17px] font-semibold"
                    : "text-[14px] font-semibold"
                }
              >
                {str(b.text)}
              </h3>
            </Match>
            <Match when={b.type === "paragraph"}>
              <p class="whitespace-pre-wrap">{str(b.text)}</p>
            </Match>
            <Match when={b.type === "article"}>
              <div>
                <p class="font-semibold">
                  {articleLabel(numbers()[i()] ?? null, layout(), Number(b.level ?? 1))}
                  <Show when={str(b.heading)}> {str(b.heading)}</Show>
                </p>
                <p class="whitespace-pre-wrap">{str(b.text)}</p>
              </div>
            </Match>
            <Match when={true}>
              <p class="text-[12px] italic text-text-tertiary">
                {tr(BLOCK_NAME[String(b.type)] ?? "A block from the template")}
              </p>
            </Match>
          </Switch>
        )}
      </For>
    </article>
  )
}
