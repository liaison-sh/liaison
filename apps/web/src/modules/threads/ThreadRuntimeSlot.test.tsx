// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P4c-T19: the predicate, written once and proved once. The thread header and
// the dock tab both mount this slot, so a drift between two copies of "is this
// a DM with one agent" (P6d-FX7, SK-8) has nowhere left to happen.

import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it } from "vitest"
import { installFakeBridge, uninstallFakeBridge } from "~/modules/desktop/fake-bridge"
import ThreadRuntimeSlot, { dmAgentSeat } from "~/modules/threads/ThreadRuntimeSlot"

const AGENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const RUNTIME_LABEL = "Where the turns of this conversation run"

function agentSeat(agentId: string, name: string) {
  return {
    id: `seat-${agentId}`,
    name,
    avatarUrl: null,
    participantType: "agent" as const,
    agentId,
  }
}

const human = (id: string, name: string) => ({ id, name, participantType: "user" as const })

describe("ThreadRuntimeSlot", () => {
  afterEach(() => {
    cleanup()
    uninstallFakeBridge()
  })

  it("the predicate names the sole agent counterpart of a DM", () => {
    expect(
      dmAgentSeat({
        threadId: "t1",
        title: null,
        currentUserId: "member",
        participants: [human("member", "Member"), agentSeat(AGENT_ID, "Support")],
      }),
    ).toEqual({ id: AGENT_ID, name: "Support" })
  })

  it("the predicate names nobody in a titled channel of one person and one agent (A35 amended)", () => {
    expect(
      dmAgentSeat({
        threadId: "t1",
        title: "s11-cloud-walk",
        threadType: "thread",
        currentUserId: "member",
        participants: [human("member", "Member"), agentSeat(AGENT_ID, "Support")],
      }),
    ).toBeNull()
  })

  it("the predicate still names the agent of an agent chat, whatever its auto-title", () => {
    expect(
      dmAgentSeat({
        threadId: "t1",
        title: "Support",
        threadType: "agent_chat",
        currentUserId: "member",
        participants: [human("member", "Member"), agentSeat(AGENT_ID, "Support")],
      }),
    ).toEqual({ id: AGENT_ID, name: "Support" })
  })

  it("the predicate names nobody in a channel with a second human", () => {
    expect(
      dmAgentSeat({
        threadId: "t1",
        title: "Launch",
        currentUserId: "member",
        participants: [
          human("member", "Member"),
          human("other", "Other"),
          agentSeat(AGENT_ID, "Support"),
        ],
      }),
    ).toBeNull()
  })

  it("the predicate names nobody for a seat with no agent id", () => {
    expect(
      dmAgentSeat({
        threadId: "t1",
        title: null,
        currentUserId: "member",
        participants: [
          human("member", "Member"),
          { id: "seat-x", name: "Support", participantType: "agent" as const, agentId: null },
        ],
      }),
    ).toBeNull()
  })

  it("the slot mounts the runtime control for a DM on the desktop", () => {
    installFakeBridge({ runtimeLocation: "local", folderPath: "/Users/someone/work" })
    render(() => (
      <ThreadRuntimeSlot
        threadId="t1"
        title={null}
        currentUserId="member"
        participants={[human("member", "Member"), agentSeat(AGENT_ID, "Support")]}
      />
    ))
    expect(screen.getByRole("button", { name: RUNTIME_LABEL })).toBeInTheDocument()
  })

  it("the slot renders nothing for a channel, bridge or no bridge", () => {
    installFakeBridge({ runtimeLocation: "local", folderPath: "/Users/someone/work" })
    const { container } = render(() => (
      <ThreadRuntimeSlot
        threadId="t1"
        title="Launch"
        currentUserId="member"
        participants={[
          human("member", "Member"),
          human("other", "Other"),
          agentSeat(AGENT_ID, "Support"),
        ]}
      />
    ))
    expect(container.innerHTML).toBe("")
  })

  it("the slot renders nothing in a browser", () => {
    const { container } = render(() => (
      <ThreadRuntimeSlot
        threadId="t1"
        title={null}
        currentUserId="member"
        participants={[human("member", "Member"), agentSeat(AGENT_ID, "Support")]}
      />
    ))
    expect(container.innerHTML).toBe("")
  })
})
