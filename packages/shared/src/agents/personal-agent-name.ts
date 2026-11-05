// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a personal agent is called before its owner renames it, and the label
// any surface falls back to when it has an agent to name and no name for it.
//
// It used to be "Liaison". Liaison is the product; there is no entity in it by
// that name, so a member reading their own sidebar saw the application talking
// back to them instead of an agent. Both sides of the wire read this one
// constant: the API stamps it on the row it creates (`personal-agent.ts`, plus
// the migration that renamed the rows already out there), and the web falls
// back to it in the few places that print an agent's name from a payload that
// may not carry one.

export const PERSONAL_AGENT_DISPLAY_NAME = "Personal agent"

/** The first word of a person's name ("Tobias Braun" -> "Tobias"), or "". */
export function ownerFirstName(ownerName: string | null | undefined): string {
  return (ownerName ?? "").trim().split(/\s+/)[0] ?? ""
}

/**
 * "{Owner}'s agent": whose agent a personal agent is. A personal agent acts FOR
 * its owner and is never its owner. It is how the agent is told whose it is (its
 * own instructions, the tool results other agents read) and the name its posts
 * carry (`agentSpeakerName`). Falls back to the product default when the owner
 * has no name to give.
 */
export function personalAgentLabel(ownerName: string | null | undefined): string {
  const first = ownerFirstName(ownerName)
  return first ? `${first}'s agent` : PERSONAL_AGENT_DISPLAY_NAME
}

/**
 * THE NAME AN AGENT'S POST IS SIGNED WITH, from the authoring agent's row.
 *
 * A personal agent signs as "{Owner}'s agent": its stored name is the generic
 * "Personal agent" (or a nickname its owner chose), and a teammate reading a
 * post in a DM or a room could not tell whose agent spoke, or would take the
 * nickname for a person. Any other agent (a team or system agent) is named,
 * and signs with its own display name. Null when the row names nobody.
 */
export function agentSpeakerName(agent: {
  displayName?: string | null
  kind?: string | null
  ownerName?: string | null
}): string | null {
  if (agent.kind === "personal" && ownerFirstName(agent.ownerName)) {
    return personalAgentLabel(agent.ownerName)
  }
  const name = agent.displayName?.trim()
  return name ? name : null
}
