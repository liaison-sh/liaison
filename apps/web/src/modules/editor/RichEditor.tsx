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
import {
  type EmojiSuggestion,
  emojiForShortcode,
  fileIdsOf,
  replaceFileIds,
  searchEmojiShortcodes,
} from "@liaison/shared"
import { Editor, type JSONContent } from "@tiptap/core"
import { CharacterCount } from "@tiptap/extensions"
import { closeHistory } from "@tiptap/pm/history"
import { Slice } from "@tiptap/pm/model"
import { type EditorState, Selection, TextSelection } from "@tiptap/pm/state"
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
import { useI18n } from "~/modules/i18n/i18n-context"
import { ownEntityLink, pastedAddressText } from "~/modules/shell/entity-link"
import { EditorToolbar, LinkRow } from "./EditorToolbar"
import { EmojiSuggest } from "./EmojiSuggest"
import { emojiNameBeforeColon, emojiQueryAt } from "./emoji-trigger"
import { type EditorPreset, editorExtensions, insertedTintKey } from "./extensions"
import type { FileViewDeps } from "./file-view"
import { fileIdsInFragment, isEmptySlice, withFileIds, withoutFiles } from "./liaison-file"
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
  /** Add markdown as new blocks after the last one, leaving the caret, the
   *  selection and the focus where they are (a signature that arrived late). */
  appendMarkdown: (markdown: string) => void
  /** Put a mention chip in place of the `@name` being typed, then a space. */
  mention: (chip: { label: string; ref: string }) => void
  /** Hold the caret or selection as it is now; edits made around it move it along. */
  anchor: () => TextAnchor
  /** Put plain text (never parsed as markup) over a range as ONE undo step;
   *  answers the range the text now covers. Dictation writes through it. */
  replaceText: (range: TextRange, text: string) => TextRange
  /** Tint a range for a moment (the text dictation just wrote). */
  tint: (range: TextRange) => void
  /** The field's markdown now, serialized on demand (the stored text while nothing changed). */
  markdown: () => string
  /**
   * Whether the text loaded last is written back byte for byte by this editor: each
   * block tied to its source, and the whole spliced back equal to it (line endings
   * aside). A page that does not is edited as source instead (SourceEditor).
   */
  readonly roundTrips: boolean
  /**
   * Show a newer text from elsewhere (another person's save) in place of this one:
   * only the range that differs is replaced, the caret and selection are mapped
   * through it, nothing is emitted and nothing lands in the undo history. The text
   * becomes the one loaded.
   */
  applyRemote: (markdown: string) => void
  /** Upload files and put each where the caret is, as the page's image or file. */
  insertFiles: (files: File[]) => void
  /**
   * The server stored its own copies of files of other pages: their ids become the
   * copies' ids (old id to new id). Not an edit: nothing is emitted, nothing lands in
   * the undo history, the caret stays, and the text becomes the one the server holds.
   */
  replaceFileIds: (map: Readonly<Record<string, string>>) => void
}

/** A page's files: how they are drawn, stored and refused (document preset). */
export interface EditorFiles {
  view: FileViewDeps
  /** Store a file on the page; answers the new file's id. Rejects with a readable message. */
  upload: (file: File) => Promise<string>
  /** A file was not added: the reason, said to the writer. */
  onRefused: (message: string) => void
  /** Said when a pasted file is one the writer cannot read (it is not inserted). */
  unreadable: string
  /** The chip of a file on its way. */
  uploading: (name: string) => string
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
  /** The text was edited (called without serializing it; `markdown()` reads it). */
  onEdit?: () => void
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
  /** A page's files (document preset): pasted, dropped and picked files are uploaded. */
  files?: EditorFiles
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
  const i18n = useI18n()
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
  // Whether the text loaded last is written back as it was read.
  let roundTrips = false
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
    settle(ed, markdown)
  }

  /** `markdown` is now the text the editor shows: what an unedited field hands back. */
  const settle = (ed: Editor, markdown: string) => {
    loaded = markdown
    sourceMap = props.preset === "inline" ? null : mapSource(ed, markdown)
    baseline = serialize(ed)
    emitted = markdown
    roundTrips =
      sourceMap !== null && spliceMarkdown(ed, sourceMap) === markdown.replace(/\r\n?/g, "\n")
  }

  /** The current text: the loaded one, byte for byte, while it is unchanged. */
  const current = (ed: Editor) => {
    const markdown = serialize(ed)
    return markdown === baseline ? loaded : markdown
  }

  /** Replace only what differs between the shown document and `markdown`'s. */
  const applyRemote = (ed: Editor, markdown: string) => {
    const manager = ed.markdown
    if (!manager) return load(ed, markdown)
    const next = ed.schema.nodeFromJSON(manager.parse(editorSource(markdown, props.preset)))
    const doc = ed.state.doc
    const start = doc.content.findDiffStart(next.content)
    if (start !== null) {
      const end = doc.content.findDiffEnd(next.content)
      let endA = end?.a ?? doc.content.size
      let endB = end?.b ?? next.content.size
      // Both ends overlap when the change repeats text around it: widen to the start.
      const overlap = start - Math.min(endA, endB)
      if (overlap > 0) {
        endA += overlap
        endB += overlap
      }
      const tr = ed.state.tr
        .replace(start, endA, next.slice(start, endB))
        .setMeta("addToHistory", false)
        .setMeta("preventUpdate", true)
      ed.view.dispatch(tr)
    }
    settle(ed, markdown)
  }

  // ── A page's files ─────────────────────────────────────────────────────────
  let uploadSeq = 0
  const chipAt = (ed: Editor, key: string): number => {
    let at = -1
    ed.state.doc.descendants((node, pos) => {
      if (at >= 0) return false
      if (node.type.name === "uploadingFile" && node.attrs.key === key) at = pos
      return true
    })
    return at
  }
  /** Each file: a chip where it goes now, the file's token once it is stored. */
  const startUploads = (ed: Editor, files: File[], at?: number) => {
    const files_ = props.files
    if (!files_ || props.preset !== "document" || !files.length || ed.isDestroyed) return
    if (at !== undefined) {
      const pos = Math.max(0, Math.min(at, ed.state.doc.content.size))
      ed.commands.setTextSelection(pos)
    }
    for (const file of files) {
      const key = `upload-${++uploadSeq}`
      ed.chain()
        .focus()
        .insertContent({ type: "uploadingFile", attrs: { key, name: file.name } })
        .run()
      const settleChip = (id: string | null, error?: unknown) => {
        if (ed.isDestroyed) return
        const pos = chipAt(ed, key)
        if (pos >= 0) {
          const tr = ed.state.tr.setMeta("addToHistory", false)
          if (id) tr.replaceWith(pos, pos + 1, ed.schema.nodes.liaisonFile!.create({ id }))
          else tr.delete(pos, pos + 1)
          ed.view.dispatch(tr)
        }
        if (!id) files_.onRefused(error instanceof Error ? error.message : String(error ?? ""))
      }
      void files_.upload(file).then(
        (id) => settleChip(id),
        (err) => settleChip(null, err),
      )
    }
  }
  /**
   * Insert what was pasted or dropped once every file it names is one the writer can
   * read: an unreadable file is left out (edge 8) and the writer is told.
   */
  const insertChecked = (
    ed: Editor,
    ids: string[],
    range: { from: number; to: number },
    insert: (readable: (id: string) => boolean) => void,
  ) => {
    const files_ = props.files
    if (!files_) return
    const held: HeldPlace = { ...range, selection: range.from !== range.to }
    anchors.add(held)
    const unique = [...new Set(ids.map((id) => id.toLowerCase()))]
    void Promise.all(
      unique.map((id) =>
        files_.view.resolve(id).then(
          (file) => [id, !!file] as const,
          () => [id, false] as const,
        ),
      ),
    ).then((answers) => {
      anchors.delete(held)
      if (ed.isDestroyed) return
      const ok = new Set(answers.filter(([, readable]) => readable).map(([id]) => id))
      if (ok.size < unique.length) files_.onRefused(files_.unreadable)
      const size = ed.state.doc.content.size
      const from = Math.max(0, Math.min(held.selection ? held.from : held.to, size))
      const to = Math.max(from, Math.min(held.to, size))
      ed.view.dispatch(ed.state.tr.setSelection(TextSelection.create(ed.state.doc, from, to)))
      insert((id) => ok.has(id.toLowerCase()))
    })
  }
  const pasteSliceChecked = (ed: Editor, slice: Slice, range: { from: number; to: number }) =>
    insertChecked(ed, fileIdsInFragment(slice.content), range, (readable) => {
      const kept = new Slice(withoutFiles(slice.content, readable), slice.openStart, slice.openEnd)
      if (isEmptySlice(kept)) return
      ed.view.dispatch(
        ed.state.tr.replaceSelection(kept).scrollIntoView().setMeta("uiEvent", "paste"),
      )
    })
  const pasteTokensChecked = (ed: Editor, text: string) => {
    const { from, to } = ed.state.selection
    insertChecked(ed, fileIdsOf(text), { from, to }, (readable) => {
      const kept = text.replace(
        /!\[(?:\\.|[^\]\\])*\]\(liaison-file:([0-9a-fA-F-]{36})\)/g,
        (whole, id: string) => (readable(id) ? whole : ""),
      )
      if (!kept.trim()) return
      // One paragraph goes into the line the caret is on, as typed text would.
      const parsed = ed.markdown?.parse(kept)
      const only = parsed?.content?.length === 1 ? parsed.content[0] : undefined
      if (only?.type === "paragraph" && only.content) ed.commands.insertContent(only.content)
      else ed.commands.insertContent(kept, { contentType: "markdown" })
    })
  }
  const replaceIds = (ed: Editor, map: Readonly<Record<string, string>>) => {
    const to = new Map(Object.entries(map).map(([from, id]) => [from.toLowerCase(), id]))
    const lookup = (id: string) => to.get(id.toLowerCase())
    if (!to.size || ed.isDestroyed) return
    const tr = ed.state.tr
    ed.state.doc.descendants((node, pos) => {
      if (node.type.name !== "liaisonFile") return true
      const next = lookup(String(node.attrs.id))
      if (next) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: next })
      return false
    })
    if (!tr.docChanged) return
    ed.view.dispatch(tr.setMeta("addToHistory", false).setMeta("preventUpdate", true))
    // The text as loaded, its blocks and its serialization take the new ids too, so
    // an unedited page still hands back exactly what the server holds.
    if (sourceMap) {
      sourceMap = sourceMap.map((block) => ({
        raw: replaceFileIds(block.raw, map),
        nodes: block.nodes.map((node) => withFileIds(node, lookup)),
      }))
    }
    loaded = replaceFileIds(loaded, map)
    baseline = replaceFileIds(baseline, map)
    if (emitted !== undefined) emitted = replaceFileIds(emitted, map)
  }

  onMount(() => {
    const ed = new Editor({
      element: mount,
      extensions: [
        ...editorExtensions(props.preset, {
          placeholder: props.placeholder,
          rawLabels: {
            image: i18n.t("kernel.editor.remoteImage"),
            link: i18n.t("kernel.editor.pageLink"),
          },
          files: {
            view: props.files?.view ?? null,
            label: i18n.t("kernel.editor.fileToken"),
            uploading: (name) =>
              props.files?.uploading(name) ?? i18n.t("kernel.editor.uploadingFile", { name }),
          },
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
        // box's drop zone), never into the text; a page uploads them where they fell.
        handleDrop: (view, event, slice, moved) => {
          const dropped = Array.from(event.dataTransfer?.files ?? [])
          const at = () => {
            try {
              return view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            } catch {
              return undefined // no layout: where the caret is
            }
          }
          if (dropped.length) {
            if (props.files && props.preset === "document") {
              event.preventDefault()
              startUploads(ed, dropped, at())
            }
            return true
          }
          // Content naming files, dragged in from elsewhere: checked as a paste is.
          if (!moved && props.files && slice && fileIdsInFragment(slice.content).length) {
            event.preventDefault()
            const pos = at() ?? ed.state.selection.from
            pasteSliceChecked(ed, slice, { from: pos, to: pos })
            return true
          }
          return false
        },
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
        handlePaste: (_view, event, slice) => {
          props.onPaste?.(event)
          if (event.defaultPrevented) return true
          // A file the surface did not take (an image, a document) is dropped
          // whole: never its name, a data URL or a stray character in the text.
          // A page uploads it and shows it where the caret is.
          const items = Array.from(event.clipboardData?.items ?? [])
          if (items.some((item) => item.kind === "file")) {
            const pasted = items
              .filter((item) => item.kind === "file")
              .map((item) => item.getAsFile())
              .filter((file): file is File => !!file)
            startUploads(ed, pasted)
            return true
          }
          // HTML naming files of this app (another page's editor or reader): each
          // file must be one the writer can read before it goes in.
          if (
            props.files &&
            event.clipboardData?.types.includes("text/html") &&
            fileIdsInFragment(slice.content).length
          ) {
            const { from, to } = ed.state.selection
            pasteSliceChecked(ed, slice, { from, to })
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
          if (props.files && props.preset === "document" && fileIdsOf(text).length) {
            pasteTokensChecked(ed, text)
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
    // Not tiptap's focus command: it focuses the view again a frame later,
    // and that writes the caret over a selection made in between.
    if (untrack(() => props.autofocus)) {
      ed.view.dispatch(ed.state.tr.setSelection(Selection.atEnd(ed.state.doc)).scrollIntoView())
      ed.view.focus()
    }
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
    ed.on("update", ({ transaction }) => {
      // An edit of the text, not a change of state (setEditable also says "update").
      if (transaction.docChanged) props.onEdit?.()
      if (!props.onChange) return
      const next = current(ed)
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
      appendMarkdown: (markdown) =>
        ed
          .chain()
          .insertContentAt(ed.state.doc.content.size, markdown, {
            contentType: "markdown",
            updateSelection: false,
          })
          .run(),
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
      markdown: () => current(ed),
      get roundTrips() {
        return roundTrips
      },
      applyRemote: (markdown) => applyRemote(ed, markdown),
      insertFiles: (files) => startUploads(ed, files),
      replaceFileIds: (map) => replaceIds(ed, map),
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
          onPick={props.files && props.preset === "document" ? pick : undefined}
          overflow={props.toolbarOverflow}
          class={props.toolbarClass}
        />
      </Show>
    )
  }
  let imageInput: HTMLInputElement | undefined
  let fileInput: HTMLInputElement | undefined
  const pick = (kind: "image" | "file") => (kind === "image" ? imageInput : fileInput)?.click()
  const picked = (input: HTMLInputElement) => {
    const chosen = Array.from(input.files ?? [])
    input.value = ""
    const ed = editor()
    if (ed && chosen.length) startUploads(ed, chosen)
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
      <Show when={props.files && props.preset === "document"}>
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          multiple
          hidden
          data-testid="rich-editor.pick-image"
          onChange={(e) => picked(e.currentTarget)}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="rich-editor.pick-file"
          onChange={(e) => picked(e.currentTarget)}
        />
      </Show>
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
