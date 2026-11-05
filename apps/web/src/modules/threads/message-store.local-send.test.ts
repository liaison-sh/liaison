// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A CONVERSATION SET TO "THIS MACHINE" IS NEVER ANSWERED BY THE SERVER.
//
// The defect: in a DM with an agent, the runtime control said "This machine"
// and no session had been started (no folder had ever been picked). The send
// path posted the message exactly as a Liaison conversation does, no claim was
// held, and the server's own agent answered on the server's model while the
// header still said "This machine".
//
// Pinned here: with the runtime local, a message is posted ONLY once a local
// session runs for that conversation, and it says so to the server
// (`localAgentId`). When the session cannot be had, nothing is posted at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopSessionState } from "~/lib/desktop-shell-contract"
import { resetLocalTurnMessages } from "~/modules/desktop/desktop-store"
import {
  type FakeBridgeOptions,
  installFakeBridge,
  liveSession,
  uninstallFakeBridge,
} from "~/modules/desktop/fake-bridge"
import {
  LocalRuntimeUnavailableError,
  localSendRefusalCopy,
} from "~/modules/threads/local-runtime-send"
import { messageStore, resetMessageStore, sendMessage } from "~/modules/threads/message-store"
import { addThread, resetThreadStore } from "~/modules/threads/thread-store"

const THREAD = "t-dm-data"
const AGENT = "agent-data"
const USER = { id: "u-me", name: "Me" }

function seedDm(threadId = THREAD, agentId = AGENT) {
  addThread({
    id: threadId,
    handle: "dm-data",
    title: null,
    type: "agent_chat",
    participants: [
      { id: USER.id, name: USER.name, participantType: "user", agentId: null },
      { id: `seat-${agentId}`, name: "Data", participantType: "agent", agentId },
    ],
    lastMessage: null,
    unreadCount: 0,
    updatedAt: "2026-09-23T14:55:00Z",
  })
}

function recordingApi(id = "m-posted") {
  const bodies: Array<Record<string, unknown>> = []
  return {
    bodies,
    api: {
      post: vi.fn(async (_path: string, body: Record<string, unknown>) => {
        bodies.push(body)
        return {
          data: {
            id,
            threadId: THREAD,
            authorId: USER.id,
            authorName: USER.name,
            authorType: "user",
            content: body.content,
            createdAt: "2026-09-23T14:55:16Z",
          },
        }
      }),
    },
  }
}

function install(initial: Partial<DesktopSessionState>, options: FakeBridgeOptions = {}) {
  return installFakeBridge(initial, options)
}

describe("sending in a conversation whose turns run on this machine", () => {
  beforeEach(() => {
    resetMessageStore()
    resetThreadStore()
    resetLocalTurnMessages()
    seedDm()
  })

  afterEach(() => {
    uninstallFakeBridge()
  })

  // THE REPORTED CASE, and the user closes the picker it now opens.
  it("posts nothing when no folder was ever chosen and the picker is closed", async () => {
    const shell = install({ runtimeLocation: "local" }, { pickFolderResult: null })
    const { api } = recordingApi()
    const sent = sendMessage(api as never, THREAD, "make the report", USER)
    await expect(sent).rejects.toBeInstanceOf(LocalRuntimeUnavailableError)
    await expect(sent).rejects.toMatchObject({ reason: "NoFolderChosen" })
    expect(api.post).not.toHaveBeenCalled()
    expect(shell.calls.pickedFolder).toBe(1)
    expect(shell.calls.pickedFolderAgents).toEqual([AGENT])
    expect(shell.calls.started).toEqual([])
    // The optimistic bubble is taken back down: nothing was sent.
    expect(messageStore.threads[THREAD]?.ids ?? []).toEqual([])
  })

  it("asks for the folder, starts the session, then posts and runs the turn here", async () => {
    const shell = install(
      { runtimeLocation: "local" },
      { pickFolderResult: "/Users/me/reports", localModels: ["claude-haiku-4-5"] },
    )
    const { api, bodies } = recordingApi("m-local")
    await sendMessage(api as never, THREAD, "make the report", USER)
    expect(shell.calls.pickedFolder).toBe(1)
    // The pick is filed under this conversation, so a relaunch keeps it.
    expect(shell.calls.pickedFolderThreads).toEqual([THREAD])
    expect(shell.calls.started).toHaveLength(1)
    expect(shell.calls.started[0]).toMatchObject({
      threadId: THREAD,
      agentId: AGENT,
      model: "claude-haiku-4-5",
    })
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ content: "make the report", localAgentId: AGENT })
    expect(shell.calls.turns).toEqual(["m-local"])
  })

  it("starts in the folder already chosen without opening the picker again", async () => {
    const shell = install({ runtimeLocation: "local", folderPath: "/Users/me/reports" })
    const { api, bodies } = recordingApi()
    await sendMessage(api as never, THREAD, "hello", USER)
    expect(shell.calls.pickedFolder).toBe(0)
    expect(shell.calls.started).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ localAgentId: AGENT })
  })

  // THE FOLDER WAS FORGOTTEN ON RELAUNCH: a fresh window has nothing on its
  // state, and the send opened the picker again for a conversation that had
  // one.
  it("after a relaunch, starts in the folder remembered for this conversation", async () => {
    const remembered = {
      id: "folder-1",
      path: "/Users/me/Rapports Liaison",
      name: "Rapports Liaison",
    }
    const shell = install(
      { runtimeLocation: "local" },
      { pickFolderResult: null, threadFolders: { [THREAD]: remembered } },
    )
    const { api, bodies } = recordingApi()
    await sendMessage(api as never, THREAD, "hello again", USER)
    expect(shell.calls.pickedFolder).toBe(0)
    expect(shell.calls.restoredThreadFolders).toEqual([`${THREAD}:${AGENT}`])
    expect(shell.calls.started).toHaveLength(1)
    expect(shell.calls.started[0]).toMatchObject({ threadId: THREAD, folderId: "folder-1" })
    expect(bodies[0]).toMatchObject({ localAgentId: AGENT })
  })

  it("posts nothing when the shell refuses the start (a device that was not approved)", async () => {
    const shell = install(
      { runtimeLocation: "local", folderPath: "/Users/me/reports" },
      { refuseStart: "NotApproved" },
    )
    const { api } = recordingApi()
    const sent = sendMessage(api as never, THREAD, "hello", USER)
    await expect(sent).rejects.toMatchObject({ reason: "NotApproved" })
    expect(api.post).not.toHaveBeenCalled()
    expect(shell.calls.turns).toEqual([])
  })

  it("posts nothing when the sidecar would not start", async () => {
    install(
      { runtimeLocation: "local", folderPath: "/Users/me/reports" },
      { refuseStart: "SidecarSpawnFailed" },
    )
    const { api } = recordingApi()
    await expect(sendMessage(api as never, THREAD, "hello", USER)).rejects.toMatchObject({
      reason: "SidecarSpawnFailed",
    })
    expect(api.post).not.toHaveBeenCalled()
  })

  it("uses the session already running for this conversation, starting nothing", async () => {
    const shell = install(liveSession(THREAD, AGENT))
    const { api, bodies } = recordingApi("m-live")
    await sendMessage(api as never, THREAD, "again", USER)
    expect(shell.calls.started).toEqual([])
    expect(shell.calls.pickedFolder).toBe(0)
    expect(bodies[0]).toMatchObject({ localAgentId: AGENT })
    expect(shell.calls.turns).toEqual(["m-live"])
  })

  it("moves the session over when it is running for another conversation", async () => {
    const shell = install(liveSession("t-other", AGENT))
    const { api } = recordingApi()
    await sendMessage(api as never, THREAD, "here now", USER)
    expect(shell.calls.started).toHaveLength(1)
    expect(shell.calls.started[0]).toMatchObject({ threadId: THREAD, agentId: AGENT })
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it("restarts a session that lost its claim before posting", async () => {
    const shell = install(liveSession(THREAD, AGENT, { reconnectReason: "ConversationLost" }))
    const { api } = recordingApi()
    await sendMessage(api as never, THREAD, "still here?", USER)
    expect(shell.calls.started).toHaveLength(1)
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it("waits for a start already in flight instead of racing it", async () => {
    const shell = install({
      runtimeLocation: "local",
      folderPath: "/Users/me/reports",
      sessionStatus: "starting",
      threadId: THREAD,
      agentId: AGENT,
    })
    const { api } = recordingApi()
    const sent = sendMessage(api as never, THREAD, "queued", USER)
    await Promise.resolve()
    expect(api.post).not.toHaveBeenCalled()
    shell.push({ sessionStatus: "running" })
    await sent
    expect(shell.calls.started).toEqual([])
    expect(api.post).toHaveBeenCalledTimes(1)
  })

  it("leaves a Liaison conversation exactly as it was", async () => {
    const shell = install({ runtimeLocation: "liaison" })
    const { api, bodies } = recordingApi()
    await sendMessage(api as never, THREAD, "server please", USER)
    expect(shell.calls.started).toEqual([])
    expect(shell.calls.pickedFolder).toBe(0)
    expect(bodies[0]).not.toHaveProperty("localAgentId")
  })

  it("leaves a browser exactly as it was", async () => {
    const { api, bodies } = recordingApi()
    await sendMessage(api as never, THREAD, "no shell here", USER)
    expect(bodies[0]).not.toHaveProperty("localAgentId")
  })

  it("leaves a channel alone: the runtime belongs to a DM with one agent", async () => {
    addThread({
      id: "t-channel",
      handle: "general",
      title: "general",
      type: "thread",
      participants: [
        { id: USER.id, name: USER.name, participantType: "user", agentId: null },
        { id: "u-other", name: "Other", participantType: "user", agentId: null },
        { id: "seat-a", name: "Data", participantType: "agent", agentId: AGENT },
      ],
      lastMessage: null,
      unreadCount: 0,
      updatedAt: "2026-09-23T14:55:00Z",
    })
    const shell = install({ runtimeLocation: "local" }, { pickFolderResult: null })
    const { api, bodies } = recordingApi()
    await sendMessage(api as never, "t-channel", "hi all", USER)
    expect(shell.calls.pickedFolder).toBe(0)
    expect(bodies[0]).not.toHaveProperty("localAgentId")
  })
})

describe("what the person is told when a local send is held back", () => {
  it("names the folder when the picker was closed", () => {
    expect(localSendRefusalCopy("NoFolderChosen")).toContain("choose a folder")
  })

  it("says the message was not sent, and where it went, for any other refusal", () => {
    for (const reason of ["NotApproved", "SidecarSpawnFailed", "TokenRefreshFailed", "Nope"]) {
      const copy = localSendRefusalCopy(reason)
      expect(copy).toContain("Not sent")
      expect(copy).toContain("back in the composer")
    }
  })
})
