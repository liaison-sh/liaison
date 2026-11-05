// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Uploaded AcroForm templates: the pdf-lib work itself. This module is pure
// (no DB, no env, no logger) because it runs INSIDE the isolate process
// (pdf-form-worker.ts); the server only ever reaches it through pdf-form.ts,
// which hard-kills the isolate on a deadline or a memory ceiling. pdf-lib's
// parse, traversal and stream decoding are synchronous, so nothing in-process
// could stop them.
//
// A template PDF is an UNTRUSTED upload that is later printed with real record
// data and handed to people who open it in whatever viewer they have. Three
// things follow, and each is enforced here rather than left to the caller:
//
// - Parsing is bounded before pdf-lib sees a byte: a raw pre-scan counts the
//   indirect objects and object streams, refuses an absurd /Length and inflates
//   every Flate stream against one running byte budget (pdf-lib decodes object
//   streams whole at load). Unparseable objects are refused, never kept raw.
//   After the parse, the page tree and the field tree are walked iteratively
//   with a visited set and a depth cap, and every /Parent is rewritten to the
//   node it was reached from: pdf-lib walks both trees recursively and ascends
//   /Parent unguarded, so a node listed twice per level costs 2^depth visits
//   and a cycle overflows the stack.
// - Active content never survives intake: document and field JavaScript,
//   open/additional actions and embedded files are removed, and actions are an
//   ALLOWLIST (GoTo, the four standard Named actions, URI with an http, https
//   or mailto scheme); every other action, /Next chains included, is dropped.
//   Every object no longer reachable from the trailer is dropped, and the result
//   is saved, reloaded and scanned again. A file that still carries any of it
//   is refused, never stored "mostly clean".
// - What cannot print faithfully is refused at upload, not at print time:
//   encrypted files (loaded WITHOUT ignoreEncryption, so even an empty user
//   password is refused: its fields cannot be rewritten without decrypting),
//   XFA forms (the XFA layer would override the AcroForm we fill), files with
//   no fields, and files whose dry-run fill + flatten fails.
//
// Filling uses the embedded Unicode faces (pdf/unicode-fonts.ts): the base-14
// Helvetica pdf-lib defaults to throws on any character above U+00FF. Output is
// always flattened, so a printed document carries no live form. A field with no
// value is never filled from a default: it prints as a visible grey placeholder.

import { inflateSync, constants as zlibConstants } from "node:zlib"
import { MAX_IMAGE_BYTES } from "@liaison/shared"
import {
  PDFArray,
  PDFButton,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  type PDFDocument as PDFDocumentType,
  PDFDropdown,
  type PDFField,
  type PDFFont,
  PDFHexString,
  type PDFImage,
  PDFInvalidObject,
  PDFName,
  type PDFObject,
  PDFOptionList,
  type PDFPage,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFStream,
  PDFString,
  PDFTextField,
  type PDFWidgetAnnotation,
  rgb,
} from "pdf-lib"
import { embedUnicodeFace, needsCjkFace, splitByFace, type UnicodeFace } from "../pdf/unicode-fonts"

/**
 * Upload size ceiling, the same as a merge's whole input (a literal here, since
 * pdf/merge.ts pulls in the DB; a test pins the two equal).
 */
export const PDF_FORM_MAX_BYTES = 50 * 1024 * 1024
/** Page ceiling, the same as a merge's output. */
export const PDF_FORM_MAX_PAGES = 500
/** Indirect objects a template may carry, packed ones included (a 500-page form sits far below). */
export const PDF_FORM_MAX_OBJECTS = 200_000
/** Object streams a template may declare. */
export const PDF_FORM_MAX_OBJECT_STREAMS = 5_000
/** Decompressed bytes of all Flate streams together. */
export const PDF_FORM_MAX_INFLATED_BYTES = 64 * 1024 * 1024
/** Depth of the page tree and of the field tree. */
export const PDF_FORM_MAX_TREE_DEPTH = 64
/** Fields a template may carry. */
export const PDF_FORM_MAX_FIELDS = 2_000
/** Characters of a text value when the field sets no /MaxLen. */
export const PDF_FORM_MAX_TEXT_LENGTH = 10_000
/** Widest and tallest image a field may take, in pixels. */
export const PDF_FORM_MAX_IMAGE_SIDE = 4_096

const PDF_MAGIC = "%PDF-"

/** Grey of a placeholder printed for a field with no value. */
const PLACEHOLDER_GREY = rgb(0.55, 0.55, 0.55)
const PLACEHOLDER_MAX_SIZE = 10
const PLACEHOLDER_MIN_SIZE = 4

/** Sample the dry run writes into every text field: Latin, Latin Extended, Cyrillic, CJK. */
export const DRY_RUN_SAMPLE = "Ab Łódź Жито 株式会社 09"

export type PdfFormErrorCode =
  | "not_a_pdf"
  | "input_too_large"
  | "too_many_pages"
  | "too_complex"
  | "encrypted"
  | "xfa"
  | "no_fields"
  | "parse_failed"
  | "parse_timeout"
  | "sanitize_failed"
  | "flatten_failed"
  | "value_too_long"
  | "invalid_option"
  | "image_invalid"

/** Typed so the upload route and tool bridge surface a stable code, not a 500. */
export class PdfFormError extends Error {
  readonly code: PdfFormErrorCode
  readonly field?: string
  constructor(code: PdfFormErrorCode, message?: string, field?: string) {
    super(message ?? code)
    this.code = code
    this.field = field
    this.name = "PdfFormError"
  }
}

export type PdfFormFieldType = "text" | "checkbox" | "radio" | "dropdown" | "signature" | "button"

export interface PdfFormRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PdfFormField {
  name: string
  type: PdfFormFieldType
  /** Zero-based page of the first widget. */
  page: number
  /** First widget's rectangle, in page user space. */
  rect: PdfFormRect
  multiline: boolean
  maxLength?: number
  options?: string[]
  tooltip?: string
}

export interface InspectResult {
  pageCount: number
  fields: PdfFormField[]
}

export interface PreparedTemplate extends InspectResult {
  /** Sanitized bytes: the only form of the template that may be stored. */
  bytes: Uint8Array
}

export type PdfFormValue = string | boolean | null | undefined

export interface PdfFormImage {
  bytes: Uint8Array
  type: "png" | "jpeg"
}

export interface FillOptions {
  /** Per-field placeholder text printed when the field has no value. */
  placeholders?: Record<string, string>
}

export interface FillResult {
  bytes: Uint8Array
  /** The value printed per field; "" for a field printed as a placeholder. */
  values: Record<string, string>
  /** Fields that printed as a placeholder. */
  blank: string[]
}

// ---------------------------------------------------------------------------
// Pre-scan: raw bytes, before pdf-lib
// ---------------------------------------------------------------------------

/** PDF whitespace (ISO 32000-1, 7.2.2): NUL and form feed included. */
const PDF_WS = "\\0\\t\\n\\f\\r "
/** Whitespace or a comment between two tokens, as pdf-lib skips them. */
const GAP = `(?:[${PDF_WS}]|%[^\\r\\n]*[\\r\\n])`
/**
 * An indirect object header in every spelling pdf-lib's parser accepts:
 * comments between the tokens, and no gap needed before `obj`.
 */
const OBJ_HEADER = new RegExp(`(\\d+)${GAP}+(\\d+)${GAP}*obj`, "g")
/** An encryption dictionary named from a trailer or an xref stream dict. */
const ENCRYPT_ENTRY = /\/Encrypt\s*(?:\d+\s+\d+\s+R|<<)/

function tooComplex(message: string): PdfFormError {
  return new PdfFormError("too_complex", message)
}

function isPdfWhitespace(code: number): boolean {
  return code === 0 || code === 9 || code === 10 || code === 12 || code === 13 || code === 32
}

/** ( ) < > [ ] { } / % */
function isPdfDelimiter(code: number): boolean {
  return (
    code === 40 ||
    code === 41 ||
    code === 60 ||
    code === 62 ||
    code === 91 ||
    code === 93 ||
    code === 123 ||
    code === 125 ||
    code === 47 ||
    code === 37
  )
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

/** pdf-lib's own name decoding (PDFName.decodeName): `#xx`, upper-case hex only. */
function decodeName(name: string): string {
  return name.replace(/#([\dABCDEF]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
}

interface ObjectBody {
  /**
   * The object's text up to `stream` as pdf-lib reads it: names decoded,
   * strings emptied, comments blanked, NUL as a space. A key or keyword inside
   * a string or a comment is not in it; an escaped name is, decoded.
   */
  dict: string
  /** Index of the `stream` keyword, or -1 when the object ends first. */
  stream: number
  /** Index just past the object's `endobj` (or the end of the file). */
  end: number
}

/**
 * Tokenise one object body from `from` the way pdf-lib's parser does, to its
 * `stream` keyword or its `endobj`. A naive search would stop at an `endobj`
 * written inside a string or a comment and never see the stream behind it.
 */
function scanObjectBody(text: string, from: number): ObjectBody {
  const out: string[] = []
  let flushed = from
  let i = from
  const flush = (to: number, replacement: string) => {
    out.push(text.slice(flushed, to), replacement)
  }
  while (i < text.length) {
    const c = text.charCodeAt(i)
    if (c === 40) {
      // A literal string: nested parens balance, a backslash escapes one byte.
      let depth = 0
      let j = i
      for (; j < text.length; j++) {
        const s = text.charCodeAt(j)
        if (s === 92) {
          j++
          continue
        }
        if (s === 40) depth++
        else if (s === 41 && --depth === 0) break
      }
      if (j >= text.length) throw new PdfFormError("parse_failed", "a PDF string never ends")
      flush(i, "()")
      i = j + 1
      flushed = i
    } else if (c === 60 && text.charCodeAt(i + 1) !== 60) {
      const close = text.indexOf(">", i + 1)
      if (close < 0) throw new PdfFormError("parse_failed", "a PDF hex string never ends")
      flush(i, "<>")
      i = close + 1
      flushed = i
    } else if (c === 60) {
      i += 2
    } else if (c === 37) {
      let j = i + 1
      while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++
      flush(i, " ")
      i = j
      flushed = i
    } else if (c === 47) {
      let j = i + 1
      while (j < text.length) {
        const n = text.charCodeAt(j)
        if (isPdfWhitespace(n) || isPdfDelimiter(n)) break
        j++
      }
      const name = text.slice(i + 1, j)
      if (name.includes("#")) {
        flush(i, `/${decodeName(name)}`)
        flushed = j
      }
      i = j
    } else if (c === 101 && text.startsWith("endobj", i)) {
      flush(i, "")
      return { dict: out.join("").replaceAll("\0", " "), stream: -1, end: i + 6 }
    } else if (
      c === 115 &&
      text.startsWith("stream", i) &&
      !(i > from && isLetter(text.charCodeAt(i - 1)))
    ) {
      flush(i, "")
      return { dict: out.join("").replaceAll("\0", " "), stream: i, end: i + 6 }
    } else {
      i++
    }
  }
  flush(text.length, "")
  return { dict: out.join("").replaceAll("\0", " "), stream: -1, end: text.length }
}

/**
 * Every /Filter of a stream dict (a stray one in /DecodeParms included): the
 * filter names, or null when a value is not a name or an array of names (an
 * indirect reference pdf-lib would resolve and the scan cannot).
 */
function streamFilters(dict: string): Array<string[] | null> {
  const found: Array<string[] | null> = []
  for (const m of dict.matchAll(/\/Filter(?![^\s()<>[\]{}/%])\s*/g)) {
    const at = m.index + m[0].length
    if (dict[at] === "/") {
      found.push([/^\/([^\s()<>[\]{}/%]*)/.exec(dict.slice(at))?.[1] ?? ""])
    } else if (dict[at] === "[") {
      const close = dict.indexOf("]", at)
      const inner = close < 0 ? "?" : dict.slice(at + 1, close)
      const names = [...inner.matchAll(/\/([^\s()<>[\]{}/%]*)/g)].map((n) => n[1] ?? "")
      found.push(inner.replace(/\/[^\s()<>[\]{}/%]*/g, "").trim() === "" ? names : null)
    } else {
      found.push(null)
    }
  }
  return found
}

function isFlate(filters: string[] | null): boolean {
  return filters?.length === 1 && (filters[0] === "FlateDecode" || filters[0] === "Fl")
}

/** A key in a decoded dict, not a prefix of a longer name. */
function keyPattern(key: string, rest: string): RegExp {
  return new RegExp(`/${key}(?![^\\s()<>[\\]{}/%])${rest}`, "g")
}

/**
 * The end of a stream's data as pdf-lib finds it when /Length is one direct
 * integer followed by `endstream`; null when pdf-lib would fall back to its
 * own search, which may run past the first `endstream` in the data.
 */
function declaredStreamEnd(text: string, dict: string, dataStart: number): number | null {
  const lengths = [...dict.matchAll(keyPattern("Length", "\\s*(\\d+)(?![\\d.])(\\s+\\d+\\s+R)?"))]
  if (lengths.length !== 1 || lengths[0]?.[2] !== undefined) return null
  const end = dataStart + Number(lengths[0]?.[1])
  if (!Number.isFinite(end) || end > text.length) return null
  const gap = new RegExp(`${GAP}*`, "y")
  gap.lastIndex = end
  gap.exec(text)
  return text.startsWith("endstream", gap.lastIndex) ? end : null
}

/**
 * Bound the structure before pdf-lib parses it: count indirect objects
 * (packed ones by their stream's /N), object streams, declared lengths, and
 * inflate every Flate stream against one running budget. pdf-lib decodes each
 * object stream whole, synchronously, at load: a small deflate bomb would
 * otherwise allocate gigabytes before any other check runs.
 *
 * The scan reads the file as pdf-lib's parser does (tokenised bodies, decoded
 * names, every header and `stream` spelling it accepts); where it cannot know
 * what pdf-lib will decode (an indirect /Type or /Filter, a filter other than
 * Flate on an object or xref stream), it refuses.
 */
export function prescanPdf(bytes: Uint8Array): void {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1")
  if (ENCRYPT_ENTRY.test(text)) throw new PdfFormError("encrypted", "PDF is encrypted")
  let objects = 0
  let objectStreams = 0
  let inflated = 0
  let pos = 0
  for (;;) {
    OBJ_HEADER.lastIndex = pos
    const header = OBJ_HEADER.exec(text)
    if (!header) break
    if (++objects > PDF_FORM_MAX_OBJECTS) {
      throw tooComplex(`PDF has more than ${PDF_FORM_MAX_OBJECTS} objects`)
    }
    const body = scanObjectBody(text, header.index + header[0].length)
    if (body.stream < 0) {
      pos = body.end
      continue
    }
    const dict = body.dict
    if (ENCRYPT_ENTRY.test(dict)) throw new PdfFormError("encrypted", "PDF is encrypted")
    // pdf-lib's spellings of the keyword's end of line, in its order.
    let dataStart = body.stream + 6
    if (text.startsWith(" \r\n", dataStart)) dataStart += 3
    else if (text.startsWith("\r\n", dataStart)) dataStart += 2
    else if (text[dataStart] === "\r" || text[dataStart] === "\n") dataStart++
    const declaredEnd = declaredStreamEnd(text, dict, dataStart)
    const endstream = text.indexOf("endstream", declaredEnd ?? dataStart)
    pos = endstream < 0 ? text.length : endstream + 9

    for (const length of dict.matchAll(keyPattern("Length", "\\s*(\\d+)"))) {
      if (Number(length[1]) > bytes.byteLength) {
        throw tooComplex("a stream declares a length past the end of the file")
      }
    }
    if (keyPattern("Type", "\\s*\\d").test(dict)) {
      throw tooComplex("a stream names its type indirectly")
    }
    const isObjStm = keyPattern("Type", "\\s*/ObjStm(?![^\\s()<>[\\]{}/%])").test(dict)
    const structural = isObjStm || keyPattern("Type", "\\s*/XRef(?![^\\s()<>[\\]{}/%])").test(dict)
    if (isObjStm) {
      if (++objectStreams > PDF_FORM_MAX_OBJECT_STREAMS) {
        throw tooComplex(`PDF has more than ${PDF_FORM_MAX_OBJECT_STREAMS} object streams`)
      }
      for (const n of dict.matchAll(keyPattern("N", "\\s*(\\d+)"))) objects += Number(n[1])
      if (objects > PDF_FORM_MAX_OBJECTS) {
        throw tooComplex(`PDF has more than ${PDF_FORM_MAX_OBJECTS} objects`)
      }
    }
    const filters = streamFilters(dict)
    if (filters.length === 0) continue
    if (!filters.every(isFlate)) {
      // pdf-lib decodes object and xref streams itself; anything but plain Flate
      // there is unusual enough to refuse rather than decode unbudgeted.
      if (structural) throw tooComplex("an object stream uses an unsupported filter")
      continue
    }
    const remaining = PDF_FORM_MAX_INFLATED_BYTES - inflated
    if (remaining <= 0) throw tooComplex("PDF streams decompress past the size budget")
    try {
      // pdf-lib's own end when /Length is trustworthy; else the rest of the
      // file, a superset of whatever its fallback search hands the decoder
      // (inflate stops at the deflate stream's own end).
      const out = inflateSync(bytes.subarray(dataStart, declaredEnd ?? bytes.byteLength), {
        maxOutputLength: remaining,
        finishFlush: zlibConstants.Z_SYNC_FLUSH,
      })
      inflated += out.byteLength
    } catch (err) {
      if (err instanceof RangeError) {
        throw tooComplex("PDF streams decompress past the size budget")
      }
      // A corrupt object stream would fail in pdf-lib too; a corrupt content
      // stream is never decoded on this path, so it is left to the viewer.
      if (structural) throw new PdfFormError("parse_failed", "an object stream is corrupt")
    }
  }
}

// ---------------------------------------------------------------------------
// Bounded loading
// ---------------------------------------------------------------------------

// pdf-lib's EncryptedPDFError is compiled as an ES5 subclass, so `instanceof`
// does not hold for the thrown value; its message is the only stable signal.
function isEncryptedError(err: unknown): boolean {
  return err instanceof Error && /is encrypted/i.test(err.message)
}

const KEY_PARENT = PDFName.of("Parent")
const KEY_KIDS = PDFName.of("Kids")
const KEY_TYPE = PDFName.of("Type")
const NAME_PAGES = PDFName.of("Pages")

interface TreeVisit {
  ref: PDFRef
  parent: PDFRef | undefined
  depth: number
}

/**
 * Walk one tree (pages, or fields) iteratively. A node reached twice, a kid
 * that is not an indirect reference and a tree deeper than the cap are refused;
 * each node's /Parent is rewritten to the node it was reached from, so pdf-lib's
 * unguarded /Parent ascent can only climb a finite path. Returns the leaf count.
 */
function walkTree(
  doc: PDFDocumentType,
  roots: PDFRef[],
  what: string,
  isBranch: (node: PDFDict) => boolean,
): number {
  const ctx = doc.context
  const visited = new Set<PDFRef>()
  const stack: TreeVisit[] = roots.map((ref) => ({ ref, parent: undefined, depth: 0 }))
  let leaves = 0
  while (stack.length > 0) {
    const visit = stack.pop()
    if (!visit) break
    if (visited.has(visit.ref)) throw tooComplex(`the ${what} tree lists a node twice`)
    visited.add(visit.ref)
    if (visit.depth > PDF_FORM_MAX_TREE_DEPTH) {
      throw tooComplex(`the ${what} tree is deeper than ${PDF_FORM_MAX_TREE_DEPTH}`)
    }
    const node = ctx.lookup(visit.ref)
    if (!(node instanceof PDFDict)) {
      throw new PdfFormError("parse_failed", `a ${what} tree node is not a dictionary`)
    }
    if (visit.parent) node.set(KEY_PARENT, visit.parent)
    else node.delete(KEY_PARENT)
    if (!isBranch(node)) {
      leaves++
      continue
    }
    const kids = node.lookup(KEY_KIDS)
    if (!(kids instanceof PDFArray)) continue
    for (const kid of kids.asArray()) {
      if (!(kid instanceof PDFRef)) throw tooComplex(`a ${what} tree kid is not a reference`)
      stack.push({ ref: kid, parent: visit.ref, depth: visit.depth + 1 })
    }
  }
  return leaves
}

/** Make the page tree and the field tree safe for pdf-lib's recursive walks. */
function walkStructure(doc: PDFDocumentType): void {
  const pagesRoot = doc.catalog.get(NAME_PAGES)
  if (!(pagesRoot instanceof PDFRef)) {
    throw new PdfFormError("parse_failed", "PDF has no page tree")
  }
  const pages = walkTree(doc, [pagesRoot], "page", (node) => {
    const type = node.lookup(KEY_TYPE)
    return type === NAME_PAGES || (type === undefined && node.has(KEY_KIDS))
  })
  if (pages > PDF_FORM_MAX_PAGES) {
    throw new PdfFormError("too_many_pages", `PDF has more than ${PDF_FORM_MAX_PAGES} pages`)
  }
  const acroForm = doc.catalog.lookup(PDFName.of("AcroForm"))
  const fields = acroForm instanceof PDFDict ? acroForm.lookup(PDFName.of("Fields")) : undefined
  if (!(fields instanceof PDFArray)) return
  const roots: PDFRef[] = []
  for (const entry of fields.asArray()) {
    if (!(entry instanceof PDFRef)) throw tooComplex("a form field is not a reference")
    roots.push(entry)
  }
  walkTree(doc, roots, "field", (node) => node.has(KEY_KIDS))
}

/** Pre-checks on (tests only turn this off, to prove the isolate's kill alone holds). */
let structureWalk = true

async function loadBounded(bytes: Uint8Array): Promise<PDFDocumentType> {
  if (bytes.byteLength > PDF_FORM_MAX_BYTES) {
    throw new PdfFormError("input_too_large", `PDF is larger than ${PDF_FORM_MAX_BYTES} bytes`)
  }
  // The MIME type is client-claimed for an upload, so only the magic decides.
  if (Buffer.from(bytes.subarray(0, PDF_MAGIC.length)).toString("latin1") !== PDF_MAGIC) {
    throw new PdfFormError("not_a_pdf")
  }
  if (structureWalk) prescanPdf(bytes)
  let doc: PDFDocumentType
  try {
    // NOT ignoreEncryption: an encrypted file must be refused, not half-read.
    // throwOnInvalidObject: pdf-lib otherwise keeps an unparseable object as
    // raw bytes that no scan below can see into, and writes it back verbatim.
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true })
  } catch (err) {
    if (err instanceof PdfFormError) throw err
    if (isEncryptedError(err)) throw new PdfFormError("encrypted", "PDF is encrypted")
    throw new PdfFormError("parse_failed", err instanceof Error ? err.message : String(err))
  }
  if (doc.isEncrypted) throw new PdfFormError("encrypted", "PDF is encrypted")
  // Checked on the raw AcroForm: pdf-lib's getForm() silently DELETES the XFA
  // entry, which would turn an XFA form into a fillable-looking AcroForm whose
  // viewers still render the XFA layer.
  if (doc.catalog.getAcroForm()?.dict.has(PDFName.of("XFA"))) {
    throw new PdfFormError("xfa", "XFA forms are not supported")
  }
  const objects = doc.context.enumerateIndirectObjects()
  if (objects.length > PDF_FORM_MAX_OBJECTS) {
    throw tooComplex(`PDF has more than ${PDF_FORM_MAX_OBJECTS} objects`)
  }
  for (const [, obj] of objects) {
    if (obj instanceof PDFInvalidObject) {
      throw new PdfFormError("parse_failed", "PDF holds an object that cannot be parsed")
    }
  }
  if (structureWalk) walkStructure(doc)
  const pageCount = doc.getPageCount()
  if (pageCount > PDF_FORM_MAX_PAGES) {
    throw new PdfFormError("too_many_pages", `PDF has more than ${PDF_FORM_MAX_PAGES} pages`)
  }
  return doc
}

function formFields(doc: PDFDocumentType): PDFField[] {
  let fields: PDFField[]
  try {
    fields = doc.getForm().getFields()
  } catch (err) {
    throw new PdfFormError("parse_failed", err instanceof Error ? err.message : String(err))
  }
  if (fields.length > PDF_FORM_MAX_FIELDS) {
    throw new PdfFormError("too_complex", `PDF has more than ${PDF_FORM_MAX_FIELDS} fields`)
  }
  return fields
}

// ---------------------------------------------------------------------------
// Sanitize
// ---------------------------------------------------------------------------

/**
 * The only actions a template keeps. Everything else (Launch, SubmitForm,
 * ImportData, JavaScript, GoToR/GoToE, Thread, Movie, Sound, Hide,
 * SetOCGState, Rendition, GoTo3DView, RichMediaExecute, and whatever a future
 * spec adds) is removed.
 */
const ALLOWED_ACTIONS = new Set(["GoTo", "Named", "URI"])
/** The standard Named actions; viewers map other names to menu items (save, print, quit). */
const STANDARD_NAMED = new Set(["NextPage", "PrevPage", "FirstPage", "LastPage"])
const ALLOWED_URI_SCHEMES = new Set(["http", "https", "mailto"])
/** Code points a viewer may silently drop or fold before it reads the scheme. */
const URI_INVISIBLE_RANGES: Array<[number, number]> = [
  [0x00, 0x20], // C0 controls and space
  [0x7f, 0xa0], // DEL, C1 controls, no-break space
  [0xad, 0xad], // soft hyphen
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x2000, 0x200f], // spaces, zero-width and direction marks
  [0x2028, 0x202f],
  [0x205f, 0x206f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
]

function hasInvisible(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (URI_INVISIBLE_RANGES.some(([lo, hi]) => c >= lo && c <= hi)) return true
  }
  return false
}

/** Keys removed wherever they appear. */
const STRIPPED_KEYS = ["AA", "JS", "JavaScript", "EmbeddedFiles", "EF"].map((k) => PDFName.of(k))
const OPEN_ACTION = PDFName.of("OpenAction")
const KEY_A = PDFName.of("A")
const KEY_N = PDFName.of("N")
const KEY_NEXT = PDFName.of("Next")
const KEY_S = PDFName.of("S")
const KEY_URI = PDFName.of("URI")
const NAME_ACTION = PDFName.of("Action")

function decodePdfText(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText()
  return undefined
}

function resolve(doc: PDFDocumentType, obj: PDFObject | undefined): PDFObject | undefined {
  return obj instanceof PDFRef ? doc.context.lookup(obj) : obj
}

/**
 * An http, https or mailto URI and nothing that could read as another scheme:
 * control characters, whitespace and invisible format characters anywhere
 * (`java\tscript:` is `javascript:` to a viewer that strips them) and UNC or
 * scheme-relative paths are refused outright.
 */
export function isSafeUri(uri: string | undefined): boolean {
  if (uri === undefined) return false
  const value = uri.trim()
  if (value === "" || hasInvisible(value)) return false
  if (value.startsWith("\\") || value.startsWith("//")) return false
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  if (!scheme || !ALLOWED_URI_SCHEMES.has(scheme)) return false
  if (scheme === "mailto") return true
  try {
    const parsed = new URL(value)
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== ""
  } catch {
    return false
  }
}

/** True only for an action on the allowlist; /S and its operands resolved through refs. */
function isAllowedAction(doc: PDFDocumentType, obj: PDFObject | undefined): boolean {
  const dict = resolve(doc, obj)
  if (!(dict instanceof PDFDict)) return false
  const s = resolve(doc, dict.get(KEY_S))
  if (!(s instanceof PDFName)) return false
  const type = s.decodeText()
  if (!ALLOWED_ACTIONS.has(type)) return false
  if (type === "Named") {
    const n = resolve(doc, dict.get(KEY_N))
    return n instanceof PDFName && STANDARD_NAMED.has(n.decodeText())
  }
  if (type === "URI") return isSafeUri(decodePdfText(resolve(doc, dict.get(KEY_URI))))
  return true
}

/** An action dict: one with /S, or typed /Action. Outline items also use /Next. */
function isActionDict(doc: PDFDocumentType, dict: PDFDict): boolean {
  return dict.has(KEY_S) || resolve(doc, dict.get(KEY_TYPE)) === NAME_ACTION
}

/** Visit every dict (stream dicts included) inside one object, without following refs. */
function forEachDict(root: PDFObject, fn: (dict: PDFDict) => void): void {
  // Iterative: a direct object nested thousands deep must not overflow the stack.
  const stack: PDFObject[] = [root]
  while (stack.length > 0) {
    const obj = stack.pop()
    if (obj instanceof PDFStream) {
      stack.push(obj.dict)
    } else if (obj instanceof PDFDict) {
      fn(obj)
      for (const [, v] of obj.entries()) stack.push(v)
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) stack.push(v)
    }
  }
}

function stripDict(doc: PDFDocumentType, dict: PDFDict): void {
  for (const key of STRIPPED_KEYS) dict.delete(key)
  if (dict.has(KEY_A) && !isAllowedAction(doc, dict.get(KEY_A))) dict.delete(KEY_A)
  if (!dict.has(KEY_NEXT) || !isActionDict(doc, dict)) return
  const next = dict.get(KEY_NEXT)
  const chain = resolve(doc, next)
  if (chain instanceof PDFArray) {
    for (let i = chain.size() - 1; i >= 0; i--) {
      if (!isAllowedAction(doc, chain.get(i))) chain.remove(i)
    }
  } else if (!isAllowedAction(doc, next)) {
    dict.delete(KEY_NEXT)
  }
}

/** Drop every indirect object the trailer can no longer reach (removed JS, files). */
function dropUnreachable(doc: PDFDocumentType): void {
  const ctx = doc.context
  const reachable = new Set<PDFRef>()
  const stack: PDFObject[] = []
  const { Root, Info } = ctx.trailerInfo
  if (Root) stack.push(Root)
  if (Info) stack.push(Info)
  while (stack.length > 0) {
    const obj = stack.pop()
    if (obj instanceof PDFRef) {
      if (reachable.has(obj)) continue
      reachable.add(obj)
      const target = ctx.lookup(obj)
      if (target) stack.push(target)
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict)
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v)
    } else if (obj instanceof PDFArray) {
      for (const v of obj.asArray()) stack.push(v)
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) ctx.delete(ref)
  }
}

/** What active content is left, as readable offences; empty means clean. */
export function findActiveContent(doc: PDFDocumentType): string[] {
  const found: string[] = []
  if (doc.catalog.has(OPEN_ACTION)) found.push("/OpenAction")
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFInvalidObject) found.push(`unparsed object ${ref.toString()}`)
    forEachDict(obj, (dict) => {
      for (const key of STRIPPED_KEYS) {
        if (dict.has(key)) found.push(`${key.asString()} in ${ref.toString()}`)
      }
      if (dict.has(KEY_A) && !isAllowedAction(doc, dict.get(KEY_A))) {
        found.push(`/A action in ${ref.toString()}`)
      }
      if (!isActionDict(doc, dict)) return
      if (resolve(doc, dict.get(KEY_TYPE)) === NAME_ACTION && !isAllowedAction(doc, dict)) {
        found.push(`${dict.get(KEY_S)?.toString()} action in ${ref.toString()}`)
      }
      const chain = resolve(doc, dict.get(KEY_NEXT))
      const links = chain instanceof PDFArray ? chain.asArray() : chain ? [chain] : []
      for (const link of links) {
        if (!isAllowedAction(doc, link)) found.push(`/Next action in ${ref.toString()}`)
      }
    })
  }
  return found
}

function sanitizeDoc(doc: PDFDocumentType): void {
  doc.catalog.delete(OPEN_ACTION)
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    forEachDict(obj, (dict) => stripDict(doc, dict))
  }
  dropUnreachable(doc)
}

/** Reload saved bytes and refuse them (`sanitize_failed`) if any active content is left. */
export async function assertNoActiveContent(bytes: Uint8Array): Promise<void> {
  const reloaded = await loadBounded(bytes)
  const left = findActiveContent(reloaded)
  if (left.length > 0) {
    throw new PdfFormError(
      "sanitize_failed",
      `active content survived: ${left.slice(0, 5).join(", ")}`,
    )
  }
}

async function saveClean(doc: PDFDocumentType): Promise<Uint8Array> {
  // No object streams: the stored template stays greppable for an auditor.
  const out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false })
  await assertNoActiveContent(out)
  return out
}

/** Remove active content; saved, reloaded and re-scanned before it is returned. */
export async function sanitizePdfForm(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await loadBounded(bytes)
  sanitizeDoc(doc)
  return saveClean(doc)
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function fieldType(field: PDFField): PdfFormFieldType {
  if (field instanceof PDFTextField) return "text"
  if (field instanceof PDFCheckBox) return "checkbox"
  if (field instanceof PDFRadioGroup) return "radio"
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) return "dropdown"
  if (field instanceof PDFSignature) return "signature"
  if (field instanceof PDFButton) return "button"
  return "button"
}

function tooltipOf(field: PDFField): string | undefined {
  const tu = decodePdfText(field.acroField.dict.lookup(PDFName.of("TU")))?.trim()
  return tu ? tu : undefined
}

/** The page holding a widget: its /P when valid, else the page whose /Annots lists it. */
function widgetPageIndex(doc: PDFDocumentType, widget: PDFWidgetAnnotation): number {
  const pages = doc.getPages()
  const p = widget.P()
  if (p) {
    const i = pages.findIndex((page) => page.ref === p)
    if (i >= 0) return i
  }
  for (let i = 0; i < pages.length; i++) {
    const annots = pages[i]?.node.Annots()
    if (!annots) continue
    for (const entry of annots.asArray()) {
      const resolved = entry instanceof PDFRef ? doc.context.lookup(entry) : entry
      if (resolved === widget.dict) return i
    }
  }
  return 0
}

interface WidgetGeom {
  page: number
  rect: PdfFormRect
}

function widgetGeometry(doc: PDFDocumentType, field: PDFField): WidgetGeom[] {
  return field.acroField.getWidgets().map((w) => {
    const r = w.getRectangle()
    return {
      page: widgetPageIndex(doc, w),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    }
  })
}

function describeField(doc: PDFDocumentType, field: PDFField): PdfFormField {
  const geom = widgetGeometry(doc, field)[0] ?? {
    page: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
  }
  const out: PdfFormField = {
    name: field.getName(),
    type: fieldType(field),
    page: geom.page,
    rect: geom.rect,
    multiline: field instanceof PDFTextField ? field.isMultiline() : false,
  }
  if (field instanceof PDFTextField) {
    const max = field.getMaxLength()
    if (max !== undefined) out.maxLength = max
  }
  if (
    field instanceof PDFDropdown ||
    field instanceof PDFOptionList ||
    field instanceof PDFRadioGroup
  ) {
    out.options = field.getOptions()
  }
  const tooltip = tooltipOf(field)
  if (tooltip) out.tooltip = tooltip
  return out
}

/** Inspect an upload: caps, encryption, XFA and fields. Throws PdfFormError. */
export async function inspectPdfForm(bytes: Uint8Array): Promise<InspectResult> {
  const doc = await loadBounded(bytes)
  return inspectDoc(doc)
}

function inspectDoc(doc: PDFDocumentType): InspectResult {
  const fields = formFields(doc)
  if (fields.length === 0) throw new PdfFormError("no_fields", "PDF has no form fields")
  return { pageCount: doc.getPageCount(), fields: fields.map((f) => describeField(doc, f)) }
}

/** The field list of a (stored, sanitized) template. */
export async function listPdfFormFields(bytes: Uint8Array): Promise<PdfFormField[]> {
  const doc = await loadBounded(bytes)
  return formFields(doc).map((f) => describeField(doc, f))
}

// ---------------------------------------------------------------------------
// Fill + flatten
// ---------------------------------------------------------------------------

function isBlank(value: PdfFormValue): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "")
}

function asChecked(value: PdfFormValue): boolean {
  if (typeof value === "boolean") return value
  return ["1", "true", "yes", "on", "x"].includes(String(value).trim().toLowerCase())
}

/** Label of a field: the last segment of its fully qualified name. */
function fieldLabel(name: string): string {
  const parts = name.split(".")
  return parts[parts.length - 1] || name
}

function hasCjk(text: string): boolean {
  for (const ch of text) if (needsCjkFace(ch)) return true
  return false
}

/**
 * pdf-lib's flatten needs an appearance REF for every widget and throws on one
 * without (a signature field with no /AP is the common case). Give such widgets
 * an empty appearance so they flatten to nothing.
 */
function ensureAppearanceRefs(doc: PDFDocumentType, fields: PDFField[]): void {
  for (const field of fields) {
    for (const widget of field.acroField.getWidgets()) {
      const ap = widget.dict.lookup(PDFName.of("AP"))
      let n: PDFObject | undefined = ap instanceof PDFDict ? ap.get(PDFName.of("N")) : undefined
      if (
        n instanceof PDFDict &&
        (field instanceof PDFCheckBox || field instanceof PDFRadioGroup)
      ) {
        const value = field.acroField.getValue()
        n = n.get(value) ?? n.get(PDFName.of("Off"))
      }
      if (n instanceof PDFRef) continue
      const r = widget.getRectangle()
      const empty = doc.context.formXObject([], {
        BBox: [0, 0, Math.max(r.width, 1), Math.max(r.height, 1)],
      })
      widget.setNormalAppearance(doc.context.register(empty))
    }
  }
}

const KEY_ANNOTS = PDFName.of("Annots")

/** The widget annotation refs of `fields` (and the fields' own refs), before flatten. */
function widgetRefs(doc: PDFDocumentType, fields: PDFField[]): Set<PDFRef> {
  const refs = new Set<PDFRef>()
  for (const field of fields) {
    refs.add(field.ref)
    for (const widget of field.acroField.getWidgets()) {
      const ref = doc.context.getObjectRef(widget.dict)
      if (ref) refs.add(ref)
    }
  }
  return refs
}

/**
 * pdf-lib 1.17's flatten deletes every widget object but unlinks the wrong ref
 * from the page (the appearance stream's, not the widget's), so each page's
 * /Annots keeps pointing at deleted objects: a broken cross-reference table
 * that strict viewers and print drivers repair or refuse. Unlink the widgets of
 * the flattened fields, and any annotation ref that no longer resolves.
 */
function unlinkFlattenedWidgets(doc: PDFDocumentType, flattened: Set<PDFRef>): void {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    const kept = annots
      .asArray()
      .filter((a) => !(a instanceof PDFRef) || (!flattened.has(a) && doc.context.lookup(a)))
    if (kept.length === annots.size()) continue
    if (kept.length === 0) page.node.delete(KEY_ANNOTS)
    else page.node.set(KEY_ANNOTS, doc.context.obj(kept))
  }
}

interface Fonts {
  get(face: UnicodeFace): Promise<PDFFont>
}

function fontLoader(doc: PDFDocumentType): Fonts {
  const cache = new Map<UnicodeFace, PDFFont>()
  return { get: (face) => embedUnicodeFace(doc, face, cache) }
}

async function drawPlaceholder(
  page: PDFPage,
  rect: PdfFormRect,
  text: string,
  fonts: Fonts,
): Promise<void> {
  const runs = await Promise.all(
    splitByFace(text).map(async (run) => ({
      text: run.text,
      font: await fonts.get(run.cjk ? "cjk" : "regular"),
    })),
  )
  const widthAt = (size: number) =>
    runs.reduce((sum, r) => sum + r.font.widthOfTextAtSize(r.text, size), 0)
  const pad = Math.min(2, rect.width / 10)
  const avail = Math.max(rect.width - 2 * pad, 1)
  let size = Math.min(PLACEHOLDER_MAX_SIZE, Math.max(rect.height * 0.7, PLACEHOLDER_MIN_SIZE))
  const width = widthAt(size)
  if (width > avail) size = Math.max(PLACEHOLDER_MIN_SIZE, (size * avail) / width)
  const y = rect.y + Math.max((rect.height - size) / 2, 0) + size * 0.2
  let x = rect.x + pad
  for (const run of runs) {
    page.drawText(run.text, { x, y, size, font: run.font, color: PLACEHOLDER_GREY })
    x += run.font.widthOfTextAtSize(run.text, size)
  }
}

function drawImageFitted(page: PDFPage, rect: PdfFormRect, image: PDFImage): void {
  const scale = Math.min(rect.width / image.width, rect.height / image.height)
  const width = image.width * scale
  const height = image.height * scale
  page.drawImage(image, {
    x: rect.x + (rect.width - width) / 2,
    y: rect.y + (rect.height - height) / 2,
    width,
    height,
  })
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Pixel size from the header (PNG IHDR, JPEG SOFn), read before embedding:
 * pdf-lib decodes the whole raster, so a few kilobytes of a 60000x60000 image
 * would otherwise cost gigabytes.
 */
export function imageSize(image: PdfFormImage): { width: number; height: number } | undefined {
  const b = image.bytes
  const u16 = (i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
  const u32 = (i: number) => u16(i) * 0x10000 + u16(i + 2)
  if (image.type === "png") {
    if (b.length < 24 || PNG_SIGNATURE.some((v, i) => b[i] !== v)) return undefined
    if (String.fromCharCode(b[12] ?? 0, b[13] ?? 0, b[14] ?? 0, b[15] ?? 0) !== "IHDR") {
      return undefined
    }
    return { width: u32(16), height: u32(20) }
  }
  if (b[0] !== 0xff || b[1] !== 0xd8) return undefined
  let i = 2
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return undefined
    const marker = b[i + 1] ?? 0
    if (marker === 0xff) {
      i++
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2
      continue
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isSof) return { width: u16(i + 7), height: u16(i + 5) }
    i += 2 + u16(i + 2)
  }
  return undefined
}

async function embedImage(
  doc: PDFDocumentType,
  name: string,
  image: PdfFormImage,
): Promise<PDFImage> {
  if (image.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new PdfFormError(
      "image_invalid",
      `image for ${name} is over ${MAX_IMAGE_BYTES} bytes`,
      name,
    )
  }
  const size = imageSize(image)
  if (!size) {
    throw new PdfFormError(
      "image_invalid",
      `image for ${name} is not a readable ${image.type}`,
      name,
    )
  }
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > PDF_FORM_MAX_IMAGE_SIDE ||
    size.height > PDF_FORM_MAX_IMAGE_SIDE
  ) {
    throw new PdfFormError(
      "image_invalid",
      `image for ${name} is ${size.width}x${size.height}; at most ${PDF_FORM_MAX_IMAGE_SIDE}x${PDF_FORM_MAX_IMAGE_SIDE}`,
      name,
    )
  }
  try {
    return image.type === "png" ? await doc.embedPng(image.bytes) : await doc.embedJpg(image.bytes)
  } catch (err) {
    throw new PdfFormError(
      "image_invalid",
      `image for ${name}: ${err instanceof Error ? err.message : String(err)}`,
      name,
    )
  }
}

async function fillDoc(
  doc: PDFDocumentType,
  values: Record<string, PdfFormValue>,
  images: Record<string, PdfFormImage>,
  options: FillOptions,
): Promise<FillResult> {
  const form = doc.getForm()
  const fields = formFields(doc)
  const fonts = fontLoader(doc)
  const regular = await fonts.get("regular")

  const printed: Record<string, string> = {}
  const blank: string[] = []
  const pending: Array<{ geom: WidgetGeom[]; text?: string; image?: PDFImage }> = []

  for (const field of fields) {
    const name = field.getName()
    const value = values[name]
    const geom = widgetGeometry(doc, field)
    const image = images[name]
    if (image) {
      pending.push({ geom, image: await embedImage(doc, name, image) })
      printed[name] = ""
      continue
    }
    // false is a real value for a checkbox, so only null/undefined/"" is blank.
    const empty =
      field instanceof PDFCheckBox ? value === undefined || value === null : isBlank(value)
    if (empty) {
      const text = options.placeholders?.[name]?.trim() || tooltipOf(field) || fieldLabel(name)
      pending.push({ geom: field instanceof PDFRadioGroup ? geom.slice(0, 1) : geom, text })
      printed[name] = ""
      blank.push(name)
      continue
    }
    const str = String(value)
    if (field instanceof PDFTextField) {
      const max = field.getMaxLength() ?? PDF_FORM_MAX_TEXT_LENGTH
      if (str.length > max) {
        throw new PdfFormError("value_too_long", `${name} takes at most ${max} characters`, name)
      }
      field.setText(str)
      if (hasCjk(str)) field.updateAppearances(await fonts.get("cjk"))
      printed[name] = str
    } else if (field instanceof PDFCheckBox) {
      if (asChecked(value)) field.check()
      else field.uncheck()
      printed[name] = asChecked(value) ? "true" : "false"
    } else if (field instanceof PDFRadioGroup || field instanceof PDFOptionList) {
      if (!field.getOptions().includes(str)) {
        throw new PdfFormError("invalid_option", `${name} has no option "${str}"`, name)
      }
      field.select(str)
      printed[name] = str
    } else if (field instanceof PDFDropdown) {
      if (str.length > PDF_FORM_MAX_TEXT_LENGTH) {
        throw new PdfFormError(
          "value_too_long",
          `${name} takes at most ${PDF_FORM_MAX_TEXT_LENGTH} characters`,
          name,
        )
      }
      if (!field.isEditable() && !field.getOptions().includes(str)) {
        throw new PdfFormError("invalid_option", `${name} has no option "${str}"`, name)
      }
      field.select(str)
      if (hasCjk(str)) field.updateAppearances(await fonts.get("cjk"))
      printed[name] = str
    } else {
      // Signature and push button fields take an image, not a value.
      pending.push({
        geom,
        text: options.placeholders?.[name]?.trim() || tooltipOf(field) || fieldLabel(name),
      })
      printed[name] = ""
      blank.push(name)
    }
  }

  try {
    // Every dirty field gets the Unicode face; CJK fields were already updated
    // (and marked clean) with the CJK face above, so this leaves them alone.
    form.updateFieldAppearances(regular)
    ensureAppearanceRefs(doc, fields)
    const flattened = widgetRefs(doc, form.getFields())
    form.flatten({ updateFieldAppearances: false })
    unlinkFlattenedWidgets(doc, flattened)
  } catch (err) {
    if (err instanceof PdfFormError) throw err
    throw new PdfFormError("flatten_failed", err instanceof Error ? err.message : String(err))
  }

  const pages = doc.getPages()
  for (const item of pending) {
    for (const g of item.geom) {
      const page = pages[g.page]
      if (!page || g.rect.width <= 0 || g.rect.height <= 0) continue
      if (item.image) drawImageFitted(page, g.rect, item.image)
      else if (item.text) await drawPlaceholder(page, g.rect, item.text, fonts)
    }
  }

  const bytes = await doc.save({ updateFieldAppearances: false })
  return { bytes, values: printed, blank }
}

/**
 * Fill a template and flatten it. `values` and `images` are keyed by fully
 * qualified field name; a field with neither prints as a grey placeholder
 * (options.placeholders, else its tooltip, else its label). The input is
 * re-sanitized first: stored templates are clean, but this is the last door
 * before a document leaves the platform.
 */
export async function fillPdfForm(
  bytes: Uint8Array,
  values: Record<string, PdfFormValue>,
  images: Record<string, PdfFormImage> = {},
  options: FillOptions = {},
): Promise<FillResult> {
  const doc = await loadBounded(bytes)
  sanitizeDoc(doc)
  return fillDoc(doc, values, images, options)
}

/**
 * Fill every text field with a mixed-script sample and flatten. Run at upload,
 * so a template that cannot print is refused there (`flatten_failed`), not on
 * the day someone needs the document.
 */
export async function dryRunPdfForm(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await loadBounded(bytes)
  const values: Record<string, PdfFormValue> = {}
  for (const field of formFields(doc)) {
    if (!(field instanceof PDFTextField)) continue
    const max = field.getMaxLength()
    values[field.getName()] =
      max !== undefined ? [...DRY_RUN_SAMPLE].slice(0, max).join("") : DRY_RUN_SAMPLE
  }
  try {
    const result = await fillDoc(doc, values, {}, {})
    return result.bytes
  } catch (err) {
    if (err instanceof PdfFormError && err.code !== "flatten_failed") throw err
    throw new PdfFormError("flatten_failed", err instanceof Error ? err.message : String(err))
  }
}

/**
 * The whole intake: inspect, sanitize, then dry-run the sanitized bytes.
 * Returns the bytes to store and the field list to store with them.
 */
export async function preparePdfFormTemplate(bytes: Uint8Array): Promise<PreparedTemplate> {
  const doc = await loadBounded(bytes)
  inspectDoc(doc)
  sanitizeDoc(doc)
  const clean = await saveClean(doc)
  const inspected = await inspectPdfForm(clean)
  await dryRunPdfForm(clean)
  return { bytes: clean, ...inspected }
}

// ---------------------------------------------------------------------------
// The isolate protocol (pdf-form-worker.ts runs one request, pdf-form.ts sends it)
// ---------------------------------------------------------------------------

/** Bytes travel base64-encoded so the IPC payload is plain JSON. */
export interface PdfFormWireImage {
  data: string
  type: "png" | "jpeg"
}

export interface PdfFormRequest {
  op: "inspect" | "list" | "sanitize" | "fill" | "dryRun" | "prepare"
  pdf: string
  values?: Record<string, string | boolean | null>
  images?: Record<string, PdfFormWireImage>
  options?: FillOptions
  /** Tests only: false skips the pre-scan and tree walk. */
  structureWalk?: boolean
}

export interface PdfFormWireResult {
  pdf?: string
  pageCount?: number
  fields?: PdfFormField[]
  values?: Record<string, string>
  blank?: string[]
}

export type PdfFormResponse =
  | { ok: true; result: PdfFormWireResult }
  | { ok: false; code: PdfFormErrorCode; message: string; field?: string }

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")
}

export function fromBase64(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"))
}

async function runOp(req: PdfFormRequest): Promise<PdfFormWireResult> {
  const pdf = fromBase64(req.pdf)
  switch (req.op) {
    case "inspect":
      return inspectPdfForm(pdf)
    case "list":
      return { fields: await listPdfFormFields(pdf) }
    case "sanitize":
      return { pdf: toBase64(await sanitizePdfForm(pdf)) }
    case "dryRun":
      return { pdf: toBase64(await dryRunPdfForm(pdf)) }
    case "prepare": {
      const prepared = await preparePdfFormTemplate(pdf)
      return {
        pdf: toBase64(prepared.bytes),
        pageCount: prepared.pageCount,
        fields: prepared.fields,
      }
    }
    case "fill": {
      const images: Record<string, PdfFormImage> = {}
      for (const [name, image] of Object.entries(req.images ?? {})) {
        images[name] = { bytes: fromBase64(image.data), type: image.type }
      }
      const filled = await fillPdfForm(pdf, req.values ?? {}, images, req.options ?? {})
      return { pdf: toBase64(filled.bytes), values: filled.values, blank: filled.blank }
    }
  }
}

/** Run one request; never throws: every failure is a typed response. */
export async function runPdfFormRequest(req: PdfFormRequest): Promise<PdfFormResponse> {
  structureWalk = req.structureWalk !== false
  try {
    return { ok: true, result: await runOp(req) }
  } catch (err) {
    if (err instanceof PdfFormError) {
      return {
        ok: false,
        code: err.code,
        message: err.message,
        ...(err.field !== undefined ? { field: err.field } : {}),
      }
    }
    // A stack overflow or any other pdf-lib throw on a hostile file.
    return {
      ok: false,
      code: "parse_failed",
      message: err instanceof Error ? err.message : String(err),
    }
  } finally {
    structureWalk = true
  }
}
