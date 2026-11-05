// SPDX-License-Identifier: FSL-1.1-ALv2
import { PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { tNow } from "~/modules/i18n/i18n-context"

/**
 * An agent's name as the viewer reads it. A personal agent nobody renamed is
 * stored with the product's default name, in English ("Personal agent"), so a
 * French sidebar listed it untranslated beside "Agent personnel" elsewhere.
 * Only that exact default is translated: a name someone chose is data.
 */
/**
 * An agent's STATE ("active", "archived") as the reader says it. The raw token
 * printed under the personal agent's name in the Chats list.
 */
export function agentStateLabel(state: string | null | undefined): string {
  const s = state?.trim()
  if (!s) return ""
  return s === "active" || s === "archived" ? tNow(`kernel.agents.agentState.${s}`) : s
}

export function localizeAgentName(name: string): string {
  if (name === PERSONAL_AGENT_DISPLAY_NAME) return tNow("kernel.agents.kindPersonal")
  // A personal agent's post is signed "{Owner}'s agent" by the server, in English.
  const owner = OWNERS_AGENT.exec(name)?.[1]
  return owner ? tNow("kernel.agents.ownersAgent", { name: owner }) : name
}

const OWNERS_AGENT = /^(.+)'s agent$/
