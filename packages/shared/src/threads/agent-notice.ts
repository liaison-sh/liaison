// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * THE AGENT'S FAILURE LINES, AS A CODE EVERY SURFACE RENDERS IN ITS READER'S LANGUAGE.
 *
 * When a turn fails the runtime writes the agent's message itself. It used to append the
 * provider's raw text to a fixed English line ("... the AI provider returned an error: Your
 * project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/
 * ..."), and only the thread view mapped it back to a sentence in the reader's language. The
 * Home unread preview, the notification row and the digest showed the raw English text, links
 * and all (third QA walk, 2026-09-23).
 *
 * Now the failure is decided once, at the source: the runtime persists a code
 * (`metadata.agentNotice`) and a fixed English line, followed by the failure's own detail made
 * safe to show (`safeAgentNoticeDetail`: one message, no stack, secret-shaped tokens masked,
 * bounded). Every surface asks `agentNoticeCode` and renders `AGENT_NOTICE_I18N_KEYS[code]` in
 * its reader's language. A one-line summary (the Home preview, a notification, the digest)
 * shows that line alone; the conversation itself shows it WITH the detail
 * (`localizeAgentNotice(..., { withDetail: true })`): a failure is never reported generically
 * where the person reads it (the API's error-reporting rule). Rows written before the code
 * existed are still recognised by their fixed prefix, and the provider detail they carry is
 * classified and shown the same way.
 */
import { isProviderCreditBlockError } from "../provider-errors"

export type AgentNoticeCode =
  | "provider_quota"
  | "provider_rate_limited"
  | "provider_error"
  | "provider_unavailable"
  | "credits_exhausted"
  | "stopped_early"

/** Where the code rides on the message row's metadata. */
export const AGENT_NOTICE_META_KEY = "agentNotice"

/** The catalog key each code renders through (kernel namespace). */
export const AGENT_NOTICE_I18N_KEYS: Record<AgentNoticeCode, string> = {
  provider_quota: "kernel.agentNotice.providerSpendCap",
  provider_rate_limited: "kernel.agentNotice.providerRateLimited",
  provider_error: "kernel.agentNotice.providerError",
  provider_unavailable: "kernel.agentNotice.providerUnavailable",
  credits_exhausted: "kernel.agentNotice.creditsRanOut",
  stopped_early: "kernel.agentNotice.stoppedEarly",
}

/**
 * The fixed English line a provider failure is stored as. It names the class and never
 * quotes the provider. Every line starts with the legacy prefix, so a reader that only knows
 * the prefix still recognises it.
 */
const PROVIDER_ERROR_PREFIX = "⚠️ I couldn't complete that response"
/** The provider failure classes, each with its fixed stored line. */
export type ProviderNoticeCode =
  | "provider_quota"
  | "provider_rate_limited"
  | "provider_error"
  | "provider_unavailable"
export const AGENT_NOTICE_STORED_LINES: Record<ProviderNoticeCode, string> = {
  provider_quota: `${PROVIDER_ERROR_PREFIX}: the AI service has reached its spending cap. Let an administrator know.`,
  provider_rate_limited: `${PROVIDER_ERROR_PREFIX}: the AI service is busy right now. Please try again in a moment.`,
  provider_error: `${PROVIDER_ERROR_PREFIX}: the AI service returned an error. Please try again in a moment.`,
  // A provider that stopped answering mid-turn (a dropped stream, a timeout, a 5xx) after
  // the runtime's own retries: what the turn did so far is kept, so "continue" resumes it.
  provider_unavailable: `${PROVIDER_ERROR_PREFIX}: the AI service stopped responding. Say "continue" and I will pick up where I stopped.`,
}

const CREDITS_RAN_OUT_PREFIX = "⚠️ Credits ran out before I could finish this response."
const STOPPED_EARLY_PREFIX = "⚠️ I stopped before writing a final answer"

/** The most characters of a failure's own detail a message carries. */
export const AGENT_NOTICE_DETAIL_MAX = 600

// Secret-shaped tokens a provider's message can quote ("Incorrect API key provided:
// sk-proj-****abcd"): masked before the detail is stored or shown.
const SECRET_SHAPES: RegExp[] = [
  /\b(?:sk|pk|rk)[-_][A-Za-z0-9_*.-]{3,}/g,
  /\bAIza[0-9A-Za-z_*-]{6,}/g,
  /\bBearer\s+\S+/gi,
  /:\/\/[^\s/:@]+:[^\s/:@]+@/g,
  /\b[0-9a-fA-F]{32,}\b/g,
]

/** `text` with every secret-shaped token masked as `[redacted]`. */
export function redactSecretShapes(text: string): string {
  let out = text
  for (const re of SECRET_SHAPES) out = out.replace(re, "[redacted]")
  return out
}

/**
 * A failure's own text, safe to show the person: the message without any stack trace
 * (lines from the first "    at " frame on are dropped), secret-shaped tokens masked, and
 * bounded. Null when nothing is left.
 */
export function safeAgentNoticeDetail(detail: string | null | undefined): string | null {
  if (!detail) return null
  const lines = detail.split("\n")
  const frame = lines.findIndex((l) => /^\s+at\s/.test(l))
  const message = (frame === -1 ? lines : lines.slice(0, frame)).join("\n").trim()
  if (!message) return null
  const safe = redactSecretShapes(message)
  return safe.length > AGENT_NOTICE_DETAIL_MAX
    ? `${safe.slice(0, AGENT_NOTICE_DETAIL_MAX).trimEnd()}…`
    : safe
}

/**
 * The stored text of a turn that failed with `detail`: the fixed line of its class, then the
 * detail itself, made safe to show. `code` is the class when the caller already knows it
 * from the error itself (the provider stopped responding); otherwise it is read off the text.
 */
export function agentNoticeStoredText(
  detail: string | null | undefined,
  code?: ProviderNoticeCode,
): string {
  const line = AGENT_NOTICE_STORED_LINES[code ?? classifyProviderError(detail)]
  const safe = safeAgentNoticeDetail(detail)
  return safe ? `${line}\n\n${safe}` : line
}

const SPEND_CAP =
  /spend(ing)?[ _-]?(cap|limit)|quota|billing|insufficient[_ ]?(funds|quota|credit)|credit balance|exceeded your current/i
const RATE_LIMITED = /rate[ _-]?limit|too many requests|\b429\b|overloaded|resource[_ ]exhausted/i

/** The class of a provider failure, from the provider's own error text. */
export function classifyProviderError(
  detail: string | null | undefined,
): "provider_quota" | "provider_rate_limited" | "provider_error" {
  const d = detail?.trim() ?? ""
  if (!d) return "provider_error"
  if (isProviderCreditBlockError(d) || SPEND_CAP.test(d)) return "provider_quota"
  if (RATE_LIMITED.test(d)) return "provider_rate_limited"
  return "provider_error"
}

function isAgentNoticeCode(v: unknown): v is AgentNoticeCode {
  return typeof v === "string" && Object.hasOwn(AGENT_NOTICE_I18N_KEYS, v)
}

/**
 * The failure code of a message, or null for any other message. The persisted code wins;
 * without one (an older row, or a surface that only carries the text, such as a notification
 * summary) the fixed line is recognised by its prefix.
 */
export function agentNoticeCode(
  content: string | null | undefined,
  metadata?: Record<string, unknown> | null,
): AgentNoticeCode | null {
  const stored = metadata?.[AGENT_NOTICE_META_KEY]
  if (isAgentNoticeCode(stored)) return stored
  if (!content) return null
  const s = content.trimStart()
  if (s.startsWith(PROVIDER_ERROR_PREFIX)) {
    for (const [code, line] of Object.entries(AGENT_NOTICE_STORED_LINES)) {
      if (s.startsWith(line)) return code as AgentNoticeCode
    }
    const detail = s.includes(":") ? s.slice(s.indexOf(":") + 1) : ""
    return classifyProviderError(detail)
  }
  if (s.startsWith(CREDITS_RAN_OUT_PREFIX)) return "credits_exhausted"
  if (s.startsWith(STOPPED_EARLY_PREFIX)) return "stopped_early"
  return null
}

const STOP_REASON = /\((stop reason: [^)]+|this run's limit is [^)]+)\)/
const TOOL_CALLS_DONE = /I completed \d+ tool calls? before stopping/

/**
 * The failure's own detail a failure message carries, safe to show, or null: the provider's
 * text after the fixed line (a row written now, or an older row after its prefix), or the stop
 * reason and the work done of a turn that stopped early.
 */
export function agentNoticeDetail(content: string | null | undefined): string | null {
  const s = content?.trimStart() ?? ""
  if (s.startsWith(PROVIDER_ERROR_PREFIX)) {
    for (const line of Object.values(AGENT_NOTICE_STORED_LINES)) {
      if (s.startsWith(line)) return safeAgentNoticeDetail(s.slice(line.length))
    }
    return safeAgentNoticeDetail(s.includes(":") ? s.slice(s.indexOf(":") + 1) : "")
  }
  if (s.startsWith(STOPPED_EARLY_PREFIX) || s.startsWith(CREDITS_RAN_OUT_PREFIX)) {
    const parts = [STOP_REASON.exec(s)?.[1], TOOL_CALLS_DONE.exec(s)?.[0]].filter(Boolean)
    return parts.length > 0 ? safeAgentNoticeDetail(`${parts.join("; ")}.`) : null
  }
  return null
}

/**
 * The message in the reader's language when it is a failure line, else unchanged. `t` is the
 * surface's own translator (the web's i18n, the server's `serverT(locale)`). `withDetail`
 * (the conversation itself) appends the failure's own detail under the line; a one-line
 * summary leaves it out.
 */
export function localizeAgentNotice(
  content: string,
  t: (key: string) => string,
  metadata?: Record<string, unknown> | null,
  opts: { withDetail?: boolean } = {},
): string {
  const code = agentNoticeCode(content, metadata)
  if (!code) return content
  const line = `⚠️ ${t(AGENT_NOTICE_I18N_KEYS[code])}`
  if (!opts.withDetail) return line
  const detail =
    agentNoticeDetail(content) ??
    (typeof metadata?.error === "string" ? safeAgentNoticeDetail(metadata.error) : null)
  return detail ? `${line}\n\n${detail}` : line
}
