// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { createHaptics, type HapticCall, type HapticsPlugin, hapticCallFor } from "./haptics"

function recordingPlugin(): { plugin: HapticsPlugin; calls: HapticCall[] } {
  const calls: HapticCall[] = []
  return {
    calls,
    plugin: {
      impact: async ({ style }) => {
        calls.push({ call: "impact", style })
      },
      selectionChanged: async () => {
        calls.push({ call: "selectionChanged" })
      },
      notification: async ({ type }) => {
        calls.push({ call: "notification", type })
      },
    },
  }
}

describe("the haptic kind to platform call mapping", () => {
  it("makes a selection the lightest tick the platform has", () => {
    expect(hapticCallFor("selection")).toEqual({ call: "selectionChanged" })
  })

  it("makes a committed action a light impact", () => {
    expect(hapticCallFor("light")).toEqual({ call: "impact", style: "LIGHT" })
  })

  it("maps the three outcomes onto notifications", () => {
    expect(hapticCallFor("success")).toEqual({ call: "notification", type: "SUCCESS" })
    expect(hapticCallFor("warning")).toEqual({ call: "notification", type: "WARNING" })
    expect(hapticCallFor("error")).toEqual({ call: "notification", type: "ERROR" })
  })
})

describe("the bridge's haptic function", () => {
  it("drives the plugin for every kind", () => {
    const recorder = recordingPlugin()
    const haptic = createHaptics(recorder.plugin)
    haptic("selection")
    haptic("light")
    haptic("error")
    expect(recorder.calls).toEqual([
      { call: "selectionChanged" },
      { call: "impact", style: "LIGHT" },
      { call: "notification", type: "ERROR" },
    ])
  })

  it("returns nothing, so no caller can await the motor", () => {
    const recorder = recordingPlugin()
    expect(createHaptics(recorder.plugin)("selection")).toBeUndefined()
  })

  it("swallows a plugin that rejects", async () => {
    const plugin: HapticsPlugin = {
      impact: async () => {
        throw new Error("no motor")
      },
      selectionChanged: async () => {
        throw new Error("no motor")
      },
      notification: async () => {
        throw new Error("no motor")
      },
    }
    const haptic = createHaptics(plugin)
    expect(() => haptic("light")).not.toThrow()
    await Promise.resolve()
  })

  it("swallows a plugin with no implementation on this platform", () => {
    const plugin = {
      impact: () => {
        throw new Error("not implemented")
      },
      selectionChanged: () => {
        throw new Error("not implemented")
      },
      notification: () => {
        throw new Error("not implemented")
      },
    } as unknown as HapticsPlugin
    const haptic = createHaptics(plugin)
    expect(() => haptic("selection")).not.toThrow()
    expect(() => haptic("success")).not.toThrow()
  })
})
