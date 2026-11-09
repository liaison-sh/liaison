// SPDX-License-Identifier: FSL-1.1-ALv2
//
// rich_text document templates: an organisation's blocks of text with
// {{path}} placeholders, laid out on the host into the shared DrawCommand
// list and rendered by the existing replayer (pdf/replay.ts). No browser, no
// sandbox, no expressions: a placeholder is a dot path into the record and
// nothing else.
//
//   body = { page?: { size?, margins?, fontSize? }, blocks: Block[] }
//   Block = heading { text, level? } | paragraph { text, size? }
//         | list { from, line, where? }   one line per row of the list `from`;
//                                     `line` placeholders are relative to the row
//         | table { columns, from?, where?, rows? }   one table row per row of
//                                     `from` (cells relative to the row), or the
//                                     fixed `rows` given (cells are texts)
//         | repeat { from, where?, blocks }   the inner blocks once per row
//         | image { fileId, width?, align? }   a PNG or JPEG of this template
//         | spacer { height }
//   Every block may carry `when`: it prints only when its conditions hold.
//   A condition is { path, is?: present|absent, equals?, in? } (a list of them
//   is an AND); a `*` segment in its path means "any row" (lines.*.sku). Rows
//   of a list, table or repeat are kept by `where`, the same conditions read
//   relative to the row.
//
// Inside a row (list line, table cell, repeat block), a path reads the row
// first and the record when the row has no such field, so a repeated block can
// still print {{invoice.number}}.
//
// A value that is missing or empty prints as a grey "[<field label>]" run and
// is reported as a blank; it never prints a default, "null" or "undefined".
// {{path ?? words}} prints the words, grey, instead of the label (still a
// blank: "not confirmed by the supplier"); {{path ??}} prints nothing and is
// not a blank (an optional field such as a phone number nobody gave).
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
const TABLE_HEADER_FILL = { r: 0.93, g: 0.93, b: 0.93 }
const TABLE_BORDER = { r: 0.7, g: 0.7, b: 0.7 }
const FONT_REGULAR = "body"
const FONT_BOLD = "bold"

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

const PATH_SOURCE = "[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*"
/** `{{path}}`, or `{{path ?? words printed grey when the value is missing}}`. */
const PLACEHOLDER_RE = new RegExp(`\\{\\{\\s*(${PATH_SOURCE})\\s*(?:\\?\\?([^{}]*))?\\}\\}`, "g")
const PATH_RE = new RegExp(`^${PATH_SOURCE}$`)
/** A condition path: a dot path whose segments may be `*` (any row of a list). */
const CONDITION_PATH_RE = /^(?:[A-Za-z0-9_]+|\*)(?:\.(?:[A-Za-z0-9_]+|\*))*$/
/** Characters of a placeholder's fallback words. */
const FALLBACK_MAX = 200
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
    "a placeholder is {{path}} with a dot path such as {{order.lines.0.sku}}, or {{path ?? words shown when it is missing}}",
  )
  .refine(
    (t) => [...t.matchAll(PLACEHOLDER_RE)].every((m) => (m[2] ?? "").length <= FALLBACK_MAX),
    `the words after ?? in a placeholder are at most ${FALLBACK_MAX} characters`,
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

const conditionSchema = z
  .object({
    path: z
      .string()
      .max(500)
      .regex(CONDITION_PATH_RE, "a dot path, where * stands for any row: lines.*.sku"),
    is: z.enum(["present", "absent"]).optional(),
    equals: z.string().max(500).optional(),
    in: z.array(z.string().max(500)).min(1).max(100).optional(),
  })
  .strict()
  .refine(
    (c) => [c.is, c.equals, c.in].filter((v) => v !== undefined).length <= 1,
    "a condition takes one of is, equals or in",
  )

/** Conditions that must all hold: one condition or a list of them. */
const conditionsSchema = z.union([conditionSchema, z.array(conditionSchema).min(1).max(20)])
export type RichTextCondition = z.infer<typeof conditionSchema>

const when = { when: conditionsSchema.optional() }
const listPath = z.string().max(500).regex(PATH_RE, "a dot path to a list, such as lines")
const fontSize = z.number().finite().min(6).max(24)

const headingBlock = z
  .object({
    type: z.literal("heading"),
    text: templateText,
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    ...when,
  })
  .strict()

const paragraphBlock = z
  .object({
    type: z.literal("paragraph"),
    text: templateText,
    size: fontSize.optional(),
    ...when,
  })
  .strict()

const listBlock = z
  .object({
    type: z.literal("list"),
    from: listPath,
    line: templateText,
    where: conditionsSchema.optional(),
    ...when,
  })
  .strict()

const columnSchema = z
  .object({
    header: templateText.optional(),
    /** The cell's text for a row of `from` (relative to the row); unused with `rows`. */
    text: templateText.optional(),
    /** Relative width (the columns share the page width by these weights). */
    width: z.number().finite().min(1).max(100).optional(),
    bold: z.boolean().optional(),
  })
  .strict()

/** Cells of a fixed table row: texts, read relative to the row being repeated, if any. */
const fixedRow = z.array(templateText).min(1).max(12)

const tableBlock = z
  .object({
    type: z.literal("table"),
    columns: z.array(columnSchema).min(1).max(12),
    from: listPath.optional(),
    where: conditionsSchema.optional(),
    rows: z
      .array(z.union([fixedRow, z.object({ cells: fixedRow, ...when }).strict()]))
      .max(200)
      .optional(),
    size: fontSize.optional(),
    ...when,
  })
  .strict()

/** A table's shape rules (kept out of the object so the block union stays discriminated). */
function tableProblem(t: z.infer<typeof tableBlock>): string | null {
  if ((t.from === undefined) === (t.rows === undefined)) return "a table takes from or rows"
  if (t.from !== undefined && !t.columns.every((c) => c.text !== undefined))
    return "every column of a table over `from` needs its text"
  if (!(t.rows ?? []).every((r) => (Array.isArray(r) ? r : r.cells).length === t.columns.length))
    return "every fixed row has one cell per column"
  return null
}

const imageBlock = z
  .object({
    type: z.literal("image"),
    fileId: z.string().uuid(),
    /** Width in points; the height follows the image. */
    width: z.number().finite().min(8).max(600).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    ...when,
  })
  .strict()

const spacerBlock = z
  .object({ type: z.literal("spacer"), height: z.number().finite().min(1).max(400), ...when })
  .strict()

const leafBlock = z.discriminatedUnion("type", [
  headingBlock,
  paragraphBlock,
  listBlock,
  tableBlock,
  imageBlock,
  spacerBlock,
])

const repeatBlock = z
  .object({
    type: z.literal("repeat"),
    from: listPath,
    where: conditionsSchema.optional(),
    blocks: z.array(leafBlock).min(1).max(RICH_TEXT_MAX_BLOCKS),
    ...when,
  })
  .strict()

const blockSchema = z.discriminatedUnion("type", [
  headingBlock,
  paragraphBlock,
  listBlock,
  tableBlock,
  imageBlock,
  spacerBlock,
  repeatBlock,
])

type AnyBlock = z.infer<typeof blockSchema>

function everyBlock(blocks: readonly AnyBlock[]): AnyBlock[] {
  return blocks.flatMap((b) => (b.type === "repeat" ? [b, ...b.blocks] : [b]))
}

export const richTextBodySchema = z
  .object({
    page: pageSchema.optional(),
    blocks: z.array(blockSchema).max(RICH_TEXT_MAX_BLOCKS),
  })
  .strict()
  .refine(
    (b) =>
      new Set(everyBlock(b.blocks).flatMap((x) => (x.type === "image" ? [x.fileId] : []))).size <=
      MAX_EMBED_IMAGES,
    `a template shows at most ${MAX_EMBED_IMAGES} different images`,
  )
  .superRefine((b, ctx) => {
    b.blocks.forEach((block, i) => {
      const inner = block.type === "repeat" ? block.blocks : [block]
      inner.forEach((x, j) => {
        if (x.type !== "table") return
        const problem = tableProblem(x)
        if (problem)
          ctx.addIssue({
            code: "custom",
            message: problem,
            path: block.type === "repeat" ? ["blocks", i, "blocks", j] : ["blocks", i],
          })
      })
    })
  })

export type RichTextBody = z.infer<typeof richTextBodySchema>
export type RichTextBlock = RichTextBody["blocks"][number]
type LeafBlock = z.infer<typeof leafBlock>
type Conditions = z.infer<typeof conditionsSchema>

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
  const each = (text: string | undefined, prefix: string | null) => {
    if (!text) return
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      const path = m[1]
      if (path) out.add(prefix ? `${prefix}.${path}` : path)
    }
  }
  const conditions = (c: Conditions | undefined, prefix: string | null) => {
    for (const one of c === undefined ? [] : Array.isArray(c) ? c : [c]) {
      const path = one.path
        .split(".")
        .filter((s) => s !== "*")
        .join(".")
      if (path) out.add(prefix ? `${prefix}.${path}` : path)
    }
  }
  const leaf = (block: LeafBlock, prefix: string | null) => {
    conditions(block.when, prefix)
    if (block.type === "heading" || block.type === "paragraph") each(block.text, prefix)
    else if (block.type === "list") {
      const from = prefix ? `${prefix}.${block.from}` : block.from
      out.add(from)
      conditions(block.where, from)
      each(block.line, from)
    } else if (block.type === "table") {
      for (const c of block.columns) each(c.header, prefix)
      if (block.from !== undefined) {
        const from = prefix ? `${prefix}.${block.from}` : block.from
        out.add(from)
        conditions(block.where, from)
        for (const c of block.columns) each(c.text, from)
      }
      for (const row of block.rows ?? []) {
        const cells = Array.isArray(row) ? row : row.cells
        if (!Array.isArray(row)) conditions(row.when, prefix)
        for (const cell of cells) each(cell, prefix)
      }
    }
  }
  for (const block of body.blocks) {
    if (block.type === "repeat") {
      conditions(block.when, null)
      out.add(block.from)
      conditions(block.where, block.from)
      for (const inner of block.blocks) leaf(inner, block.from)
    } else leaf(block, null)
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

/**
 * Where a path inside a row reads: the row (`<base>.<path>`) when the row holds
 * the path's first field, else the record root when IT holds it, else the row.
 * Outside a row, the root.
 */
function scopedPath(record: Record<string, unknown>, base: string | null, rel: string): string {
  if (base === null) return rel
  const row = readPath(record, base)
  const first = rel.split(".")[0] ?? ""
  if (row !== null && typeof row === "object" && !Array.isArray(row) && Object.hasOwn(row, first))
    return `${base}.${rel}`
  // Neither holds it: the row's field is the one missing (one blank per field, not per root).
  return Object.hasOwn(record, first) ? rel : `${base}.${rel}`
}

/** Every value a condition path reaches, `*` expanding to each row of a list. */
function valuesAt(root: unknown, segments: readonly string[]): unknown[] {
  if (segments.length === 0) return [root]
  const [head, ...rest] = segments
  if (head === "*") {
    return Array.isArray(root) ? root.flatMap((row) => valuesAt(row, rest)) : []
  }
  const next = readPath(root, head ?? "")
  return next === undefined ? [] : valuesAt(next, rest)
}

function conditionValues(
  record: Record<string, unknown>,
  base: string | null,
  path: string,
): unknown[] {
  const segments = path.split(".")
  const head = segments[0] ?? ""
  if (base !== null) {
    const row = readPath(record, base)
    const rowHolds =
      row !== null && typeof row === "object" && !Array.isArray(row) && Object.hasOwn(row, head)
    if (head === "*" || rowHolds) return valuesAt(row, segments)
  }
  return valuesAt(record, segments)
}

function holds(
  record: Record<string, unknown>,
  base: string | null,
  c: RichTextCondition,
): boolean {
  const printed = conditionValues(record, base, c.path).flatMap((v) => {
    if (Array.isArray(v)) return v.length > 0 ? ["list"] : []
    const p = printable(v)
    return p === null ? [] : [p.trim().toLowerCase()]
  })
  if (c.equals !== undefined) return printed.includes(c.equals.trim().toLowerCase())
  if (c.in !== undefined) {
    const wanted = new Set(c.in.map((v) => v.trim().toLowerCase()))
    return printed.some((v) => wanted.has(v))
  }
  return c.is === "absent" ? printed.length === 0 : printed.length > 0
}

/** Whether every condition holds (no conditions: always). */
export function conditionsHold(
  record: Record<string, unknown>,
  base: string | null,
  conditions: Conditions | undefined,
): boolean {
  if (conditions === undefined) return true
  const list = Array.isArray(conditions) ? conditions : [conditions]
  return list.every((c) => holds(record, base, c))
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
      const fallback = match[2]
      const path = scopedPath(this.record, base, rel)
      const value = printable(readPath(this.record, path))
      if (value !== null) {
        out.push({ text: value, bold })
      } else if (fallback === undefined) {
        const label = this.labelOf(path)
        out.push({ text: `[${label}]`, color: "placeholder", bold })
        this.noteBlank(path, label)
      } else if (fallback.trim() !== "") {
        // The template's own words for a missing value, grey: still a blank to fill.
        out.push({ text: fallback.trim(), color: "placeholder", bold })
        this.noteBlank(path, this.labelOf(path))
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

  /**
   * A table: a bold header row on a light fill when any column has a header,
   * then one row per entry of `rows` (each a list of cell runs). A row that
   * does not fit starts a new page; a row taller than a page is laid out
   * anyway and runs past the bottom margin rather than being cut.
   */
  table(
    columns: ReadonlyArray<{ width?: number | undefined; bold?: boolean | undefined }>,
    header: TextRun[][] | null,
    rows: TextRun[][][],
    size: number,
  ): void {
    const pad = 3
    const lineHeight = size * 1.3
    const total = columns.reduce((n, c) => n + (c.width ?? 1), 0)
    const widths = columns.map((c) => (this.contentWidth * (c.width ?? 1)) / total)
    const drawRow = (cells: TextRun[][], fill: boolean) => {
      const wrapped = cells.map((runs, i) =>
        wrapRuns(runs, Math.max(8, (widths[i] ?? 0) - pad * 2), size),
      )
      const lines = Math.max(1, ...wrapped.map((w) => w.length))
      const height = lines * lineHeight + pad * 2
      if (this.y - height < this.bottom && !this.atPageTop()) this.newPage()
      const top = this.y
      let x = this.left
      for (const [i, w] of widths.entries()) {
        this.push({
          op: "drawRectangle",
          page: this.page,
          x,
          y: top - height,
          width: w,
          height,
          ...(fill ? { color: TABLE_HEADER_FILL } : {}),
          borderColor: TABLE_BORDER,
          borderWidth: 0.5,
        })
        let lineY = top - pad - size
        for (const pieces of wrapped[i] ?? []) {
          let px = x + pad
          for (const piece of pieces) {
            if (piece.text !== "") {
              this.push({
                op: "drawText",
                page: this.page,
                text: piece.text,
                x: px,
                y: lineY,
                size,
                font: piece.bold ? FONT_BOLD : FONT_REGULAR,
                ...(piece.color === "placeholder" ? { color: PLACEHOLDER_GREY } : {}),
              })
            }
            px += widthOf(piece, size)
          }
          lineY -= lineHeight
        }
        x += w
      }
      this.y = top - height
    }
    if (header) drawRow(header, true)
    for (const cells of rows) drawRow(cells, false)
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

/** The full paths of the rows of `from` (read in `base`) that `where` keeps; null when not a list. */
function keptRows(
  record: Record<string, unknown>,
  base: string | null,
  from: string,
  where: Conditions | undefined,
): string[] | null {
  const path = scopedPath(record, base, from)
  const rows = listRows(record, path)
  if (rows === null) return null
  const out: string[] = []
  for (let i = 0; i < rows.length; i++) {
    const rowPath = `${path}.${i}`
    if (conditionsHold(record, rowPath, where)) out.push(rowPath)
  }
  return out
}

/** Lay a body out into draw commands (pure: images already resolved). */
export function layoutRichText(
  body: RichTextBody,
  record: Record<string, unknown>,
  labelOf: (path: string) => string,
  images: ReadonlyMap<string, ImageInfo> = new Map(),
  title?: string,
): { commands: DrawCommand[]; blanks: RichTextBlank[]; pageCount: number } {
  // Every top-level list is checked before any layout work.
  for (const block of body.blocks) {
    if ((block.type === "list" || block.type === "repeat") && block.from)
      listRows(record, block.from)
    if (block.type === "table" && block.from) listRows(record, block.from)
  }

  const layout = new Layout(body, record, labelOf, images, title)
  const size = layout.fontSize

  const leaf = (block: LeafBlock, base: string | null) => {
    if (!conditionsHold(record, base, block.when)) return
    switch (block.type) {
      case "heading": {
        const hs = size * HEADING_SCALE[block.level ?? 1]
        layout.gap(size * 0.6)
        layout.text(layout.runs(block.text, base, true), hs, hs * 1.25)
        layout.gap(size * 0.4)
        break
      }
      case "paragraph": {
        const ps = block.size ?? size
        layout.text(layout.runs(block.text, base, false), ps, ps * 1.4)
        layout.gap(size * 0.6)
        break
      }
      case "list": {
        const rows = keptRows(record, base, block.from, block.where)
        if (rows === null) {
          const path = scopedPath(record, base, block.from)
          const label = labelOf(path)
          layout.noteBlank(path, label)
          layout.text([{ text: `[${label}]`, color: "placeholder" }], size, size * 1.4)
        } else {
          for (const row of rows) layout.text(layout.runs(block.line, row, false), size, size * 1.4)
        }
        layout.gap(size * 0.6)
        break
      }
      case "table": {
        const ts = block.size ?? size * 0.9
        const header = block.columns.some((c) => c.header !== undefined)
          ? block.columns.map((c) => layout.runs(c.header ?? "", base, true))
          : null
        let rows: TextRun[][][]
        if (block.from !== undefined) {
          const kept = keptRows(record, base, block.from, block.where) ?? []
          rows = kept.map((row) =>
            block.columns.map((c) => layout.runs(c.text ?? "", row, c.bold === true)),
          )
        } else {
          rows = (block.rows ?? []).flatMap((r) => {
            const cells = Array.isArray(r) ? r : r.cells
            if (!Array.isArray(r) && !conditionsHold(record, base, r.when)) return []
            return [
              cells.map((cell, i) => layout.runs(cell, base, block.columns[i]?.bold === true)),
            ]
          })
        }
        if (rows.length > 0 || header) layout.table(block.columns, header, rows, ts)
        layout.gap(size * 0.8)
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

  for (const block of body.blocks) {
    if (block.type === "repeat") {
      if (!conditionsHold(record, null, block.when)) continue
      for (const row of keptRows(record, null, block.from, block.where) ?? []) {
        for (const inner of block.blocks) leaf(inner, row)
      }
    } else leaf(block, null)
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
  for (const block of everyBlock(body.blocks)) {
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
