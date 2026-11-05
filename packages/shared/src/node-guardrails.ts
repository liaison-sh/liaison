// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE GUARDRAIL LEVEL OF A NODE PROFILE (D18): the suggestion for an agent's
// model and the risk note shown at setup. What each level allows is the level
// table (node-levels.ts), the one definition the API, the web settings and the
// desktop node all read.

import { isNodeLevel, NODE_DEFAULT_LEVEL, NODE_LEVELS, type NodeLevel } from "./node-levels"

// The level names live in the level table (node-levels.ts); these are the
// older names of the same values, still read by the settings and the API.
export const NODE_GUARDRAIL_LEVELS = NODE_LEVELS
export type NodeGuardrailLevel = NodeLevel

/** A profile with no level runs Strict: the narrowest, as every profile did before D18. */
export const NODE_DEFAULT_GUARDRAIL: NodeGuardrailLevel = NODE_DEFAULT_LEVEL

export const isNodeGuardrailLevel = isNodeLevel

/**
 * The level suggested for an agent's model (D18): Standard for a frontier
 * model (Opus or Fable class), Strict for everything else, a small, cheap
 * model (Haiku), a model we cannot place, or Auto (null). Open is never
 * suggested.
 */
export function suggestedNodeGuardrail(modelId: string | null | undefined): NodeGuardrailLevel {
  const id = (modelId ?? "").toLowerCase()
  if (/(^|[-/.])(opus|fable)([-.]|$)/.test(id)) return "standard"
  return "strict"
}

/**
 * The risk note (D18), in a few plain sentences, shown at setup in the
 * settings and carried by the agent tools that set up node work. Agent-neutral,
 * and it names no hosting provider's settings (D20, L13).
 */
export function nodeGuardrailRiskNote(suggested: NodeGuardrailLevel): string {
  return [
    "Untrusted input (mail, tickets, web pages) can steer any model running on your computer, and small, cheap models more easily; guardrails cost some efficiency, so they are recommended on cheap models like Haiku.",
    "On Strict and Standard, a determined prompt-injected session can still push to the default branch from a script; the pre-push hook refuses it, but a script can get past it.",
    `Suggested level for this agent's model: ${suggested === "standard" ? "Standard" : "Strict"}.`,
  ].join(" ")
}
