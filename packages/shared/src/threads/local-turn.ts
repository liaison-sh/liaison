// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A TURN THAT RAN ON THE USER'S MACHINE, IN THE SHAPE A SERVER TURN IS STORED IN.
 *
 * A cloud turn leaves one agent message whose metadata carries `modelId`,
 * `toolCalls` (name, args, result, status), `timeline` (reasoning runs and tool
 * ids in the order they happened), `reasoning`, `stepCount`, `usage` and
 * `finishReason` (`agent-service.ts` finalize). Everything downstream reads
 * those keys: the thread view draws the activity from them, the history replay
 * turns `toolCalls` back into tool parts for the next turn, the checkpoint
 * budget counts them (`historyRowTokens`) and the compaction trigger reads
 * `usage.lastStepInputTokens`. A local turn used to leave only its final text,
 * so every one of those readers saw a turn that did nothing.
 *
 * This module is the ONE definition of that record for a local turn, shared by
 * the desktop that builds it and the server that stores it, and it owns the
 * redaction both of them apply: the desktop so a secret never leaves the
 * machine, the server because a client is never trusted to have done it.
 */

/** One tool call, as `metadata.toolCalls` holds it for a server turn. */
export interface LocalTurnToolCall {
  toolCallId: string
  toolName: string
  args: unknown
  result: unknown
  status: "completed" | "error"
  error?: { message: string }
}

/** One entry of `metadata.timeline`, exactly the server's `TurnTimelineEntry`. */
export type LocalTurnTimelineEntry =
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; toolCallId: string }
  | { kind: "text"; text: string }

/** `metadata.usage` of a server turn, in the same keys. */
export interface LocalTurnUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  lastStepInputTokens?: number
}

/** Everything a local turn stores beside its text. */
export interface LocalTurnRecord {
  modelId: string | null
  toolCalls: LocalTurnToolCall[]
  timeline: LocalTurnTimelineEntry[]
  reasoning?: string
  stepCount: number
  usage: LocalTurnUsage
  finishReason: string
  /** The Claude Code session the turn ran in, so a later start knows what it would resume. */
  sdkSessionId?: string
}

/** How many tool calls one stored turn keeps. A turn past it keeps the first ones. */
export const LOCAL_TURN_MAX_TOOL_CALLS = 200
/** How many timeline entries one stored turn keeps. */
export const LOCAL_TURN_MAX_TIMELINE = 400
/** One string inside a tool call's arguments, at most. */
export const LOCAL_TURN_ARG_STRING_LIMIT = 2000
/** One tool result, as text, at most. The replay clips it further. */
export const LOCAL_TURN_RESULT_LIMIT = 4000
/** One reasoning run, at most. */
export const LOCAL_TURN_REASONING_LIMIT = 8000
/**
 * How much answer text the timeline keeps, all text entries together: the
 * reply's own bound. Past it the entries stop, and the thread view draws the
 * stored reply below the activity, as for a turn with no text entries.
 */
export const LOCAL_TURN_TIMELINE_TEXT_LIMIT = 100_000

/**
 * The whole record, serialized, at most. The reply route takes 1 MB of JSON and
 * the answer's text rides in the same body: a record past this is shrunk (tool
 * results first, then arguments) rather than making the answer unpostable.
 */
export const LOCAL_TURN_MAX_BYTES = 400_000

/** What a struck-out secret reads as. */
export const REDACTED = "[redacted]"

/**
 * The shapes a credential takes in a command line, a URL, a header or a JSON
 * body. Ordered: the specific shapes first, so `Bearer <jwt>` reads as one
 * redaction rather than a bearer and a leftover.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // An Authorization header value, whatever the scheme.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{8,}=*/gi, `$1 ${REDACTED}`],
  // A JWT anywhere, including one a capability URL carries in its path.
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  // Provider and forge keys with a known prefix.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  // `token=...`, `sig=...`, `X-Amz-Signature=...` in a query string or a form.
  [
    /\b((?:access_|refresh_|id_|api_|session_|auth_)?token|capability|cap|sig|signature|secret|password|passwd|api_?key|apikey|key|X-Amz-(?:Signature|Credential|Security-Token)|X-Goog-Signature)=([^&\s"'<>]+)/gi,
    `$1=${REDACTED}`,
  ],
  // `"token": "..."`, `"password": "..."` in a JSON body.
  [
    /("(?:[A-Za-z_]*token|[A-Za-z_]*secret|password|passwd|api_?key|apikey|authorization|cookie)"\s*:\s*")[^"]*(")/gi,
    `$1${REDACTED}$2`,
  ],
  // `Authorization: <anything>` and `Cookie: <anything>` in a curl -H.
  [/\b(authorization|cookie|x-api-key)(\s*:\s*)[^"'\n]+/gi, `$1$2${REDACTED}`],
]

/**
 * A run of token characters long enough to be a random token. Matched
 * linearly, its conditions checked in `strikeOpaqueRun`: the lookahead form
 * (`\b(?=…{32,}\b)(?=…[a-z])…`) was quadratic, every `\b` of "a-a-a-…"
 * rescanning the whole run (A59).
 */
const OPAQUE_RUN = /[A-Za-z0-9_-]{32,}/g

/** `-` is the one token character that is not a word character. */
function isWordAt(run: string, i: number): boolean {
  return run.charCodeAt(i) !== 45
}

/**
 * Anything else long, opaque and mixed like a random token (base64url with
 * letters of both cases and digits). Hex digests and paths are left alone.
 * Strikes the run from its first word boundary `p` such that the rest holds a
 * lower-case letter, an upper-case letter and a digit, and a word boundary
 * lies at least 32 characters on; what precedes `p` is kept. Same matches as
 * the lookahead form, in one pass over the run.
 */
function strikeOpaqueRun(run: string): string {
  const len = run.length
  // A maximal run: the characters around it are not word characters.
  const boundary = (q: number) =>
    q === 0
      ? isWordAt(run, 0)
      : q === len
        ? isWordAt(run, len - 1)
        : isWordAt(run, q - 1) !== isWordAt(run, q)
  let lastBoundary = -1
  for (let q = len; q > 0; q--) {
    if (boundary(q)) {
      lastBoundary = q
      break
    }
  }
  let lower = -1
  let upper = -1
  let digit = -1
  for (let i = len - 1; i >= 0 && (lower < 0 || upper < 0 || digit < 0); i--) {
    const c = run.charCodeAt(i)
    if (lower < 0 && c >= 97 && c <= 122) lower = i
    else if (upper < 0 && c >= 65 && c <= 90) upper = i
    else if (digit < 0 && c >= 48 && c <= 57) digit = i
  }
  const limit = Math.min(lastBoundary - 32, lower, upper, digit)
  for (let p = 0; p <= limit; p++) {
    if (boundary(p)) return run.slice(0, p) + REDACTED
  }
  return run
}

/** The keys whose value is a secret whatever it looks like. */
export const SECRET_KEY =
  /^(?:.*token|.*secret|password|passwd|api_?key|apikey|authorization|cookie|credentials?)$/i

/**
 * W3-D5: the roots a Claude Code project-folder slug starts from. The CLI
 * names a project's folder after its cwd with every `/` turned into `-`
 * (`/Volumes/Disk/work/x` -> `-Volumes-Disk-work-x`).
 */
const FS_ROOTS: ReadonlySet<string> = new Set([
  "Users",
  "Volumes",
  "home",
  "tmp",
  "private",
  "var",
  "opt",
  "mnt",
  "srv",
  "root",
  "Library",
  "Applications",
  "System",
  "workspace",
  "workspaces",
  "nix",
  "usr",
  "media",
])

/** The longest parent folder name read back from a slug (`claude-501`, `projects`). */
const PARENT_SCAN_LIMIT = 64

/**
 * W3-D5: whether the run at `offset` is a Claude Code project-folder slug:
 * a whole path segment that reads `-<root>-…` (a cwd turned into a name) and
 * sits directly under `.claude/projects/` or under the CLI's own
 * `tmp/claude-*` folder. Any other long run in a path, local or not, is
 * struck like any token (`/private/<token>/…`, `~/.config/svc/<token>/…`).
 * Each check reads a bounded window around the run, so a whole string stays
 * one pass (A59).
 */
function isProjectSlug(text: string, offset: number, run: string): boolean {
  if (text.charCodeAt(offset - 1) !== 47) return false
  const after = text.charCodeAt(offset + run.length)
  if (!(Number.isNaN(after) || after === 47 || endsPath(after))) return false
  if (run.charCodeAt(0) !== 45) return false
  const dash = run.indexOf("-", 1)
  const root = dash < 0 ? run.slice(1) : run.slice(1, dash)
  if (!FS_ROOTS.has(root)) return false
  const parentEnd = offset - 1
  let parentStart = parentEnd
  const floor = Math.max(0, parentEnd - PARENT_SCAN_LIMIT)
  while (parentStart > floor && text.charCodeAt(parentStart - 1) !== 47) parentStart--
  if (text.charCodeAt(parentStart - 1) !== 47) return false
  const parent = text.slice(parentStart, parentEnd)
  if (parent === "projects") return text.slice(parentStart - 9, parentStart) === "/.claude/"
  if (parent.startsWith("claude-")) return text.slice(parentStart - 5, parentStart) === "/tmp/"
  return false
}

/** Characters that end a path where it sits in a line, a JSON string, a tag or an assignment. */
function endsPath(c: number): boolean {
  // whitespace " ' ` < > ( ) [ ] { } = , ; |
  return (
    c <= 32 ||
    c === 34 ||
    c === 39 ||
    c === 96 ||
    c === 60 ||
    c === 62 ||
    c === 40 ||
    c === 41 ||
    c === 91 ||
    c === 93 ||
    c === 123 ||
    c === 125 ||
    c === 61 ||
    c === 44 ||
    c === 59 ||
    c === 124
  )
}

/** Strikes out every credential shaped run in a string. */
export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement)
  return out.replace(OPAQUE_RUN, (run: string, offset: number) =>
    isProjectSlug(out, offset, run) ? run : strikeOpaqueRun(run),
  )
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}...` : text
}

/**
 * A tool call's arguments with every string redacted and clipped, every key
 * that names a secret struck out, and the whole bounded in depth and width, so
 * an argument blob is never a way to smuggle a secret or a megabyte into a row.
 */
export function redactArgs(
  value: unknown,
  depth = 0,
  limit: number = LOCAL_TURN_ARG_STRING_LIMIT,
): unknown {
  if (typeof value === "string") return clip(redactSecrets(value), limit)
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (depth >= 6) return "[...]"
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => redactArgs(item, depth + 1, limit))
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redactArgs(inner, depth + 1, limit)
    }
    return out
  }
  return null
}

/** A tool result as the text a person reads, redacted and clipped. */
export function redactResult(value: unknown): string | null {
  if (value === null || value === undefined) return null
  let text: string
  if (typeof value === "string") text = value
  else if (Array.isArray(value)) {
    // The SDK's content blocks: the text ones are the result, the rest is noise.
    text = value
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n")
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  return clip(redactSecrets(text), LOCAL_TURN_RESULT_LIMIT)
}

/**
 * The name the server knows a tool by. The Liaison catalog reaches the SDK
 * through an MCP server named `liaison`, so `kernel__threads_list` arrives as
 * `mcp__liaison__kernel__threads_list`; stored under the long name, the same
 * call would read as two different tools depending on where the turn ran.
 */
export function normalizeLocalToolName(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith("mcp__liaison__") ? trimmed.slice("mcp__liaison__".length) : trimmed
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined
}

/**
 * THE ONE SANITIZER, run by the desktop before sending and by the server before
 * storing: shape checked, bounded, and every free text redacted. Anything that
 * does not fit the record is dropped rather than stored as the client sent it.
 */
export function sanitizeLocalTurnRecord(input: unknown): LocalTurnRecord {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const toolCalls: LocalTurnToolCall[] = []
  const ids = new Set<string>()
  for (const call of Array.isArray(raw.toolCalls) ? raw.toolCalls : []) {
    if (toolCalls.length >= LOCAL_TURN_MAX_TOOL_CALLS) break
    if (!call || typeof call !== "object") continue
    const c = call as Record<string, unknown>
    if (typeof c.toolCallId !== "string" || !c.toolCallId || c.toolCallId.length > 200) continue
    if (typeof c.toolName !== "string" || !c.toolName.trim()) continue
    if (ids.has(c.toolCallId)) continue
    ids.add(c.toolCallId)
    const status = c.status === "error" ? "error" : "completed"
    const error =
      status === "error" && c.error && typeof c.error === "object"
        ? redactResult((c.error as { message?: unknown }).message)
        : null
    toolCalls.push({
      toolCallId: c.toolCallId,
      toolName: clip(normalizeLocalToolName(c.toolName), 200),
      args: redactArgs(c.args ?? {}),
      result: redactResult(c.result),
      status,
      ...(error ? { error: { message: error } } : {}),
    })
  }
  const timeline: LocalTurnTimelineEntry[] = []
  let timelineText = 0
  for (const entry of Array.isArray(raw.timeline) ? raw.timeline : []) {
    if (timeline.length >= LOCAL_TURN_MAX_TIMELINE) break
    if (!entry || typeof entry !== "object") continue
    const e = entry as Record<string, unknown>
    if (e.kind === "tool" && typeof e.toolCallId === "string" && ids.has(e.toolCallId)) {
      timeline.push({ kind: "tool", toolCallId: e.toolCallId })
    } else if (e.kind === "reasoning" && typeof e.text === "string" && e.text.trim()) {
      timeline.push({
        kind: "reasoning",
        text: clip(redactSecrets(e.text), LOCAL_TURN_REASONING_LIMIT),
      })
    } else if (e.kind === "text" && typeof e.text === "string" && e.text.trim()) {
      // The answer's own words, where they came between the tools. Stored as the
      // reply text is (not redacted, since the reply is not), so the thread view
      // can match them against it; dropped whole past the bound, never cut.
      timelineText += e.text.length
      if (timelineText > LOCAL_TURN_TIMELINE_TEXT_LIMIT) continue
      timeline.push({ kind: "text", text: e.text })
    }
  }
  const usageRaw = (raw.usage && typeof raw.usage === "object" ? raw.usage : {}) as Record<
    string,
    unknown
  >
  const usage: LocalTurnUsage = {}
  for (const key of [
    "inputTokens",
    "outputTokens",
    "cachedInputTokens",
    "lastStepInputTokens",
  ] as const) {
    const value = nonNegative(usageRaw[key])
    if (value !== undefined) usage[key] = value
  }
  const reasoning =
    typeof raw.reasoning === "string" && raw.reasoning.trim()
      ? clip(redactSecrets(raw.reasoning), LOCAL_TURN_REASONING_LIMIT * 4)
      : undefined
  shrinkToBudget(toolCalls)
  return {
    modelId:
      typeof raw.modelId === "string" && raw.modelId.trim() ? clip(raw.modelId.trim(), 100) : null,
    toolCalls,
    timeline,
    ...(reasoning ? { reasoning } : {}),
    stepCount: nonNegative(raw.stepCount) ?? Math.max(1, toolCalls.length),
    usage,
    finishReason:
      typeof raw.finishReason === "string" && /^[a-z_-]{1,40}$/.test(raw.finishReason)
        ? raw.finishReason
        : "stop",
    ...(typeof raw.sdkSessionId === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(raw.sdkSessionId)
      ? { sdkSessionId: raw.sdkSessionId }
      : {}),
  }
}

function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Keeps the tool calls under the byte budget, cheapest loss first: results cut
 * short, then arguments cut short, then both dropped. The names, the order and
 * the statuses always stay: they are what the activity is.
 */
function shrinkToBudget(toolCalls: LocalTurnToolCall[]): void {
  if (serializedSize(toolCalls) <= LOCAL_TURN_MAX_BYTES) return
  for (const call of toolCalls) {
    if (typeof call.result === "string") call.result = clip(call.result, 400)
  }
  if (serializedSize(toolCalls) <= LOCAL_TURN_MAX_BYTES) return
  for (const call of toolCalls) call.args = redactArgs(call.args, 0, 200)
  if (serializedSize(toolCalls) <= LOCAL_TURN_MAX_BYTES) return
  for (const call of toolCalls) {
    call.args = {}
    call.result = null
  }
}
