// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE HELP TAB (`/help`): the user docs (docs/, published at liaison.sh/docs),
// read from the copy this build ships (help-docs.ts), so they match the version
// running and open offline, on desktop and phone alike. A page link stays in the
// tab, an outside link opens in the browser, "Open in browser" opens the same
// page on the site. Search and the contents sit in the sidebar (HelpSidebar.tsx);
// the phone, which has none, shows them at the top of the tab.
import { ExternalLink } from "lucide-solid"
import { type Component, createEffect, createResource, on, Show } from "solid-js"
import { openExternalUrl } from "~/modules/desktop/desktop-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { shellTier } from "~/modules/shell/shell-tier"
import { Button } from "~/ui/Button"
import { createHelpIndex, HelpNav, HelpResults, HelpSearchBox } from "./HelpSidebar"
import { helpSiteUrl, helpTargetOf, loadHelpPage } from "./help-docs"
import { helpNavSeq, helpQuery, helpTarget, showHelpPage } from "./help-store"
import "./help-docs.css"

/** In the system browser on the desktop app, a new browser tab elsewhere. */
async function openOutside(url: string): Promise<void> {
  if (await openExternalUrl(url)) return
  window.open(url, "_blank", "noopener,noreferrer")
}

const HelpTab: Component = () => {
  const { t } = useI18n()
  const [index, { refetch: refetchIndex }] = createHelpIndex()
  const [page, { refetch: refetchPage }] = createResource(
    // Keyed by a non-empty string: the landing page's url is "", which a resource skips.
    () => `page:${helpTarget().url}`,
    (key) => loadHelpPage(key.slice("page:".length)),
  )
  const phone = () => shellTier() === "phone"
  const searching = () => phone() && helpQuery().trim() !== ""
  let scroller: HTMLDivElement | undefined

  // A new page, or a link to an anchor: go to the anchor, else the top.
  createEffect(
    // An errored resource throws when read: check its error first.
    on([() => (page.error ? undefined : page()), helpNavSeq], ([shown]) => {
      if (!shown || !scroller) return
      const hash = helpTarget().hash
      requestAnimationFrame(() => {
        if (!scroller) return
        const el = hash ? scroller.querySelector(`[id="${CSS.escape(hash)}"]`) : null
        if (el) el.scrollIntoView({ block: "start" })
        else scroller.scrollTop = 0
      })
    }),
  )

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    const copy = target.closest("button.copy")
    if (copy) {
      const code = copy.closest(".code")?.querySelector("pre code")?.textContent ?? ""
      void navigator.clipboard?.writeText(code).then(() => {
        copy.textContent = t("kernel.help.copied")
        setTimeout(() => {
          copy.textContent = t("kernel.help.copy")
        }, 1500)
      })
      return
    }
    const a = target.closest("a")
    const href = a?.getAttribute("href")
    if (!a || !href) return
    e.preventDefault()
    if (href.startsWith("#")) {
      showHelpPage({ url: helpTarget().url, hash: href.slice(1) })
      return
    }
    const inDocs = helpTargetOf(href)
    if (inDocs) showHelpPage(inDocs)
    else if (/^https?:\/\//i.test(href)) void openOutside(href)
  }

  const failed = () => Boolean(page.error || index.error)

  return (
    <div data-testid="help-tab" class="flex h-full min-h-0 flex-col bg-surface">
      <Show when={phone()}>
        <div class="px-4 pb-2 pt-3">
          <HelpSearchBox />
        </div>
      </Show>
      <div ref={scroller} class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={!searching()}
          fallback={
            <Show when={index()}>
              {(idx) => (
                <div class="px-2 pb-6">
                  <HelpResults index={idx()} />
                </div>
              )}
            </Show>
          }
        >
          <Show
            when={!failed()}
            fallback={
              <div data-testid="help-load-failed" class="flex flex-col items-start gap-3 p-6">
                <p class="text-[13.5px] text-text-secondary">{t("kernel.help.loadFailed")}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void refetchIndex()
                    void refetchPage()
                  }}
                >
                  {t("kernel.help.retry")}
                </Button>
              </div>
            }
          >
            <Show
              when={page()}
              fallback={
                <p class="p-6 text-[13px] text-text-tertiary">{t("kernel.help.loading")}</p>
              }
            >
              {(p) => (
                <article
                  data-testid="help-page"
                  data-url={p().url}
                  class="mx-auto w-full max-w-[760px] px-5 pb-16 pt-6 sm:px-8"
                >
                  <div class="mb-1 flex items-center gap-3">
                    <span class="min-w-0 flex-1 truncate text-[12px] text-text-tertiary">
                      {p().section}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      data-testid="help-open-in-browser"
                      onClick={() => void openOutside(helpSiteUrl(helpTarget()))}
                    >
                      <ExternalLink size={14} />
                      <span>{t("kernel.help.openInBrowser")}</span>
                    </Button>
                  </div>
                  <h1 class="text-[24px] font-semibold leading-tight text-text">{p().title}</h1>
                  <Show when={p().showLede}>
                    <p class="mt-2 text-[15px] leading-relaxed text-text-secondary">
                      {p().description}
                    </p>
                  </Show>
                  {/* Link and copy-button clicks are delegated (onClick): the links stay real,
                      keyboard-reachable anchors. The HTML is first-party, built from this repo's
                      docs/ into this build (scripts/docs/build-app-bundle.ts), never user content. */}
                  <div
                    class="prose-docs mt-6"
                    ref={(el) => el.addEventListener("click", onClick)}
                    innerHTML={p().html}
                  />
                  <Show when={phone() && p().url === ""}>
                    <Show when={index()}>
                      {(idx) => (
                        <div class="mt-8 border-t border-border-subtle pt-4">
                          <h2 class="px-3 pb-1 text-[13px] font-semibold text-text">
                            {t("kernel.help.contents")}
                          </h2>
                          <HelpNav index={idx()} />
                        </div>
                      )}
                    </Show>
                  </Show>
                </article>
              )}
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}

export default HelpTab
