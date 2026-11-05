// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Invoked model": the model choice of a conversation between PEOPLE, moved
// off the composer and into the conversation's actions menu.
//
// In a DM with a colleague a model pill beside the send button made the chat
// read like a chat with a bot, even though the agent is only a guest someone
// invoked. The choice still has to be reachable, so it is an entry of the
// "..." menu instead, on the desktop header and on the phone header alike.
//
// The state and the handlers stay ThreadView's (the conversation's override,
// the agent's default, the reasoning levels, the PATCH and its rollback). The
// phone header is not inside ThreadView, so ThreadView PUBLISHES its control
// here by thread id and both headers read it back. Nothing is duplicated: the
// entry opens the very ModelSelector the composer chip opens, with the same
// props.
//
// The selector does not nest inside the menu: the menu closes on hover out
// and the selector's own popup is portalled elsewhere, so a nested picker
// would vanish under the pointer. Choosing the entry closes the menu, and
// once the menu has finished closing the selector opens on an invisible
// anchor laid over the "..." trigger.

import { Sparkles } from "lucide-solid"
import { type Accessor, createSignal, type JSX, Show } from "solid-js"
import { modelShortLabel } from "~/lib/model-groups"
import { modelMenuReachable } from "~/modules/agent/ModelSelector"
import { useI18n } from "~/modules/i18n/i18n-context"
import ThreadModelChip, { type ThreadModelChipProps } from "~/modules/threads/ThreadModelChip"

/** What ThreadView publishes: exactly the props its composer chip takes. */
export type ThreadModelControl = Omit<
  ThreadModelChipProps,
  "asMenuAnchor" | "open" | "onOpenChange"
>

interface Entry {
  token: symbol
  props: Accessor<ThreadModelControl>
}

// One conversation can be mounted twice (the main panel and the dock), so
// each publisher keeps its own entry and the latest one answers.
const [registry, setRegistry] = createSignal<Record<string, Entry[]>>({})

/** Publish a conversation's model control. Returns the unpublish. */
export function provideThreadModelControl(
  threadId: string,
  props: Accessor<ThreadModelControl>,
): () => void {
  const token = Symbol(threadId)
  setRegistry((r) => ({ ...r, [threadId]: [...(r[threadId] ?? []), { token, props }] }))
  return () =>
    setRegistry((r) => {
      const left = (r[threadId] ?? []).filter((e) => e.token !== token)
      const next = { ...r }
      if (left.length > 0) next[threadId] = left
      else delete next[threadId]
      return next
    })
}

/** The conversation's model control, or null when it has no agent seat. */
export function threadModelControl(threadId: string): ThreadModelControl | null {
  const entries = registry()[threadId]
  const entry = entries?.[entries.length - 1]
  return entry ? entry.props() : null
}

interface InvokedModelMenuOptions {
  threadId: () => string
  /** The shared rule: `isPersonToPersonConversation`. */
  enabled: () => boolean
  /** Close the host's actions menu. */
  closeMenu: () => void
}

/**
 * The entry and its anchor for one header. The host renders `Item` in its
 * menu, `Anchor` beside the "..." trigger (inside a `relative` box), and
 * passes `onCloseAutoFocus` to the menu's content.
 */
export function createInvokedModelMenu(opts: InvokedModelMenuOptions) {
  const i18n = useI18n()
  const control = () => (opts.enabled() ? threadModelControl(opts.threadId()) : null)
  const [pickerOpen, setPickerOpen] = createSignal(false)
  let pending = false

  function choose() {
    pending = true
    opts.closeMenu()
  }

  /** The menu has finished closing: open the selector instead of handing
   *  focus back to the trigger, which would dismiss it on the spot. */
  function onCloseAutoFocus(event: Event) {
    if (!pending) return
    pending = false
    event.preventDefault()
    setPickerOpen(true)
  }

  const Item = (props: { class: string; iconSize: number; roving?: boolean }): JSX.Element => (
    <Show when={control()}>
      {(c) => (
        // Locked (a managed org without the tier or credits) still says which
        // model answers, and why it cannot be changed, as the composer pill did.
        <button
          type="button"
          data-roving={props.roving ? "" : undefined}
          data-testid="thread-invoked-model"
          class={`${props.class} disabled:cursor-default disabled:opacity-60`}
          disabled={!modelMenuReachable(c().balance)}
          title={
            modelMenuReachable(c().balance) ? undefined : i18n.t("kernel.upgradeToChangeModel")
          }
          onClick={choose}
        >
          <Sparkles size={props.iconSize} class="shrink-0" />
          {/* The entry's name never truncates; a long model name does. */}
          <span class="flex-1 whitespace-nowrap text-left">
            {i18n.t("kernel.threadInvokedModel")}
          </span>
          <span
            data-testid="thread-invoked-model-label"
            class="min-w-0 truncate text-[12px] text-text-tertiary"
          >
            {modelShortLabel(c().agentModelId ?? c().agentDefaultModelId)}
          </span>
        </button>
      )}
    </Show>
  )

  // The anchor shares a box with the host's "..." trigger, whose ref the menu
  // keeps to itself: closing the picker hands focus back to that trigger, not
  // to the invisible anchor.
  let anchorBox: HTMLSpanElement | undefined
  function onPickerOpenChange(open: boolean) {
    setPickerOpen(open)
    if (!open) anchorBox?.parentElement?.querySelector<HTMLButtonElement>("button")?.focus()
  }

  const Anchor = (): JSX.Element => (
    <Show when={control()}>
      {(c) => (
        <span ref={anchorBox} class="contents">
          <ThreadModelChip
            asMenuAnchor
            open={pickerOpen()}
            onOpenChange={onPickerOpenChange}
            threadId={c().threadId}
            balance={c().balance}
            availableModelIds={c().availableModelIds}
            agentModelId={c().agentModelId}
            agentDefaultModelId={c().agentDefaultModelId}
            reasoningLevel={c().reasoningLevel}
            onSelect={(id) => c().onSelect(id)}
            onSelectReasoning={(level) => c().onSelectReasoning?.(level)}
          />
        </span>
      )}
    </Show>
  )

  return { Item, Anchor, onCloseAutoFocus }
}
