// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { appsCalledInSteps, takeMidTurnSkills } from "~/modules/agent/skills/mid-turn-skills"

const state = {
  anchorable: [
    {
      name: "gizmo-playbook",
      description: "gizmos",
      apps: ["gizmos"],
      body: "G",
      requiredScopes: [],
    },
    {
      name: "widget-playbook",
      description: "widgets",
      apps: ["widgets"],
      body: "W",
      requiredScopes: [],
    },
  ],
  inContext: [],
  activeApps: ["widgets"],
}

describe("mid-turn app-anchored skills", () => {
  it("reads the apps a turn called, kernel excluded", () => {
    expect([
      ...appsCalledInSteps([
        { toolCalls: [{ toolName: "gizmos__list" }, { toolName: "kernel__tool_search" }] },
        { toolCalls: [{ toolName: "skill_read" }] },
      ]),
    ]).toEqual(["gizmos"])
  })

  it("delivers a newly called app's skills once, never an app assembly already covered", () => {
    const delivered = new Set<string>()
    const first = takeMidTurnSkills(state, new Set(["gizmos", "widgets"]), delivered)
    expect(first.map((s) => s.name)).toEqual(["gizmo-playbook"])
    expect(takeMidTurnSkills(state, new Set(["gizmos"]), delivered)).toEqual([])
  })
})
