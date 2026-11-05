// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Builds the assembled context (system prompt + initial user message) for a
// sub-agent run. Unlike `modules/agent/context/context.ts` for the chat agent, this
// does NOT pull thread history — sub-runs start with a fresh context window
// containing only the role's system prompt, any role-attached skill bodies,
// and the structured input payload supplied by the parent's spawnAgent call.
//
// PROMPT CACHE: the request carries the main loop's two Anthropic breakpoints
// (subRunPrompt below). The role's prompt, its skills and the deferred-tool
// catalog are the same for every run of the role and every step of a run, so
// they form one stable system block marked for the cache; the structured input
// differs per run and rides in a second, unmarked system block; the dispatch
// prompt is the one user message, marked too, so each step of the run re-reads
// system + prompt from the cache and pays only for the tool results after it.
// Before this the whole system was one plain string with no breakpoint:
// every step of every sub-run re-billed its full prefix at the input rate.

import type { ActorContext } from "~/db/rls"
import { resolveAnthropicCacheTtl } from "~/modules/agent/providers/anthropic-cache-ttl"

export interface AssembleSubRunContextParams {
  run: {
    prompt: string
    input: unknown
    subagentType: string
    threadId: string
  }
  def: {
    systemPrompt: string
    skills: string[]
    mcpServers: string[]
  }
  orgId: string
  actor: ActorContext
}

export interface AssembledSubRunContext {
  /** Same for every run of the role: its prompt, skills and dispatch line. */
  stableSystem: string
  /** This run's structured input, or null when there is none. */
  inputSystem: string | null
  /** The parent's dispatch prompt: the run's one user message. */
  prompt: string
}

export interface SubRunSystemPart {
  role: "system"
  content: string
  providerOptions?: {
    anthropic: { cacheControl: { type: "ephemeral"; ttl: "5m" | "1h" } }
  }
}

export async function assembleSubRunContext(
  params: AssembleSubRunContextParams,
): Promise<AssembledSubRunContext> {
  const sections: string[] = [params.def.systemPrompt]

  // Skills bodies are stored as plain strings on the role definition row
  // for v1 — the loader in skill-loader.ts reads from disk for the chat
  // agent. For sub-agents we keep the skills as names only and rely on
  // the role's systemPrompt to embed instructions. A future iteration
  // can resolve skill bodies via a per-org skills registry.
  if (params.def.skills.length > 0) {
    sections.push(`## Skills available\n\n${params.def.skills.map((s) => `- ${s}`).join("\n")}`)
  }

  sections.push(
    `## Your input\n\nYou were dispatched as a \`${params.run.subagentType}\` sub-agent.`,
  )

  return {
    stableSystem: sections.join("\n\n"),
    inputSystem:
      params.run.input !== null && params.run.input !== undefined
        ? `Structured input payload:\n\n\`\`\`json\n${JSON.stringify(params.run.input, null, 2)}\n\`\`\``
        : null,
    prompt: params.run.prompt,
  }
}

/**
 * The run's `system` and `messages` for runAgentStream, with the cache
 * breakpoints set. `extraStable` (the deferred-tool catalog) joins the stable
 * block: it depends on the org's apps, not on the run.
 */
export function subRunPrompt(
  context: AssembledSubRunContext,
  extraStable?: string,
): {
  system: SubRunSystemPart[]
  messages: Array<{
    role: "user"
    content: string
    providerOptions: SubRunSystemPart["providerOptions"]
  }>
} {
  const cache = {
    anthropic: { cacheControl: { type: "ephemeral" as const, ttl: resolveAnthropicCacheTtl() } },
  }
  const stable = extraStable ? `${context.stableSystem}\n\n${extraStable}` : context.stableSystem
  return {
    system: [
      { role: "system", content: stable, providerOptions: cache },
      ...(context.inputSystem ? [{ role: "system" as const, content: context.inputSystem }] : []),
    ],
    messages: [{ role: "user", content: context.prompt, providerOptions: cache }],
  }
}
