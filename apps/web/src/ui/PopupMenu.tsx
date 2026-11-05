// SPDX-License-Identifier: FSL-1.1-ALv2
import { DropdownMenu } from "@kobalte/core/dropdown-menu"
import {
  type Component,
  createContext,
  createUniqueId,
  type JSX,
  type ParentComponent,
  splitProps,
  useContext,
} from "solid-js"
import { cn } from "~/lib/cn"

interface PopupMenuContextValue {
  triggerId: string
}

const PopupMenuContext = createContext<PopupMenuContextValue>()

function usePopupMenuContext() {
  const context = useContext(PopupMenuContext)

  if (!context) {
    throw new Error("PopupMenu components must be used within PopupMenu")
  }

  return context
}

interface RootProps {
  open: boolean
  onOpenChange(open: boolean): void
  /** Where the menu opens relative to its trigger. Defaults to below it; a
   *  trigger in a narrow rail opens sideways so the menu does not cover the
   *  rail it belongs to. */
  placement?: "bottom-start" | "right-end" | "right-start"
  children: JSX.Element
}

const Root: ParentComponent<RootProps> = (props) => {
  const triggerId = `popup-menu-trigger-${createUniqueId()}`
  const [local, forwarded] = splitProps(props, ["children"])

  return (
    <PopupMenuContext.Provider value={{ triggerId }}>
      <DropdownMenu
        modal={false}
        open={forwarded.open}
        onOpenChange={forwarded.onOpenChange}
        placement={forwarded.placement}
        gutter={4}
      >
        {local.children}
      </DropdownMenu>
    </PopupMenuContext.Provider>
  )
}

const Trigger: ParentComponent<{
  class?: string
  id?: string
  "aria-label"?: string
  /** A hover hint, for a trigger whose content is an icon alone. */
  title?: string
  "data-testid"?: string
  /** A trigger in a dense row (an editor toolbar) keeps its size on a touch tier. */
  "data-touch-dense"?: boolean
  tabIndex?: number
  /** A read-only surface (an archived record) keeps the trigger visible but inert. */
  disabled?: boolean
}> = (props) => {
  const context = usePopupMenuContext()

  return (
    <DropdownMenu.Trigger
      id={props.id ?? context.triggerId}
      tabIndex={props.tabIndex}
      disabled={props.disabled}
      class={cn(
        "outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:rounded",
        props.class,
      )}
      aria-label={props["aria-label"]}
      title={props.title}
      data-testid={props["data-testid"]}
      data-touch-dense={props["data-touch-dense"]}
    >
      {props.children}
    </DropdownMenu.Trigger>
  )
}

interface ContentProps {
  class?: string
  "aria-label"?: string
  "aria-labelledby"?: string
  "data-testid"?: string
  /** Where focus goes on closing; `preventDefault` keeps it off the trigger. */
  onCloseAutoFocus?: (event: Event) => void
  /**
   * Data attributes set on the portalled menu itself: a menu opened from a
   * floating surface carries that surface's markers (it is part of it).
   */
  attrs?: Record<`data-${string}`, string>
  children: JSX.Element
}

const Content: ParentComponent<ContentProps> = (props) => {
  const context = usePopupMenuContext()
  const [local] = splitProps(props, [
    "class",
    "children",
    "aria-labelledby",
    "aria-label",
    "data-testid",
    "onCloseAutoFocus",
    "attrs",
  ])

  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        class={cn(
          "popup-menu z-50 rounded-lg border border-border bg-elevated py-1 shadow-popover outline-none",
          local.class,
        )}
        aria-label={local["aria-label"]}
        aria-labelledby={
          !local["aria-label"] ? (local["aria-labelledby"] ?? context.triggerId) : undefined
        }
        data-testid={local["data-testid"]}
        onCloseAutoFocus={local.onCloseAutoFocus}
        {...local.attrs}
      >
        {local.children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  )
}

/**
 * Whether a `PopupMenu.Label` has a group to label (P6d-T18).
 *
 * Kobalte's `DropdownMenu.GroupLabel` reads its group's context and THROWS
 * when there is none. The content is portalled, so that throw takes the whole
 * portal down and the menu renders nothing at all: no error on screen, no
 * failing assertion, just a trigger that opens onto an empty box. A label in
 * the wrong place is a one word mistake and it cost a debugging session.
 */
const PopupMenuGroupContext = createContext<boolean>(false)

const Group: ParentComponent<{ children: JSX.Element }> = (props) => {
  return (
    <PopupMenuGroupContext.Provider value={true}>
      <DropdownMenu.Group>{props.children}</DropdownMenu.Group>
    </PopupMenuGroupContext.Provider>
  )
}

interface ItemProps {
  onSelect(): void
  variant?: "danger"
  class?: string
  textValue?: string
  /** Keep the menu open after selecting — for multi-select menus (e.g. filter
   *  toggles) where the user picks several items in one visit. Defaults to
   *  Kobalte's close-on-select behaviour when omitted. */
  closeOnSelect?: boolean
  disabled?: boolean
  /** A hover hint, for a row whose content is an icon alone. */
  title?: string
  "aria-label"?: string
  "data-testid"?: string
  children: JSX.Element
}

const ITEM_BASE_CLASS =
  "mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] outline-none transition-colors data-[highlighted]:bg-surface-hover data-[highlighted]:ring-2 data-[highlighted]:ring-inset data-[highlighted]:ring-accent/40"
const ITEM_DEFAULT_TONE = "text-text-secondary data-[highlighted]:text-text"

interface LinkItemProps {
  href: string
  /** Ask the browser to save the target instead of navigating to it. */
  download?: boolean
  class?: string
  textValue?: string
  "data-testid"?: string
  children: JSX.Element
}

/**
 * A menu row that IS a link: a real anchor with a real `href`, so the browser's
 * own link behaviour (save, copy address, open elsewhere) applies, and the
 * keyboard activates it like any other row. For a file the visitor downloads, a
 * scripted navigation would lose all of that.
 */
const LinkItem: Component<LinkItemProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "children", "href", "download"])

  return (
    <DropdownMenu.Item
      as="a"
      href={local.href}
      download={local.download ? "" : undefined}
      rel="noopener"
      class={cn(ITEM_BASE_CLASS, ITEM_DEFAULT_TONE, "no-underline", local.class)}
      // The menu pattern activates a row on Space as well as Enter, and an
      // anchor only answers Enter: without this, Space closes the menu and
      // nothing is downloaded.
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === " ") (event.currentTarget as HTMLAnchorElement).click()
      }}
      {...others}
    >
      {local.children}
    </DropdownMenu.Item>
  )
}

const Item: Component<ItemProps> = (props) => {
  const [local, others] = splitProps(props, ["variant", "class", "children", "onSelect"])

  return (
    <DropdownMenu.Item
      class={cn(
        ITEM_BASE_CLASS,
        local.variant === "danger"
          ? "text-danger data-[highlighted]:bg-danger/10"
          : ITEM_DEFAULT_TONE,
        local.class,
      )}
      onSelect={() => local.onSelect()}
      {...others}
    >
      {local.children}
    </DropdownMenu.Item>
  )
}

const LABEL_CLASS =
  "px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-text-tertiary"

/**
 * A section heading inside the menu. Inside a `PopupMenu.Group` it is the
 * group's accessible label; outside one it still RENDERS, as a presentational
 * heading, rather than throwing the portal away with the rest of the menu.
 *
 * The mistake is still a mistake and it still says so, once, in the console:
 * a heading with no group labels nothing for a screen reader. What it no
 * longer does is make the whole menu disappear.
 */
const Label: Component<{ children: JSX.Element }> = (props) => {
  const inGroup = useContext(PopupMenuGroupContext)
  if (!inGroup) {
    console.error(
      "PopupMenu.Label outside a PopupMenu.Group: rendering it as a plain heading. Wrap the section in PopupMenu.Group so it labels something.",
    )
    return (
      <div role="presentation" class={LABEL_CLASS}>
        {props.children}
      </div>
    )
  }
  return <DropdownMenu.GroupLabel class={LABEL_CLASS}>{props.children}</DropdownMenu.GroupLabel>
}

const Separator: Component = () => <DropdownMenu.Separator class="my-1 h-px bg-border-subtle" />

export const PopupMenu = Object.assign(Root, {
  Trigger,
  Content,
  Group,
  Item,
  LinkItem,
  Label,
  Separator,
})
