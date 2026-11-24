// SPDX-License-Identifier: FSL-1.1-ALv2
import { isScopeCovered } from "~/modules/agent/scopes/scope-coverage"

/**
 * Reads a tool performs before it acts, which its `requiredScopes` (the scope that gates the call)
 * does not list. A routine runs capped to its own scopes, so without these every tick fails: the
 * mail reply and forward preflights read the conversation and its mailbox account, compose reads the
 * mailbox it sends from ("Conversation account not found or inaccessible", walks 2026-10-09 and
 * 2026-10-12). `routine_tool_scopes` returns them with the tool, so the list the user approves runs,
 * and a routine template that names one of these tools must carry them (routine-templates.guard.test).
 */
export const ROUTINE_TOOL_RUN_READS: Readonly<Record<string, readonly string[]>> = {
  mail__reply: ["mail:conversations:read", "mail:accounts:read"],
  mail__forward: ["mail:conversations:read", "mail:accounts:read"],
  mail__compose: ["mail:accounts:read"],
}

/**
 * The run reads a template lacks for the tools its text names (`mail__compose`, or `mail:compose`),
 * as `tool: scope`. A `:write` scope runs with its own `:read` beside it (`routineRunScopes`).
 */
export function missingRunReads(template: { text: string; scopes: readonly string[] }): string[] {
  const held = template.scopes.flatMap((s) =>
    s.endsWith(":write") ? [s, `${s.slice(0, -":write".length)}:read`] : [s],
  )
  const out: string[] = []
  for (const [tool, reads] of Object.entries(ROUTINE_TOOL_RUN_READS)) {
    const named = new RegExp(`\\b${tool.replace("__", "(?:__|:)")}\\b`)
    if (!named.test(template.text)) continue
    for (const read of reads) if (!isScopeCovered([read], held)) out.push(`${tool}: ${read}`)
  }
  return out
}
