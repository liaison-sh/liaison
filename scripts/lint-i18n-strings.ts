// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * CI lint check: detect hardcoded user-facing string literals in web view
 * code (kernel modules + in-process apps). Every user-facing string must
 * resolve through the i18n `t()` translator (Phase 13, I1; Acceptance: 0
 * violations).
 *
 * Heuristic AST-free scan: flags
 *   - JSX text nodes containing letters (outside `{...}` expressions)
 *   - string literals assigned to the user-facing attributes
 *     placeholder / title / aria-label / alt
 * Excludes: `data-testid`, class/style strings, import/specifier lines,
 * `t("…")` arguments, pure-symbol/numeric/whitespace text, and code comments
 * (including JSX expression comments holding only a block or line comment,
 * on one line or many).
 *
 * Exported `scanFile` / `scanSource` are unit-tested in
 * scripts/lint-i18n-strings.test.ts.
 */
import { Glob } from "bun"

export interface I18nViolation {
  file: string
  line: number
  text: string
}

const UI_ATTRS = ["placeholder", "title", "aria-label", "alt"] as const

// An attribute literal like:  placeholder="Search people"
const ATTR_RE = new RegExp(`\\b(${UI_ATTRS.join("|")})\\s*=\\s*"([^"]*[A-Za-z]{2,}[^"]*)"`, "g")

// JSX text node: ">  Some words  <" — letters present, not an expression.
const JSX_TEXT_RE = />([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g

// Lines that are TypeScript generic/type-annotation context, where the
// `>…<` regex would otherwise capture an inner type name (e.g.
// `Promise<void>`, `api.get<{ x: number }>()`, `Map<string, Foo>`).
// Deliberately narrow: a generic in TS is an identifier IMMEDIATELY
// followed by `<` (`Promise<`, `api.get<`, `Array<`) — JSX elements have
// whitespace/paren/`{`/`>`/start-of-line before `<` (`return <div>`,
// `<span>`), so this does not exclude component render lines.
const TS_CONTEXT_RE = /([A-Za-z_$][\w$]*<(?!\/)[^<>]*>|:\s*Promise\b)/

// A line that is a JS/TS expression or statement (NOT JSX markup) where the
// `>…<` regex would capture a comparison/logical expression
// (`if (status >= 400 && status < 500)`, `a > b && c < d`). JSX text lines
// never start with these keywords nor wrap a `>`/`<` numeric/logical compare.
const JS_EXPR_LINE_RE =
  /^\s*(if|while|for|return|const|let|var|else|switch|case|do)\b(?![^=]*=\s*[("'`]|\s+\w+\s*=>)/
// The captured "text" itself contains JS operators → it's an expression,
// not user copy (e.g. `= 400 && status `, `>= n ? a : b`).
const EXPR_TEXT_RE = /(&&|\|\||===|!==|>=|<=|\?\s|\bstatus\b\s*[<>]|=>|\breturn\b)/

function isLikelyCode(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  // No letters at all (pure punctuation/numbers) → not user copy.
  if (!/[A-Za-z]/.test(trimmed)) return true
  // Single token w/o spaces that looks like a code identifier / type / path
  // / dotted member / enum value — not a sentence.
  if (!/\s/.test(trimmed)) {
    // Dotted member access, contains a slash/paren/bracket → code.
    if (/[./()[\]<>|]/.test(trimmed)) return true
    // CamelCase/PascalCase or all-caps single identifier with no separators
    // is much more likely a type/value than user-visible copy. Genuine UI
    // single words ("Save", "Email") are still flagged because they're
    // capitalized-first lowercase-rest words; we only skip mixed-case ids
    // (fooBar / FooBar with an internal capital) and ALLCAPS.
    if (/^[A-Z][a-z0-9]*[A-Z]/.test(trimmed)) return true // PascalCase w/ internal cap
    if (/^[a-z]+[A-Z]/.test(trimmed)) return true // camelCase
    if (/^[A-Z0-9_]+$/.test(trimmed) && trimmed.length > 1) return true // ALLCAPS / CONST
    if (trimmed.length < 2) return true
  }
  return false
}

// A JSX expression holding only comments (block or line comments in braces),
// possibly spanning lines. Its words are notes for the reader, never rendered text.
// A block comment ends at its FIRST `*/` (no lazy `[\s\S]*?`, which could run on
// to a later comment and swallow the code between them).
const JSX_COMMENT_EXPR_RE = /\{(?:\s*(?:\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\n]*(?=\n)))+\s*\}/g

/** Empties every comment-only JSX expression, keeping its newlines so the
 *  reported line numbers stay those of the source. */
function stripJsxComments(content: string): string {
  return content.replace(JSX_COMMENT_EXPR_RE, (m) => `{${m.replace(/[^\n]/g, "")}}`)
}

export function scanSource(file: string, content: string): I18nViolation[] {
  const out: I18nViolation[] = []
  const lines = stripJsxComments(content).split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const trimmed = line.trim()
    // Skip imports, comments, testid/class attributes, and t() lines.
    if (
      trimmed.startsWith("import ") ||
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("/*")
    ) {
      continue
    }

    for (const m of line.matchAll(ATTR_RE)) {
      const text = m[2] ?? ""
      if (isLikelyCode(text)) continue
      out.push({ file, line: i + 1, text: text.trim() })
    }

    // JSX text only — skip lines that are TS type/generic context or JS
    // statement/expression lines (the `>…<` regex would otherwise capture
    // inner type names or comparison expressions like `a >= 1 && b < 2`).
    if (!TS_CONTEXT_RE.test(line) && !JS_EXPR_LINE_RE.test(line)) {
      for (const m of line.matchAll(JSX_TEXT_RE)) {
        const text = m[1] ?? ""
        // Inside a `{t(...)}` or other expression the regex won't match (it
        // excludes `{}`), so any letter run here is a literal node.
        if (isLikelyCode(text)) continue
        // The captured run itself contains JS operators → expression, not
        // user copy (defends against `>= 400 && status <`).
        if (EXPR_TEXT_RE.test(text)) continue
        out.push({ file, line: i + 1, text: text.trim() })
      }
    }

    // KNOWN GAP (P13-M2): multi-line JSX text (opening tag, prose, closing
    // tag on separate lines) and string
    // literals passed as component props / toast() / .ts store messages are
    // NOT caught by this heuristic scanner. A conservative regex for the
    // multi-line case produced ~292 false positives across apps/web; robustly
    // closing this needs a real JSX/TS AST pass (ts-morph/babel) — tracked as
    // a follow-up. This comment prevents the gap being mistaken for
    // "fully enforced".
  }
  return out
}

export async function scanFile(absPath: string, relPath: string): Promise<I18nViolation[]> {
  const content = await Bun.file(absPath).text()
  return scanSource(relPath, content)
}

export async function lintI18nStrings(webRoot: string): Promise<I18nViolation[]> {
  const violations: I18nViolation[] = []
  for await (const path of new Glob("src/**/*.tsx").scan(webRoot)) {
    if (path.endsWith(".test.tsx")) continue
    // Test fixtures (e2e harness apps and their stub UIs) never ship to a person.
    if (path.startsWith("src/tests/")) continue
    violations.push(...(await scanFile(`${webRoot}/${path}`, path)))
  }
  return violations
}

if (import.meta.main) {
  const webRoot = `${import.meta.dir}/../apps/web`
  const violations = await lintI18nStrings(webRoot)
  if (violations.length > 0) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}: hardcoded user-facing string: "${v.text}"`)
    }
    console.error(`\n${violations.length} hardcoded string(s) found. Wrap in t("<ns>.<key>").`)
    process.exit(1)
  }
  console.log("No hardcoded user-facing strings in apps/web view code.")
}
