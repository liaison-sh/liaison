// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Transform source rules. A transform is a plain script, not a module: it
 * defines top-level functions and the host calls them by name.
 *
 *   function transform(batch, ctx) { ...; return { state } }        // uploads
 *   function finish(batch, ctx) { ... }                              // uploads, optional: once after the last batch
 *   async function pull(page, ctx) { ...; return { nextCursor, state } } // API sources
 *
 * There is nothing to import: the sandbox has no modules, no network and no
 * bytes, and `ctx` (four host methods) is the whole API. So `import`, `export`
 * and `require` are refused up front with a message that says what to write
 * instead, rather than failing later as an obscure syntax error.
 */

export const TRANSFORM_SOURCE_MAX_CHARS = 200_000

export type TransformEntry = "transform" | "pull" | "finish"

export class TransformSourceError extends Error {
  readonly code = "invalid_transform_source"
  constructor(message: string) {
    super(message)
    this.name = "TransformSourceError"
  }
}

/**
 * The source with comments and string/template literal contents blanked out
 * (same length), so a keyword check never trips on text inside them.
 */
function codeOnly(source: string): string {
  // Every JavaScript line terminator ends a line comment and a line: read them all as \n.
  const src = source.replace(/[\r\u2028\u2029]/g, "\n")
  let out = ""
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const next = src[i + 1]
    if (c === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " "
        i++
      }
      continue
    }
    if (c === "/" && next === "*") {
      out += "  "
      i += 2
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < n) {
        out += "  "
        i += 2
      }
      continue
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c
      out += quote
      i++
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\") {
          out += "  "
          i += 2
          continue
        }
        out += src[i] === "\n" ? "\n" : " "
        i++
      }
      if (i < n) {
        out += quote
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

// A line ends at CR, LS and PS too (JavaScript line terminators).
const IMPORT_STATEMENT_RE = /(^|[;{}\n\r\u2028\u2029])\s*import\s*(?:[\w${}*\s,]+\s+from\s*)?["'`]/
const IMPORT_CALL_RE = /(^|[^\w$.])import\s*\(/
const IMPORT_META_RE = /(^|[^\w$.])import\s*\.\s*meta\b/
const EXPORT_RE =
  /(^|[;{}\n\r\u2028\u2029])\s*export\s+(default\b|function\b|async\b|const\b|let\b|var\b|class\b|\{|\*)/
const REQUIRE_RE = /(^|[^\w$.])require\s*\(/

const NO_MODULES =
  "A transform is a plain script: there are no modules to load and nothing to export. " +
  "Define top-level functions (function transform(batch, ctx) for uploads, " +
  "async function pull(page, ctx) for API sources); ctx.emitRecords, ctx.declareFile, " +
  "ctx.downloadToFile and ctx.apiGet are the whole host API."

/** Refuse a source the sandbox cannot run as a transform, with a message the author can act on. */
export function validateTransformSource(source: string, entry: "transform" | "pull"): void {
  if (typeof source !== "string" || source.trim() === "") {
    throw new TransformSourceError("The transform source is empty.")
  }
  if (source.length > TRANSFORM_SOURCE_MAX_CHARS) {
    throw new TransformSourceError(
      `The transform source is ${source.length} characters; the limit is ${TRANSFORM_SOURCE_MAX_CHARS}.`,
    )
  }
  const code = codeOnly(source)
  if (IMPORT_STATEMENT_RE.test(code) || IMPORT_CALL_RE.test(code) || IMPORT_META_RE.test(code)) {
    throw new TransformSourceError(`import is not available in a transform. ${NO_MODULES}`)
  }
  if (EXPORT_RE.test(code)) {
    throw new TransformSourceError(`export is not available in a transform. ${NO_MODULES}`)
  }
  if (REQUIRE_RE.test(code)) {
    throw new TransformSourceError(`require() is not available in a transform. ${NO_MODULES}`)
  }
  if (!definesFunction(code, entry)) {
    throw new TransformSourceError(
      entry === "transform"
        ? "The transform must define a top-level function transform(batch, ctx)."
        : "The transform must define a top-level async function pull(page, ctx).",
    )
  }
}

function definesFunction(code: string, entry: "transform" | "pull"): boolean {
  return new RegExp(
    `(^|[;{}\\n])\\s*(async\\s+)?function\\s*\\*?\\s*${entry}\\s*\\(|(^|[;{}\\n])\\s*(var|let|const)\\s+${entry}\\s*=`,
  ).test(code)
}

/**
 * The script the sandbox evaluates: a prelude that makes the module globals
 * fail loudly if a source reaches them anyway, then the source as written.
 */
export function wrapTransformSource(source: string): string {
  return [
    "var module = undefined, exports = undefined;",
    `function require() { throw new Error(${JSON.stringify(`require() is not available in a transform. ${NO_MODULES}`)}) }`,
    source,
  ].join("\n")
}
