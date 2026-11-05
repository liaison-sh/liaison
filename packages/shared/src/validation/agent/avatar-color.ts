// SPDX-License-Identifier: FSL-1.1-ALv2
import { z } from "zod"

/**
 * An agent's avatar colour: one of the eight agent avatar gradients
 * (`--agent-avatar-0` … `--agent-avatar-7` in the web theme), stored on
 * `kernel.agents.avatar_color`. The server gives each new agent the colour
 * its org uses least, so agents in one org differ; a person may pick another.
 */
export const AGENT_AVATAR_COLOR_COUNT = 8

export const agentAvatarColorSchema = z
  .number()
  .int()
  .min(0)
  .max(AGENT_AVATAR_COLOR_COUNT - 1)

export type AgentAvatarColor = z.infer<typeof agentAvatarColorSchema>

/** True for a stored colour slot the palette carries. */
export function isAgentAvatarColor(value: unknown): value is AgentAvatarColor {
  return agentAvatarColorSchema.safeParse(value).success
}
