// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { computeDockLift, type DockBarRect } from "./dockLift"

// A composer along the bottom of a 1300px-wide panel: its root ends at the
// panel's bottom (y = 900), the action row's controls sit 8-40px above it.
const root = { left: 0, right: 1290, top: 700, bottom: 900 }
const attach = { left: 20, right: 160, top: 860, bottom: 892 }
const send = { left: 1080, right: 1250, top: 860, bottom: 892 }
const bar = (left: number): DockBarRect => ({ left, right: 1290, top: 868, bottom: 900 })

describe("computeDockLift", () => {
  it("lifts nothing without a bar (phone, tablet, tests)", () => {
    expect(computeDockLift(root, [attach, send], null, 0)).toBe(0)
  })

  it("lifts nothing while the bar only grazes Send's corner", () => {
    // Send's centre is x = 1165: a bar starting right of it leaves it usable.
    expect(computeDockLift(root, [attach, send], bar(1200), 0)).toBe(0)
  })

  it("lifts the composer onto the bar once the bar hides a control", () => {
    expect(computeDockLift(root, [attach, send], bar(720), 0)).toBe(32)
  })

  it("is stable once lifted: positions are judged without the lift", () => {
    const lifted = (b: typeof root) => ({ ...b, top: b.top - 32, bottom: b.bottom - 32 })
    expect(computeDockLift(lifted(root), [lifted(attach), lifted(send)], bar(720), 32)).toBe(32)
    // The bar shrinks back: the lift drops.
    expect(computeDockLift(lifted(root), [lifted(attach), lifted(send)], bar(1200), 32)).toBe(0)
  })

  it("ignores controls that are not laid out", () => {
    const hidden = { left: 1100, right: 1100, top: 880, bottom: 880 }
    expect(computeDockLift(root, [hidden], bar(720), 0)).toBe(0)
  })

  it("leaves a composer above the bar alone (a side panel with its own clearance)", () => {
    const raised = { left: 900, right: 1290, top: 600, bottom: 860 }
    const raisedSend = { left: 1100, right: 1250, top: 820, bottom: 852 }
    expect(computeDockLift(raised, [raisedSend], bar(720), 0)).toBe(0)
  })
})
