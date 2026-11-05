// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SESSION'S HOST TOOLS (S5, S6, S10; D1).
//
// A node session ends Done only on an explicit signal. The session gives it
// itself through two tools of an in-process MCP server the sidecar passes to
// every run, `liaison_session`:
//
// - `mark_done {summary, prUrl?}`: the task is finished (S57: with the pull
//   request it opened, https only);
// - `needs_you {reason, code?}`: the session needs the person (A29: `code`
//   `push_failed` when the push or the pull request failed).
//
// Each call sets the run's completion latch (the later call wins) and says so
// in the transcript (`system` `marked_done` / `marked_needs_you`). The latch
// is read when the run ends (`job_done.completion`) and cleared when an owner
// message is delivered (the next turn decides again). Nothing here reads the
// model's text: the tool call is the only input.

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import {
  HOST_MCP_SERVER,
  type NodeSessionCompletion,
  nodeSessionCompletionSchema,
} from "../../../packages/shared/src/node-session-protocol"

/** The longest summary or reason the latch and the transcript keep. */
const MAX_TEXT = 300

/** What each tool answers the model with: fixed text, never the input. */
export const HOST_TOOL_REPLIES = {
  mark_done: "Recorded. The session ends Done when this turn ends.",
  needs_you: "Recorded. The session ends Needs you when this turn ends.",
} as const

/** The two lines the system prompt's append carries so the session uses them. */
export const HOST_TOOL_LINES = [
  `When the task is finished, call mcp__${HOST_MCP_SERVER}__mark_done with a one-line summary.`,
  `If you need the person, call mcp__${HOST_MCP_SERVER}__needs_you with the reason, then end your turn.`,
] as const

/** The one reason code a session may name itself (A29). */
export const SESSION_REASON_CODES = ["push_failed"] as const

/** The tools' input shapes; the SDK validates every call against them. */
export const HOST_TOOL_INPUTS = {
  mark_done: {
    summary: z.string().max(MAX_TEXT),
    /** S57: https only, at most 500 characters (the completion's own rule). */
    prUrl: nodeSessionCompletionSchema.shape.prUrl,
  },
  needs_you: {
    reason: z.string().min(1).max(MAX_TEXT),
    code: z.enum(SESSION_REASON_CODES).optional(),
  },
}

export interface CompletionMark {
  by: "session" | "needs_you"
  summary?: string
  reason?: string
  prUrl?: string
  reasonCode?: (typeof SESSION_REASON_CODES)[number]
  at: string
}

/** The run's completion signal, latched until the run ends or an owner message is delivered. */
export class CompletionLatch {
  private mark: CompletionMark | null = null

  set(mark: CompletionMark): void {
    this.mark = mark
  }

  clear(): void {
    this.mark = null
  }

  /** The completion as `job_done` carries it; undefined when the run set none. */
  completion(): NodeSessionCompletion | undefined {
    if (!this.mark) return undefined
    const { by, summary, reason, prUrl, reasonCode } = this.mark
    return {
      by,
      ...(summary ? { summary } : {}),
      ...(reason ? { reason } : {}),
      ...(prUrl ? { prUrl } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    }
  }
}

export interface HostToolEvent {
  subtype: "marked_done" | "marked_needs_you"
  text: string
}

type Reply = { content: Array<{ type: "text"; text: string }> }
const reply = (text: string): Reply => ({ content: [{ type: "text", text }] })
const capped = (text: string | undefined) => (text ?? "").slice(0, MAX_TEXT)

/** The two handlers, apart from the server so they can be called directly. */
export function hostToolHandlers(latch: CompletionLatch, emit: (event: HostToolEvent) => void) {
  return {
    mark_done: async (args: { summary?: string; prUrl?: string }): Promise<Reply> => {
      const summary = capped(args.summary)
      latch.set({
        by: "session",
        summary,
        ...(args.prUrl ? { prUrl: args.prUrl } : {}),
        at: new Date().toISOString(),
      })
      emit({ subtype: "marked_done", text: summary })
      return reply(HOST_TOOL_REPLIES.mark_done)
    },
    needs_you: async (args: {
      reason: string
      code?: (typeof SESSION_REASON_CODES)[number]
    }): Promise<Reply> => {
      const reason = capped(args.reason)
      latch.set({
        by: "needs_you",
        reason,
        ...(args.code ? { reasonCode: args.code } : {}),
        at: new Date().toISOString(),
      })
      emit({ subtype: "marked_needs_you", text: reason })
      return reply(HOST_TOOL_REPLIES.needs_you)
    },
  }
}

/** The in-process `liaison_session` server of one run. */
export function hostTools(latch: CompletionLatch, emit: (event: HostToolEvent) => void) {
  const h = hostToolHandlers(latch, emit)
  return createSdkMcpServer({
    name: HOST_MCP_SERVER,
    version: "1.0.0",
    tools: [
      tool(
        "mark_done",
        "Call this when the task is finished, with a one-line summary of what was done and, when you opened a pull request, its https URL as prUrl. The session then ends Done when this turn ends.",
        HOST_TOOL_INPUTS.mark_done,
        (args) => h.mark_done(args),
      ),
      tool(
        "needs_you",
        "Call this when you need the person (a decision, an access, a blocker), with the reason, then end your turn; pass code push_failed when a push or a pull request failed. The session then ends Needs you.",
        HOST_TOOL_INPUTS.needs_you,
        (args) => h.needs_you(args),
      ),
    ],
  })
}
