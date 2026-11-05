// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  isLevelRaise,
  isNodeLevel,
  levelNeedsConfirmation,
  levelRank,
  levelRow,
  MACH_LOOKUP_DENYLIST,
  minLevel,
  NODE_ALWAYS_ALLOWED_TOOLS,
  NODE_ASK_TOOLS,
  NODE_DEFAULT_LEVEL,
  NODE_LEVELS,
  NODE_PROTECTED_BRANCHES,
} from "./node-levels"

describe("the node level table (spec level table, L10)", () => {
  it("ranks strict < standard < open", () => {
    expect(NODE_LEVELS).toEqual(["strict", "standard", "open"])
    expect(levelRank("strict")).toBe(0)
    expect(levelRank("standard")).toBe(1)
    expect(levelRank("open")).toBe(2)
    expect(NODE_DEFAULT_LEVEL).toBe("strict")
    expect(isNodeLevel("standard")).toBe(true)
    expect(isNodeLevel("custom")).toBe(false)
    expect(minLevel("open", "standard")).toBe("standard")
    expect(minLevel("strict", "open")).toBe("strict")
  })

  it("a raise is any move up, and Open from anywhere", () => {
    expect(isLevelRaise("strict", "standard")).toBe(true)
    expect(isLevelRaise("standard", "open")).toBe(true)
    expect(isLevelRaise("open", "strict")).toBe(false)
    expect(isLevelRaise("strict", "strict")).toBe(false)
    expect(isLevelRaise("standard", "strict")).toBe(false)
  })

  it("every choice of Open needs a confirmation (D24, D42)", () => {
    expect(levelNeedsConfirmation("open", "open")).toBe(true)
    expect(levelNeedsConfirmation("strict", "open")).toBe(true)
    expect(levelNeedsConfirmation("strict", "standard")).toBe(true)
    expect(levelNeedsConfirmation("standard", "standard")).toBe(false)
    expect(levelNeedsConfirmation("open", "standard")).toBe(false)
    expect(levelNeedsConfirmation("standard", "strict")).toBe(false)
  })

  it("strict and standard deny exactly EnterWorktree, CronCreate, ScheduleWakeup, RemoteTrigger; open denies none", () => {
    const denied = ["EnterWorktree", "CronCreate", "ScheduleWakeup", "RemoteTrigger"]
    expect([...levelRow("strict").deniedTools].sort()).toEqual([...denied].sort())
    expect([...levelRow("standard").deniedTools].sort()).toEqual([...denied].sort())
    expect(levelRow("open").deniedTools).toEqual([])
    expect(NODE_ALWAYS_ALLOWED_TOOLS).toContain("Skill")
    expect(NODE_ALWAYS_ALLOWED_TOOLS).not.toContain("EnterWorktree")
    expect(NODE_ASK_TOOLS).toEqual(["AskUserQuestion", "ExitPlanMode"])
  })

  it("only open runs without the sandbox", () => {
    expect(levelRow("strict").sandbox).toBe(true)
    expect(levelRow("standard").sandbox).toBe(true)
    expect(levelRow("open").sandbox).toBe(false)
    expect(levelRow("open").secretsDenied).toBe(false)
    expect(levelRow("standard").secretsDenied).toBe(true)
  })

  it("one protected-branch list", () => {
    expect(NODE_PROTECTED_BRANCHES).toEqual(["main", "master", "trunk", "develop", "production"])
    expect(NODE_PROTECTED_BRANCHES).not.toContain("HEAD")
  })

  it("S29: standard allows local binding, strict does not, open has no sandbox to bind in (D10c, D25)", () => {
    expect(levelRow("strict").allowLocalBinding).toBe(false)
    expect(levelRow("standard").allowLocalBinding).toBe(true)
    expect(levelRow("open").allowLocalBinding).toBe(true)
    // D25: no Mach list starts headless Chromium in the CLI sandbox, so none is opened.
    for (const level of NODE_LEVELS)
      expect({ level, mach: levelRow(level).machLookups }).toEqual({ level, mach: [] })
  })

  it("D55: only Standard lists the Playwright test runners; no npm run or bun run script", () => {
    expect(levelRow("standard").browserTestRunners).toEqual([
      "npx playwright test",
      "bunx playwright test",
      "pnpm exec playwright test",
      "yarn exec playwright test",
    ])
    expect(levelRow("strict").browserTestRunners).toEqual([])
    expect(levelRow("open").browserTestRunners).toEqual([])
    for (const level of NODE_LEVELS) {
      for (const runner of levelRow(level).browserTestRunners) {
        expect(runner).not.toMatch(/^(npm|bun) run\b/)
        // D56 F3: bare yarn <name> runs a package script of that name first.
        expect(runner).not.toMatch(/^yarn (?!exec )/)
      }
    }
  })

  it("S29: no Mach entry of any level matches the LaunchServices / Apple events denylist", () => {
    expect([...MACH_LOOKUP_DENYLIST]).toEqual([
      "com.apple.coreservices.launchservicesd",
      "com.apple.lsd.*",
      "com.apple.CoreServices.coreservicesd",
      "com.apple.coreservices.appleevents",
      "com.apple.windowserver.*",
    ])
    const denied = (name: string) =>
      MACH_LOOKUP_DENYLIST.some((d) =>
        d.endsWith("*") ? name.startsWith(d.slice(0, -1)) : name === d,
      )
    for (const level of NODE_LEVELS) {
      expect({ level, denied: levelRow(level).machLookups.filter(denied) }).toEqual({
        level,
        denied: [],
      })
    }
  })
})
