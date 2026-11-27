// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Text files an agent reads directly: a Markdown note, a CSV export, a JSON or
 * YAML config, a log, source code. `files_read` hands their decoded text to the
 * agent instead of a download URL, so a chat attachment such as `notes.md` is
 * readable in the turn (the agent's web fetch cannot open the long signed URL,
 * and the media reader only knows images, video and documents).
 *
 * The bytes are decoded as strict UTF-8 and never rendered: a file that is not
 * text (a NUL byte, an invalid UTF-8 sequence) is refused as binary rather than
 * dumped into the model's context. At most `TEXT_READ_MAX_BYTES` are read; a
 * longer file comes back cut, with a note saying so.
 */

/** Bytes of a text file the agent gets inline (about 25k tokens). */
export const TEXT_READ_MAX_BYTES = 100 * 1024

/** MIME types (beyond `text/*`) that carry text. */
const TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/x-typescript",
  "application/sql",
  "application/x-sh",
  "application/x-shellscript",
  "application/x-httpd-php",
  "application/x-python",
  "application/x-ruby",
  "application/x-tex",
  "application/x-subrip",
  "application/rtf",
])

/**
 * Types a browser or a mail client gives a file it does not recognise. Only for
 * these does the extension decide: a file declared as an image stays an image
 * whatever its name says.
 */
const GENERIC_MIME_TYPES: ReadonlySet<string> = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/unknown",
  "application/x-unknown",
])

/** Extensions of text files, for a file stored with a generic type. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "properties",
  "xml",
  "html",
  "htm",
  "svg",
  "css",
  "scss",
  "less",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "graphql",
  "vue",
  "svelte",
  "tex",
  "rst",
  "adoc",
  "org",
  "srt",
  "vtt",
  "ics",
  "vcf",
  "diff",
  "patch",
  "gitignore",
  "dockerfile",
])

function baseMime(mimeType: string | null | undefined): string {
  return (mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
}

function extensionOf(filename: string): string {
  const name = filename.trim().toLowerCase()
  const dot = name.lastIndexOf(".")
  return dot < 0 ? name : name.slice(dot + 1)
}

/**
 * Is this file text by what it declares: a `text/*` or known text type, a
 * `+json`/`+xml` type, or a generic type with a text extension (`.md` uploads
 * often arrive as `application/octet-stream`)? The bytes are still checked
 * (`decodeTextBytes`): a binary file named `.md` is refused there.
 */
export function isTextLikeFile(mimeType: string | null | undefined, filename: string): boolean {
  const mime = baseMime(mimeType)
  if (mime.startsWith("text/")) return true
  if (TEXT_MIME_TYPES.has(mime)) return true
  if (mime.endsWith("+json") || mime.endsWith("+xml")) return true
  if (GENERIC_MIME_TYPES.has(mime)) return TEXT_EXTENSIONS.has(extensionOf(filename))
  return false
}

export type DecodedText =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; reason: "binary" }

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })

/**
 * Decode the first bytes of a file as strict UTF-8. `truncated` says the file
 * goes on past `bytes`: the cut may then split a multi-byte character, so up to
 * three trailing bytes of an incomplete sequence are dropped before decoding.
 * A NUL byte or any other invalid sequence means the file is not text.
 */
export function decodeTextBytes(bytes: Uint8Array, truncated: boolean): DecodedText {
  if (bytes.includes(0)) return { ok: false, reason: "binary" }
  let end = bytes.length
  if (truncated) {
    // Walk back over continuation bytes (10xxxxxx) to the start of the last
    // character; drop it when its sequence is incomplete.
    let i = end - 1
    let back = 0
    while (i >= 0 && back < 3 && (bytes[i] & 0xc0) === 0x80) {
      i--
      back++
    }
    if (i >= 0) {
      const lead = bytes[i]
      const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
      if (end - i < need) end = i
    }
  }
  try {
    return { ok: true, text: STRICT_UTF8.decode(bytes.subarray(0, end)), truncated }
  } catch {
    return { ok: false, reason: "binary" }
  }
}
