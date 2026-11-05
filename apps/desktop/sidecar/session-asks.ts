// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A SESSION'S WAITING REQUESTS AND THE OWNER'S ANSWERS (P3-T08; S9, S12,
// S14, D39, L6, L17).
//
// A permission request outside the level, an AskUserQuestion or an
// ExitPlanMode waits in canUseTool for the owner, with no timeout anywhere:
// only the owner's decision, a Stop, the SDK withdrawing the call or the
// process ending settles it. Each settlement emits one `decision` event.
//
// - Allow once: the call goes on with its original input.
// - Allow for this session (G2): also a node-side rule for the session's life,
//   kept in `<sessionDir>/allowed.json`: the same tool on the same target (a
//   file tool: the file's directory; WebFetch: the host; WebSearch: any;
//   `git push <remote> <branch>`: that remote and branch; any other call: its
//   exact input). An SDK allow rule would change nothing, since the guard's
//   own `ask` comes first (CV2).
// - Deny: the CLI writes a denied tool_result and the turn goes on (S14).
// - An answer fills AskUserQuestion's `answers`, keyed by question text.
// - Approving a plan leaves plan mode: the one `setMode` other than plan an
//   answer may carry (G3). Every other path keeps the rule that an answer
//   never switches the mode (bypass and acceptEdits above all).

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import type { NodeSessionCommand } from "../../../packages/shared/src/node-session-protocol"
import type { CommandResult } from "./session-control"
import { realTargetFrom } from "./unattended-profile"

/**
 * An answer to a waiting request never switches the session's permission mode,
 * except into plan: a `setMode` to anything else (bypass above all) is dropped.
 * `planExit` lets exactly one `setMode` to default through, for an approved
 * plan (G3).
 */
export function sanitizePermissionResult(
  result: PermissionResult,
  opts: { planExit?: boolean } = {},
): PermissionResult {
  if (result.behavior !== "allow" || !result.updatedPermissions) return result
  return {
    ...result,
    updatedPermissions: result.updatedPermissions.filter(
      (u) =>
        u.type !== "setMode" ||
        u.mode === "plan" ||
        (opts.planExit === true && u.mode === "default" && u.destination === "session"),
    ),
  }
}

export type AskKind = "permission" | "question" | "plan"

export interface AskInfo {
  tool: string
  input: Record<string, unknown>
  kind: AskKind
}

export type DecisionOutcome = "allow" | "allow_session" | "deny" | "answered" | "expired"
export type DecisionBy = "owner" | "stop" | "process_exit"

export interface DecisionPayload {
  requestId: string
  outcome: DecisionOutcome
  by: DecisionBy
}

/** Where a session's relative and `~` paths resolve: as its guard resolves them. */
export interface RuleBase {
  home: string
  cwd: string
}

/**
 * G2's target of a call: what "the same" means for Allow for this session. A
 * file's directory is the one the guard decides on (P3-fix m5): relative to
 * the session's folder, `~` expanded, symlinks resolved; a spelling the guard
 * refuses (a `..`) matches only its exact input.
 */
export function ruleTarget(tool: string, input: Record<string, unknown>, base?: RuleBase): string {
  const filePath = input.file_path ?? input.notebook_path ?? input.path
  if (
    ["Write", "Edit", "MultiEdit", "NotebookEdit", "Read"].includes(tool) &&
    typeof filePath === "string" &&
    filePath.length > 0
  ) {
    const real = base ? realTargetFrom(filePath, base.home, base.cwd) : path.resolve(filePath)
    if (!real) return `input:${JSON.stringify(input)}`
    return `dir:${path.dirname(real)}`
  }
  if (tool === "WebFetch" && typeof input.url === "string") {
    try {
      return `host:${new URL(input.url).host.toLowerCase()}`
    } catch {
      return `input:${JSON.stringify(input)}`
    }
  }
  if (tool === "WebSearch") return "any"
  if (tool === "Bash" && typeof input.command === "string") {
    const push =
      /^\s*git\s+push\s+(?:-u\s+|--set-upstream\s+)?([A-Za-z0-9._-]+)\s+([A-Za-z0-9._/-]+)\s*$/.exec(
        input.command,
      )
    if (push) return `push:${push[1]} ${push[2]}`
    return `command:${input.command}`
  }
  return `input:${JSON.stringify(input)}`
}

interface Rule {
  tool: string
  target: string
}

/** G2: the session's Allow for this session rules, persisted so a resumed run keeps them. */
export class SessionRules {
  private readonly rules: Rule[] = []
  private readonly file: string | null

  constructor(
    sessionDir?: string,
    private readonly base?: RuleBase,
  ) {
    this.file = sessionDir ? path.join(sessionDir, "allowed.json") : null
    if (this.file && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown
        if (Array.isArray(raw)) {
          for (const r of raw) {
            if (r && typeof r.tool === "string" && typeof r.target === "string") {
              this.rules.push({ tool: r.tool, target: r.target })
            }
          }
        }
      } catch {
        // An unreadable file holds no rule: the owner is asked again.
      }
    }
  }

  match(tool: string, input: Record<string, unknown>): boolean {
    const target = ruleTarget(tool, input, this.base)
    return this.rules.some((r) => r.tool === tool && r.target === target)
  }

  add(tool: string, input: Record<string, unknown>): void {
    if (this.match(tool, input)) return
    this.rules.push({ tool, target: ruleTarget(tool, input, this.base) })
    if (!this.file) return
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.rules), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

interface Waiting extends AskInfo {
  settle: (result: PermissionResult, decision: DecisionPayload, planExit?: boolean) => void
}

type DecisionCommand = Extract<NodeSessionCommand, { type: "permission_decision" | "answer" }>

/**
 * The session's waiting requests (S12, D39). No timer: a request waits until
 * the owner, a Stop, the SDK or the process ending settles it.
 */
export class SessionAsks {
  private readonly waiting = new Map<string, Waiting>()
  /** Each settlement's `decision` event (set by the run). */
  onDecision: ((decision: DecisionPayload) => void) | null = null
  /** G2's rules (set by the run, from the session dir). */
  rules: SessionRules = new SessionRules()

  ask(requestId: string, info?: AskInfo | null, signal?: AbortSignal): Promise<PermissionResult> {
    return new Promise((resolve) => {
      const settle: Waiting["settle"] = (result, decision, planExit) => {
        if (!this.waiting.has(requestId)) return
        this.waiting.delete(requestId)
        this.onDecision?.(decision)
        resolve(sanitizePermissionResult(result, { planExit: planExit === true }))
      }
      this.waiting.set(requestId, {
        tool: info?.tool ?? "",
        input: info?.input ?? {},
        kind: info?.kind ?? "permission",
        settle,
      })
      // The SDK withdrew the call: it is no longer waiting on anyone.
      signal?.addEventListener(
        "abort",
        () =>
          settle(
            { behavior: "deny", message: "The request was withdrawn.", interrupt: true },
            { requestId, outcome: "expired", by: "process_exit" },
          ),
        { once: true },
      )
    })
  }

  /** True when the id named a request that was still waiting. */
  resolve(
    requestId: string,
    result: PermissionResult,
    decision: Omit<DecisionPayload, "requestId"> = { outcome: "allow", by: "owner" },
  ): boolean {
    const w = this.waiting.get(requestId)
    if (!w) return false
    w.settle(result, {
      requestId,
      ...(result.behavior === "deny" && decision.outcome === "allow"
        ? { outcome: "deny" as const, by: decision.by }
        : decision),
    })
    return true
  }

  pending(): string[] {
    return [...this.waiting.keys()]
  }

  /** The open requests in the order they came. */
  open(): Array<AskInfo & { requestId: string }> {
    return [...this.waiting.entries()].map(([requestId, w]) => ({
      requestId,
      tool: w.tool,
      input: w.input,
      kind: w.kind,
    }))
  }

  /** Denies every waiting request with `interrupt` (a Stop, the process ending). */
  denyAll(message: string, decision: Omit<DecisionPayload, "requestId">): void {
    for (const id of this.pending()) {
      this.waiting
        .get(id)
        ?.settle({ behavior: "deny", message, interrupt: true }, { requestId: id, ...decision })
    }
  }

  /** The owner's `permission_decision` or `answer` (S9). */
  decide(command: DecisionCommand): CommandResult {
    const { requestId } = command.payload
    const w = this.waiting.get(requestId)
    if (!w) return { outcome: "noop" }
    const owner = (outcome: DecisionOutcome): DecisionPayload => ({
      requestId,
      outcome,
      by: "owner",
    })
    if (command.type === "answer") {
      if (w.kind !== "question") return { outcome: "noop" }
      w.settle(
        { behavior: "allow", updatedInput: { ...w.input, answers: command.payload.answers } },
        owner("answered"),
      )
      return { outcome: "applied" }
    }
    const { allow, scope } = command.payload
    if (w.kind === "plan") {
      if (allow) {
        w.settle(
          {
            behavior: "allow",
            updatedInput: w.input,
            updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }],
          },
          owner("allow"),
          true,
        )
      } else w.settle({ behavior: "deny", message: "Keep planning." }, owner("deny"))
      return { outcome: "applied" }
    }
    if (w.kind === "question") {
      // A question is answered, or dismissed with a deny; never "allowed".
      if (allow) return { outcome: "noop" }
      w.settle({ behavior: "deny", message: "Denied by the owner." }, owner("deny"))
      return { outcome: "applied" }
    }
    if (!allow) {
      w.settle({ behavior: "deny", message: "Denied by the owner." }, owner("deny"))
      return { outcome: "applied" }
    }
    if (scope === "session") this.rules.add(w.tool, w.input)
    w.settle(
      { behavior: "allow", updatedInput: w.input },
      owner(scope === "session" ? "allow_session" : "allow"),
    )
    return { outcome: "applied" }
  }
}
