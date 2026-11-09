// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE ONE EDITOR for what people write in Liaison. It shows formatting as
// formatting and reads and writes markdown, so storage, agents and renderers
// are unchanged. Presets: `full` (documents, tasks), `minimal` (messages) and
// `inline` (a one-line field: marks and shortcuts, Enter submits).
//
// `value` is the field's markdown. While nothing has been edited, `onChange`
// hands back that exact string rather than the editor's own spelling of it,
// so opening a field and leaving it never rewrites what was stored.
import { type EmojiSuggestion, emojiForShortcode, searchEmojiShortcodes } from "@liaison/shared"
import { Editor, type JSONContent } from "@tiptap/core"
import { CharacterCount } from "@tiptap/extensions"
import { closeHistory } from "@tiptap/pm/history"
import { type EditorState, Selection } from "@tiptap/pm/state"
import {
  type Component,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js"
import { Portal } from "solid-js/web"
import { cn } from "~/lib/cn"
import type { MentionTrigger } from "~/lib/mention-service"
import { ownEntityLink, pastedAddressText } from "~/modules/shell/entity-link"
import { EditorToolbar, LinkRow } from "./EditorToolbar"
import { EmojiSuggest } from "./EmojiSuggest"
import { emojiNameBeforeColon, emojiQueryAt } from "./emoji-trigger"
import { type EditorPreset, editorExtensions, insertedTintKey } from "./extensions"
import { mapSource, type SourceMap, spliceMarkdown } from "./source-map"

export interface RichEditorHandle {
  /** The editable field itself (the magic wand proofreads what it shows). */
  element: HTMLElement
  focus: () => void
  /** Type text at the end, as if keyed in there. */
  insertText: (text: string) => void
  /** Insert text at the caret, where it was when the field lost focus. */
  insert: (text: string) => void
  /** Insert markdown where the caret was (a reply template). */
  insertMarkdown: (markdown: string) => void
  /** Put a mention chip in place of the `@name` being typed, then a space. */
  mention: (chip: { label: string; ref: string }) => void
  /** Hold the caret or selection as it is now; edits made around it move it along. */
  anchor: () => TextAnchor
  /** Put plain text (never parsed as markup) over a range as ONE undo step;
   *  answers the range the text now covers. Dictation writes through it. */
  replaceText: (range: TextRange, text: string) => TextRange
  /** Tint a range for a moment (the text dictation just wrote). */
  tint: (range: TextRange) => void
}

/** How long text written by dictation stays tinted (the CSS fade's length). */
export const INSERTED_TINT_MS = 1600

export interface TextRange {
  from: number
  to: number
}

/** A held place in the text, mapped through every edit until released. */
export interface TextAnchor {
  /**
   * Where to write: the held selection while nobody edited inside it, else an
   * empty range at its end (after anything typed at a held caret).
   */
  range: () => TextRange
  release: () => void
}

interface HeldPlace {
  from: number
  to: number
  /** Held as a selection to replace; false for a caret (or a selection since edited). */
  selection: boolean
}

/** One transaction's step maps applied to a held place (see `anchors`). */
function mapHeldPlace(
  held: HeldPlace,
  maps: ReadonlyArray<{
    map: (pos: number, assoc?: number) => number
    forEach: (fn: (oldStart: number, oldEnd: number) => void) => void
  }>,
): void {
  for (const map of maps) {
    let edited = false
    if (held.selection) {
      map.forEach((oldStart, oldEnd) => {
        const inside =
          oldStart === oldEnd
            ? oldStart > held.from && oldStart < held.to
            : oldStart < held.to && oldEnd > held.from
        if (inside) edited = true
      })
    }
    if (!held.selection) {
      held.from = map.map(held.from, 1)
      held.to = map.map(held.to, 1)
    } else if (edited) {
      // No longer what was selected: from here on a caret at its end, so
      // what is typed there next also stays before the dictation.
      held.to = map.map(held.to, 1)
      held.from = held.to
      held.selection = false
    } else {
      held.from = map.map(held.from, 1)
      held.to = map.map(held.to, -1)
    }
  }
}

/** The `@name` or `#name` being typed at the caret. */
export interface MentionQuery {
  trigger: MentionTrigger
  text: string
}

export interface RichEditorProps {
  value: string
  onChange?: (markdown: string) => void
  preset: EditorPreset
  /** `focus`: the toolbar shows under the text while the field has focus;
   *  `none`: hidden (the chat's Aa shows it). Default `always`. */
  toolbar?: "always" | "focus" | "none"
  /** Renders the toolbar into this element (a composer's header row) instead
   *  of above the text. Focus moving into it still counts as in the field. */
  toolbarMount?: HTMLElement
  /** How the toolbar handles a row too narrow for every tool (EditorToolbar). */
  toolbarOverflow?: "more" | "scroll"
  toolbarClass?: string
  placeholder?: string
  autofocus?: boolean
  disabled?: boolean
  maxLength?: number
  onSubmit?: () => void
  /** Enter submits and Shift+Enter starts the next line (a message). */
  enterSubmits?: boolean
  onCancel?: () => void
  /** Sees each key first; `true` takes it (an open picker's arrows and Enter). */
  onKeyDown?: (event: KeyboardEvent) => boolean
  /** The `@name` or `#name` being typed, or null once there is none. */
  onMention?: (query: MentionQuery | null) => void
  /** Focus left the editor, its toolbar and its link row. */
  onBlur?: () => void
  /** Called first; a handler that calls `preventDefault` keeps the paste (pasted files). */
  onPaste?: (event: ClipboardEvent) => void
  ref?: (handle: RichEditorHandle) => void
  class?: string
  editorClass?: string
  "aria-label"?: string
  "data-testid"?: string
}

/** In a one-line field a leading `1.` or `#` is text, not a list or a heading. */
function editorSource(markdown: string, preset: EditorPreset): string {
  if (preset !== "inline") return markdown
  return markdown.replace(/^(\s*\d*)([*+-](?=\s)|#(?=#*(\s|$))|>|(?<=\d)[.)](?=\s|$))/, "$1\\$2")
}

/**
 * The mention being typed: `@` or `#` at the start of a line or after a space,
 * then up to 30 characters without one, ending at the caret.
 */
function mentionAt(state: EditorState): (MentionQuery & { from: number }) | null {
  const { empty, $from } = state.selection
  if (!empty || $from.parent.type.spec.code) return null
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : "\ufffc",
  )
  const match = /(?:^|\s)([@#])(\S{0,30})$/.exec(before)
  if (!match) return null
  const text = match[2]!
  return { trigger: match[1] as MentionTrigger, text, from: $from.pos - text.length - 1 }
}

/** Text as typed: its lines, joined by line breaks. */
function asTyped(text: string): JSONContent[] {
  return text
    .split(/\r\n?|\n/)
    .flatMap((line, i) => [
      ...(i > 0 ? [{ type: "hardBreak" }] : []),
      ...(line ? [{ type: "text", text: line }] : []),
    ])
}

/** VS Code language modes that hold prose, not code. */
const PROSE_MODES = new Set(["markdown", "plaintext"])

/**
 * What a paste into a message was copied from: code (a code editor, a <pre>,
 * `white-space: pre`), prose from a text editor (taken line for line), or
 * anything else (its HTML). `pre-wrap` and `pre-line` are how chat views, mail
 * and rich editors lay out prose, so they never mark code.
 */
function pastedFrom(data: DataTransfer): "code" | "text" | "html" {
  if (data.types.includes("vscode-editor-data")) {
    let mode: unknown
    try {
      mode = JSON.parse(data.getData("vscode-editor-data")).mode
    } catch {
      mode = undefined
    }
    return typeof mode === "string" && PROSE_MODES.has(mode) ? "text" : "code"
  }
  return /white-space:\s*pre(?![\w-])|<pre[\s>]/i.test(data.getData("text/html")) ? "code" : "html"
}

/** A pasted code block, the caret then on the line after it to go on typing. */
function pasteCode(ed: Editor, code: string): void {
  ed.chain()
    .insertContent({ type: "codeBlock", content: [{ type: "text", text: code }] })
    .run()
  const { $from } = ed.state.selection
  if ($from.parent.type.name !== "codeBlock") return
  const after = $from.after()
  if (after < ed.state.doc.content.size) ed.commands.setTextSelection(after + 1)
  else ed.commands.exitCode()
}

function linkHref(input: string): string {
  const href = input.trim()
  return !href || /^[a-z][\w+.-]*:/i.test(href) ? href : `https://${href}`
}

export const RichEditor: Component<RichEditorProps> = (props) => {
  const [editor, setEditor] = createSignal<Editor>()
  const [version, setVersion] = createSignal(0)
  const [focused, setFocused] = createSignal(false)
  const [linking, setLinking] = createSignal(false)
  // A focus toolbar folds away only once the press that took focus elsewhere
  // is released: folding on the press moved the page under the pointer, and
  // the click landed on whatever slid into its place.
  let pressing = false
  const press = () => {
    pressing = true
  }
  const release = () => {
    pressing = false
  }
  onMount(() => {
    if (props.toolbar !== "focus") return
    window.addEventListener("pointerdown", press, true)
    window.addEventListener("pointerup", release, true)
    window.addEventListener("pointercancel", release, true)
    onCleanup(() => {
      window.removeEventListener("pointerdown", press, true)
      window.removeEventListener("pointerup", release, true)
      window.removeEventListener("pointercancel", release, true)
    })
  })
  const fold = () => {
    if (!pressing) return setFocused(false)
    const after = () => setTimeout(() => setFocused(frame.contains(document.activeElement)))
    window.addEventListener("pointerup", after, { once: true })
    window.addEventListener("pointercancel", after, { once: true })
  }
  let mount!: HTMLDivElement
  let frame!: HTMLDivElement
  // The markdown last loaded, its serialization as loaded, and the last value emitted.
  let loaded = ""
  let baseline = ""
  let emitted: string | undefined
  // Each block's source, so blocks not edited are written back as they were read.
  let sourceMap: SourceMap | null = null
  const serialize = (ed: Editor) =>
    // The trailing empty paragraph the editor keeps after a list is not content.
    sourceMap ? spliceMarkdown(ed, sourceMap) : ed.getMarkdown().trimEnd()
  let mentioning = ""
  // The emoji picker: the shortcode being typed, and the one Escape closed
  // (it stays closed until the colon it belongs to is gone).
  const [emoji, setEmoji] = createSignal<{
    items: EmojiSuggestion[]
    from: number
    active: number
    anchor: { left: number; top: number; bottom: number }
  } | null>(null)
  let emojiDismissed: number | null = null
  const syncEmoji = (ed: Editor) => {
    const query = ed.isEditable && ed.view.hasFocus() ? emojiQueryAt(ed.state) : null
    if (!query) {
      emojiDismissed = null
      if (emoji()) setEmoji(null)
      return
    }
    if (emojiDismissed === query.from) {
      if (emoji()) setEmoji(null)
      return
    }
    const items = searchEmojiShortcodes(query.text)
    if (!items.length) {
      if (emoji()) setEmoji(null)
      return
    }
    let anchor = { left: 0, top: 0, bottom: 0 }
    try {
      const at = ed.view.coordsAtPos(ed.state.selection.from)
      anchor = { left: at.left, top: at.top, bottom: at.bottom }
    } catch {
      // No layout (a test environment): the list opens at the corner.
    }
    const same = emoji()
    const active = same && same.from === query.from ? Math.min(same.active, items.length - 1) : 0
    setEmoji({ items, from: query.from, active, anchor })
  }
  const pickEmoji = (ed: Editor, item: EmojiSuggestion) => {
    const open = emoji()
    if (!open) return
    const { to } = ed.state.selection
    ed.view.dispatch(ed.state.tr.insertText(item.emoji, open.from, to))
    setEmoji(null)
    ed.view.focus()
  }
  // Keys an open picker takes before anything else sees them.
  const emojiKey = (event: KeyboardEvent): boolean => {
    const open = emoji()
    const ed = editor()
    if (!open || !ed || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
      return false
    }
    const n = open.items.length
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const step = event.key === "ArrowDown" ? 1 : n - 1
        setEmoji({ ...open, active: (open.active + step) % n })
        break
      }
      case "Enter":
      case "Tab": {
        if (event.shiftKey) return false
        pickEmoji(ed, open.items[open.active]!)
        break
      }
      case "Escape":
        emojiDismissed = open.from
        setEmoji(null)
        break
      default:
        return false
    }
    event.preventDefault()
    return true
  }
  // The caret right after the space a picked mention adds: a space typed
  // there first is that space (people type one after a name anyway, and the
  // message went out as "@Tobias Braun  please").
  let softSpace: number | null = null
  // Held places (dictation's caret) follow every edit made while they wait.
  // A caret is mapped forward at both ends, so text typed AT it stays before
  // it (and is never covered by the range). A selection is mapped inward
  // (edits at its edges stay outside) until anything changes inside it: from
  // then on it is no longer what was selected, and it becomes a caret at its
  // end, so the text goes in there instead of replacing it.
  const anchors = new Set<HeldPlace>()

  const load = (ed: Editor, markdown: string) => {
    // Loading is not an edit: it neither notifies nor lands in the undo history.
    // The caret starts at the top, as a reader does: left at the end, an
    // always-shown toolbar lit the tools of the last block (a quote).
    ed.chain()
      .setMeta("addToHistory", false)
      .setContent(editorSource(markdown, props.preset), {
        contentType: "markdown",
        emitUpdate: false,
      })
      .command(({ tr }) => {
        tr.setSelection(Selection.atStart(tr.doc))
        return true
      })
      .run()
    loaded = markdown
    sourceMap = props.preset === "inline" ? null : mapSource(ed, markdown)
    baseline = serialize(ed)
    emitted = markdown
  }

  onMount(() => {
    const ed = new Editor({
      element: mount,
      extensions: [
        ...editorExtensions(props.preset, {
          placeholder: props.placeholder,
          keys: {
            onSubmit: props.onSubmit && (() => props.onSubmit?.()),
            enterSubmits: props.enterSubmits,
            onCancel: props.onCancel && (() => props.onCancel?.()),
            onLink: () => setLinking(true),
          },
        }),
        ...(props.maxLength ? [CharacterCount.configure({ limit: props.maxLength })] : []),
      ],
      editable: !props.disabled,
      // Focused below, as it mounts: tiptap's own autofocus runs a task later
      // and moved the caret to the end over a selection made meanwhile (select
      // all, then type, ended up appending).
      autofocus: false,
      editorProps: {
        attributes: {
          class: cn("prose-thread min-w-0 outline-none", props.editorClass),
          role: "textbox",
          "aria-multiline": props.preset === "inline" ? "false" : "true",
          ...(props["aria-label"] || props.placeholder
            ? { "aria-label": props["aria-label"] ?? props.placeholder ?? "" }
            : {}),
          ...(props["data-testid"] ? { "data-testid": props["data-testid"] } : {}),
        },
        // Files dropped on the text go to the surface around it (the comment
        // box's drop zone), never into the text.
        handleDrop: (_view, event) => !!event.dataTransfer?.files.length,
        handleKeyDown: (_view, event) => emojiKey(event) || (props.onKeyDown?.(event) ?? false),
        handleTextInput: (view, from, to, text) => {
          const at = softSpace
          softSpace = null
          // The closing colon of a known shortcode turns it into the emoji.
          if (text === ":" && from === to) {
            const typed = emojiNameBeforeColon(view.state)
            // Not the one whose picker Escape closed: the person said "not an emoji".
            const dismissed = typed !== null && typed.from === emojiDismissed
            const char = typed && !dismissed && emojiForShortcode(typed.text.toLowerCase())
            if (typed && char) {
              view.dispatch(view.state.tr.insertText(char, typed.from, to))
              return true
            }
          }
          return text === " " && from === at && to === at
        },
        handlePaste: (_view, event) => {
          props.onPaste?.(event)
          if (event.defaultPrevented) return true
          // A file the surface did not take (an image, a document) is dropped
          // whole: never its name, a data URL or a stray character in the text.
          if (Array.from(event.clipboardData?.items ?? []).some((item) => item.kind === "file")) {
            return true
          }
          // Plain text is read as markdown: it is what the field stores, and
          // what a reader would have seen it as. A message takes it as copied,
          // line for line, as the chat field always did.
          const data = event.clipboardData
          if (props.preset === "inline" || !data) return false
          // Code copied from an editor (VS Code writes one <div> per line) is
          // taken as copied in a message: several lines are a code block, seen
          // as code while typing and sent fenced; one line stays text. Prose
          // from a VS Code markdown or text file is text, line for line.
          const copied = props.preset === "minimal" ? pastedFrom(data) : "html"
          const code = copied === "code"
          if (copied === "html" && data.types.includes("text/html")) return false
          const text = pastedAddressText(data.getData("text/plain"))
          if (!text) return false
          // An address of an entity page on THIS server is a reference to that
          // entity: the chip every other mention is, not a bare link.
          const own = ed.isActive("codeBlock") ? null : ownEntityLink(text)
          if (own) {
            ed.chain()
              .insertContent([
                { type: "mention", attrs: { label: own.label, ref: own.ref } },
                { type: "text", text: " " },
              ])
              .run()
            return true
          }
          const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "")
          if (code && lines.includes("\n")) pasteCode(ed, lines)
          else if (props.preset === "minimal") ed.commands.insertContent(asTyped(text))
          else ed.commands.insertContent(text, { contentType: "markdown" })
          return true
        },
      },
    })
    load(
      ed,
      untrack(() => props.value),
    )
    if (untrack(() => props.autofocus)) ed.commands.focus("end")
    ed.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) {
        for (const held of anchors) mapHeldPlace(held, transaction.mapping.maps)
      }
      setVersion((v) => v + 1)
      syncEmoji(ed)
      if (!props.onMention) return
      const query = mentionAt(ed.state)
      const key = query ? `${query.trigger}${query.text}` : ""
      if (key === mentioning) return
      mentioning = key
      props.onMention(query && { trigger: query.trigger, text: query.text })
    })
    ed.on("blur", () => setEmoji(null))
    ed.on("update", () => {
      const markdown = serialize(ed)
      const next = markdown === baseline ? loaded : markdown
      if (next === emitted) return
      emitted = next
      props.onChange?.(next)
    })
    setEditor(ed)
    props.ref?.({
      element: ed.view.dom,
      focus: () => ed.commands.focus("end"),
      insertText: (text) => ed.chain().focus("end").insertContent(text).run(),
      // Focus synchronously first: TipTap's focus waits a frame outside
      // Safari, and the keys typed right after a pick or an emoji were lost.
      insert: (text) => {
        ed.view.focus()
        ed.chain().focus().insertContent(text).run()
      },
      mention: (chip) => {
        ed.view.focus()
        const { from, to } = ed.state.selection
        ed.chain()
          .focus()
          .insertContentAt(
            { from: mentionAt(ed.state)?.from ?? from, to },
            { type: "mention", attrs: chip },
          )
          .run()
        const after = ed.state.selection.$from.nodeAfter?.text?.startsWith(" ")
        if (after) ed.commands.setTextSelection(ed.state.selection.from + 1)
        else ed.commands.insertContent(" ")
        softSpace = ed.state.selection.from
      },
      insertMarkdown: (markdown) =>
        ed.chain().focus().insertContent(markdown, { contentType: "markdown" }).run(),
      anchor: () => {
        const { from, to } = ed.state.selection
        const held: HeldPlace = { from, to, selection: from !== to }
        anchors.add(held)
        return {
          range: () => ({ from: held.selection ? held.from : held.to, to: held.to }),
          release: () => anchors.delete(held),
        }
      },
      replaceText: (range, text) => {
        const size = ed.state.doc.content.size
        const from = Math.max(0, Math.min(range.from, size))
        const to = Math.max(from, Math.min(range.to, size))
        ed.view.focus()
        // Its own undo step: never merged with typing just before it.
        const tr = closeHistory(ed.state.tr.insertText(text, from, to))
        ed.view.dispatch(tr)
        return { from, to: from + text.length }
      },
      tint: (range) => {
        if (ed.isDestroyed) return
        ed.view.dispatch(ed.state.tr.setMeta(insertedTintKey, range))
        setTimeout(() => {
          if (!ed.isDestroyed) ed.view.dispatch(ed.state.tr.setMeta(insertedTintKey, null))
        }, INSERTED_TINT_MS)
      },
    })
    onCleanup(() => {
      setEditor(undefined)
      ed.destroy()
    })
  })

  // A value from outside (a reset after sending, a live update) replaces the content.
  createEffect(
    on(
      () => props.value,
      (value) => {
        const ed = editor()
        if (ed && value !== emitted) load(ed, value)
      },
      { defer: true },
    ),
  )
  createEffect(() => editor()?.setEditable(!props.disabled))

  const applyLink = (input: string) => {
    const ed = editor()
    if (!ed) return
    const href = linkHref(input)
    const chain = ed.chain().focus().extendMarkRange("link")
    if (!href) chain.unsetLink().run()
    else if (ed.state.selection.empty && !ed.isActive("link")) {
      chain
        .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
        .run()
    } else chain.setLink({ href }).run()
    closeLink()
  }
  // Focus goes back to the text BEFORE the row leaves, or its going would read
  // as leaving the field. Synchronously: TipTap's focus command waits a frame
  // outside Safari, and by then the row is gone and focus fell to the page.
  function closeLink() {
    editor()?.view.focus()
    setLinking(false)
  }

  const linkRow = () => (
    <LinkRow
      initial={editor()?.getAttributes("link").href ?? ""}
      canRemove={!!editor()?.isActive("link")}
      onApply={applyLink}
      onRemove={() => applyLink("")}
      onClose={closeLink}
    />
  )
  const toolbar = () => {
    const ed = editor()
    if (!ed || props.preset === "inline") return null
    return (
      <Show when={!linking()} fallback={linkRow()}>
        <EditorToolbar
          editor={ed}
          preset={props.preset}
          version={version}
          disabled={props.disabled}
          onLink={() => setLinking(true)}
          overflow={props.toolbarOverflow}
          class={props.toolbarClass}
        />
      </Show>
    )
  }
  const showToolbar = () =>
    !props.disabled &&
    (props.toolbar === "none" ? linking() : props.toolbar !== "focus" || focused() || linking())

  return (
    <div
      ref={frame}
      class={cn("rich-editor flex min-w-0 flex-col gap-2.5", props.class)}
      onFocusIn={() => setFocused(true)}
      onFocusOut={(e) => {
        const next = e.relatedTarget as Node | null
        if (frame.contains(next) || props.toolbarMount?.contains(next)) return
        fold()
        setLinking(false)
        props.onBlur?.()
      }}
    >
      {/* Stays at the top of the scrolling page while a long text is edited,
          painted with the field's own background (--editor-bg, set by a
          surface whose field is not on the page colour). */}
      <Show when={!props.toolbarMount && props.toolbar !== "focus" && showToolbar()}>
        <div class="sticky top-0 z-10 bg-[var(--editor-bg,var(--color-bg))]">{toolbar()}</div>
      </Show>
      <Show when={props.toolbarMount}>
        {(host) => (
          <Portal mount={host()} ref={(el: HTMLDivElement) => el.classList.add("contents")}>
            <Show when={showToolbar()}>{toolbar()}</Show>
          </Portal>
        )}
      </Show>
      <div ref={mount} class="min-w-0" />
      <Show when={!props.toolbarMount && props.toolbar === "focus" && showToolbar()}>
        {toolbar()}
      </Show>
      <Show when={props.preset === "inline" && linking()}>{linkRow()}</Show>
      <Show when={emoji()}>
        {(open) => (
          <EmojiSuggest
            items={open().items}
            active={open().active}
            anchor={open().anchor}
            onPick={(item) => {
              const ed = editor()
              if (ed) pickEmoji(ed, item)
            }}
          />
        )}
      </Show>
    </div>
  )
}

export default RichEditor
