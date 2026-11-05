// SPDX-License-Identifier: FSL-1.1-ALv2
//
// FINDING A PATH ON THE USER'S COMPUTER IN AN AGENT'S TEXT.
//
// In the desktop app a local session writes files, and its answer names them:
// "saved to C:\Users\someone\Documents\Reports\Hub X\report-2026-08.pdf". The
// thread turns such a path into a link the shell opens (the shell, not this
// file, decides what a click may do: it never runs a program). This file only
// answers "is this a path, and which one", for two kinds of text:
//
//   - DELIMITED text (inline code, a one line code block, a markdown link's
//     target, a quoted run): the whole of it is the candidate, so spaces are
//     fine, and a relative path counts when the session's folder is known.
//   - BARE prose: a path has to be recognised inside a sentence, so it is
//     stricter. It drops the punctuation that ends a sentence, and refuses
//     the look alikes: the path part of a URL, a fraction, a date, "and/or",
//     a slash command, a lone "/". It links only a path that ENDS in a file
//     extension or a separator.
//     A path under a user's own files (`C:\`, `~/`, `/Users/`, `/home/`,
//     `/Volumes/`) may hold single spaces anywhere, file name included
//     (`.../2026.06_Hub X - Monthly review.pdf`): it ends at the FIRST file
//     extension (or trailing separator) that is followed by the end of the
//     line, sentence punctuation, a closing quote, or a space and a word that
//     cannot continue a path (no separator, no extension of its own). Any
//     other path stops at whitespace, and is never linked when the next word
//     could be the rest of it: when in doubt it stays text (an agent that
//     writes the path in backticks gets its link).
//
// NETWORK PATHS ARE NEVER LINKS (`\\host\share`, `//host/...`,
// `file://host/...`): on Windows even checking whether one exists connects to
// the host and hands it the user's NTLM hash. The shell refuses them too; the
// page does not invite the click.
//
// Pure string work, no DOM, so every rule is a table row in the test.

/** Characters Windows forbids in a path component (the drive colon aside). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a path may not hold
const WINDOWS_FORBIDDEN = /[<>:"|?*\u0000-\u001f]/

/**
 * Where a bare path under a user's own files starts: a drive, `~/`, or a
 * macOS or Linux home or volume folder.
 */
const BARE_USER_ROOT_RE = /[A-Za-z]:[\\/]|~[\\/]|\/(?:Users|home|Volumes)\//g

/** What a Windows path may hold in bare text, separators included. */
const WINDOWS_PATH_CHAR = /[^:*?"<>|\s]/

/** What a macOS, Linux or `~/` path may hold in bare text, separators included. */
const POSIX_PATH_CHAR = /[^\s<>"'`|]/

/**
 * Where a user's own files live: a path that starts here may name a folder
 * with a space in it, in code or quotes, and end without an extension.
 */
const USER_ROOT_RE = /^(?:[A-Za-z]:[\\/]|~[\\/]|\/(?:Users|home|Volumes)\/)/

/** `/a/b...` in bare text: at least one folder and no whitespace. */
const BARE_POSIX_RE = /\/(?:[^\s/<>"'`|]+\/)+[^\s/<>"'`|]*/g

/** `file://...` in bare text. */
const BARE_FILE_URL_RE = /file:\/\/[^\s<>"'`]+/gi

/** A quoted run whose inside may be a path with spaces in it. */
const QUOTED_RE = /(["“«'<])([^"“”«»'<>\n]{3,}?)(["”»'>])/g
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "“": "”", "«": "»", "'": "'", "<": ">" }

/**
 * The top level folders a bare POSIX path may start from when its last part
 * has no extension. Bare text is full of slashes that are not paths
 * (`/api/v2/users`, `/help`), so a POSIX path in prose has to either start
 * somewhere a file lives or end in a file name.
 */
const POSIX_ROOTS = new Set([
  "Users",
  "home",
  "tmp",
  "private",
  "var",
  "Volumes",
  "mnt",
  "media",
  "opt",
  "srv",
  "root",
  "etc",
  "usr",
  "Applications",
  "Library",
  "System",
  "run",
])

/** A file name extension with at least one letter in it (`.pdf`, `.mp4`, not `.5`). */
const EXTENSION_RE = /\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/

/** The punctuation a sentence puts after a path, which is not part of it. */
const TRAILING_PUNCTUATION = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  ")",
  "]",
  "}",
  "'",
  '"',
  "»",
  "”",
  "’",
  "…",
])

/** One path found in bare text: where it is, and what to ask the shell to open. */
export interface LocalPathMatch {
  start: number
  end: number
  /** The text as written, which is what the link shows. */
  text: string
  /** What the shell is asked to open. */
  target: string
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char)
}

/**
 * Whether a path ends where a path plausibly ends: in a file extension on its
 * last part, or in a separator (a folder).
 */
function endsLikeAPath(path: string): boolean {
  if (/[\\/]$/.test(path)) return true
  const last = path.split(/[\\/]/).pop() ?? ""
  return EXTENSION_RE.test(last)
}

/**
 * A POSIX path worth a link: under a folder files live in, or ending in a file
 * name. `/api/v1/threads` is a route, not a file.
 */
function plausiblePosix(path: string): boolean {
  const parts = posixComponents(path)
  if (!parts) return false
  return (
    POSIX_ROOTS.has(parts[0]) || (!path.endsWith("/") && EXTENSION_RE.test(parts[parts.length - 1]))
  )
}

/** A POSIX path with at least two components, none of them empty. */
function posixComponents(path: string): string[] | null {
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path
  const parts = trimmed.split("/").slice(1)
  if (parts.length < 2 || parts.some((part) => part.length === 0 || part.trim() !== part)) {
    return null
  }
  return parts
}

/**
 * Whether a path reaches past this machine, in any spelling the shell would
 * also refuse: two leading separators (`\\host`, `//host`, `/\host`), a
 * home path that turns into one (`~///host`), a `file:` URL with a host, or
 * one whose path decodes to a network path (`file:///%5C%5Chost`).
 */
function isNetworkLike(text: string): boolean {
  if (/^[\\/][\\/]/.test(text) || /^~[\\/][\\/]/.test(text)) return true
  if (!/^file:/i.test(text)) return false
  const rest = text.replace(/^file:\/\/(?:localhost(?=[\\/]))?/i, "")
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return true
  }
  return !/^[\\/]/.test(decoded) || /^[\\/][\\/]/.test(decoded)
}

/**
 * Whether the whole of a DELIMITED text is an absolute local path, answering
 * the text itself (which is what the shell resolves) or null.
 */
function absolutePath(text: string): string | null {
  // Never a network or device path, in any spelling.
  if (isNetworkLike(text)) return null
  if (/^file:/i.test(text)) {
    // No host, or `localhost`, and then one separator: `file:///...`.
    return /^file:\/\/(?:localhost)?\/(?![\\/])[^<>"\n]+$/i.test(text) ? text : null
  }
  if (/^[A-Za-z]:[\\/]/.test(text)) {
    return WINDOWS_FORBIDDEN.test(text.slice(2)) ? null : text
  }
  if (/^~[\\/]\S/.test(text)) return text
  if (text.startsWith("/")) return plausiblePosix(text) ? text : null
  return null
}

/**
 * Whether a DELIMITED text is a relative path worth resolving: `./x`, `../x`,
 * or folders and a file name (`Reports/report.pdf`). A bare name is not
 * enough: `package.json` in a sentence is a word as often as it is a file.
 */
function isRelativePath(text: string): boolean {
  if (/^\.{1,2}[\\/][^\\/\s]/.test(text)) return !WINDOWS_FORBIDDEN.test(text)
  if (/^[\\/~@]/.test(text) || text.includes("://") || WINDOWS_FORBIDDEN.test(text)) return false
  const parts = text.split(/[\\/]/)
  if (parts.length < 2 || parts.some((part) => part.length === 0 || part.trim() !== part)) {
    return false
  }
  return EXTENSION_RE.test(parts[parts.length - 1])
}

/**
 * A relative path joined to the session folder, with that folder's own
 * separator. `..` is left for the shell to resolve.
 */
export function joinLocalPath(base: string, relative: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(base) || (base.includes("\\") && !base.includes("/"))
  const separator = windows ? "\\" : "/"
  let rest = relative
  while (/^\.[\\/]/.test(rest)) rest = rest.slice(2)
  if (windows) rest = rest.replace(/\//g, "\\")
  const root = base.replace(/[\\/]+$/, "")
  return `${root}${separator}${rest}`
}

/**
 * THE PATH A DELIMITED TEXT NAMES (inline code, a code block's only line, a
 * link target, a quoted run), or null. `base` is the session folder, when this
 * conversation's session has one: a relative path resolves against it and is
 * text otherwise.
 */
export function delimitedLocalPath(raw: string, base?: string | null): string | null {
  let text = raw.trim()
  // Quoted INSIDE the code (`"/Users/x/Hub X"`): the quotes say where the
  // path ends, so a space in it is part of it.
  const quoted = /^(["'])(.+)\1$/.exec(text)
  if (quoted) text = quoted[2].trim()
  if (text.length < 3 || text.includes("\n")) return null
  // Unquoted and with a space: a path under a user's own files (a drive,
  // `~/`, `/Users/`, `/home/`, `/Volumes/`) may be a folder with a space in
  // it. Anything else has to end like a path, and nothing that passes a flag
  // is one: `/usr/bin/env node`, `C:\tools\run --fast` are command lines.
  if (!quoted && /\s/.test(text)) {
    if (/\s-/.test(text)) return null
    if (!USER_ROOT_RE.test(text) && !endsLikeAPath(text)) return null
  }
  const absolute = absolutePath(text)
  if (absolute) return absolute
  if (base && isRelativePath(text)) return joinLocalPath(base, text)
  return null
}

/**
 * The target of a markdown link, when it is a local path. Marked hands the
 * href URI encoded (`Hub%20X`), so everything but a `file://` URL (which the
 * shell decodes itself) is decoded first.
 */
export function localPathFromHref(href: string, base?: string | null): string | null {
  if (/^file:\/\//i.test(href)) return delimitedLocalPath(href, base)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href) || /^(?:mailto|tel|data|javascript):/i.test(href)) {
    return null
  }
  let decoded = href
  try {
    decoded = decodeURI(href)
  } catch {
    return null
  }
  return delimitedLocalPath(decoded, base)
}

/** Drops the sentence punctuation after a bare path, keeping a balanced `)`. */
function trimTrailing(text: string): string {
  let out = text
  while (out.length > 0) {
    const last = out[out.length - 1]
    if (!TRAILING_PUNCTUATION.has(last)) break
    if (last === ")") {
      const open = out.split("(").length - 1
      const close = out.split(")").length - 1
      if (close <= open) break
    }
    out = out.slice(0, -1)
  }
  return out
}

/**
 * Whether the words right after a bare match look like the rest of a longer
 * path with a space in it (`report final.pdf`, `a b.pdf`, `X\report.pdf`).
 * Then the match is a strict prefix of what the agent meant, and a link to it
 * would open something else.
 */
function continuesAsAPath(after: string): boolean {
  const next = /^ (\S+)/.exec(after)
  if (!next) return false
  const word = trimTrailing(next[1])
  // A word that STARTS a path is the next path, not the rest of this one.
  if (startsAPath(word)) return false
  return /[\\/]/.test(word) || EXTENSION_RE.test(word)
}

/**
 * A bare path under a user's own files, from `start` (where its root is) to
 * where it ends, as written, or null. Words joined by single spaces belong to
 * it, in a folder or in the file name, until the first file extension (or a
 * trailing separator) after which the path cannot go on: the end of the line,
 * a character a path does not hold here, sentence punctuation, or a space and
 * a word that is not the rest of a path. `.../Hub X/report 2026-08.pdf and
 * emailed it` ends at `.pdf`; `.../Node.js Projects/a.txt` does not end at
 * `Node.js`, because `Projects/a.txt` continues it.
 */
function scanUserRootPath(text: string, start: number, rootLength: number): string | null {
  const pathChar = /^[A-Za-z]:/.test(text.slice(start, start + 2))
    ? WINDOWS_PATH_CHAR
    : POSIX_PATH_CHAR
  let index = start + rootLength
  while (true) {
    while (index < text.length && pathChar.test(text[index])) index++
    const raw = text.slice(start, index)
    const written = trimTrailing(raw)
    // A folder ends at its separator; a component never starts with a space.
    if (/[\\/]$/.test(written)) return written
    const last = written.split(/[\\/]/).pop() ?? ""
    const isFile = EXTENSION_RE.test(last)
    // Anything but one space and a word ends it here: the end of the line or
    // of the text, a second space, a character no path holds here, or the
    // punctuation that closes a sentence.
    const oneSpaceThenMore = text[index] === " " && pathChar.test(text[index + 1] ?? " ")
    if (written.length < raw.length || !oneSpaceThenMore) return isFile ? written : null
    const after = text.slice(index)
    if (isFile && !continuesAsAPath(after)) return written
    // A word that starts a path is the next path, not the rest of this one.
    if (!isFile && startsAPath(after.slice(1))) return null
    index += 1
  }
}

/** Whether a text starts with what starts a path. */
function startsAPath(text: string): boolean {
  return /^(?:[\\/~]|[A-Za-z]:[\\/]|file:)/i.test(text)
}

/**
 * EVERY LOCAL PATH IN A RUN OF BARE PROSE, in order and never overlapping.
 * Absolute paths only: a relative one in a sentence cannot be told from words.
 */
export function findLocalPaths(text: string): LocalPathMatch[] {
  const found: LocalPathMatch[] = []
  const push = (start: number, raw: string) => {
    const written = trimTrailing(raw)
    if (written.length < 3 || !endsLikeAPath(written) || isNetworkLike(written)) return
    if (continuesAsAPath(text.slice(start + written.length))) return
    found.push({ start, end: start + written.length, text: written, target: written })
  }

  // Quoted first: inside quotes a path may carry spaces.
  for (const match of text.matchAll(QUOTED_RE)) {
    const [, open, inner, close] = match
    if (QUOTE_PAIRS[open] !== close) continue
    const target = absolutePath(inner)
    if (!target) continue
    const start = (match.index ?? 0) + open.length
    found.push({ start, end: start + inner.length, text: inner, target })
  }

  for (const match of text.matchAll(BARE_FILE_URL_RE)) {
    const start = match.index ?? 0
    if (isWordChar(text[start - 1])) continue
    if (!absolutePath(trimTrailing(match[0]))) continue
    push(start, match[0])
  }

  for (const match of text.matchAll(BARE_POSIX_RE)) {
    const start = match.index ?? 0
    const before = text[start - 1]
    // Start of text, after whitespace, or after an opening delimiter. Not
    // after a letter or digit (`and/or`, `1/2`, `2026/09/24`), and not after
    // a colon or a slash (the path of a URL).
    if (before !== undefined && !/[\s(["'<«“]/.test(before)) continue
    const written = trimTrailing(match[0])
    if (!posixComponents(written)) continue
    push(start, written)
  }

  // Under a user's own files, where a name may have spaces in it.
  for (const match of text.matchAll(BARE_USER_ROOT_RE)) {
    const start = match.index ?? 0
    const before = text[start - 1]
    if (/^[A-Za-z]:/.test(match[0])) {
      // Not inside a word, a URL (`host/C:/x`) or a longer path.
      if (isWordChar(before) || (before !== undefined && /[\\/:.]/.test(before))) continue
    } else if (before !== undefined && !/[\s(["'<«“]/.test(before)) {
      continue
    }
    const written = scanUserRootPath(text, start, match[0].length)
    if (written) push(start, written)
  }

  // Earliest first, the longest of two that start together, and nothing that
  // overlaps a path already taken.
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: LocalPathMatch[] = []
  for (const match of found) {
    const previous = kept[kept.length - 1]
    if (previous && match.start < previous.end) continue
    kept.push(match)
  }
  return kept
}
