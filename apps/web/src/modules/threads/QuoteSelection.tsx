// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "QUOTE" ON A SELECTION (S12).
//
// Selecting text inside ONE message of a surface (the channel list, or a reply
// panel) floats a "Quote" button over the selection. Pressing it puts the
// excerpt in the composer of that same surface as a removable chip. A
// selection spanning two messages, or reaching outside the surface, offers
// nothing: a quote names exactly one source.

import { Quote } from "lucide-solid"
import { type Component, createSignal, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { useI18n } from "~/modules/i18n/i18n-context"
import { isClientMessageId, type Message } from "~/modules/threads/message-store"
import { excerptForQuote } from "~/modules/threads/quote-excerpt"
import { setQuoteDraft } from "~/modules/threads/quote-store"

interface QuoteSelectionProps {
  /** The surface's scroll container; only selections inside it count. */
  container: () => HTMLElement | null | undefined
  /** The composer the quote goes to (quote-store key). */
  surfaceKey: string
  resolveMessage: (messageId: string) => Message | undefined
  /** Called after the quote is placed, e.g. to focus that composer. */
  onQuoted?: () => void
}

interface Offer {
  message: Message
  text: string
  top: number
  left: number
}

function rowOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : (node?.parentElement ?? null)
  return el?.closest<HTMLElement>("[data-message-id]") ?? null
}

const QuoteSelection: Component<QuoteSelectionProps> = (props) => {
  const i18n = useI18n()
  const [offer, setOffer] = createSignal<Offer | null>(null)

  function evaluate(): void {
    const selection = typeof window !== "undefined" ? window.getSelection() : null
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      setOffer(null)
      return
    }
    const range = selection.getRangeAt(0)
    const container = props.container()
    const row = rowOf(range.startContainer)
    if (!container || !row || row !== rowOf(range.endContainer) || !container.contains(row)) {
      setOffer(null)
      return
    }
    const id = row.dataset.messageId ?? ""
    const message = id && !isClientMessageId(id) ? props.resolveMessage(id) : undefined
    const text = selection.toString()
    if (!message?.content || message.deletedAt || !text.trim()) {
      setOffer(null)
      return
    }
    // Over the middle of the selection; a runtime without layout (tests)
    // still gets a button, just not a well placed one.
    const rect =
      typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null
    setOffer({
      message,
      text,
      top: Math.max(4, (rect?.top ?? 0) - 34),
      left: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
    })
  }

  onMount(() => {
    const onUp = () => queueMicrotask(evaluate)
    const onSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setOffer(null)
    }
    document.addEventListener("mouseup", onUp)
    document.addEventListener("keyup", onUp)
    document.addEventListener("selectionchange", onSelectionChange)
    onCleanup(() => {
      document.removeEventListener("mouseup", onUp)
      document.removeEventListener("keyup", onUp)
      document.removeEventListener("selectionchange", onSelectionChange)
    })
  })

  function quote(): void {
    const current = offer()
    if (!current) return
    setQuoteDraft(props.surfaceKey, {
      messageId: current.message.id,
      excerpt: excerptForQuote(current.text, current.message.content ?? ""),
      authorName: current.message.authorName,
      replyRootId: current.message.replyRootId ?? null,
    })
    window.getSelection()?.removeAllRanges()
    setOffer(null)
    props.onQuoted?.()
  }

  return (
    <Show when={offer()}>
      {(o) => (
        <Portal>
          <button
            type="button"
            data-testid="quote-selection-button"
            class="fixed z-50 flex -translate-x-1/2 items-center gap-1 rounded-md border border-border bg-elevated px-2 py-1 text-[12px] font-medium text-text shadow-popover hover:bg-surface-hover"
            style={{ top: `${o().top}px`, left: `${o().left}px` }}
            // Keep the selection alive through the press.
            onMouseDown={(e) => e.preventDefault()}
            onClick={quote}
          >
            <Quote size={12} class="text-text-secondary" />
            {i18n.t("kernel.replyThreads.quote")}
          </button>
        </Portal>
      )}
    </Show>
  )
}

export default QuoteSelection
