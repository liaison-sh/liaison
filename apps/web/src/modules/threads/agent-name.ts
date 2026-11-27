// SPDX-License-Identifier: FSL-1.1-ALv2
import { ERASED_USER_DISPLAY_NAME, PERSONAL_AGENT_DISPLAY_NAME } from "@liaison/shared"
import { type Translate, tNow } from "~/modules/i18n/i18n-context"

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

/**
 * An author's or participant's name as the viewer reads it: the product's own
 * English defaults (a personal agent's default name, "{Owner}'s agent", an
 * erased person's "Deleted user") in the viewer's language, any other name as
 * it is.
 */
export function localizeAgentName(name: string): string {
  return localizeAgentNameWith(name, tNow)
}

/** `localizeAgentName` with the caller's own translate function. */
export function localizeAgentNameWith(name: string, t: Translate): string {
  // An erased person's row is named "Deleted user" by the server (the neutral
  // name erasure stores), and their messages, notes and comments stay signed
  // with it. Every author or participant name goes through here, so this is
  // where it is read in the viewer's language.
  if (name === ERASED_USER_DISPLAY_NAME) return t("kernel.deletedUser")
  if (name === PERSONAL_AGENT_DISPLAY_NAME) return t("kernel.agents.kindPersonal")
  // A personal agent's post is signed "{Owner}'s agent" by the server, in English.
  const owner = OWNERS_AGENT.exec(name)?.[1]
  return owner ? t("kernel.agents.ownersAgent", { name: owner }) : name
}

const OWNERS_AGENT = /^(.+)'s agent$/
