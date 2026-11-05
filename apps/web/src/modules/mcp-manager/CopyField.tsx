// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A value someone has to paste elsewhere exactly (the redirect URL a provider
// app needs). The clipboard API is missing on plain http and in some embedded
// views, and may be refused: then the text is selected, the legacy copy
// command tried, and the line under it says to press the copy shortcut.
import { type Component, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"

export type CopyOutcome = "copied" | "selected"

/** Copies `text`; on refusal selects it in `input` so the person copies it by hand. */
export async function copyWithFallback(
  text: string,
  input: HTMLInputElement | undefined,
): Promise<CopyOutcome> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return "copied"
    }
  } catch {
    // Refused (no permission, insecure context): fall through to selection.
  }
  if (input) {
    input.focus()
    input.select()
    try {
      if (typeof document.execCommand === "function" && document.execCommand("copy")) {
        return "copied"
      }
    } catch {
      // Not supported: the selection stays for a manual copy.
    }
  }
  return "selected"
}

export const CopyField: Component<{ value: string; testid: string; label: string }> = (props) => {
  const i18n = useI18n()
  const [outcome, setOutcome] = createSignal<CopyOutcome | null>(null)
  let input: HTMLInputElement | undefined
  return (
    <div class="flex flex-col gap-1">
      <span class="text-[12.5px] font-medium text-text">{props.label}</span>
      <div class="flex items-center gap-2">
        <input
          ref={input}
          readOnly
          data-testid={props.testid}
          aria-label={props.label}
          class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 font-mono text-xs"
          value={props.value}
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button
          size="sm"
          variant="outline"
          data-testid={`${props.testid}-copy`}
          onClick={async () => setOutcome(await copyWithFallback(props.value, input))}
        >
          {outcome() === "copied" ? i18n.t("kernel.mcpUi.copied") : i18n.t("kernel.mcpUi.copy")}
        </Button>
      </div>
      <Show when={outcome() === "selected"}>
        <span class="text-xs text-text-secondary" data-testid={`${props.testid}-manual`}>
          {i18n.t("kernel.mcpUi.copyManually")}
        </span>
      </Show>
    </div>
  )
}
