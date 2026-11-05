// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What this page shares with the desktop shell: one object on the window, and
// nothing else. The identity attributes, the badge slot and the document
// announcement this file used to pin are gone with the overlay that needed
// them (A33, P6d-T16a and P6d-T16b), so the first case here is that the page
// publishes none of them.
//
// It is asserted over the SOURCE rather than over a render, and deliberately:
// the attributes were published by three components whose render harnesses
// mock half the app between them, and what has to hold is that NO component
// publishes one, not that these three do not. A source sweep is the shape of
// that claim. Putting any of the five attributes back turns it red.

import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  DESKTOP_BRIDGE_VERSION,
  emptyDesktopSessionState,
  getDesktopBridge,
  parseLocalModels,
} from "~/lib/desktop-shell-contract"

const WEB_SRC = resolve(import.meta.dirname, "..")

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      out.push(...sourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    out.push(full)
  }
  return out
}

describe("the DOM scrape contract", () => {
  it("the page publishes no desktop identity attributes", () => {
    const offenders: string[] = []
    for (const file of sourceFiles(WEB_SRC)) {
      const body = readFileSync(file, "utf8")
      // SET or DECLARED, not merely named: a JSX attribute, or a string
      // constant holding the attribute's name. A selector in a test that
      // asserts the absence of one, and a comment that says the attributes are
      // gone, both name it in order to say nobody sets it.
      if (/data-liaison-[a-z-]+(=|["'])/.test(body)) offenders.push(file.slice(WEB_SRC.length + 1))
    }
    expect(offenders).toEqual([])
  })

  it("names no event for a message the shell has to be told about", () => {
    const contract = readFileSync(join(WEB_SRC, "lib/desktop-shell-contract.ts"), "utf8")
    expect(contract).not.toContain("liaison:thread-message")
    expect(contract).not.toContain("announceThreadMessage")
  })
})

// ---------------------------------------------------------------------------
// P6d-T03: the bridge half. The page renders, the shell acts, and a browser
// has no bridge at all.

describe("getDesktopBridge", () => {
  function stubBridge(version: number): Record<string, unknown> {
    return {
      version,
      platform: "macos",
      pickFolder: async () => null,
      getServerAddress: () => null,
      setServerAddress: async () => {},
      startSession: async () => false,
      stopSession: async () => {},
      sendTurn: async () => {},
      interruptTurn: async () => {},
      respondToPermission: async () => {},
      readLocalFile: async () => null,
      subscribe: () => () => {},
      getState: () => emptyDesktopSessionState(),
    }
  }

  it("getDesktopBridge returns null when the window has no bridge", () => {
    expect(getDesktopBridge({})).toBeNull()
  })

  it("getDesktopBridge returns null for an unknown bridge version", () => {
    expect(getDesktopBridge({ __LIAISON_DESKTOP__: { version: 99 } })).toBeNull()
  })

  it("getDesktopBridge returns the bridge for the supported version", () => {
    const bridge = stubBridge(DESKTOP_BRIDGE_VERSION)
    expect(getDesktopBridge({ __LIAISON_DESKTOP__: bridge })).toBe(bridge)
  })
})

describe("the permission mode a window starts in", () => {
  it("is Auto before anybody chose one", () => {
    expect(emptyDesktopSessionState().permissionMode).toBe("auto")
  })
})

describe("the levels a local model takes (S25)", () => {
  it("S25: a local model's efforts survive parseLocalModels and the capabilities body", () => {
    expect(
      parseLocalModels([
        {
          id: "claude-opus-5-5",
          label: "Claude Opus 5.5",
          efforts: ["low", "medium", "high", "xhigh", "max"],
        },
        // Unknown levels are dropped; none left, no efforts at all.
        { id: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: ["high", "turbo", 3] },
        { id: "claude-fable-5-1", label: "Claude Fable 5.1", efforts: ["turbo"] },
        { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", efforts: "max" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
      ]),
    ).toEqual([
      {
        id: "claude-opus-5-5",
        label: "Claude Opus 5.5",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      },
      { id: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: ["high"] },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ])
  })
})
