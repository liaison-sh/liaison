// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE HELP SIDEBAR, beside the Help tab on desktop and tablet: a search box over
// the whole docs, then either the results or the docs' table of contents, the
// open page lit. The phone has no sidebar, so the tab shows the same box,
// results and contents itself (HelpTab.tsx); they live here once.
import type { HelpDocsIndex } from "@liaison/shared"
import { Search } from "lucide-solid"
import { type Component, createMemo, createResource, For, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { loadHelpIndex, searchHelp } from "./help-docs"
import { helpQuery, helpTarget, setHelpQuery, showHelpPage } from "./help-store"

/** The docs index, read once per session (help-docs.ts caches it). */
export function createHelpIndex() {
  return createResource(loadHelpIndex)
}

export const HelpSearchBox: Component<{ autofocus?: boolean }> = (props) => {
  const { t } = useI18n()
  return (
    <label class="flex items-center gap-2 rounded-md border border-border-subtle bg-surface px-2.5 py-1.5">
      <Search size={14} class="shrink-0 text-text-tertiary" />
      <span class="sr-only">{t("kernel.help.searchLabel")}</span>
      <input
        type="search"
        data-testid="help-search"
        placeholder={t("kernel.help.searchPlaceholder")}
        autocomplete="off"
        spellcheck={false}
        autofocus={props.autofocus}
        class="w-full bg-transparent text-[13px] text-text outline-none placeholder:text-text-tertiary"
        value={helpQuery()}
        onInput={(e) => setHelpQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setHelpQuery("")
        }}
      />
    </label>
  )
}

export const HelpResults: Component<{ index: HelpDocsIndex; onPicked?: () => void }> = (props) => {
  const { t } = useI18n()
  const hits = createMemo(() => searchHelp(props.index, helpQuery()))
  return (
    <Show
      when={hits().length > 0}
      fallback={
        <p data-testid="help-no-results" class="px-3 py-2 text-[12.5px] text-text-tertiary">
          {t("kernel.help.noResults", { query: helpQuery().trim() })}
        </p>
      }
    >
      <ul data-testid="help-results" class="flex flex-col gap-0.5">
        <For each={hits()}>
          {(hit) => (
            <li>
              <button
                type="button"
                data-testid="help-result"
                data-url={hit.entry.url}
                onClick={() => {
                  showHelpPage({ url: hit.entry.url, hash: hit.heading?.id ?? "" })
                  props.onPicked?.()
                }}
                class="flex w-full flex-col rounded px-3 py-1.5 text-left hover:bg-surface-hover"
              >
                <span class="truncate text-[13px] text-text">
                  {hit.heading ? hit.heading.text : hit.entry.title}
                </span>
                <span class="truncate text-[11.5px] text-text-tertiary">
                  {hit.heading
                    ? hit.entry.title
                    : [hit.entry.section, hit.snippet ?? hit.entry.description]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </Show>
  )
}

export const HelpNav: Component<{ index: HelpDocsIndex; onPicked?: () => void }> = (props) => {
  const pick = (url: string) => {
    showHelpPage({ url, hash: "" })
    props.onPicked?.()
  }
  const Row: Component<{ url: string; title: string }> = (row) => {
    const active = () => helpTarget().url === row.url
    return (
      <button
        type="button"
        data-testid="help-nav-page"
        data-url={row.url}
        aria-current={active() ? "page" : undefined}
        onClick={() => pick(row.url)}
        class={cn(
          "flex w-full items-center rounded px-3 py-1 text-left text-[13px] transition-colors",
          active()
            ? "bg-surface-active font-medium text-text"
            : "text-text-secondary hover:bg-surface-hover",
        )}
      >
        <span class="min-w-0 flex-1 truncate">{row.title}</span>
      </button>
    )
  }
  return (
    <div data-testid="help-nav" class="flex flex-col">
      <Row url={props.index.landing.url} title={props.index.landing.title} />
      <For each={props.index.sections}>
        {(section) => (
          <div class="mt-3">
            <h3 class="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary">
              {section.title}
            </h3>
            <For each={section.pages}>{(p) => <Row url={p.url} title={p.title} />}</For>
          </div>
        )}
      </For>
    </div>
  )
}

const HelpSidebar: Component = () => {
  const { t } = useI18n()
  const [index] = createHelpIndex()
  return (
    <nav
      data-testid="help-sidebar"
      aria-label={t("kernel.help.title")}
      class="flex h-full min-h-0 flex-col"
    >
      <div class="px-3 pb-2 pt-3">
        <HelpSearchBox />
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <Show when={index()}>
          {(idx) => (
            <Show when={helpQuery().trim()} fallback={<HelpNav index={idx()} />}>
              <HelpResults index={idx()} />
            </Show>
          )}
        </Show>
      </div>
    </nav>
  )
}

export default HelpSidebar
