// SPDX-License-Identifier: FSL-1.1-ALv2
import type { EffectivePathHop } from "@liaison/shared"
import { describe, expect, it } from "vitest"
import { advancePath, PATH_START, pathProgress } from "./wayfinding"

const all = () => true

describe("advancePath", () => {
  const openSession: EffectivePathHop[] = [
    { label: "Open the session in the list", anchor: "session-row[data-id=s1]" },
  ]
  const toAgent: EffectivePathHop[] = [
    { label: "Open Chats", anchor: "dock-chats" },
    { label: "Open your agent", anchor: "chats-personal-agent-row[data-in-dock=true]" },
    { label: "Ask your agent" },
  ]

  it("puts a hop still in view behind the person once the step's element is on its page", () => {
    const state = advancePath(openSession, PATH_START, all, true, true, {
      onRoute: true,
      targetAnchor: "request-card",
    })
    expect(pathProgress(openSession, state)).toEqual({ done: 1, current: null })
  })

  it("stops at a text hop: the words to send stay to send", () => {
    // Chats is still in view; the agent's conversation (its composer) is open.
    const onScreen = (i: number) => i === 0
    const state = advancePath(toAgent, PATH_START, onScreen, true, true, {
      onRoute: true,
      targetAnchor: "compose-field[data-thread-id=c1]",
    })
    expect(pathProgress(toAgent, state)).toEqual({ done: 2, current: 2 })
  })

  it("keeps the hops while the element shows on another page", () => {
    const state = advancePath(openSession, PATH_START, all, true, true, {
      onRoute: false,
      targetAnchor: "request-card",
    })
    expect(pathProgress(openSession, state)).toEqual({ done: 0, current: 0 })
  })

  it("keeps a hop beyond the element (the agent to pick once Chats is open)", () => {
    const state = advancePath(toAgent, PATH_START, all, true, true, {
      onRoute: true,
      targetAnchor: "dock-chats",
    })
    expect(pathProgress(toAgent, state)).toEqual({ done: 1, current: 1 })
  })

  it("takes the way again from the hop on screen once the person left the element", () => {
    // The project's subtasks: its breadcrumb on the task, then the list.
    const toBoard: EffectivePathHop[] = [
      { label: "Open the project", anchor: "task-detail.breadcrumb-project" },
      { label: "The new subtasks are in its list" },
    ]
    const onList = advancePath(toBoard, PATH_START, () => false, true, true, { onRoute: true })
    expect(pathProgress(toBoard, onList)).toEqual({ done: 1, current: 1 })
    // Back on the task: the breadcrumb is on screen, the subtasks are not.
    const backOnTask = advancePath(toBoard, onList, (i) => i === 0, false, true, { onRoute: true })
    expect(pathProgress(toBoard, backOnTask)).toEqual({ done: 0, current: 0 })
    const again = advancePath(toBoard, backOnTask, () => false, true, true, { onRoute: true })
    expect(pathProgress(toBoard, again)).toEqual({ done: 1, current: 1 })
  })

  it("keeps a hop passed while the element loads, before the person got to it", () => {
    // The agent picked: its row is gone, Chats still shows, the conversation is not up yet.
    const picked = advancePath(toAgent, PATH_START, (i) => i <= 1, false, true, { onRoute: true })
    expect(pathProgress(toAgent, picked)).toEqual({ done: 1, current: 1 })
    const loading = advancePath(toAgent, picked, (i) => i === 0, false, true, { onRoute: true })
    expect(pathProgress(toAgent, loading)).toEqual({ done: 1, current: 1 })
  })

  it("keeps the hops while the element is not on screen", () => {
    const state = advancePath(openSession, PATH_START, all, false, true, { onRoute: true })
    expect(pathProgress(openSession, state)).toEqual({ done: 0, current: 0 })
  })
})
