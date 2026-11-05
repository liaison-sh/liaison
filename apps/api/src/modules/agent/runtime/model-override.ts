// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Which model an agent's turn actually asks for.
 *
 * An agent carries a DEFAULT (`agents.model_preference`, set on the agent's
 * settings page). A conversation may override it (`threads.agent_model_id`),
 * because the same agent is worth a different model in different places: an
 * oracle on a laptop through Claude Code, the same oracle on a phone through a
 * cheap fast model. The override is per conversation and applies from the next
 * turn; clearing it falls back to the agent's default, and only then to the
 * org's auto-select.
 *
 * Pure on purpose: precedence is a rule, not a query.
 */
export function resolveEffectiveAgentModel(params: {
  /** The conversation's override, null when none is set. */
  threadModelId?: string | null
  /** The agent's own default. */
  agentModelPreference?: string | null
}): string | null {
  return params.threadModelId ?? params.agentModelPreference ?? null
}

/**
 * Whether a user may pin this conversation to `modelId`. Clearing the override
 * (null) is always allowed: it asks for less, not more. Anything else must be
 * a model the ORG can actually call, which is the same list the picker offers
 * (`GET /credits/models`): a model whose provider has no key, or one the plan
 * does not reach, would fail at send time and leave the conversation pinned to
 * a model that can never answer.
 */
export function isModelSelectable(
  modelId: string | null | undefined,
  availableModelIds: readonly string[],
): boolean {
  if (modelId === null || modelId === undefined) return true
  return availableModelIds.includes(modelId)
}
