// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `kernel:spawn_agent` tool handler — the LLM-driven entry point into the
// sub-agent dispatch primitive (Task 6).
//
// Plumbing:
//  1. Reconstruct an `ActorContext` from the tool's `AppContext` (the kernel
//     execute-tool wrapper injects `userId`/`orgId`/`scopes`/`actorType`).
//  2. Read the parent's run frame from `runContextStore` (set by
//     `runAgentChat` for chat parents and by `subrun-worker` for nested
//     spawns) so the new `agent_runs` row points at the right parent.
//  3. Call `spawnAgent` with the role + caller params, then `awaitResult()`.
//  4. Return the structured `SubRunResult` to the LLM so it can decide what
//     to do next (post a summary, kick off another spawn, etc.).
//
// The tool is registered unconditionally in `kernel-tools.ts`. `agent.spawn`
// is a kernel-universal capability (see `KERNEL_CAPABILITIES` in
// app-registries), so `tool-bridge`'s capability gate always passes and
// `spawn_agent` surfaces in every org with no app install required.

import type { ActorContext } from "~/db/rls"
import { rootLogger } from "~/lib/logger"
import { currentRunContext } from "~/modules/agent/runtime/run-context"
import type { SubRunResult } from "~/modules/agent/subruns/spawn-agent"
import { spawnAgent } from "~/modules/agent/subruns/spawn-agent"

const log = rootLogger.child({ module: "spawn-agent-tool" })

/**
 * Thrown when `spawn_agent` is invoked outside an in-process agent execution
 * thread. This is an EXPECTED caller-context error, not a bug: `spawn_agent`
 * is excluded from the outbound MCP gateway projection (`requiresAgentExecutionThread`
 * in app-registries.ts) precisely because it can never succeed from an
 * external MCP client, so reaching this guard means something in-process
 * called it without the thread frame set up — a caller mistake, not an
 * unexpected exception. `execute-tool.ts`'s catch recognizes `code` and logs
 * at warn (matching this module's own `log.warn` above the throw) instead of
 * error, so a mere caller-context mistake does not page the on-call operator.
 */
export class SpawnAgentContextError extends Error {
  readonly code = "invalid_context" as const
  readonly retryable = false as const
  constructor(message: string) {
    super(message)
    this.name = "SpawnAgentContextError"
  }
}

interface SpawnAgentToolParams {
  subagent_type: string
  description: string
  prompt: string
  input?: unknown
  scopes?: string[]
  output_schema?: Record<string, unknown>
  continue_on_error?: boolean
  max_steps?: number
  timeout_ms?: number
}

interface SpawnAgentToolCtx {
  userId: string
  orgId: string
  actorType: "user" | "agent" | "mcp"
  scopes?: string[]
  dimensionGrants?: Record<string, string[]>
  agentExecutionThreadId?: string
  /** The calling turn's stop (the AI SDK's abortSignal for this tool call). */
  abortSignal?: AbortSignal
}

export async function handleSpawnAgent(
  params: unknown,
  ctx: SpawnAgentToolCtx,
): Promise<SubRunResult> {
  const args = params as SpawnAgentToolParams

  // Reconstruct the caller's ActorContext. The tool only fires from in-app
  // agent loops (actorType==='agent' from `executeWrapper`'s 'in-app-agent'
  // origin), which always carry a `userId` — we mirror that into the
  // `UserContext` shape `spawnAgent` consumes.
  const actor: ActorContext = {
    actorType: "user",
    userId: ctx.userId,
    orgId: ctx.orgId,
    scopes: ctx.scopes ?? [],
    dimensionGrants: ctx.dimensionGrants ?? {},
  }

  const parent = currentRunContext()
  // `agentExecutionThreadId` is the agent's surface thread (chat root) — the
  // hidden subrun thread is created inside `spawnAgent`.
  const parentThreadId = ctx.agentExecutionThreadId
  if (!parentThreadId) {
    log.warn(
      { runId: parent?.runId, orgId: ctx.orgId },
      "spawn_agent called outside an agent execution thread",
    )
    throw new SpawnAgentContextError(
      "kernel__spawn_agent requires an active agent execution thread (ctx.agentExecutionThreadId missing)",
    )
  }

  const handle = await spawnAgent({
    parentRun: {
      // A root turn's run id names no agent_runs row (only sub-runs have one), so only a
      // sub-run caller is recorded as the parent (as the sandbox bridge's spawn does).
      id: parent && parent.nestingDepth > 0 ? parent.runId : null,
      threadId: parentThreadId,
      actor,
      nestingDepth: parent?.nestingDepth ?? 0,
      ...(parent && parent.nestingDepth > 0 ? { rootRunId: parent.rootRunId } : {}),
    },
    subagentType: args.subagent_type,
    description: args.description,
    prompt: args.prompt,
    input: args.input,
    scopes: args.scopes,
    outputSchema: args.output_schema,
    continueOnError: args.continue_on_error,
    maxSteps: args.max_steps,
    timeoutMs: args.timeout_ms,
  })

  // Stopping the turn that waits here ends the sub-run (and what it spawned) with it.
  return await handle.awaitResult(ctx.abortSignal ? { signal: ctx.abortSignal } : {})
}
