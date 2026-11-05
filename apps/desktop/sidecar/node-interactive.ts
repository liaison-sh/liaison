// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN INTERACTIVE NODE CHAT TURN (P4 N-D T6b; spec-node.md "Profiles and
// unattended mode" S24, A24, A50/F9).
//
// The owner drives a chat that runs on their node from the web or the phone.
// One turn is one job, started by the shell with the same `--unattended <job
// file>` entry as an unattended job, the file saying `kind: "interactive"`:
//
// - The SDK session the chat ran in last time is RESUMED (`resume`), so the
//   chat keeps its context from turn to turn; the new session id goes back
//   with the result and the server keeps it for the next turn.
// - The chat's own permission mode (auto, manual, edit, plan), the same modes
//   and the same Auto policy as a desktop local session. BYPASS IS REFUSED:
//   nobody is at the computer to watch what a bypassed session does, so a job
//   naming it never starts, `allowDangerouslySkipPermissions` is false and a
//   mode change on the control line is refused.
// - A permission prompt is a `permission_request` line. The page relays it to
//   the owner (POST /api/nodes/jobs/:id/permission-requests, an Allow / Deny
//   card), waits for the decision (10 minutes, then deny) and answers with a
//   `permission_response` control line. Nothing is ever answered yes here.
// - Config isolation always, no setting source: a folder's own CLAUDE.md or
//   .claude hooks never run unseen in a remotely driven chat.
//
// - Each step (a tool call, its result) is a `turn_progress` line, which the
//   page relays (POST /api/nodes/jobs/:id/turn-progress) so the chat shows the
//   turn live, as it shows a cloud turn.
//
// The run ends with one `job_done` line, carrying `sdkSessionId`.

import { mkdirSync } from "node:fs"
import { userInfo } from "node:os"
import path from "node:path"
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import { autoAllows, liaisonOrigin } from "./auto-policy"
import {
  appDataDir,
  isolationEnv,
  prepareIsolatedConfig,
  realClaudeConfigDir,
} from "./config-isolation"
import {
  AsyncQueue,
  type CanUseTool,
  createPermissionBroker,
  guardRunnableEdits,
  type McpConfigFile,
  PERMISSION_MODE_REFUSED,
  sessionIdOf,
  userMessage,
} from "./index"
import { OutsideTextTracker, OutsideTextVerdicts } from "./outside-text"
import {
  DISALLOWED_SDK_TOOLS,
  guardHook,
  liaisonMcpServer,
  mapPermissionMode,
  readMcpConfig,
} from "./sdk-runner"
import {
  jobContextFor,
  type QueryFn,
  type Refusal,
  type UnattendedJob,
  type UnattendedOutcome,
  UsageCounter,
} from "./unattended"
import type { JobContext } from "./unattended-profile"

/** The modes a remotely driven node chat may run in (A24: never bypass). */
export const NODE_CHAT_MODES = ["auto", "manual", "edit", "plan"] as const
export type NodeChatMode = (typeof NODE_CHAT_MODES)[number]

export function isNodeChatMode(value: unknown): value is NodeChatMode {
  return typeof value === "string" && (NODE_CHAT_MODES as readonly string[]).includes(value)
}

/** Why a mode change is refused while a node chat turn runs. */
export const NODE_CHAT_MODE_FIXED = "NodeChatModeFixed"

export const BYPASS_UNAVAILABLE_REMOTE =
  "Bypass is not available for a chat that runs on your node: nobody is at the computer to watch what it does."

/** Where this turn runs, stated after the agent definition. */
export function interactiveRuntimeNote(ctx: JobContext, user: string): string {
  return [
    "# Where this turn runs",
    `You are running on ${user}'s computer, their Liaison node, in the folder ${ctx.agentDir}, on their own Claude account.`,
    "This chat is driven remotely: the person writes from the web, the phone or the desktop app and is not at this computer.",
    "Every permission question reaches them as an Allow / Deny card wherever they are; an unanswered one is denied after 10 minutes. Bypass is not available.",
    "Your final message is posted in the conversation as your answer.",
  ].join("\n")
}

function currentUser(): string {
  try {
    return userInfo().username || "the owner"
  } catch {
    return "the owner"
  }
}

export interface InteractiveOptionsDeps {
  mcp: McpConfigFile
  canUseTool: CanUseTool
  env: Record<string, string | undefined>
}

/** The SDK options one interactive turn runs with. Separated so a test can read every one. */
export function interactiveOptions(
  job: UnattendedJob,
  ctx: JobContext,
  deps: InteractiveOptionsDeps,
): Options {
  const mode = isNodeChatMode(job.permissionMode) ? job.permissionMode : "manual"
  const append = [
    job.agentDefinition || deps.mcp.agentDefinition || "",
    interactiveRuntimeNote(ctx, currentUser()),
  ]
    .filter(Boolean)
    .join("\n\n")
  return {
    cwd: ctx.agentDir,
    model: job.model,
    ...(job.resumeSessionId ? { resume: job.resumeSessionId } : {}),
    permissionMode: mapPermissionMode(mode),
    allowDangerouslySkipPermissions: false,
    settingSources: [],
    disallowedTools: [...DISALLOWED_SDK_TOOLS],
    systemPrompt: { type: "preset", preset: "claude_code", append },
    env: deps.env,
    mcpServers: job.mcpConfigPath ? { liaison: liaisonMcpServer(deps.mcp, job.mcpConfigPath) } : {},
    canUseTool: deps.canUseTool as Options["canUseTool"],
  }
}

/**
 * One step of the turn as the chat shows it while it runs: the tool, and the
 * command, file or address it acts on (never its other input, a file's content
 * for one). The server redacts secrets from it before anyone sees it.
 */
export function stepSummary(toolName: string, input: unknown): string {
  const fields = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const value =
    toolName === "Bash"
      ? fields.command
      : (fields.file_path ?? fields.path ?? fields.url ?? fields.pattern ?? fields.query)
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 200) : ""
}

/** The turn's steps in one SDK message: `turn_progress` events (tool calls and their results). */
export function progressEventsOf(message: unknown): Array<Record<string, unknown>> {
  const m = message as {
    type?: string
    message?: { content?: unknown }
  }
  if (m?.type !== "assistant" && m?.type !== "user") return []
  const content = Array.isArray(m.message?.content) ? m.message.content : []
  const events: Array<Record<string, unknown>> = []
  for (const block of content as Array<Record<string, unknown>>) {
    if (m.type === "assistant" && block?.type === "tool_use" && typeof block.id === "string") {
      const toolName = typeof block.name === "string" ? block.name : ""
      if (!toolName) continue
      events.push({
        type: "tool_call",
        id: block.id,
        toolName,
        summary: stepSummary(toolName, block.input),
      })
    } else if (
      m.type === "user" &&
      block?.type === "tool_result" &&
      typeof block.tool_use_id === "string"
    ) {
      events.push({ type: "tool_result", id: block.tool_use_id, isError: block.is_error === true })
    }
  }
  return events
}

export interface InteractiveOutcome extends UnattendedOutcome {
  sdkSessionId?: string | null
}

export interface RunInteractiveArgs {
  job: UnattendedJob
  emit: (event: Record<string, unknown>) => void
  control?: AsyncIterable<string>
  cliPath?: string | null
  queryFn?: QueryFn
  platform?: NodeJS.Platform
  sourceEnv?: Record<string, string | undefined>
  /** The app's data dir, where each SDK session's outside-text verdict is kept. */
  dataDir?: string
}

export async function runInteractiveJob(args: RunInteractiveArgs): Promise<InteractiveOutcome> {
  const { job, emit } = args
  const ctx = jobContextFor(job, args.platform ?? process.platform)
  const refusals: Refusal[] = []
  const counter = new UsageCounter(job.hardTokenLimit)
  let sdkSessionId: string | null = null
  let ranOn: string | null = null
  const finish = (
    outcome: Omit<InteractiveOutcome, "refusals" | "usage" | "sdkSessionId">,
  ): InteractiveOutcome => {
    const full = {
      ...outcome,
      refusals,
      usage: counter.snapshot(),
      sdkSessionId,
      model: ranOn ?? job.model,
    }
    emit({ type: "job_done", jobId: job.jobId, ...full })
    return full
  }

  // A24, on this side too: whatever the server sent, a remotely driven chat
  // never runs bypassed, and an unknown mode never falls through to a default.
  if (!isNodeChatMode(job.permissionMode)) {
    return finish({
      status: "refused",
      code: "error",
      text: "",
      error:
        job.permissionMode === "bypass"
          ? BYPASS_UNAVAILABLE_REMOTE
          : `Unknown permission mode for a node chat: ${String(job.permissionMode)}.`,
    })
  }
  if (!job.mcpConfigPath) {
    return finish({
      status: "refused",
      code: "auth_required",
      text: "",
      error: "No Liaison connection for this agent on this node.",
    })
  }
  const mcp = readMcpConfig(job.mcpConfigPath)
  mkdirSync(ctx.agentDir, { recursive: true, mode: 0o700 })
  const mode = job.permissionMode

  const sourceEnv = args.sourceEnv ?? process.env
  // Isolation ALWAYS: the owner's own Claude Code connectors never reach a
  // chat driven from elsewhere. Created on first use, like a local session's.
  const env = args.queryFn
    ? { ...sourceEnv }
    : { ...sourceEnv, ...isolationEnv(prepareIsolatedConfig().dir) }

  // Outside text read in this turn keeps Auto asking before shell commands for
  // the rest of it (outside-text.ts). A RESUMED chat carries the earlier turns'
  // tool results in its context, which this process never saw: it starts from
  // the verdict the last turn of that SDK session kept, in the app's data dir
  // (never the agent's folder), and as marked when there is none.
  const dataDir = args.dataDir ?? (args.queryFn ? undefined : appDataDir())
  // The server this node is bound to: a fetch from it reads the organisation's
  // own data, fenced by the server (auto-policy.ts `fetchesOnlyFromOwnServer`).
  const ownOrigin = liaisonOrigin(job.server)
  const outsideText = new OutsideTextTracker(ctx.agentDir, {
    resumed: Boolean(job.resumeSessionId),
    resumeSessionId: job.resumeSessionId,
    ...(dataDir ? { verdicts: new OutsideTextVerdicts(path.join(dataDir, "outside-text")) } : {}),
    configDir: realClaudeConfigDir(env),
    ownOrigin,
  })
  const permissions = createPermissionBroker(
    (event) => emit({ ...event, jobId: job.jobId }),
    (toolName, input, context) =>
      mode === "auto" &&
      autoAllows(toolName, input, ctx.agentDir, context, {
        readOutsideText: outsideText.readOutsideText,
        ownOrigin,
      }),
  )
  const guard = guardRunnableEdits(
    () => mode === "auto" && outsideText.readOutsideText,
    ctx.agentDir,
    permissions,
  )
  const options = interactiveOptions(job, ctx, { mcp, canUseTool: permissions.canUseTool, env })
  options.hooks = { PreToolUse: [guardHook(guard)] }
  if (args.cliPath) options.pathToClaudeCodeExecutable = args.cliPath

  const prompts = new AsyncQueue<SDKUserMessage>()
  prompts.push(userMessage(job.prompt) as SDKUserMessage)
  const run = (args.queryFn ?? ((a) => sdkQuery(a)))({ prompt: prompts, options })

  let stop = null as "aborted" | "token_limit" | null
  let lastText = ""
  const control = args.control
  if (control) {
    void (async () => {
      for await (const line of control) {
        if (!line.trim()) continue
        let parsed: {
          type?: string
          mode?: string
          requestId?: string
          behavior?: "allow" | "deny"
          message?: string
        }
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (parsed.type === "permission_response" && typeof parsed.requestId === "string") {
          // The owner's answer; anything but an explicit allow is a deny.
          permissions.resolve(
            parsed.requestId,
            parsed.behavior === "allow" ? "allow" : "deny",
            parsed.message ?? "denied by the owner",
          )
        } else if (parsed.type === "set_permission_mode") {
          emit({ type: PERMISSION_MODE_REFUSED, mode: parsed.mode, reason: NODE_CHAT_MODE_FIXED })
        } else if (parsed.type === "abort" || parsed.type === "shutdown") {
          stop = stop ?? "aborted"
          permissions.failClosed()
          prompts.close()
          run.close()
          return
        }
      }
      // The shell is gone: nobody can answer a prompt any more.
      permissions.failClosed()
    })()
  }

  type ResultLike = {
    subtype?: string
    result?: string
    permission_denials?: Array<{ tool_name?: string; tool_input?: Record<string, unknown> }>
    errors?: string[]
  }
  let result = null as ResultLike | null
  try {
    for await (const message of run) {
      if (stop) break
      counter.add(message)
      outsideText.observe(message)
      sdkSessionId = sessionIdOf(message) ?? sdkSessionId
      const m = message as {
        type?: string
        subtype?: string
        model?: string
        message?: { content?: Array<{ type?: string; text?: string }> }
      }
      if (m.type === "system" && m.subtype === "init" && typeof m.model === "string") {
        ranOn = m.model
      }
      // The chat shows the turn's steps as they happen (the shell relays them).
      const steps = progressEventsOf(message)
      if (steps.length > 0) emit({ type: "turn_progress", jobId: job.jobId, events: steps })
      if (m.type === "assistant") {
        const text = (m.message?.content ?? [])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join("")
        if (text) lastText = text
      }
      if (m.type === "result") {
        result = message as unknown as ResultLike
        prompts.close()
        break
      }
      if (counter.exceeded) {
        stop = "token_limit"
        permissions.failClosed()
        await run.interrupt().catch(() => undefined)
        run.close()
        break
      }
    }
  } catch (error) {
    if (!stop) {
      permissions.failClosed()
      return finish({
        status: "error",
        code: "error",
        text: lastText,
        error: (error as Error).message || String(error),
      })
    }
  } finally {
    prompts.close()
  }
  permissions.failClosed()

  if (stop === "aborted") return finish({ status: "aborted", text: lastText })
  if (stop === "token_limit") {
    return finish({
      status: "token_limit",
      code: "token_limit",
      text: `${lastText}\n\nStopped: this turn reached its hard limit of ${job.hardTokenLimit} tokens (${counter.snapshot().totalTokens} used).`.trim(),
    })
  }
  if (!result) {
    return finish({
      status: "error",
      code: "error",
      text: lastText,
      error: "the run ended without a result",
    })
  }
  // What the owner (or the 10 minute deadline) denied, listed with the answer.
  for (const denial of result.permission_denials ?? []) {
    const tool = String(denial.tool_name ?? "")
    refusals.push({ tool, reason: `${tool}: denied by the owner` })
  }
  if (result.subtype !== "success") {
    return finish({
      status: "error",
      code: "error",
      text: lastText,
      error: (result.errors ?? []).join("; ") || String(result.subtype),
    })
  }
  return finish({
    status: "done",
    text: typeof result.result === "string" ? result.result : lastText,
  })
}
