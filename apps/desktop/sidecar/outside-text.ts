// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HAS THIS SESSION READ OUTSIDE TEXT?
//
// A local session's Liaison tools return text written outside the
// organisation: a customer's mail, a ticket message, a web page. Once such text
// reached the model it stays in the model's context for the rest of the
// session, so Auto stops running shell commands on its own from then on
// (auto-policy.ts `SessionFacts`): a command the model proposes after reading
// it may be the text's, not the person's.
//
// THE SIGNAL. The Liaison server fences outside text in `<external-content>`
// tags inside a tool result, and a tool whose whole result is outside text (a
// declared taint source) also carries an `<external-content-notice>` block
// (apps/api/src/lib/external-content.ts). Both are in the result's TEXT, the
// one part of a result the CLI is guaranteed to hand on: it filters a result's
// `_meta` before the SDK sees it. A forged tag can only make Auto stricter.
//
// FAIL CLOSED. A result this cannot read (an unknown block shape, a tool use it
// never saw announced, a Liaison result that is not the server's JSON because
// the CLI truncated it or saved it to a file) counts as outside text. Results
// of every other MCP server, of the web tools, and of a shell command that read
// from the network count as outside text whatever they say: their text was
// written by someone else by definition.
//
// A RESUMED SESSION carries earlier results this process never saw. A node chat
// resumes its SDK session every turn, so the verdict is kept per SDK session
// (`OutsideTextVerdicts`, in the app's own data dir, never in the session
// folder): marked as soon as a result marks it, clean only once a turn ended
// with the whole stream seen. A resumed session starts clean only when its
// stored verdict says clean; no verdict, or one it cannot read, starts marked.
//
// A SAVED RESULT. A Liaison result too large for the model's context is saved
// by the CLI under its own `tool-results` directory and replaced with a pointer.
// The model may Read that file later, so its text is judged by the same rule:
// read only from the CLI's store in this session's config dir, never another
// path, and an unreadable or cut file still counts as outside text.

import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { LIAISON_MCP_SERVER, readsFromNetwork } from "./auto-policy"
import { readRegularFileNoFollow } from "./safe-read"

/** Any opening of the fence or of its notice, escaped or not, any case. */
const OUTSIDE_TEXT_TAG = /(?:<|&lt;)\s*\/?\s*external-content/i

/** Built-in tools whose results are text from the web. */
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"])

/** The largest saved result this reads; a bigger one counts as outside text. */
const SAVED_RESULT_MAX_BYTES = 32 * 1024 * 1024

/** What a session's stored verdict says. */
export interface OutsideTextVerdict {
  marked: boolean
  why: string | null
}

/**
 * The verdict of each SDK session, one owner-only file per session id in a
 * directory of the app's own data dir (outside every session folder, so a
 * session's ordinary edits never reach it). A file it cannot read is no
 * verdict, which a resumed session takes as marked.
 */
export class OutsideTextVerdicts {
  constructor(private readonly dir: string) {}

  /** The stored verdict of `sdkSessionId`, or null when there is none it trusts. */
  read(sdkSessionId: string): OutsideTextVerdict | null {
    const file = this.fileOf(sdkSessionId)
    if (!file || !this.dirIsOwn()) return null
    const raw = readRegularFileNoFollow(file, 4096)
    if (raw === null) return null
    try {
      const parsed = JSON.parse(raw) as { marked?: unknown; why?: unknown }
      if (typeof parsed.marked !== "boolean") return null
      return { marked: parsed.marked, why: typeof parsed.why === "string" ? parsed.why : null }
    } catch {
      return null
    }
  }

  /** Reads the verdict and removes it: until this run stores one again, there is none. */
  take(sdkSessionId: string): OutsideTextVerdict | null {
    const verdict = this.read(sdkSessionId)
    this.forget(sdkSessionId)
    return verdict
  }

  /** Stores the verdict (written aside, then renamed over the old one). Throws on failure. */
  write(sdkSessionId: string, verdict: OutsideTextVerdict): void {
    const file = this.fileOf(sdkSessionId)
    if (!file) throw new Error("no verdict file for this session id")
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (!this.dirIsOwn()) throw new Error("the verdict directory is not a plain directory")
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(verdict)}\n`, { mode: 0o600, flag: "w" })
    renameSync(temp, file)
  }

  forget(sdkSessionId: string): void {
    const file = this.fileOf(sdkSessionId)
    if (!file) return
    try {
      rmSync(file, { force: true })
    } catch {
      // Nothing to remove.
    }
  }

  private fileOf(sdkSessionId: string): string | null {
    if (!/^[A-Za-z0-9-]{1,128}$/.test(sdkSessionId)) return null
    return path.join(this.dir, `${sdkSessionId}.json`)
  }

  private dirIsOwn(): boolean {
    try {
      const st = lstatSync(this.dir)
      return st.isDirectory() && !st.isSymbolicLink()
    } catch {
      return false
    }
  }
}

export interface OutsideTextOptions {
  /** The session resumes an earlier one whose tool results this process never saw. */
  resumed?: boolean
  /** The SDK session it resumes, to look its stored verdict up. */
  resumeSessionId?: string | null
  /** Where verdicts are kept across runs; without it a resumed session starts marked. */
  verdicts?: OutsideTextVerdicts
  /** The CLI's config dir, whose `projects/<project>/<session>/tool-results` hold saved results. */
  configDir?: string
  /** The session's own Liaison server (auto-policy.ts `liaisonOrigin`), whose fetches are not outside text. */
  ownOrigin?: string | null
}

export class OutsideTextTracker {
  private readonly toolUses = new Map<string, { name: string; input: unknown }>()
  private seen = false
  private reason: string | null = null
  private sessionId: string | null = null
  private readonly verdicts: OutsideTextVerdicts | undefined
  private readonly configDir: string | undefined
  private readonly ownOrigin: string | null

  /**
   * `cwd`: the session folder, for the shell rule. A resumed session starts
   * marked unless its stored verdict says clean: it cannot tell otherwise, and
   * fails closed. The stored verdict is consumed, so a run that ends before
   * storing its own leaves none, and the next one starts marked.
   */
  constructor(
    private readonly cwd: string,
    options: OutsideTextOptions = {},
  ) {
    this.verdicts = options.verdicts
    this.configDir = options.configDir
    this.ownOrigin = options.ownOrigin ?? null
    if (!options.resumed) return
    const stored =
      options.resumeSessionId && this.verdicts ? this.verdicts.take(options.resumeSessionId) : null
    if (stored?.marked === false) return
    this.mark(stored?.why ?? "a resumed session, whose earlier results it never saw")
  }

  /** True once any tool result in the session carried outside text. */
  get readOutsideText(): boolean {
    return this.seen
  }

  /** Why the session counts as having read outside text, for logs. */
  get why(): string | null {
    return this.reason
  }

  /** Feeds one SDK message; the order is the stream's. */
  observe(message: unknown): void {
    if (!message || typeof message !== "object") return
    const m = message as {
      type?: unknown
      session_id?: unknown
      message?: { content?: unknown }
    }
    if (typeof m.session_id === "string" && m.session_id && m.session_id !== this.sessionId) {
      this.sessionId = m.session_id
      if (this.seen) this.store()
    }
    // A turn's result: every message of the turn went through here, so the
    // session's verdict so far is complete. Only now may a clean one be kept.
    if (m.type === "result") {
      this.store()
      return
    }
    const content = m.message?.content
    if (m.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        const b = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }
        if (
          (b?.type === "tool_use" || b?.type === "server_tool_use" || b?.type === "mcp_tool_use") &&
          typeof b.id === "string" &&
          typeof b.name === "string"
        ) {
          this.toolUses.set(b.id, { name: b.name, input: b.input })
        }
      }
      return
    }
    if (m.type !== "user" || !Array.isArray(content)) return
    for (const block of content) {
      const b = block as {
        type?: unknown
        tool_use_id?: unknown
        content?: unknown
        is_error?: unknown
      }
      if (b?.type !== "tool_result") continue
      const use = typeof b.tool_use_id === "string" ? this.toolUses.get(b.tool_use_id) : undefined
      const why = outsideTextReason(use?.name, b.content, {
        input: use?.input,
        cwd: this.cwd,
        isError: b.is_error === true,
        ...(this.configDir ? { configDir: this.configDir } : {}),
        ownOrigin: this.ownOrigin,
      })
      if (why) this.mark(why)
    }
  }

  private mark(why: string): void {
    if (this.seen) return
    this.seen = true
    this.reason = why
    this.store()
  }

  /** Keeps the verdict for the next run of this session. A marked one that cannot be kept leaves none. */
  private store(): void {
    if (!this.verdicts || !this.sessionId) return
    try {
      this.verdicts.write(this.sessionId, { marked: this.seen, why: this.reason })
    } catch {
      this.verdicts.forget(this.sessionId)
    }
  }
}

/** Why one tool result counts as outside text, or null when it does not. */
export function outsideTextReason(
  toolName: string | undefined,
  content: unknown,
  call: {
    input?: unknown
    cwd?: string
    isError?: boolean
    configDir?: string
    ownOrigin?: string | null
  } = {},
): string | null {
  if (toolName === undefined) return "a tool result for a call it never saw"
  if (WEB_TOOLS.has(toolName)) return `a ${toolName} result`
  // A shell command that read from the network (curl, git pull, gh, npx…)
  // printed what it read; a fetch from the session's own Liaison server only
  // what the server fenced.
  if (toolName === "Bash") {
    const command = (call.input as { command?: unknown } | undefined)?.command
    if (typeof command !== "string") return "a shell result for a command it cannot read"
    return readsFromNetwork(command, call.cwd ?? "/", call.ownOrigin ?? null)
      ? "a shell command that read from the network"
      : null
  }
  if (!toolName.startsWith("mcp__")) return null
  // Every tool of the Liaison server is judged by its result, the wrappers
  // that call another Liaison tool (`liaison_call_tool`) included: the server
  // fences what they return the same way.
  if (!toolName.startsWith(`mcp__${LIAISON_MCP_SERVER}__`)) return `a result of ${toolName}`
  const text = resultText(content)
  if (text === null) return `an unreadable result of ${toolName}`
  if (carriesTag(text)) return `outside text in a result of ${toolName}`
  // A result the CLI saved to a file: what the model may Read is that file.
  const saved = !call.isError ? parseSavedResult(text) : null
  if (saved) {
    if (saved.cut) return `a saved result of ${toolName} cut at the CLI's size limit`
    const whole = readSavedResult(saved.file, call.configDir)
    if (whole === null) return `a saved result of ${toolName} it cannot read`
    const why = savedResultReason(whole, saved.format)
    return why ? `${why} in a saved result of ${toolName}` : null
  }
  // The server's result opens with its JSON payload. One that does not is a
  // result the CLI truncated: what it held cannot be checked, so it counts.
  // A failed call's text is the CLI's or the server's own error.
  if (!call.isError && !opensWithJson(content)) {
    return `a truncated or saved result of ${toolName}`
  }
  return null
}

/** A tag in the text, or in any string of it when it is JSON (a `\u003c` spelling included). */
function carriesTag(text: string): boolean {
  if (OUTSIDE_TEXT_TAG.test(text)) return true
  if (!text.includes("\\u")) return false
  try {
    return anyString(JSON.parse(text), (s) => OUTSIDE_TEXT_TAG.test(s))
  } catch {
    return false
  }
}

function anyString(value: unknown, test: (s: string) => boolean): boolean {
  if (typeof value === "string") return test(value)
  if (Array.isArray(value)) return value.some((v) => anyString(v, test))
  if (value && typeof value === "object") {
    return Object.values(value).some((v) => anyString(v, test))
  }
  return false
}

/**
 * The CLI's pointer to an MCP result it saved (Claude Code 2.1.x):
 * `Error: result (<n> characters…) exceeds maximum allowed tokens. Output has
 * been saved to <file>.` then `Format: <how>`, and a note when the saved file
 * holds only the first part of the result.
 */
function parseSavedResult(text: string): { file: string; format: string; cut: boolean } | null {
  const found =
    /^Error: result \([^)\n]*\) exceeds maximum allowed tokens\. Output has been saved to ([^\n]+)\.\nFormat: ([^\n]+)\n/.exec(
      text,
    )
  if (!found) return null
  return {
    file: found[1] as string,
    format: found[2] as string,
    cut: text.includes("the output exceeded the persist byte limit"),
  }
}

/**
 * The text of a saved result, when the file is one the CLI saved for the
 * Liaison server in its own store: `<configDir>/projects/<project>/<session>/
 * tool-results/mcp-liaison-….txt`, a regular file (no link). Null otherwise.
 */
function readSavedResult(file: string, configDir: string | undefined): string | null {
  if (!configDir || !path.isAbsolute(file)) return null
  const name = path.basename(file)
  if (!name.startsWith(`mcp-${LIAISON_MCP_SERVER}-`) || !name.endsWith(".txt")) return null
  try {
    const real = realpathSync(file)
    const projects = path.join(realpathSync(configDir), "projects")
    const rel = path.relative(projects, real)
    const parts = rel.split(path.sep)
    if (rel.startsWith("..") || path.isAbsolute(rel) || parts.length !== 4) return null
    if (parts[2] !== "tool-results" || parts.some((p) => p === "" || p === "..")) return null
    return readRegularFileNoFollow(real, SAVED_RESULT_MAX_BYTES)
  } catch {
    return null
  }
}

/**
 * Why a saved result's text counts, by the inline rule: a tag anywhere, or a
 * text that is not the server's JSON. `format` is the CLI's own: the plain
 * text of a lone text block (`Plain text`, or `JSON with schema: …` when that
 * text is JSON), or the JSON of the whole block array (`JSON array…`).
 */
function savedResultReason(whole: string, format: string): string | null {
  if (carriesTag(whole)) return "outside text"
  // `JSON with schema: {…}` is the CLI's name for a lone text block that is
  // itself JSON (the server's own result), saved as that text.
  if (format === "Plain text" || format.startsWith("JSON with schema"))
    return opensWithJson(whole) ? null : "a text that is not the server's JSON"
  if (format.startsWith("JSON array")) {
    let blocks: unknown
    try {
      blocks = JSON.parse(whole)
    } catch {
      return "a block array it cannot parse"
    }
    if (!Array.isArray(blocks)) return "a block array it cannot parse"
    const text = resultText(blocks)
    if (text === null) return "a block it cannot read"
    if (carriesTag(text)) return "outside text"
    return opensWithJson(blocks) ? null : "a text that is not the server's JSON"
  }
  return "a format it does not read"
}

/** True when the result's first text block is a whole JSON value. */
function opensWithJson(content: unknown): boolean {
  const first =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content.find((b) => (b as { type?: unknown })?.type === "text") as { text?: string })
            ?.text
        : undefined
  if (typeof first !== "string") return Array.isArray(content) && content.length === 0
  try {
    JSON.parse(first)
    return true
  } catch {
    return false
  }
}

/** A tool result's text, or null when its shape is not one this reads. */
function resultText(content: unknown): string | null {
  if (content === undefined || content === null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown }
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text)
    else if (b?.type === "image") continue
    else return null
  }
  return parts.join("\n")
}
