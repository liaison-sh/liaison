// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Best-effort secret redaction for an imported session (S43, A48, A59).
 *
 * Every byte an import uploads (listing fields, replay, stream, subagent
 * events) passes `redactImportText` on the node, before stdout, so the run
 * outbox on disk is redacted too. The chain is the shared `redactSecrets`
 * followed by what an imported transcript adds: PEM private-key blocks,
 * assignments (`NAME=value`, `NAME: value`, anywhere on a line) and JSON keys
 * whose NAME contains a secret word, URL userinfo passwords and a few more
 * key prefixes.
 *
 * Linear time is a hard rule (A59): a transcript line is attacker-shaped
 * text. No pattern here backtracks; what a regex cannot do linearly is a hand
 * scanner that moves forward and never re-scans what it already passed.
 */

import { REDACTED, redactSecrets, SECRET_KEY } from "./threads/local-turn"

/** What a struck-out private-key block reads as. */
export const REDACTED_PRIVATE_KEY = "[redacted private key]"

/**
 * A NAME holding one of these words (upper-cased) is a secret's name (S43
 * "contains"; B2-2, D52 adds AUTH, DSN and CONN). `AUTHOR` alone is not AUTH.
 */
const SECRET_NAME_PARTS = [
  "SECRET",
  "TOKEN",
  "KEY",
  "PASSWORD",
  "PASS",
  "PWD",
  "CREDENTIAL",
  "AUTH",
  "DSN",
  "CONN",
]

/** How far a PEM header may run before its closing dashes, and how far its END may be. */
const PEM_HEADER_MAX = 64
const PEM_BODY_MAX = 65536
/** A JSON key longer than this is not read as a key. */
const JSON_NAME_MAX = 128
/** B2-2: an assignment's NAME is read back at most this far from its `=` or `:`, and blanks this far. */
const ASSIGN_NAME_MAX = 128
const ASSIGN_BLANKS_MAX = 16
/** B2-6: a quoted value runs past its line for at most this many characters, then only to its line's end. */
const QUOTED_VALUE_MAX = 8 * 1024
/** B2-6: a netrc `password` looks back this far for its `machine` or `login`; a pgpass field is at most this long. */
const NETRC_LOOKBACK = 256
const PGPASS_FIELD_MAX = 256
/** D49 F3: JSON inside a string is parsed this many levels deep, each string at most 1 MiB. */
const JSON_DEPTH_MAX = 3
const JSON_TEXT_MAX = 1024 * 1024
/** B2-4: an array or object under a secret-named JSON key is matched this far at most. */
const JSON_VALUE_MAX = 64 * 1024
/**
 * B2-4 (D52): the known usage counts. A number under one of these names is a
 * count, never a secret; any other value under a secret-named key is struck.
 */
const USAGE_COUNT_KEYS = new Set([
  "tokensIn",
  "tokensOut",
  "contextTokens",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "maxTokens",
  "max_tokens",
  "hardTokenLimit",
])
/** B2-5: a JWK's private members (RSA, EC and OKP's, and a symmetric key's `k`). */
const JWK_PRIVATE = new Set(["d", "p", "q", "dp", "dq", "qi", "oth", "k"])
/** B2-5: a PuTTY key's `Private-Lines` count is believed up to this many lines. */
const PPK_LINES_MAX = 4096
/** A URL scheme longer than this is not read as a scheme. */
const SCHEME_MAX = 32

/**
 * Key prefixes `redactSecrets` does not know. Each branch starts with a
 * literal and is followed by one class run, so a failed attempt costs a few
 * characters and a run is consumed once.
 */
const EXTRA_PREFIXES =
  /\b(?:[sr]k_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9+/=]{8,}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|xapp-[A-Za-z0-9-]{10,}|shp(?:at|ss)_[A-Za-z0-9]{16,}|dop_v1_[A-Za-z0-9]{16,}|pypi-AgE[A-Za-z0-9_-]{16,}|AGE-SECRET-KEY-1[0-9A-Z]{58})/g

function isSecretName(name: string): boolean {
  let upper = name.toUpperCase()
  // B2-2: `AUTHOR` is a name, not an AUTH word (AUTHORIZATION still is).
  for (let at = upper.indexOf("AUTHOR"); at !== -1; at = upper.indexOf("AUTHOR", at + 1)) {
    if (!upper.startsWith("AUTHORIZ", at)) upper = `${upper.slice(0, at)}-${upper.slice(at + 4)}`
  }
  return SECRET_NAME_PARTS.some((part) => upper.includes(part))
}

function isNameStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
}

function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 46 || c === 45
}

function isBlank(c: number): boolean {
  return c === 32 || c === 9
}

/** A value with its surrounding quotes kept, the inside struck out. */
function redactValue(value: string): string {
  if (value === "" || value === REDACTED) return value
  const q = value[0]
  if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) {
    return `${q}${REDACTED}${q}`
  }
  if (q === '"' || q === "'") return `${q}${REDACTED}`
  return REDACTED
}

/**
 * PEM private-key blocks, by scanner: a `-----BEGIN ` whose header ends
 * `PRIVATE KEY-----` (or PGP's `PRIVATE KEY BLOCK-----`, D49 F4) within 64
 * bytes, through its `-----END …-----` within 64 KiB, becomes one marker; no END → struck to the end of the string. The
 * scan resumes after the struck span, so repeated headers cost one pass.
 * Newlines are irrelevant, so a block inside a JSON string (`\n` escaped) is
 * caught whole.
 */
function redactPem(text: string): string {
  // B2-5: an SSH2 (SECSH, RFC 4716) block: `---- BEGIN … PRIVATE KEY ----`.
  return redactArmored(
    redactArmored(text, "-----BEGIN ", "-----END ", "-----"),
    "---- BEGIN ",
    "---- END ",
    " ----",
  )
}

/** One armour's private-key blocks (see redactPem). */
function redactArmored(text: string, BEGIN: string, END: string, DASHES: string): string {
  if (!text.includes(BEGIN)) return text
  let out = ""
  let from = 0
  let i = 0
  for (;;) {
    const b = text.indexOf(BEGIN, i)
    if (b === -1) break
    const hs = b + BEGIN.length
    const window = text.slice(hs, hs + PEM_HEADER_MAX + 5)
    const close = window.indexOf(DASHES)
    const header = close === -1 ? "" : window.slice(0, close)
    if (!header.endsWith("PRIVATE KEY") && !header.endsWith("PRIVATE KEY BLOCK")) {
      i = hs
      continue
    }
    const bodyStart = hs + close + DASHES.length
    const e = text.indexOf(END, bodyStart)
    out += text.slice(from, b) + REDACTED_PRIVATE_KEY
    if (e === -1 || e - bodyStart > PEM_BODY_MAX) {
      return out
    }
    const tail = text.slice(e + END.length, e + END.length + PEM_HEADER_MAX + 5).indexOf(DASHES)
    from = tail === -1 ? e + END.length : e + END.length + tail + DASHES.length
    i = from
  }
  return from === 0 ? text : out + text.slice(from)
}

/**
 * B2-2 (D52): ASSIGNMENTS, anywhere on a line and in any form: `NAME=value`
 * and `NAME: value` wherever NAME starts (`.env`, `export NAME=`, `- NAME=` of a
 * compose list, `ENV NAME=`, `docker run -e NAME=`, after `;`, after any tool
 * prefix: a Read line number, a Grep path with blanks or `-N-` in it, no
 * line number), plus a Dockerfile's `ENV NAME value`. A NAME containing a
 * secret word gets its value struck (quotes kept): a quoted value to its
 * closing quote, an unquoted one to the end of the line, a `;` or a `"`.
 *
 * One forward pass: each `=` and `:` reads its NAME back at most
 * `ASSIGN_NAME_MAX` characters (stopping at the first non-name character),
 * and a struck value is passed over, never scanned again. Not an assignment:
 * `==`, `=>`, `!=`, `<=`, `>=`, `::`, `:=`, `://`, a Grep `path:N:` prefix,
 * and a `file.ext:` path.
 */
function redactAssignments(text: string): string {
  const parts: string[] = []
  let from = 0
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text.charCodeAt(i)
    let span: Span | null = null
    if (c === 58) span = pgpassAt(text, i) ?? assignmentAt(text, i)
    else if (c === 61) span = assignmentAt(text, i)
    else if (c === 69) span = dockerEnvAt(text, i)
    else if (c === 80 && text.startsWith("Private-Lines:", i)) span = ppkLinesAt(text, i)
    else if (c === 112 || c === 80) span = netrcAt(text, i)
    if (!span) {
      i++
      continue
    }
    const value = text.slice(span.start, span.end)
    const struck = redactValue(value)
    if (struck !== value) {
      parts.push(text.slice(from, span.start), struck)
      from = span.end
    }
    i = Math.max(span.end, i + 1)
    // B2-6: a YAML block scalar (`password: |`) under a secret key: the lines
    // indented deeper than the key are its value. B2-5: a PuTTY key's next
    // `Private-Lines` lines are.
    if (span.blockIndent !== undefined || span.lines !== undefined) {
      const lines =
        span.lines !== undefined
          ? nextLines(text, i, span.lines)
          : blockLines(text, i, span.blockIndent as number)
      for (const line of lines) {
        const v = text.slice(line.start, line.end)
        if (v !== REDACTED) {
          parts.push(text.slice(from, line.start), REDACTED)
          from = line.end
        }
        i = line.end
      }
    }
  }
  if (from === 0) return text
  parts.push(text.slice(from))
  return parts.join("")
}

/** A value's span; `blockIndent` when it is a YAML block indicator under a key indented that much. */
interface Span {
  start: number
  end: number
  blockIndent?: number
  /** B2-5: this many lines after the span are its value. */
  lines?: number
}

/**
 * B2-5: a PuTTY `.ppk` file's `Private-Lines: N` at `i`: the N lines after
 * it hold the private key (the short last one escapes every opaque-run rule).
 */
function ppkLinesAt(text: string, i: number): Span | null {
  if (i > 0 && isNameChar(text.charCodeAt(i - 1))) return null
  let p = i + "Private-Lines:".length
  while (p < text.length && isBlank(text.charCodeAt(p))) p++
  let count = 0
  const digits = p
  while (p < text.length && p - digits < 5 && isDigit(text.charCodeAt(p))) {
    count = count * 10 + (text.charCodeAt(p) - 48)
    p++
  }
  if (p === digits || count === 0) return null
  return { start: p, end: p, lines: Math.min(count, PPK_LINES_MAX) }
}

/** B2-5: the content spans of the `count` lines after `from`'s line, Read prefixes passed. */
function* nextLines(text: string, from: number, count: number): Generator<Span> {
  let start = text.indexOf("\n", from)
  for (let k = 0; k < count && start !== -1; k++) {
    start++
    const { at } = lineContent(text, start)
    let end = at
    while (end < text.length && text.charCodeAt(end) !== 10) end++
    const nl = end
    if (end > at && text.charCodeAt(end - 1) === 13) end--
    if (end > at) yield { start: at, end }
    start = nl < text.length ? nl : -1
  }
}

/** `|` or `>`, then an optional chomping `-`/`+` and indentation digit: a YAML block scalar's indicator. */
function isBlockIndicator(value: string): boolean {
  const c = value.charCodeAt(0)
  if (c !== 124 && c !== 62) return false
  let k = 1
  if (value.charCodeAt(k) === 45 || value.charCodeAt(k) === 43) k++
  if (isDigit(value.charCodeAt(k))) k++
  return k === value.length
}

/**
 * Where a line's content starts and how deeply it is indented: past a Read
 * prefix (`   12\t`, `   12→`) when there is one, then past its blanks.
 */
function lineContent(text: string, start: number): { at: number; indent: number } {
  let p = start
  while (p < text.length && isBlank(text.charCodeAt(p))) p++
  let d = p
  while (d < text.length && d - p <= 12 && isDigit(text.charCodeAt(d))) d++
  const after = text.charCodeAt(d)
  const base = d > p && (after === 9 || after === 0x2192) ? d + 1 : start
  let q = base
  while (q < text.length && isBlank(text.charCodeAt(q))) q++
  return { at: q, indent: q - base }
}

/**
 * B2-6: the lines after `from` (the block indicator's line end) indented
 * deeper than `keyIndent`, each as its content's span; blank lines inside
 * pass, the first shallower line ends the block. Each line is read once.
 */
function* blockLines(text: string, from: number, keyIndent: number): Generator<Span> {
  let start = text.indexOf("\n", from)
  while (start !== -1) {
    start++
    const { at, indent } = lineContent(text, start)
    let end = at
    while (end < text.length && text.charCodeAt(end) !== 10) end++
    const nl = end
    if (end > at && text.charCodeAt(end - 1) === 13) end--
    if (end > at) {
      if (indent <= keyIndent) return
      yield { start: at, end }
    }
    if (nl >= text.length) return
    start = nl
  }
}

/** The blanks right before `nameStart`, back to the line's content start: the key's indentation. */
function keyIndentAt(text: string, nameStart: number): number | undefined {
  let lineStart = nameStart
  while (
    lineStart > 0 &&
    nameStart - lineStart <= NETRC_LOOKBACK &&
    text.charCodeAt(lineStart - 1) !== 10
  ) {
    lineStart--
  }
  const { at, indent } = lineContent(text, lineStart)
  return at === nameStart ? indent : undefined
}

/**
 * B2-6: a netrc `password` at `i` (`machine h login u password X`, or
 * `password X` opening its own line): the token after it. Only when a
 * `machine` or `login` word precedes it on its line (within 256 characters)
 * or it is the line's first word, so prose that says "password" is left.
 */
function netrcAt(text: string, i: number): Span | null {
  if (text.slice(i, i + 8).toLowerCase() !== "password") return null
  if (i > 0 && isNameChar(text.charCodeAt(i - 1))) return null
  let p = i + 8
  if (!isBlank(text.charCodeAt(p))) return null
  while (p < text.length && isBlank(text.charCodeAt(p))) p++
  const first = text.charCodeAt(p)
  if (p >= text.length || first === 10 || first === 13 || first === 61 || first === 58) return null
  let lineStart = i
  while (
    lineStart > 0 &&
    i - lineStart <= NETRC_LOOKBACK &&
    text.charCodeAt(lineStart - 1) !== 10
  ) {
    lineStart--
  }
  const before = text.slice(lineStart, i).toLowerCase()
  const netrc =
    lineContent(text, lineStart).at === i || /\b(?:machine|login|default)\s/.test(before)
  if (!netrc) return null
  let e = p
  while (e < text.length && !isSpace(text.charCodeAt(e))) e++
  return { start: p, end: e }
}

/**
 * B2-6: a `.pgpass` line, `host:port:database:user:password`, whose first
 * `:` is at `c`: the password, to the line's end. The port is digits or `*`;
 * the other fields hold no blank and no `:`, each at most 256 characters.
 */
function pgpassAt(text: string, c: number): Span | null {
  // host: back over host characters to a blank, a tab or the line's start.
  let h = c
  while (h > 0 && c - h <= PGPASS_FIELD_MAX) {
    const ch = text.charCodeAt(h - 1)
    if (!(isNameChar(ch) || ch === 42)) break
    h--
  }
  if (h === c || c - h > PGPASS_FIELD_MAX) return null
  if (h > 0 && !isSpace(text.charCodeAt(h - 1)) && text.charCodeAt(h - 1) !== 0x2192) return null
  let p = c + 1
  const field = (digitsOnly: boolean): boolean => {
    const s0 = p
    while (p < text.length && p - s0 <= PGPASS_FIELD_MAX) {
      const ch = text.charCodeAt(p)
      if (ch === 58 || isSpace(ch)) break
      if (digitsOnly && !isDigit(ch) && ch !== 42) return false
      p++
    }
    if (p === s0 || text.charCodeAt(p) !== 58) return false
    p++
    return true
  }
  if (!field(true) || !field(false) || !field(false)) return null
  let e = p
  while (e < text.length && text.charCodeAt(e) !== 10) e++
  if (e > p && text.charCodeAt(e - 1) === 13) e--
  return e > p ? { start: p, end: e } : null
}

/** Is `c` an operator character that, just before an `=`, makes it a comparison or an update? */
function isOperatorBefore(c: number): boolean {
  // = ! < > + - * / % & | ^ ~ ? :
  return (
    c === 61 ||
    c === 33 ||
    c === 60 ||
    c === 62 ||
    c === 43 ||
    c === 42 ||
    c === 47 ||
    c === 37 ||
    c === 38 ||
    c === 124 ||
    c === 94 ||
    c === 126 ||
    c === 63 ||
    c === 58
  )
}

/** A `file.ext` token (a Grep path's last part before its `:`), never a key. */
function looksLikeFileName(token: string): boolean {
  const dot = token.lastIndexOf(".")
  if (dot <= 0 || token.length - dot - 1 < 1 || token.length - dot - 1 > 5) return false
  for (let k = dot + 1; k < token.length; k++) {
    const ch = token.charCodeAt(k)
    if (!((ch >= 97 && ch <= 122) || isDigit(ch))) return false
  }
  return true
}

/** The secret-named assignment whose `=` or `:` is at `sep`: its value's span, else null. */
function assignmentAt(text: string, sep: number): Span | null {
  const sc = text.charCodeAt(sep)
  const next = text.charCodeAt(sep + 1)
  const prev = sep > 0 ? text.charCodeAt(sep - 1) : -1
  if (sc === 61) {
    if (next === 61 || next === 62 || (prev !== -1 && isOperatorBefore(prev))) return null
  } else {
    if (next === 58 || next === 61 || prev === 58) return null
    if (next === 47 && text.charCodeAt(sep + 2) === 47) return null
    // A Grep `path:N:` or `path:N-` prefix: the number is a line number.
    let d = sep + 1
    while (d < text.length && d - sep <= 12 && isDigit(text.charCodeAt(d))) d++
    if (d > sep + 1 && (text.charCodeAt(d) === 58 || text.charCodeAt(d) === 45)) return null
  }
  // The NAME: back over at most a few blanks, then over name characters.
  let q = sep
  while (q > 0 && sep - q < ASSIGN_BLANKS_MAX && isBlank(text.charCodeAt(q - 1))) q--
  const nameEnd = q
  while (q > 0 && nameEnd - q <= ASSIGN_NAME_MAX && isNameChar(text.charCodeAt(q - 1))) q--
  if (q === nameEnd || nameEnd - q > ASSIGN_NAME_MAX) return null
  const name = text.slice(q, nameEnd)
  if (sc === 58 && looksLikeFileName(name)) return null
  if (!isSecretName(name)) return null
  const span = valueSpan(text, sep + 1, q > 0 ? text.charCodeAt(q - 1) : -1)
  if (span && sc === 58 && isBlockIndicator(text.slice(span.start, span.end))) {
    const indent = keyIndentAt(text, q)
    // The indicator itself stays: the block's lines are the value.
    return indent === undefined ? null : { start: span.end, end: span.end, blockIndent: indent }
  }
  return span
}

/**
 * A Dockerfile's legacy `ENV NAME value` (no `=`) at `i`: the value's span
 * when NAME is secret-named, else null (the `ENV NAME=value` form is an
 * ordinary assignment).
 */
function dockerEnvAt(text: string, i: number): Span | null {
  if (!text.startsWith("ENV", i)) return null
  if (i > 0 && isNameChar(text.charCodeAt(i - 1))) return null
  let q = i + 3
  if (!isBlank(text.charCodeAt(q))) return null
  while (q < text.length && q - i < ASSIGN_BLANKS_MAX && isBlank(text.charCodeAt(q))) q++
  const nameStart = q
  const nameEnd = readName(text, q, Math.min(text.length, q + ASSIGN_NAME_MAX + 1))
  if (nameEnd === nameStart || nameEnd - nameStart > ASSIGN_NAME_MAX) return null
  if (!isBlank(text.charCodeAt(nameEnd))) return null
  if (!isSecretName(text.slice(nameStart, nameEnd))) return null
  return valueSpan(text, nameEnd, -1)
}

/**
 * The value that starts after blanks at `p`, on the same line: quoted, to
 * its closing quote (none on the line: to the line's end); unquoted, to the
 * line's end, a `;`, or a `"` (a `'` too when the NAME was opened by one). A
 * trailing CR stays out. Null when the line holds no value.
 */
function valueSpan(text: string, p: number, opener: number): Span | null {
  // Forward only, never past the line: a value is scanned once, as far as it goes.
  const n = text.length
  while (p < n && isBlank(text.charCodeAt(p))) p++
  const lineEnd = (e: number) => (e > p && text.charCodeAt(e - 1) === 13 ? e - 1 : e)
  if (p >= n || text.charCodeAt(p) === 10 || lineEnd(p + 1) === p) return null
  const q = text.charCodeAt(p)
  if (q === 34 || q === 39) {
    // B2-6: a quoted value may run past its line (a multi-line `.env`
    // value), for at most QUOTED_VALUE_MAX; unclosed by then, only its own
    // line is struck.
    let e = p + 1
    let firstNl = -1
    const limit = Math.min(n, p + QUOTED_VALUE_MAX)
    while (e < limit) {
      const ch = text.charCodeAt(e)
      if (ch === 10 && firstNl === -1) firstNl = e
      if (ch === q) return { start: p, end: e + 1 }
      e += ch === 92 && q === 34 ? 2 : 1
    }
    return { start: p, end: lineEnd(firstNl === -1 ? Math.min(e, n) : firstNl) }
  }
  // B2-4: an array or an object (code, a YAML flow value) to its matching
  // bracket, across lines; none within JSON_VALUE_MAX: struck that far, so
  // the scan resumes past it and never matches the same stretch twice.
  if (q === 91 || q === 123) {
    const close = bracketEnd(text, p)
    return { start: p, end: close === -1 ? Math.min(n, p + JSON_VALUE_MAX) : close }
  }
  let e = p
  while (e < n) {
    const ch = text.charCodeAt(e)
    if (ch === 10 || ch === 59 || ch === 34 || (ch === 39 && opener === 39)) break
    e++
  }
  if (e === n || text.charCodeAt(e) === 10) e = lineEnd(e)
  // An escaped quote (`\"` in JSON text) closes the string: its backslash stays.
  else if (text.charCodeAt(e) === 34 && e > p && text.charCodeAt(e - 1) === 92) e--
  return e > p ? { start: p, end: e } : null
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57
}

/** The end of a NAME `[A-Za-z_][A-Za-z0-9_.-]*` starting at `p`, or `p` if none. */
function readName(text: string, p: number, limit: number): number {
  if (p >= limit || !isNameStart(text.charCodeAt(p))) return p
  let q = p + 1
  while (q < limit && isNameChar(text.charCodeAt(q))) q++
  return q
}

/**
 * JSON-style keys, by scanner: `"NAME"[ \t]*:[ \t]*value` with NAME at most
 * 128 characters and no quote or newline; a NAME containing a secret word
 * gets its value struck. A string value ends at its closing unescaped quote,
 * or at the end of the line when it has none. B2-4 (D52): an array, an object
 * (to its matching bracket, across lines, at most 64 KiB) or a number (unless
 * a known usage count) becomes the string `"[redacted]"`, so JSON text stays
 * JSON for the structural pass (D49 F3). A key opened by an escaped quote
 * (`\"NAME\"`, JSON inside a string) is left to that structural pass.
 */
function redactJsonKeys(text: string): string {
  // B2-5: a JWK's private members, when the text holds a JWK.
  const jwk = text.includes('"kty"')
  const secret = (name: string) => isSecretName(name) || (jwk && JWK_PRIVATE.has(name))
  const parts: string[] = []
  let from = 0
  let i = 0
  for (;;) {
    const open = text.indexOf('"', i)
    if (open === -1) break
    i = open + 1
    let close = -1
    const nameLimit = Math.min(text.length, open + 1 + JSON_NAME_MAX + 1)
    for (let p = open + 1; p < nameLimit; p++) {
      const c = text.charCodeAt(p)
      if (c === 34) {
        close = p
        break
      }
      if (c === 10) break
    }
    if (close <= open + 1) continue
    let q = close + 1
    while (q < text.length && isBlank(text.charCodeAt(q))) q++
    if (text.charCodeAt(q) !== 58) continue
    q++
    while (q < text.length && isBlank(text.charCodeAt(q))) q++
    const first = text.charCodeAt(q)
    if (first !== 34) {
      const name = text.slice(open + 1, close)
      if (open > 0 && text.charCodeAt(open - 1) === 92) continue
      if (!secret(name)) continue
      let end = -1
      if (first === 91 || first === 123) {
        end = bracketEnd(text, q)
      } else if (isDigit(first) || first === 45) {
        end = q + 1
        while (end < text.length && isNumberChar(text.charCodeAt(end))) end++
        if (USAGE_COUNT_KEYS.has(name)) end = -2
      } else continue
      if (end === -2) {
        i = q + 1
        continue
      }
      const valueEnd = end === -1 ? Math.min(text.length, q + JSON_VALUE_MAX) : end
      parts.push(text.slice(from, q), `"${REDACTED}"`)
      from = valueEnd
      i = valueEnd
      continue
    }
    if (!secret(text.slice(open + 1, close))) continue
    const valueStart = q + 1
    let p = valueStart
    while (p < text.length) {
      const c = text.charCodeAt(p)
      if (c === 34 || c === 10) break
      p += c === 92 ? 2 : 1
    }
    const valueEnd = Math.min(p, text.length)
    if (text.slice(valueStart, valueEnd) !== REDACTED) {
      parts.push(text.slice(from, valueStart), REDACTED)
      from = valueEnd
    }
    i = valueEnd
  }
  if (from === 0) return text
  parts.push(text.slice(from))
  return parts.join("")
}

function isNumberChar(c: number): boolean {
  // 0-9 . e E + -
  return isDigit(c) || c === 46 || c === 101 || c === 69 || c === 43 || c === 45
}

/**
 * B2-4: the index just past the `]` or `}` that closes the one at `open`,
 * strings skipped; -1 when none does within JSON_VALUE_MAX.
 */
function bracketEnd(text: string, open: number): number {
  let depth = 0
  const limit = Math.min(text.length, open + JSON_VALUE_MAX)
  for (let p = open; p < limit; p++) {
    const c = text.charCodeAt(p)
    if (c === 34) {
      for (p++; p < limit; p++) {
        const d = text.charCodeAt(p)
        if (d === 92) p++
        else if (d === 34 || d === 10) break
      }
      continue
    }
    if (c === 91 || c === 123) depth++
    else if (c === 93 || c === 125) {
      depth--
      if (depth === 0) return p + 1
    }
  }
  return -1
}

function isSchemeChar(c: number): boolean {
  return (
    (c >= 97 && c <= 122) ||
    (c >= 65 && c <= 90) ||
    (c >= 48 && c <= 57) ||
    c === 43 ||
    c === 46 ||
    c === 45
  )
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11
}

/**
 * URL userinfo passwords, by scanner: `scheme://user:password@` keeps the
 * user and the host and strikes the password. Every scan stops at a `/`, so
 * it never runs past the next `://`.
 */
function redactUserinfo(text: string): string {
  let out = ""
  let from = 0
  let i = 0
  for (;;) {
    const sep = text.indexOf("://", i)
    if (sep === -1) break
    i = sep + 3
    let s = sep
    while (s > 0 && sep - s < SCHEME_MAX && isSchemeChar(text.charCodeAt(s - 1))) s--
    while (s < sep && !isNameStart(text.charCodeAt(s))) s++
    if (s === sep) continue
    let p = sep + 3
    while (p < text.length) {
      const c = text.charCodeAt(p)
      if (c === 47 || c === 58 || c === 64 || isSpace(c)) break
      p++
    }
    if (p === sep + 3 || text.charCodeAt(p) !== 58) continue
    const pwStart = p + 1
    let q = pwStart
    while (q < text.length) {
      const c = text.charCodeAt(q)
      if (c === 64 || c === 47 || isSpace(c)) break
      q++
    }
    if (q === pwStart || text.charCodeAt(q) !== 64) continue
    if (text.slice(pwStart, q) !== REDACTED) {
      out += text.slice(from, pwStart) + REDACTED
      from = q
    }
    i = q
  }
  return from === 0 ? text : out + text.slice(from)
}

/** The text scanners, in order, on one string. */
function redactTextOnly(text: string): string {
  let out = redactSecrets(text)
  out = redactPem(out)
  out = redactAssignments(out)
  out = redactJsonKeys(out)
  out = redactUserinfo(out)
  out = out.replace(EXTRA_PREFIXES, REDACTED)
  return out
}

/** Strikes out every credential shaped run an imported transcript may carry. */
export function redactImportText(text: string): string {
  return redactText(text, 0)
}

/**
 * The text scanners, then (D49 F3) a string that is JSON, as an MCP result
 * often is (`{"result":"{\"password\":\"x\"}"}`), is parsed and redacted
 * structurally too, its own strings included: at most `JSON_DEPTH_MAX` levels
 * of strings in strings and `JSON_TEXT_MAX` characters each, so the work stays
 * a small multiple of the input. Re-serialised only when that struck
 * something; otherwise the text is left exactly as the scanners left it.
 */
function redactText(text: string, depth: number): string {
  const out = redactTextOnly(text)
  if (depth >= JSON_DEPTH_MAX || out.length > JSON_TEXT_MAX || !looksLikeJson(out)) return out
  let parsed: unknown
  try {
    parsed = JSON.parse(out)
  } catch {
    return out
  }
  if (!parsed || typeof parsed !== "object") return out
  const struck = redactValueDeep(parsed, depth + 1)
  const before = JSON.stringify(parsed)
  const after = JSON.stringify(struck)
  if (after === before) return out
  return out.includes("\n") ? JSON.stringify(struck, null, 2) : after
}

/** Its first non-blank character opens a JSON object or array. */
function looksLikeJson(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (isSpace(c)) continue
    return c === 123 || c === 91
  }
  return false
}

function redactValueDeep(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value, depth)
  if (Array.isArray(value)) return value.map((v) => redactValueDeep(v, depth))
  if (value && typeof value === "object")
    return redactObject(value as Record<string, unknown>, depth)
  return value
}

/**
 * D49 F2: a key that names a secret strikes its value, as a local turn's
 * `redactArgs` does: any value under one of its names (`password`, `api_key`,
 * `authorization`, `…token`, `…secret`, `credentials`...). B2-4 (D52): so does
 * a NAME containing an S43 word (`DB_PASSWORD`, `apiKeys`, `privateKey`), for
 * a string, a number, an array or an object alike; only a number under a
 * known usage count (`tokensIn` and its kin) stays, and a boolean.
 */
function strikesValue(key: string, value: unknown): boolean {
  if (value === null || value === undefined || value === REDACTED) return false
  if (SECRET_KEY.test(key)) return true
  if (!isSecretName(key) || typeof value === "boolean") return false
  return typeof value !== "number" || !USAGE_COUNT_KEYS.has(key)
}

/** Keys pass the redactor too; two keys that redact alike stay apart as ` [2]`, ` [3]`. */
function redactObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // B2-5: a JWK (an object with a string `kty`) loses its private members.
  const jwk = typeof value.kty === "string"
  for (const [k, v] of Object.entries(value)) {
    let key = redactTextOnly(k)
    if (Object.hasOwn(out, key)) {
      let n = 2
      while (Object.hasOwn(out, `${key} [${n}]`)) n++
      key = `${key} [${n}]`
    }
    const jwkPrivate = jwk && JWK_PRIVATE.has(k) && v !== REDACTED
    out[key] = jwkPrivate || strikesValue(k, v) ? REDACTED : redactValueDeep(v, depth)
  }
  return out
}

/**
 * The event with every string of its payload and every object key redacted.
 * Returns a new event; idempotent. Runs before `capEvent` (a cap can cut a key
 * in half and leave its prefix unrecognisable).
 */
export function redactImportEvent<E extends { payload: Record<string, unknown> }>(e: E): E {
  return { ...e, payload: redactObject(e.payload, 0) }
}
