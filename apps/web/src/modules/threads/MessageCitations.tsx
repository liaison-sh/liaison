// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The sources an agent's answer links to, listed under it: every distinct
 * web page the message cites, by host, so a person can check where an answer
 * came from at a glance (`message-citations`). A page is an `http(s)` link, or
 * a bare address with a path (`eur-lex.europa.eu/eli/reg/2023/1542/oj/eng`) or
 * a `www.` one, which models often write in a "Sources:" list and which is
 * read as https. Nothing when the message links no page.
 */
import { type Component, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"

/** At most this many sources are listed (an answer citing more keeps its inline links). */
export const MAX_CITATIONS = 8

/** The last character of a link: never the sentence's punctuation after it. */
const LINK_END = `[^\\s<>()\\].,;:!?'"]`
/** A host name: dot-separated labels ending in an alphabetic top-level domain. */
const HOST = "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,24}"
/**
 * A bare address: a host followed by a path, or a `www.` host. Never part of a
 * word, a path, an email or a full link (the lookbehind), so a file name
 * (`seed-demo.ts`) or a version (`Node.js 22`) is not one.
 */
const BARE = `(?<![\\w@./:\\-])((?:www\\.${HOST}(?:\\/(?:[^\\s<>()\\]]*${LINK_END})?)?)|(?:${HOST}\\/(?:[^\\s<>()\\]]*${LINK_END})?))`
const LINK = new RegExp(
  `\\]\\((https?:\\/\\/[^\\s)]+)\\)|(?<![(\\w])(https?:\\/\\/[^\\s<>()\\]]+${LINK_END})|${BARE}`,
  "gi",
)

export interface Citation {
  url: string
  host: string
}

/** The distinct web pages a message's text links to, in order of appearance. */
export function citationsOf(content: string | null | undefined): Citation[] {
  if (!content) return []
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const m of content.matchAll(LINK)) {
    const raw = m[1] ?? m[2] ?? (m[3] ? `https://${m[3]}` : undefined)
    if (!raw) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue
    const key = url.href
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ url: url.href, host: url.hostname.replace(/^www\./, "") })
    if (out.length >= MAX_CITATIONS) break
  }
  return out
}

export const MessageCitations: Component<{
  content: string | null | undefined
  /** The agent turn the answer belongs to (`metadata.turnId`, its trigger). */
  turnId?: string | null
  /**
   * The person's message the answer answers (`metadata.askId`). `data-turn-id`
   * is `askId ?? turnId`: the question this answers, also after an approval,
   * whose handed-back turn is triggered by the result row.
   */
  askId?: string | null
}> = (props) => {
  const i18n = useI18n()
  const citations = () => citationsOf(props.content)
  return (
    <Show when={citations().length > 0}>
      <div
        data-testid="message-citations"
        data-turn-id={props.askId ?? props.turnId ?? undefined}
        class="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]"
      >
        <span class="text-text-tertiary">{i18n.t("kernel.knowledgeSources")}</span>
        <For each={citations()}>
          {(citation, index) => (
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="message-citation"
              title={citation.url}
              class="inline-flex max-w-[220px] items-center gap-1 truncate rounded-full border border-border-subtle px-2 py-0.5 text-text-secondary hover:bg-surface-hover hover:text-text"
            >
              <span class="text-text-tertiary">{index() + 1}</span>
              <span class="truncate">{citation.host}</span>
            </a>
          )}
        </For>
      </div>
    </Show>
  )
}
