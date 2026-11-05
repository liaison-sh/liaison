// SPDX-License-Identifier: FSL-1.1-ALv2
//
// rich_text document templates: an organisation's blocks of text with
// {{path}} placeholders, laid out on the host into the shared DrawCommand
// list and rendered by the existing replayer (pdf/replay.ts). No browser, no
// sandbox, no expressions: a placeholder is a dot path into the record and
// nothing else.
//
//   body = { page?: { size?, margins?, fontSize? }, blocks: Block[] }
//   Block = heading { text, level? } | paragraph { text }
//         | list { from, line }       one line per row of the list `from`;
//                                     `line` placeholders are relative to the row
//         | image { fileId, width?, align? }   a PNG or JPEG of this template
//         | spacer { height }
//
// A value that is missing or empty prints as a grey "[<field label>]" run and
// is reported as a blank; it never prints a default, "null" or "undefined".
// Paths read own properties only (no prototype walk). A list with more rows
// than RICH_TEXT_MAX_LIST_ROWS, or a document past the replayer's page or
// command bounds, is refused whole: a document is never truncated (D32).
//
// The renderer takes its image resolver from the caller: print.ts passes one
// that only finds files parented to the template being printed, so a body can
// never pull another template's or record's file into a PDF.

import {
  type DrawCommand,
  type LinePiece,
  MAX_COMMANDS,
  MAX_EMBED_IMAGES,
  type TextRun,
  textWidth,
  wrapRuns,
} from "@liaison/shared"
import { PDFDocument } from "pdf-lib"
import { z } from "zod"
import { MAX_PAGES, type ResolvedImage, replayDrawCommands } from "~/modules/pdf/replay"

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const RICH_TEXT_MAX_BLOCKS = 200
/** Characters per text field of a block (a drawText takes at most 20 000, commands.ts). */
export const RICH_TEXT_MAX_TEXT = 20_000
/** Rows one list block prints; more refuses with too_many_rows. */
export const RICH_TEXT_MAX_LIST_ROWS = 1000

const PAGE_SIZES = { A4: { width: 595.28, height: 841.89 }, Letter: { width: 612, height: 792 } }
const DEFAULT_MARGIN = 56
const DEFAULT_FONT_SIZE = 10
const HEADING_SCALE = { 1: 1.6, 2: 1.3, 3: 1.1 } as const
const PLACEHOLDER_GREY = { r: 0.55, g: 0.55, b: 0.55 }
const FONT_REGULAR = "body"
const FONT_BOLD = "bold"

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const PATH_SOURCE = "[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*"
const PLACEHOLDER_RE = new RegExp(`\\{\\{\\s*(${PATH_SOURCE})\\s*\\}\\}`, "g")
const PATH_RE = new RegExp(`^${PATH_SOURCE}$`)
/** Segments that never resolve, even as an own property of a parsed record. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"])

/** The text with every well-formed placeholder removed; a "{{" or "}}" left is malformed. */
function malformedPlaceholder(text: string): boolean {
  const rest = text.replace(PLACEHOLDER_RE, "")
  return rest.includes("{{") || rest.includes("}}")
}

const templateText = z
  .string()
  .max(RICH_TEXT_MAX_TEXT)
  .refine(
    (t) => !malformedPlaceholder(t),
    "a placeholder is {{path}} with a dot path such as {{order.lines.0.sku}}",
  )

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

const margin = z.number().finite().min(18).max(144)

const pageSchema = z
  .object({
    size: z.enum(["A4", "Letter"]).optional(),
    margins: z
      .object({
        top: margin.optional(),
        right: margin.optional(),
        bottom: margin.optional(),
        left: margin.optional(),
      })
      .strict()
      .optional(),
    fontSize: z.number().finite().min(8).max(14).optional(),
  })
  .strict()

const headingBlock = z
  .object({
    type: z.literal("heading"),
    text: templateText,
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  })
  .strict()

const paragraphBlock = z.object({ type: z.literal("paragraph"), text: templateText }).strict()

const listBlock = z
  .object({
    type: z.literal("list"),
    from: z.string().max(500).regex(PATH_RE, "a dot path to a list, such as lines"),
    line: templateText,
  })
  .strict()

const imageBlock = z
  .object({
    type: z.literal("image"),
    fileId: z.string().uuid(),
    /** Width in points; the height follows the image. */
    width: z.number().finite().min(8).max(600).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
  })
  .strict()

const spacerBlock = z
  .object({ type: z.literal("spacer"), height: z.number().finite().min(1).max(400) })
  .strict()

const blockSchema = z.discriminatedUnion("type", [
  headingBlock,
  paragraphBlock,
  listBlock,
  imageBlock,
  spacerBlock,
])

export const richTextBodySchema = z
  .object({
    page: pageSchema.optional(),
    blocks: z.array(blockSchema).max(RICH_TEXT_MAX_BLOCKS),
  })
  .strict()
  .refine(
    (b) =>
      new Set(b.blocks.flatMap((x) => (x.type === "image" ? [x.fileId] : []))).size <=
      MAX_EMBED_IMAGES,
    `a template shows at most ${MAX_EMBED_IMAGES} different images`,
  )

export type RichTextBody = z.infer<typeof richTextBodySchema>
export type RichTextBlock = RichTextBody["blocks"][number]

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RichTextErrorCode = "body_invalid" | "too_many_rows" | "document_too_large"

export class RichTextError extends Error {
  constructor(
    readonly code: RichTextErrorCode,
    message: string,
    /** For body_invalid: where in the body the first problem is ("blocks.2.text"). */
    readonly path?: string,
  ) {
    super(message)
    this.name = "RichTextError"
  }
}

/** Validate a body; the message names the first problems by their path in the body. */
export function parseRichTextBody(body: unknown): RichTextBody {
  const parsed = richTextBodySchema.safeParse(body)
  if (parsed.success) return parsed.data
  const pathOf = (i: { path: PropertyKey[] }) =>
    i.path.length > 0 ? i.path.map(String).join(".") : "body"
  const first = parsed.error.issues[0]
  const issues = parsed.error.issues.slice(0, 3).map((i) => `${pathOf(i)}: ${i.message}`)
  throw new RichTextError(
    "body_invalid",
    `The template body is not valid: ${issues.join("; ")}`,
    first ? pathOf(first) : "body",
  )
}

/**
 * Every record path a body reads, in the order it first appears: a
 * placeholder's path, a list's `from`, and a list line's placeholders as
 * `<from>.<path>` (the row index left out, the way a record type declares
 * its repeating fields).
 */
export function richTextPlaceholderPaths(body: RichTextBody): string[] {
  const out = new Set<string>()
  const each = (text: string, prefix: string | null) => {
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      const path = m[1]
      if (path) out.add(prefix ? `${prefix}.${path}` : path)
    }
  }
  for (const block of body.blocks) {
    if (block.type === "heading" || block.type === "paragraph") each(block.text, null)
    else if (block.type === "list") {
      out.add(block.from)
      each(block.line, block.from)
    }
  }
  return [...out]
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** Walk a dot path through own properties only; array segments are indexes. */
function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root
  for (const segment of path.split(".")) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(segment)) return undefined
      cur = cur[Number(segment)]
    } else if (cur !== null && typeof cur === "object" && Object.hasOwn(cur, segment)) {
      cur = (cur as Record<string, unknown>)[segment]
    } else {
      return undefined
    }
  }
  return cur
}

/** A record value as printed text; null when there is nothing to print. */
function printable(value: unknown): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null
  if (typeof value === "bigint") return String(value)
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return null
}

/** A placeholder that printed grey: `path` is the full record path. */
export interface RichTextBlank {
  path: string
  label: string
}

export interface RichTextRenderInput {
  body: unknown
  record: Record<string, unknown>
  /** The words for a record path (`lines.0.sku`), shown in the grey placeholder. */
  labelOf: (path: string) => string
  /**
   * The template's own images: fail closed, a file that is not the
   * template's resolves to null and its block is skipped.
   */
  resolveImage: (fileId: string) => Promise<ResolvedImage | null>
  title?: string
}

export interface RichTextRendered {
  bytes: Uint8Array
  blanks: RichTextBlank[]
  pageCount: number
}

interface ImageInfo {
  image: ResolvedImage
  width: number
  height: number
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

class Layout {
  readonly commands: DrawCommand[] = []
  readonly blanks: RichTextBlank[] = []
  private readonly blankKeys = new Set<string>()
  private page = -1
  private y = 0
  private readonly width: number
  private readonly height: number
  private readonly top: number
  private readonly right: number
  private readonly bottom: number
  private readonly left: number
  readonly fontSize: number

  constructor(
    body: RichTextBody,
    private readonly record: Record<string, unknown>,
    private readonly labelOf: (path: string) => string,
    private readonly images: ReadonlyMap<string, ImageInfo>,
    title: string | undefined,
  ) {
    const size = PAGE_SIZES[body.page?.size ?? "A4"]
    this.width = size.width
    this.height = size.height
    const m = body.page?.margins ?? {}
    this.top = m.top ?? DEFAULT_MARGIN
    this.right = m.right ?? DEFAULT_MARGIN
    this.bottom = m.bottom ?? DEFAULT_MARGIN
    this.left = m.left ?? DEFAULT_MARGIN
    this.fontSize = body.page?.fontSize ?? DEFAULT_FONT_SIZE
    this.commands.push({
      op: "setMetadata",
      ...(title ? { title: title.slice(0, 300) } : {}),
      producer: "Liaison",
      creator: "Liaison",
    })
    this.commands.push({ op: "embedFont", ref: FONT_REGULAR, standardFont: "Helvetica" })
    this.commands.push({ op: "embedFont", ref: FONT_BOLD, standardFont: "HelveticaBold" })
    this.newPage()
    for (const [i, id] of [...images.keys()].entries()) {
      this.commands.push({ op: "embedImage", ref: `img${i}`, fileId: id })
    }
  }

  get pageCount(): number {
    return this.page + 1
  }

  private get contentWidth(): number {
    return this.width - this.left - this.right
  }

  private get contentHeight(): number {
    return this.height - this.top - this.bottom
  }

  private atPageTop(): boolean {
    return this.y >= this.height - this.top
  }

  private newPage(): void {
    this.page += 1
    if (this.page >= MAX_PAGES) {
      throw new RichTextError(
        "document_too_large",
        `The document would run past ${MAX_PAGES} pages; nothing was printed`,
      )
    }
    this.commands.push({ op: "addPage", width: this.width, height: this.height })
    this.y = this.height - this.top
  }

  private push(cmd: DrawCommand): void {
    // Leave room for the image embeds placed after the fonts.
    if (this.commands.length >= MAX_COMMANDS - MAX_EMBED_IMAGES) {
      throw new RichTextError(
        "document_too_large",
        "The document has too much content to print; nothing was printed",
      )
    }
    this.commands.push(cmd)
  }

  /** Text with its placeholders resolved: record values as text, blanks as grey runs. */
  runs(text: string, base: string | null, bold: boolean): TextRun[] {
    const out: TextRun[] = []
    let last = 0
    for (const match of text.matchAll(PLACEHOLDER_RE)) {
      const index = match.index ?? 0
      if (index > last) out.push({ text: text.slice(last, index), bold })
      const rel = match[1] ?? ""
      const path = base === null ? rel : `${base}.${rel}`
      const value = printable(readPath(this.record, path))
      if (value !== null) {
        out.push({ text: value, bold })
      } else {
        const label = this.labelOf(path)
        out.push({ text: `[${label}]`, color: "placeholder", bold })
        this.noteBlank(path, label)
      }
      last = index + match[0].length
    }
    if (last < text.length) out.push({ text: text.slice(last), bold })
    return out
  }

  noteBlank(path: string, label: string): void {
    // One entry per field: a missing SKU on 300 rows is one thing to fill.
    const key = path
      .split(".")
      .filter((s) => !/^\d+$/.test(s))
      .join(".")
    if (this.blankKeys.has(key)) return
    this.blankKeys.add(key)
    this.blanks.push({ path, label })
  }

  /** Lay out runs as wrapped lines, each hard line break starting a new line. */
  text(runs: TextRun[], size: number, lineHeight: number): void {
    // Split the runs on "\n" so a typed line break is kept.
    const hardLines: TextRun[][] = [[]]
    for (const run of runs) {
      const parts = run.text.split("\n")
      for (const [i, part] of parts.entries()) {
        if (i > 0) hardLines.push([])
        if (part !== "") hardLines[hardLines.length - 1]?.push({ ...run, text: part })
      }
    }
    for (const hard of hardLines) {
      for (const line of wrapRuns(hard, this.contentWidth, size)) this.line(line, size, lineHeight)
    }
  }

  private line(pieces: LinePiece[], size: number, lineHeight: number): void {
    if (this.y - lineHeight < this.bottom) this.newPage()
    const baseline = this.y - size
    let x = this.left
    for (const piece of pieces) {
      if (piece.text !== "") {
        this.push({
          op: "drawText",
          page: this.page,
          text: piece.text,
          x,
          y: baseline,
          size,
          font: piece.bold ? FONT_BOLD : FONT_REGULAR,
          ...(piece.color === "placeholder" ? { color: PLACEHOLDER_GREY } : {}),
        })
      }
      x += widthOf(piece, size)
    }
    this.y -= lineHeight
  }

  gap(height: number): void {
    if (this.atPageTop()) return
    this.y -= height
  }

  spacer(height: number): void {
    if (this.y - height < this.bottom) {
      this.newPage()
      return
    }
    this.y -= height
  }

  image(block: Extract<RichTextBlock, { type: "image" }>): void {
    const info = this.images.get(block.fileId)
    if (!info || info.width <= 0 || info.height <= 0) return
    let w = Math.min(block.width ?? info.width, this.contentWidth)
    let h = (w * info.height) / info.width
    if (h > this.contentHeight) {
      h = this.contentHeight
      w = (h * info.width) / info.height
    }
    if (this.y - h < this.bottom) this.newPage()
    const align = block.align ?? "left"
    const x =
      align === "left"
        ? this.left
        : align === "right"
          ? this.left + this.contentWidth - w
          : this.left + (this.contentWidth - w) / 2
    const ref = `img${[...this.images.keys()].indexOf(block.fileId)}`
    this.push({ op: "drawImage", page: this.page, ref, x, y: this.y, maxWidth: w, maxHeight: h })
    this.y -= h
  }
}

function widthOf(piece: LinePiece, size: number): number {
  return textWidth(piece.text, size, piece.bold)
}

/** The rows a list block prints: refuses over the cap, never truncates (D32). */
function listRows(record: Record<string, unknown>, from: string): unknown[] | null {
  const rows = readPath(record, from)
  if (!Array.isArray(rows)) return null
  if (rows.length > RICH_TEXT_MAX_LIST_ROWS) {
    throw new RichTextError(
      "too_many_rows",
      `The record has ${rows.length} rows in "${from}"; a template lists at most ${RICH_TEXT_MAX_LIST_ROWS}. Nothing was printed.`,
    )
  }
  return rows
}

/** Lay a body out into draw commands (pure: images already resolved). */
export function layoutRichText(
  body: RichTextBody,
  record: Record<string, unknown>,
  labelOf: (path: string) => string,
  images: ReadonlyMap<string, ImageInfo> = new Map(),
  title?: string,
): { commands: DrawCommand[]; blanks: RichTextBlank[]; pageCount: number } {
  // Every list is checked before any layout work.
  for (const block of body.blocks) if (block.type === "list") listRows(record, block.from)

  const layout = new Layout(body, record, labelOf, images, title)
  const size = layout.fontSize
  for (const block of body.blocks) {
    switch (block.type) {
      case "heading": {
        const hs = size * HEADING_SCALE[block.level ?? 1]
        layout.gap(size * 0.6)
        layout.text(layout.runs(block.text, null, true), hs, hs * 1.25)
        layout.gap(size * 0.4)
        break
      }
      case "paragraph": {
        layout.text(layout.runs(block.text, null, false), size, size * 1.4)
        layout.gap(size * 0.6)
        break
      }
      case "list": {
        const rows = listRows(record, block.from)
        if (rows === null) {
          const label = labelOf(block.from)
          layout.noteBlank(block.from, label)
          layout.text([{ text: `[${label}]`, color: "placeholder" }], size, size * 1.4)
        } else {
          for (let i = 0; i < rows.length; i++) {
            layout.text(layout.runs(block.line, `${block.from}.${i}`, false), size, size * 1.4)
          }
        }
        layout.gap(size * 0.6)
        break
      }
      case "image": {
        layout.image(block)
        layout.gap(size * 0.6)
        break
      }
      case "spacer": {
        layout.spacer(block.height)
        break
      }
    }
  }
  return { commands: layout.commands, blanks: layout.blanks, pageCount: layout.pageCount }
}

/** Read an image's size the way the replayer will embed it; null when unusable. */
async function imageInfo(image: ResolvedImage): Promise<ImageInfo | null> {
  try {
    const doc = await PDFDocument.create()
    const embedded =
      image.mime === "image/png"
        ? await doc.embedPng(image.bytes)
        : image.mime === "image/jpeg"
          ? await doc.embedJpg(image.bytes)
          : null
    if (!embedded) return null
    return { image, width: embedded.width, height: embedded.height }
  } catch {
    return null
  }
}

/** Render a rich_text body against a record into PDF bytes. */
export async function renderRichText(input: RichTextRenderInput): Promise<RichTextRendered> {
  const body = parseRichTextBody(input.body)
  const images = new Map<string, ImageInfo>()
  for (const block of body.blocks) {
    if (block.type !== "image" || images.has(block.fileId)) continue
    const resolved = await input.resolveImage(block.fileId).catch(() => null)
    const info = resolved ? await imageInfo(resolved) : null
    if (info) images.set(block.fileId, info)
  }
  const { commands, blanks, pageCount } = layoutRichText(
    body,
    input.record,
    input.labelOf,
    images,
    input.title,
  )
  const bytes = await replayDrawCommands(commands, {
    resolveImage: async (fileId) => images.get(fileId)?.image ?? null,
  })
  return { bytes, blanks, pageCount }
}
