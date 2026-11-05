// SPDX-License-Identifier: FSL-1.1-ALv2
// Composer — shared message-composer primitive used by Tickets reply,
// Mail reply, Threads message bar, and Liaison agent prompt. Modern UX:
// single bordered card; optional tabs above the editor; footer
// row INSIDE the card with left actions, inline hint, and primary submit.
//
// Variants:
// - default: surface-sunken bg with accent focus ring
// - note:    amber-tinted bg for "internal note" mode
// - flush:   no rounded ring (when the parent already provides chrome)
// - chat:    the conversation composers (threads, computer sessions): flat
//            elevated card, 18px corners, accent ring and wash on focus
//
// The chat pieces (TextArea, Controls, Send, Settings) are shared by every
// chat-style composer, so the thread bar and the session composer are two
// configurations of one field rather than two implementations.

import { ArrowUp, Check, ChevronDown, SlidersHorizontal } from "lucide-solid"
import {
  type Component,
  createContext,
  createEffect,
  createSignal,
  For,
  type JSX,
  type ParentComponent,
  Show,
  splitProps,
  useContext,
} from "solid-js"
import { cn } from "~/lib/cn"
import { OverlaySheet } from "./OverlaySheet"
import { PopupMenu } from "./PopupMenu"

type ComposerVariant = "default" | "note" | "flush" | "chat"

const CHAT_CARD =
  "rounded-[18px] bg-elevated ring-1 ring-border-strong transition-[box-shadow] focus-within:shadow-composer-focus focus-within:ring-1 focus-within:ring-accent/40"

/**
 * The chat field's text, for a rich editor and a plain textarea alike. The size
 * a message is READ at (15px on a 22px line), and the 16px floor on a phone,
 * where WKWebView zooms the page on focusing a smaller field. Eight lines on a
 * desktop, six on a phone, then it scrolls inside the field: a composer that
 * grows without a cap eats the conversation above it. `!`: message prose sets
 * its own reading size.
 */
export function chatTextClass(phone: boolean): string {
  return phone
    ? "max-h-[144px] min-h-6 overflow-y-auto text-[16px]! leading-6!"
    : "max-h-[176px] min-h-[22px] overflow-y-auto text-[15px]! leading-[22px]!"
}

interface ComposerContextValue {
  variant: () => ComposerVariant
  disabled: () => boolean
}

const ComposerContext = createContext<ComposerContextValue>()

function useComposerContext(): ComposerContextValue {
  const ctx = useContext(ComposerContext)
  if (!ctx) throw new Error("Composer.* components must be used within <Composer>")
  return ctx
}

interface RootProps {
  variant?: ComposerVariant
  disabled?: boolean
  class?: string
  children: JSX.Element
}

const Root: ParentComponent<RootProps> = (props) => {
  const variant = () => props.variant ?? "default"
  const disabled = () => props.disabled ?? false
  return (
    <ComposerContext.Provider value={{ variant, disabled }}>
      <div
        class={cn(
          "flex flex-col overflow-hidden transition-colors",
          variant() === "chat"
            ? CHAT_CARD
            : variant() === "flush"
              ? ""
              : "rounded-xl ring-1 focus-within:ring-2",
          variant() === "note"
            ? "bg-amber-950/30 ring-amber-900/40 focus-within:ring-amber-700/60"
            : variant() === "default"
              ? "bg-surface-sunken ring-border focus-within:ring-accent/40"
              : "",
          props.class,
        )}
        data-composer
        data-variant={variant()}
        data-disabled={disabled() ? "true" : undefined}
      >
        {props.children}
      </div>
    </ComposerContext.Provider>
  )
}

const Tabs: ParentComponent<{ class?: string; "aria-label"?: string }> = (props) => (
  <div
    role="tablist"
    aria-label={props["aria-label"]}
    class={cn("flex items-center gap-0.5 border-b border-border/40 px-2 pt-1.5 pb-1", props.class)}
  >
    {props.children}
  </div>
)

interface TabProps {
  active: boolean
  tone?: "default" | "amber"
  onClick: () => void
  testId?: string
  children: JSX.Element
}

const Tab: Component<TabProps> = (props) => (
  <button
    type="button"
    role="tab"
    aria-selected={props.active ? "true" : "false"}
    data-active={props.active ? "true" : "false"}
    data-testid={props.testId}
    onClick={() => props.onClick()}
    class={cn(
      "rounded-md px-2 py-0.5 text-[12px] font-medium transition-colors",
      props.active
        ? props.tone === "amber"
          ? "bg-amber-900/40 text-amber-200"
          : "bg-surface text-text shadow-sm"
        : "text-text-tertiary hover:bg-surface/40 hover:text-text-secondary",
    )}
  >
    {props.children}
  </button>
)

interface EditorWrapperProps {
  class?: string
  children: JSX.Element
}

/**
 * Wraps the actual editable area. Apps pass their own `<textarea>` /
 * `contentEditable` div as children — Composer only owns the chrome,
 * focus ring, and consistent padding so editor implementations stay
 * native to each surface (rich text vs plain) without contention.
 */
const EditorSlot: ParentComponent<EditorWrapperProps> = (props) => (
  <div class={cn("min-h-[44px] px-3 py-2 text-[13.5px]", props.class)}>{props.children}</div>
)

const Footer: ParentComponent<{ class?: string }> = (props) => {
  const ctx = useComposerContext()
  return (
    <div
      class={cn(
        "flex items-center gap-2 border-t px-2 py-1.5 text-[11px]",
        ctx.variant() === "note" ? "border-amber-900/40" : "border-border/40",
        props.class,
      )}
      data-composer-footer
    >
      {props.children}
    </div>
  )
}

interface SubmitProps {
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  testId?: string
  /** Accessible name and hover hint, for when the visible text alone does
   *  not say why the control is disabled (files still uploading). */
  label?: string
  /** A send queued behind an upload: announced as a pressed toggle, marked
   *  `data-queued` for styling and tests. Undefined when there is no queue. */
  pressed?: boolean
  variant?: "default" | "secondary"
  /** What pressing it does (`data-action`), when the button sends different
   *  things by mode: a guided tour's guard reads it before pressing. */
  action?: string
  class?: string
  children: JSX.Element
}

const Submit: Component<SubmitProps> = (props) => {
  const [local] = splitProps(props, [
    "onClick",
    "disabled",
    "loading",
    "testId",
    "label",
    "pressed",
    "variant",
    "action",
    "class",
    "children",
  ])
  return (
    <button
      type="button"
      data-testid={local.testId}
      title={local.label}
      aria-label={local.label}
      aria-pressed={local.pressed}
      data-queued={local.pressed ? "true" : undefined}
      data-action={local.action}
      onClick={() => local.onClick()}
      disabled={local.disabled || local.loading}
      class={cn(
        "ml-auto inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        local.variant === "secondary"
          ? "bg-surface text-text-secondary ring-1 ring-border hover:bg-surface-emphasis hover:text-text"
          : "bg-accent text-accent-foreground shadow-sm hover:bg-accent/90",
        local.class,
      )}
    >
      {local.children}
    </button>
  )
}

/** A plain-text chat field that grows with its text up to `chatTextClass`'s cap. */
const TextArea: Component<
  Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "ref"> & {
    phone: boolean
    value: string
    /** The field itself, for the writing helpers beside it (wand, dictation). */
    ref?: (el: HTMLTextAreaElement) => void
  }
> = (props) => {
  const [local, rest] = splitProps(props, ["phone", "class", "ref"])
  let el!: HTMLTextAreaElement
  createEffect(() => {
    void props.value
    el.style.height = "auto"
    const cap = Number.parseFloat(getComputedStyle(el).maxHeight)
    el.style.height = `${Number.isNaN(cap) ? el.scrollHeight : Math.min(el.scrollHeight, cap)}px`
  })
  return (
    <textarea
      ref={(node) => {
        el = node
        local.ref?.(node)
      }}
      rows={1}
      class={cn(
        "block w-full resize-none bg-transparent text-text outline-none placeholder:text-text-secondary",
        chatTextClass(local.phone),
        local.class,
      )}
      {...rest}
    />
  )
}

/** The chat card's control line under the text: tools left, send at the far right. */
const Controls: ParentComponent<{ class?: string; testId?: string }> = (props) => (
  <div
    class={cn("flex flex-wrap items-center gap-0.5 px-2 pb-2 pt-1.5", props.class)}
    data-testid={props.testId}
  >
    {props.children}
  </div>
)

interface SendProps {
  onClick: () => void
  disabled?: boolean
  label: string
  title?: string
  pressed?: boolean
  queued?: boolean
  phone?: boolean
  testId?: string
  /** The conversation it sends to, as `data-thread-id`: a guided step presses only its own. */
  threadId?: string
  /** "true" on the person's own agent conversation, as `data-personal-agent`. */
  personalAgent?: "true" | "false"
  /** Replaces the arrow (a send queued behind an upload shows a clock). */
  children?: JSX.Element
}

/**
 * The chat send button: an accent rounded square, 36px (40px on a phone).
 * DISABLED IS ITS OWN COLOURS, NOT A FADED ACCENT: an accent at 30% opacity over
 * the card read as a live button that did nothing.
 */
const Send: Component<SendProps> = (props) => (
  <button
    type="button"
    data-testid={props.testId}
    data-thread-id={props.threadId}
    data-personal-agent={props.personalAgent}
    onClick={() => props.onClick()}
    disabled={props.disabled}
    title={props.title}
    aria-label={props.label}
    aria-pressed={props.pressed}
    data-queued={props.queued ? "true" : undefined}
    class={`flex ${props.phone ? "h-10 w-10" : "h-9 w-9"} shrink-0 items-center justify-center rounded-xl bg-accent text-accent-foreground transition-[background-color,color,transform] hover:bg-accent-hover active:scale-95 disabled:cursor-not-allowed disabled:bg-surface-active disabled:text-text-tertiary disabled:active:scale-100`}
  >
    {props.children ?? <ArrowUp size={17} />}
  </button>
)

export interface ComposerOption {
  value: string
  label: string
  /** One line saying what the option does, under its name in the menu. */
  description?: string
}

export interface ComposerSetting {
  /** The setting's name: the pill's accessible name and the sheet group's label. */
  label: string
  value: string
  options: ComposerOption[]
  onSelect: (value: string) => void
  icon?: JSX.Element
}

const labelOf = (s: ComposerSetting) => s.options.find((o) => o.value === s.value)?.label ?? s.value

/** One setting as a quiet toolbar pill opening a menu that explains each option. */
const Pill: Component<{ setting: ComposerSetting }> = (props) => {
  const [open, setOpen] = createSignal(false)
  return (
    <PopupMenu open={open()} onOpenChange={setOpen}>
      <PopupMenu.Trigger
        aria-label={props.setting.label}
        class="inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2 text-[12.5px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text data-[expanded]:bg-surface-hover data-[expanded]:text-text"
      >
        <span class="contents" data-setting={props.setting.label} data-value={props.setting.value}>
          {props.setting.icon}
          {labelOf(props.setting)}
          <ChevronDown size={11} class="opacity-60" aria-hidden="true" />
        </span>
      </PopupMenu.Trigger>
      <PopupMenu.Content class="min-w-60 max-w-80">
        <PopupMenu.Group>
          <PopupMenu.Label>{props.setting.label}</PopupMenu.Label>
          <For each={props.setting.options}>
            {(o) => (
              <PopupMenu.Item onSelect={() => props.setting.onSelect(o.value)} class="items-start">
                <span class="mt-0.5 w-4 shrink-0 text-accent">
                  <Show when={o.value === props.setting.value}>
                    <Check size={14} />
                  </Show>
                </span>
                <span class="min-w-0">
                  <span class="block text-text">{o.label}</span>
                  <Show when={o.description}>
                    <span class="block text-[12px] text-text-tertiary">{o.description}</span>
                  </Show>
                </span>
              </PopupMenu.Item>
            )}
          </For>
        </PopupMenu.Group>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

interface SettingsProps {
  settings: ComposerSetting[]
  phone: boolean
  /** The phone sheet's title and the summary button's accessible name. */
  title: string
  closeLabel: string
  /** A line under the phone sheet's choices (when changes apply). */
  note?: string
}

/**
 * The composer's settings (model, level, ...). A desktop shows one pill per
 * setting; a phone folds them into one summary button opening a sheet of
 * 40px choices, so the control line never wraps under the keyboard.
 */
const Settings: Component<SettingsProps> = (props) => {
  const [sheet, setSheet] = createSignal(false)
  return (
    <Show
      when={props.phone}
      fallback={<For each={props.settings}>{(s) => <Pill setting={s} />}</For>}
    >
      <button
        type="button"
        aria-label={props.title}
        aria-haspopup="dialog"
        onClick={() => setSheet(true)}
        class="inline-flex h-10 min-w-0 items-center gap-1.5 rounded-xl px-2.5 text-[13px] text-text-secondary hover:bg-surface-hover"
      >
        <SlidersHorizontal size={15} class="shrink-0" aria-hidden="true" />
        <span class="truncate">{props.settings.map(labelOf).join(" · ")}</span>
      </button>
      <OverlaySheet
        open={sheet()}
        onClose={() => setSheet(false)}
        variant="bottom"
        title={props.title}
        closeLabel={props.closeLabel}
      >
        <div class="flex flex-col gap-4 px-4 pt-3 pb-4">
          <For each={props.settings}>
            {(s) => (
              <fieldset class="m-0 min-w-0 border-0 p-0">
                <legend class="mb-1.5 p-0 text-[12px] text-text-secondary">{s.label}</legend>
                <div class="flex flex-wrap gap-1.5">
                  <For each={s.options}>
                    {(o) => (
                      <button
                        type="button"
                        aria-pressed={o.value === s.value}
                        onClick={() => s.onSelect(o.value)}
                        class="min-h-10 rounded-xl border border-border bg-surface px-3.5 text-[14px] text-text aria-pressed:border-accent aria-pressed:bg-accent/10 aria-pressed:font-medium"
                      >
                        {o.label}
                      </button>
                    )}
                  </For>
                </div>
              </fieldset>
            )}
          </For>
          <Show when={props.note}>
            <p class="text-[12px] text-text-secondary">{props.note}</p>
          </Show>
        </div>
      </OverlaySheet>
    </Show>
  )
}

export const Composer = Object.assign(Root, {
  Tabs,
  Tab,
  EditorSlot,
  Footer,
  Submit,
  TextArea,
  Controls,
  Send,
  Settings,
})

export type { ComposerVariant }
