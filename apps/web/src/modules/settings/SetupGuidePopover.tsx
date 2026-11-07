// SPDX-License-Identifier: FSL-1.1-ALv2
// `?` setup-guide popover for an app connection. Renders the connection's
// `setupGuide` — summary + numbered markdown steps + a "full docs" link — in a
// FloatingPanel (the README-designated primitive for rich hover/click floating
// content; preferred over a bespoke ui/Popover wrapper). Degrades to nothing
// when the connection declares no (non-empty) setupGuide.

import { type Component, For, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { renderMarkdown } from "~/modules/knowledge/markdown"
import { FloatingPanel } from "~/ui/FloatingPanel"
import type { AppSetupGuide } from "./apps-store"

function hasContent(guide?: AppSetupGuide): boolean {
  return !!guide && (!!guide.summary || (guide.steps?.length ?? 0) > 0 || !!guide.docsUrl)
}

export const SetupGuidePopover: Component<{ guide?: AppSetupGuide; label?: string }> = (props) => {
  const i18n = useI18n()
  return (
    <Show when={hasContent(props.guide)}>
      <FloatingPanel.Uncontrolled
        triggerLabel={props.label ?? "How to connect"}
        triggerClass="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] font-semibold leading-none text-text-secondary hover:border-border-strong hover:text-text"
        contentClass="max-w-sm p-3"
        trigger={
          <span data-testid="setup-guide-trigger" aria-hidden="true">
            ?
          </span>
        }
      >
        <div data-testid="setup-guide-content" class="flex flex-col gap-2 text-sm">
          <Show when={props.guide?.summary}>
            <p class="text-text">{props.guide?.summary}</p>
          </Show>
          <Show when={(props.guide?.steps?.length ?? 0) > 0}>
            {/* A step's "Open: <url>" line is one long word: wrap it inside
                the popover instead of clipping it at the edge. */}
            <ol class="list-decimal space-y-1 pl-4 text-text-secondary [overflow-wrap:anywhere]">
              <For each={props.guide?.steps}>
                {(step) => (
                  // setupGuide steps are author-controlled markdown; renderMarkdown
                  // funnels through DOMPurify before this innerHTML injection.
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitised by renderMarkdown
                  <li data-testid="setup-guide-step" innerHTML={renderMarkdown(step)} />
                )}
              </For>
            </ol>
          </Show>
          <Show when={props.guide?.docsUrl}>
            <a
              data-testid="setup-guide-docs"
              href={props.guide?.docsUrl}
              target="_blank"
              rel="noreferrer"
              class="text-accent hover:underline"
            >
              {i18n.t("kernel.settingsUi.fullGuide")}
            </a>
          </Show>
        </div>
      </FloatingPanel.Uncontrolled>
    </Show>
  )
}
