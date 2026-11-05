// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Did a routine tick do its job? A tick that returns without throwing used to
// be recorded as succeeded even when it could not work at all: the support
// routine ran for two weeks with no tickets tool, reported "Blocked" in its run
// log, and every run read "succeeded". This judges the tick from what it
// actually did, the tool calls and the final text it posted in its output
// thread during the tick, and names the reason when it failed:
//
//   - a tool it called was unavailable ("No tool named ...", the SDK's
//     unavailable-tool refusal) and the run did not get past it. It got past
//     it when it later called that same tool successfully (a misspelt name the
//     model corrected), or when it carried on: a later tool call succeeded and
//     the run ended with output, and the refused tool was not one that writes
//     (a lookup it could do without, such as a skill it was told to read, a
//     web search or page fetch, or a name it made up). A refused WRITE tool is
//     the job's own action, so the run fails however it ends: the support
//     routine without its reply tool must not read "succeeded" because it added
//     a note instead. What counts as a write here is `isOutcomeWriteTool`
//     below, not the read-only-run marker: the web tools are kept out of
//     read-only runs because a URL can carry data out, yet they change nothing,
//     so a run that lacked one and carried on did its job. The discovery
//     helper kernel__tool_search is not a job tool: calling it where it does
//     not exist is noise, and a job tool it then lacks is caught by its own call;
//   - its final text declares it blocked ("Classification: Blocked", "Blocked:"
//     at the start of a line);
//   - its last turn did not end with an answer: it failed at the provider (an
//     in-band stream error, a refusal before or during the call, a thrown
//     stream: `finishReason: "error"`), or the runtime wrote its failure line
//     itself (`metadata.agentNotice`: spend cap, rate limit, credits ran out,
//     stopped before a final answer). Such a turn posted nothing the job asked
//     for; it used to read "succeeded" because it called no refused tool and
//     wrote no "Blocked" line. The run's error carries the failure's own detail
//     and code, never a generic line. Only the LAST turn counts: an earlier
//     turn that failed and a later one that answered is a run that did its job.
//
// A refused call the run got past, and a call whose input the tool's schema
// refused, are WARNINGS: logged with the routine's context, never the run's
// `error`, so a run that did its job is not reported to its owner as stopped.
import { agentNoticeCode, agentNoticeDetail, safeAgentNoticeDetail } from "@liaison/shared"
import { and, asc, eq, gte } from "drizzle-orm"
import { withPrivilegedDb } from "~/db/privileged"
import { messages } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { toolRegistry } from "~/modules/apps/app-registries"

const log = rootLogger.child({ module: "routine-tick-outcome" })

export interface TickToolCall {
  toolName?: string
  status?: string
  error?: { message?: string } | string | null
}

const UNAVAILABLE_RE =
  /No tool named "([^"]+)"|Model tried to call unavailable tool '?"?([A-Za-z0-9_:.-]+)/
/** The SDK's refusal of a call whose input failed the tool's schema. */
const INVALID_INPUT_RE = /Invalid input for tool|AI_InvalidToolInputError/
const DISCOVERY_TOOLS = new Set(["kernel__tool_search", "tool_search"])
/**
 * "Blocked" as the run's own verdict: at the start of a line, optionally after
 * a list marker and a Classification/Status/Outcome label, with markdown
 * emphasis anywhere in between. "the customer is blocked by" mid-sentence does
 * not match.
 */
const BLOCKED_RE =
  /(?:^|\n)[\s>*_-]*(?:(?:classification|status|outcome|result)[\s*_]*:[\s*_]*)?blocked\b/i

function errorText(e: TickToolCall["error"]): string {
  if (!e) return ""
  return typeof e === "string" ? e : String(e.message ?? "")
}

export interface TickOutcome {
  /** Why the run failed, or null when it did its job. */
  failure: string | null
  /** Refused calls the run got past: worth a log line, not a failed run. */
  warnings: string[]
}

const succeeded = (c: TickToolCall): boolean => !c.error && c.status !== "error"

/** Judge a tick from its tool calls and final text. Pure. */
export function judgeTickOutcome(input: {
  toolCalls: TickToolCall[]
  finalText: string
  /** True for a tool that writes. Unknown names (not registered) are not writes. */
  isWriteTool?: (sdkName: string) => boolean
}): TickOutcome {
  const calls = input.toolCalls
  const text = input.finalText ?? ""
  const endedWithOutput = text.trim().length > 0
  const warnings: string[] = []
  for (let i = 0; i < calls.length; i++) {
    const err = errorText(calls[i].error)
    const m = UNAVAILABLE_RE.exec(err)
    if (!m) {
      if (INVALID_INPUT_RE.test(err)) {
        warnings.push(`The input of a call to ${calls[i].toolName ?? "a tool"} was refused`)
      }
      continue
    }
    const name = m[1] ?? m[2] ?? calls[i].toolName ?? "unknown"
    if (DISCOVERY_TOOLS.has(name)) continue
    const later = calls.slice(i + 1)
    if (later.some((c) => c.toolName === name && succeeded(c))) continue
    const carriedOn =
      endedWithOutput &&
      later.some((c) => !DISCOVERY_TOOLS.has(c.toolName ?? "") && succeeded(c)) &&
      !(input.isWriteTool?.(name) ?? false)
    if (!carriedOn) {
      return { failure: `A tool the routine called was unavailable: ${name}`, warnings }
    }
    warnings.push(`A tool the routine called was unavailable: ${name}`)
  }
  if (BLOCKED_RE.test(text)) {
    const line = text.split("\n").find((l) => /blocked/i.test(l)) ?? "Blocked"
    return {
      failure: `The run reported itself blocked: ${line.replace(/[*_]/g, "").trim().slice(0, 300)}`,
      warnings,
    }
  }
  return { failure: null, warnings }
}

/**
 * How the failure of a turn that stopped (no error) before its final answer
 * starts. A turn that parked a gated call can end that way: the worker still
 * lets such a run wait for the decision (routine-worker.ts).
 */
export const TURN_STOPPED_EARLY = "The run's turn stopped before writing a final answer"

/** What the tick's last agent message says about how its turn ended. */
export interface TickLastTurn {
  content: string
  metadata: Record<string, unknown> | null
}

/**
 * Why the tick's last turn failed, or null when it ended with an answer. Pure.
 * A turn failed when it ended in an error (`finishReason: "error"`) or the
 * runtime wrote its failure line (`agentNotice`). The reason names the
 * failure's own detail (the provider's or the refusal's message, made safe to
 * show) and its code when the error carried one.
 */
export function judgeLastTurn(turn: TickLastTurn): string | null {
  const meta = turn.metadata ?? {}
  const errored = meta.finishReason === "error"
  const notice = agentNoticeCode(turn.content, meta)
  if (!errored && !notice) return null
  const detail =
    (typeof meta.error === "string" ? safeAgentNoticeDetail(meta.error) : null) ??
    agentNoticeDetail(turn.content)
  const code = typeof meta.errorCode === "string" && meta.errorCode ? meta.errorCode : null
  const what =
    notice === "credits_exhausted"
      ? "The run's turn stopped: credits ran out"
      : notice === "stopped_early"
        ? TURN_STOPPED_EARLY
        : notice === "provider_quota"
          ? "The run's turn failed: the AI service reached its spending cap"
          : notice === "provider_rate_limited"
            ? "The run's turn failed: the AI service was rate limited"
            : notice === "provider_unavailable"
              ? "The run's turn failed: the AI service stopped responding"
              : "The run's turn failed with an error"
  const tail = [detail, code ? `(code: ${code})` : null].filter(Boolean).join(" ")
  return tail ? `${what}: ${tail}` : what
}

/** The reason a tick failed, or null when it did its job. Pure. */
export function classifyTickOutcome(input: Parameters<typeof judgeTickOutcome>[0]): string | null {
  return judgeTickOutcome(input).failure
}

/** The fields of a registered tool that say whether it writes. */
export interface OutcomeToolDeclaration {
  readOnly?: boolean
  writesToTable?: string
  gated?: boolean
  gatedWhen?: unknown
  conditionalGate?: boolean
  taintSource?: boolean
}

/**
 * Is this tool, refused to a routine, the job's own write action? For the
 * outcome judge only; whether a tool may run in a read-only run is
 * `isReadOnlyTool` (runtime/read-only-run.ts), a stricter, egress-aware rule.
 *
 *   - a declared `writesToTable`, or any gate (`gated`, `gatedWhen`,
 *     `conditionalGate`: the call can park an approval), is a write;
 *   - an explicit `readOnly` is a read;
 *   - a KERNEL tool that is a `taintSource` and declares none of the above is a
 *     read: its job is to bring outside text into the turn (web_search,
 *     web_fetch). It is not marked `readOnly` on purpose, since its request is
 *     an outward channel, but it changes nothing. Only kernel code earns this:
 *     a manifest's `taintSource` is the app's own claim, and an MCP tool sends
 *     its arguments to a third party that may act on them;
 *   - anything else is a write (fail safe: an unmarked app tool may be one).
 */
export function isOutcomeWriteTool(app: string, def: OutcomeToolDeclaration): boolean {
  if (typeof def.writesToTable === "string") return true
  if (def.gated === true || def.gatedWhen !== undefined || def.conditionalGate === true) {
    return true
  }
  if (def.readOnly === true) return false
  return !(app === "kernel" && def.taintSource === true)
}

/** Whether `sdkName` (`app__tool`) is a registered tool of the org that writes. */
export function registeredWriteTool(orgId: string, sdkName: string): boolean {
  const sep = sdkName.indexOf("__")
  if (sep <= 0) return false
  const app = sdkName.slice(0, sep)
  const toolPart = sdkName.slice(sep + 2)
  for (const [key, def] of toolRegistry.entriesOf(orgId)) {
    if (key[1] !== app) continue
    if (key[2].replace(/[^a-zA-Z0-9_-]/g, "_") !== toolPart) continue
    return isOutcomeWriteTool(app, def)
  }
  return false
}

/**
 * Read what the tick posted in its output thread since it started (the
 * routine's agent messages: their tool calls and the last one's text) and
 * judge it.
 */
export async function judgeRoutineTick(
  orgId: string,
  threadId: string,
  since: Date,
): Promise<string | null> {
  const rows = await withPrivilegedDb(orgId, "routine-tick-outcome", (tx) =>
    tx
      .select({ content: messages.content, metadata: messages.metadata })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.authorType, "agent"),
          gte(messages.createdAt, since),
        ),
      )
      .orderBy(asc(messages.createdAt)),
  )
  if (rows.length === 0) return null
  const toolCalls: TickToolCall[] = []
  for (const r of rows) {
    const calls = (r.metadata as { toolCalls?: unknown } | null)?.toolCalls
    if (Array.isArray(calls)) toolCalls.push(...(calls as TickToolCall[]))
  }
  const last = rows[rows.length - 1]
  const finalText =
    typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "")
  // A turn that ended in an error did not do the job, whatever its tool calls say.
  const turnFailure = judgeLastTurn({
    content: finalText,
    metadata: (last.metadata as Record<string, unknown> | null) ?? null,
  })
  if (turnFailure) {
    log.warn({ orgId, threadId, failure: turnFailure }, "Routine tick's last turn failed")
    return turnFailure
  }
  const outcome = judgeTickOutcome({
    toolCalls,
    finalText,
    isWriteTool: (name) => registeredWriteTool(orgId, name),
  })
  if (outcome.warnings.length > 0) {
    log.warn(
      { orgId, threadId, warnings: outcome.warnings, failed: outcome.failure !== null },
      "Routine tick refused some tool calls",
    )
  }
  return outcome.failure
}
