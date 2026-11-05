// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A surface that knows only an agent's id (the live turn header over a
// streaming answer, a message author) draws the colour the agent listing
// stores for it, and repaints when a new one is saved.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { resetAgentAvatarColors } from "~/lib/agent-avatar-colors"
import {
  loadAgentDirectory,
  resetAgentDirectory,
  setAgentAvatarColor,
} from "~/modules/threads/agent-directory"
import { LiveTurnHeader } from "~/modules/threads/MessageList"

const AGENT = "33333333-3333-4333-8333-333333333333"

describe("an agent's disc wears its stored colour", () => {
  afterEach(() => {
    cleanup()
    resetAgentDirectory()
    resetAgentAvatarColors()
  })

  it("renders the listing's colour by id and repaints on save", async () => {
    await loadAgentDirectory({
      get: async () => ({
        data: [{ id: AGENT, handle: "@support", displayName: "Support", avatarColor: 4 }],
      }),
    })
    render(() => <LiveTurnHeader agentId={AGENT} />)
    const disc = () =>
      screen.getByTestId("agent-stream-author").firstElementChild?.getAttribute("style") ?? ""
    expect(disc()).toContain("--agent-avatar-4-bg")
    setAgentAvatarColor(AGENT, 7)
    expect(disc()).toContain("--agent-avatar-7-bg")
  })
})
