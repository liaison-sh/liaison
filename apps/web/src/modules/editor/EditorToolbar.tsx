// SPDX-License-Identifier: FSL-1.1-ALv2
import type { Editor } from "@tiptap/core"
import {
  Bold,
  Check,
  Code,
  Heading,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  type LucideProps,
  MoreHorizontal,
  Quote,
  SquareCode,
  Strikethrough,
  Table,
  Underline,
  Unlink,
  X,
} from "lucide-solid"
import {
  type Component,
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { formatKeyLabel } from "~/modules/shell/key-label"
import { createScrollOverflow } from "~/primitives/createScrollOverflow"
import { PopupMenu } from "~/ui/PopupMenu"
import { Toggle } from "~/ui/Toggle"
import { Tooltip } from "~/ui/Tooltip"
import { type EditorPreset, TOOLBAR_HEADING } from "./extensions"

interface Tool {
  key: string
  icon: (props: LucideProps) => JSX.Element
  shortcut?: string
  /** A second chord that does the same, shown after the first in the hint. */
  shortcutAlias?: string
  active: (editor: Editor) => boolean
  run: (editor: Editor) => void
}

const mark = (name: "bold" | "italic" | "underline" | "strike" | "code", shortcut?: string) => ({
  key: name,
  shortcut,
  active: (e: Editor) => e.isActive(name),
  run: (e: Editor) => e.chain().focus().toggleMark(name).run(),
})

const heading = (level: 1 | 2 | 3, icon: Tool["icon"]): Tool => ({
  key: `heading${level}`,
  icon,
  shortcut: `mod+alt+${level}`,
  active: (e) => e.isActive("heading", { level }),
  run: (e) => e.chain().focus().toggleHeading({ level }).run(),
})

/** The tool's name with its shortcut(s): "Bold (⌘B)". */
const hintFor = (tool: Tool, label: string): string => {
  if (!tool.shortcut) return label
  const keys = [tool.shortcut, tool.shortcutAlias].filter((k): k is string => !!k)
  return `${label} (${keys.map((k) => formatKeyLabel(k)).join(", ")})`
}

const TOOLS: Record<string, Tool> = {
  heading: {
    key: "heading",
    icon: Heading,
    active: (e) => e.isActive("heading"),
    run: (e) => e.chain().focus().toggleHeading({ level: TOOLBAR_HEADING }).run(),
  },
  heading1: heading(1, Heading1),
  heading2: heading(2, Heading2),
  heading3: heading(3, Heading3),
  bold: { ...mark("bold", "mod+b"), icon: Bold },
  italic: { ...mark("italic", "mod+i"), icon: Italic },
  underline: { ...mark("underline", "mod+u"), icon: Underline },
  strike: { ...mark("strike", "mod+shift+x"), shortcutAlias: "mod+shift+s", icon: Strikethrough },
  bulletList: {
    key: "bulletList",
    icon: List,
    shortcut: "mod+shift+8",
    active: (e) => e.isActive("bulletList"),
    run: (e) => e.chain().focus().toggleBulletList().run(),
  },
  orderedList: {
    key: "orderedList",
    icon: ListOrdered,
    shortcut: "mod+shift+7",
    active: (e) => e.isActive("orderedList"),
    run: (e) => e.chain().focus().toggleOrderedList().run(),
  },
  taskList: {
    key: "taskList",
    icon: ListTodo,
    shortcut: "mod+shift+9",
    active: (e) => e.isActive("taskList"),
    run: (e) => e.chain().focus().toggleTaskList().run(),
  },
  link: {
    key: "link",
    icon: Link,
    shortcut: "mod+k",
    active: (e) => e.isActive("link"),
    run: () => {},
  },
  quote: {
    key: "quote",
    icon: Quote,
    shortcut: "mod+shift+b",
    active: (e) => e.isActive("blockquote"),
    run: (e) => e.chain().focus().toggleBlockquote().run(),
  },
  code: { ...mark("code", "mod+e"), icon: Code },
  codeBlock: {
    key: "codeBlock",
    icon: SquareCode,
    shortcut: "mod+alt+c",
    active: (e) => e.isActive("codeBlock"),
    run: (e) => e.chain().focus().toggleCodeBlock().run(),
  },
  // In a table the tool opens the table's actions (TableMenu) instead.
  table: {
    key: "table",
    icon: Table,
    active: (e) => e.isActive("table"),
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
}

/** What can be done to the table the caret is in, in menu order. The menu gives focus back. */
const TABLE_ACTIONS = [
  ["addRowAfter", (e: Editor) => e.commands.addRowAfter()],
  ["addColumnAfter", (e: Editor) => e.commands.addColumnAfter()],
  ["deleteRow", (e: Editor) => e.commands.deleteRow()],
  ["deleteColumn", (e: Editor) => e.commands.deleteColumn()],
  ["deleteTable", (e: Editor) => e.commands.deleteTable()],
] as const

type ToolbarPreset = Exclude<EditorPreset, "inline">

/** The tools each preset shows, in groups. The inline preset has shortcuts only. */
export const TOOLBAR_LAYOUT: Record<ToolbarPreset, string[][]> = {
  full: [
    ["heading", "bold", "italic", "underline", "strike"],
    ["bulletList", "orderedList", "taskList"],
    ["link", "quote", "code", "codeBlock"],
  ],
  minimal: [
    ["bold", "italic", "underline", "strike"],
    ["link", "bulletList", "quote", "code"],
  ],
  document: [
    ["heading1", "heading2", "heading3"],
    ["bold", "italic", "underline", "strike"],
    ["bulletList", "orderedList", "taskList"],
    ["link", "quote", "code", "codeBlock", "table"],
  ],
}

/** A tool button (h-7 w-7), the row's gap (gap-0.5) and a group divider (mx-1 w-px). */
const TOOL_PX = 28
const GAP_PX = 2
const DIVIDER_PX = 9

/**
 * Which tools a row `width` px wide shows, in order, and which go into the
 * "more" menu at its end (with the width the row then takes). Every tool
 * shows when they all fit.
 */
export function toolbarFit(
  preset: ToolbarPreset,
  width: number,
): { shown: string[]; more: string[]; width: number } {
  const steps: Array<{ key: string; px: number }> = []
  TOOLBAR_LAYOUT[preset].forEach((group, g) => {
    group.forEach((key, i) => {
      const lead = steps.length === 0 ? 0 : GAP_PX
      const divider = g > 0 && i === 0 ? DIVIDER_PX + GAP_PX : 0
      steps.push({ key, px: lead + divider + TOOL_PX })
    })
  })
  const all = steps.reduce((sum, step) => sum + step.px, 0)
  if (all <= width) return { shown: steps.map((s) => s.key), more: [], width: all }
  const morePx = GAP_PX + TOOL_PX
  let used = 0
  let count = 0
  while (count < steps.length && used + steps[count].px + morePx <= width) {
    used += steps[count].px
    count++
  }
  return {
    shown: steps.slice(0, count).map((s) => s.key),
    more: steps.slice(count).map((s) => s.key),
    width: used + (count === 0 ? TOOL_PX : morePx),
  }
}

export const EditorToolbar: Component<{
  editor: Editor
  preset: ToolbarPreset
  /** Read inside every check, so the buttons follow the selection. */
  version: () => number
  disabled?: boolean
  onLink: () => void
  /** `more` (default): the tools that do not fit fold into a "more" menu.
   *  `scroll`: every tool stays in the row, which scrolls sideways with a
   *  fade at the edge that has more (a header row on a phone). */
  overflow?: "more" | "scroll"
  class?: string
}> = (props) => {
  const i18n = useI18n()
  const scrolls = () => props.overflow === "scroll"
  const isActive = (tool: Tool) => {
    props.version()
    return tool.active(props.editor)
  }
  let row: HTMLDivElement | undefined
  // ONE ROW, NOTHING CLIPPED: the tools that do not fit the row's width go
  // into a "more" menu at its end (a ~340 px task comment cut the quote and
  // code tools off at the edge). Unmeasured (no layout yet), every tool shows.
  const [width, setWidth] = createSignal(Number.POSITIVE_INFINITY)
  onMount(() => {
    const el = row
    if (!el) return
    const measure = () => setWidth(el.clientWidth > 0 ? el.clientWidth : Number.POSITIVE_INFINITY)
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    onCleanup(() => observer.disconnect())
  })
  const fit = createMemo(() =>
    toolbarFit(props.preset, scrolls() ? Number.POSITIVE_INFINITY : width()),
  )
  const { canScrollStart, canScrollEnd } = createScrollOverflow(() => row, "horizontal")
  const fade = () => {
    if (!scrolls()) return undefined
    const start = canScrollStart() ? "transparent, #000 1.25rem" : "#000"
    const end = canScrollEnd() ? "#000 calc(100% - 1.25rem), transparent" : "#000"
    const mask = `linear-gradient(to right, ${start}, ${end})`
    return { "mask-image": mask, "-webkit-mask-image": mask }
  }
  /** The groups as shown: hidden tools out, a group left empty dropped. */
  const groups = createMemo(() => {
    const shown = new Set(fit().shown)
    return TOOLBAR_LAYOUT[props.preset]
      .map((group) => group.filter((key) => shown.has(key)))
      .filter((group) => group.length > 0)
  })
  return (
    <div
      ref={row}
      role="toolbar"
      aria-label={i18n.t("kernel.editor.formatting")}
      data-testid="rich-editor.toolbar"
      data-overflow={scrolls() ? "scroll" : "more"}
      class={cn(
        "flex min-w-0 shrink-0 items-center gap-0.5",
        scrolls() ? "overflow-x-auto overflow-y-hidden [scrollbar-width:none]" : "overflow-hidden",
        props.class,
      )}
      style={fade()}
      // Pressing a tool keeps the caret in the text. On the mouse event, not
      // the pointer one: WebKit drops the click of a tap whose pointerdown was
      // cancelled, so no tool worked by touch on iOS.
      onMouseDown={(e) => e.preventDefault()}
    >
      <For each={groups()}>
        {(group, index) => (
          <>
            <Show when={index() > 0}>
              <span aria-hidden="true" class="mx-1 h-4 w-px shrink-0 bg-border-subtle" />
            </Show>
            <For each={group}>
              {(key) => {
                const tool = TOOLS[key]!
                const label = i18n.t(`kernel.editor.${key}`)
                const Icon = tool.icon
                return (
                  <Show
                    when={!(key === "table" && isActive(tool))}
                    fallback={<TableMenu editor={props.editor} label={label} />}
                  >
                    <Tooltip content={hintFor(tool, label)} triggerClass="shrink-0">
                      <Toggle
                        pressed={isActive(tool)}
                        onChange={() => (key === "link" ? props.onLink() : tool.run(props.editor))}
                        disabled={props.disabled}
                        aria-label={label}
                        data-testid={`rich-editor.tool-${key}`}
                        data-touch-dense
                        class="h-7 w-7 shrink-0 rounded-sm p-0"
                      >
                        <Icon class="h-3.5 w-3.5" stroke-width={2.25} />
                      </Toggle>
                    </Tooltip>
                  </Show>
                )
              }}
            </For>
          </>
        )}
      </For>
      <Show when={fit().more.length > 0}>
        <MoreTools editor={props.editor} keys={fit().more} onLink={props.onLink} />
      </Show>
    </div>
  )
}

/** The tools the row had no room for, by name, in a menu at its end. */
const MoreTools: Component<{
  editor: Editor
  keys: string[]
  onLink: () => void
}> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  return (
    <PopupMenu open={open()} onOpenChange={setOpen}>
      <PopupMenu.Trigger
        aria-label={i18n.t("kernel.editor.moreTools")}
        data-testid="rich-editor.more"
        class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm p-0 text-text-secondary hover:bg-surface-hover hover:text-text"
        data-touch-dense
      >
        <MoreHorizontal class="h-3.5 w-3.5" stroke-width={2.25} />
      </PopupMenu.Trigger>
      <PopupMenu.Content
        aria-label={i18n.t("kernel.editor.moreTools")}
        data-testid="rich-editor.more-menu"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const { editor } = props
          if (!editor.isDestroyed && !editor.view.dom.contains(document.activeElement)) {
            editor.view.focus()
          }
        }}
      >
        <For each={props.keys}>
          {(key) => {
            const tool = TOOLS[key]!
            const Icon = tool.icon
            const label = i18n.t(`kernel.editor.${key}`)
            return (
              <PopupMenu.Item
                data-testid={`rich-editor.more-${key}`}
                onSelect={() => (key === "link" ? props.onLink() : tool.run(props.editor))}
              >
                <span class="flex items-center gap-2">
                  <Icon class="h-3.5 w-3.5" stroke-width={2.25} />
                  {hintFor(tool, label)}
                </span>
              </PopupMenu.Item>
            )
          }}
        </For>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

/**
 * The table tool while the caret is in a table: its actions, by name. Focus
 * goes back to the text, so typing carries on in the cell, never to the tool.
 */
const TableMenu: Component<{ editor: Editor; label: string }> = (props) => {
  const i18n = useI18n()
  const [open, setOpen] = createSignal(false)
  return (
    <PopupMenu open={open()} onOpenChange={setOpen}>
      <PopupMenu.Trigger
        aria-label={props.label}
        data-testid="rich-editor.tool-table"
        class="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm bg-accent-glow p-0 text-accent"
        data-touch-dense
      >
        <Table class="h-3.5 w-3.5" stroke-width={2.25} />
      </PopupMenu.Trigger>
      <PopupMenu.Content
        aria-label={props.label}
        data-testid="rich-editor.table-menu"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          const { editor } = props
          if (!editor.isDestroyed && !editor.view.dom.contains(document.activeElement)) {
            editor.view.focus()
          }
        }}
      >
        <For each={TABLE_ACTIONS}>
          {([key, run]) => (
            <PopupMenu.Item
              variant={key === "deleteTable" ? "danger" : undefined}
              onSelect={() => {
                run(props.editor)
                // Back to the text at once, not once the menu has faded out:
                // keys and clicks meanwhile went to the closing menu.
                props.editor.view.focus()
              }}
              data-testid={`rich-editor.table-${key}`}
            >
              {i18n.t(`kernel.editor.${key}`)}
            </PopupMenu.Item>
          )}
        </For>
      </PopupMenu.Content>
    </PopupMenu>
  )
}

/** The link row: shown in place of the toolbar (below an inline field) while a link is edited. */
export const LinkRow: Component<{
  initial: string
  canRemove: boolean
  onApply: (href: string) => void
  onRemove: () => void
  onClose: () => void
}> = (props) => {
  const i18n = useI18n()
  const [href, setHref] = createSignal(props.initial)
  let input: HTMLInputElement | undefined
  onMount(() => input?.select())
  const iconButton =
    "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
  return (
    <form
      data-testid="rich-editor.link-row"
      class="flex min-w-0 items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        props.onApply(href())
      }}
    >
      <input
        ref={input}
        type="text"
        inputmode="url"
        autocapitalize="off"
        autocorrect="off"
        spellcheck={false}
        data-testid="rich-editor.link-input"
        aria-label={i18n.t("kernel.editor.linkUrl")}
        placeholder={i18n.t("kernel.editor.linkUrl")}
        value={href()}
        onInput={(e) => setHref(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.isComposing || (e.key !== "Escape" && e.key !== "Enter")) return
          // Handled here, not by the form's implicit submit: focus is back in
          // the text by then, and the Enter would land there and replace the
          // selection just linked with a line break.
          e.preventDefault()
          e.stopPropagation()
          if (e.key === "Enter") props.onApply(href())
          else props.onClose()
        }}
        class="h-7 min-w-0 flex-1 rounded-sm border border-border bg-bg px-2 text-[12.5px] text-text outline-none placeholder:text-text-tertiary focus:border-accent-muted"
      />
      <button
        type="submit"
        class={cn(iconButton, "text-accent")}
        aria-label={i18n.t("kernel.editor.applyLink")}
        data-testid="rich-editor.link-apply"
      >
        <Check class="h-3.5 w-3.5" />
      </button>
      <Show when={props.canRemove}>
        <button
          type="button"
          class={iconButton}
          aria-label={i18n.t("kernel.editor.removeLink")}
          onClick={() => props.onRemove()}
        >
          <Unlink class="h-3.5 w-3.5" />
        </button>
      </Show>
      <button
        type="button"
        class={iconButton}
        aria-label={i18n.t("kernel.common.cancel")}
        onClick={() => props.onClose()}
      >
        <X class="h-3.5 w-3.5" />
      </button>
    </form>
  )
}
