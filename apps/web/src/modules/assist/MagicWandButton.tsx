// SPDX-License-Identifier: FSL-1.1-ALv2
import { WandSparkles } from "lucide-solid"
import { type Component, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { ProofreadFormat } from "./types"
import { useMagicWand } from "./useMagicWand"

export const MagicWandButton: Component<{
  getEl: () => HTMLTextAreaElement | HTMLElement | undefined
  kind: ProofreadFormat
  disabled?: boolean
  class?: string
  /** The glyph's size. 16 everywhere but the chat composer's larger row. */
  iconSize?: number
}> = (props) => {
  const i18n = useI18n()
  const wand = useMagicWand({ getEl: () => props.getEl(), kind: props.kind })
  return (
    <button
      type="button"
      data-testid="magic-wand"
      aria-label={i18n.t("kernel.magicWand")}
      title={i18n.t("kernel.magicWand")}
      disabled={props.disabled || wand.running()}
      // Keep the editor's selection/focus when the button is pressed.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => void wand.run()}
      class={cn(
        "inline-flex items-center justify-center rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50",
        props.class,
      )}
    >
      <Show
        when={wand.running()}
        fallback={<WandSparkles size={props.iconSize ?? 16} aria-hidden="true" />}
      >
        <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </Show>
    </button>
  )
}
