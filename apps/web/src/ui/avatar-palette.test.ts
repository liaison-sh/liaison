// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, describe, expect, it } from "vitest"
import { rememberAgentAvatarColor, resetAgentAvatarColors } from "~/lib/agent-avatar-colors"
import { agentAvatarColors, agentAvatarSlot, avatarPaletteIndex } from "~/ui/avatar-palette"

const AGENT = "22222222-2222-4222-8222-222222222222"

describe("agent avatar slot", () => {
  afterEach(() => resetAgentAvatarColors())

  it("falls back to the hash of the id when nothing is stored", () => {
    expect(agentAvatarSlot(AGENT)).toBe(avatarPaletteIndex(AGENT))
  })

  it("wears the colour the caller passes over the hash", () => {
    const passed = (avatarPaletteIndex(AGENT) + 3) % 8
    expect(agentAvatarSlot(AGENT, passed)).toBe(passed)
    expect(agentAvatarColors(AGENT, passed).background).toBe(`var(--agent-avatar-${passed}-bg)`)
  })

  it("wears the stored colour a read carried, wherever only the id is known", () => {
    rememberAgentAvatarColor(AGENT, 6)
    expect(agentAvatarSlot(AGENT)).toBe(6)
    expect(agentAvatarSlot(AGENT, 1)).toBe(6)
    expect(agentAvatarColors(AGENT).solid).toBe("var(--agent-avatar-6-solid)")
  })

  it("ignores a slot outside the palette", () => {
    rememberAgentAvatarColor(AGENT, 9)
    expect(agentAvatarSlot(AGENT, -1)).toBe(avatarPaletteIndex(AGENT))
  })
})
