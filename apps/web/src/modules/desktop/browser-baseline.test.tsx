// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T01: the PRE SLICE browser baseline.
//
// Taken at slice head, before any desktop surface lands in apps/web, and
// committed as __snapshots__/browser-baseline.snap. P6d-T17 asserts a browser
// render against this file and may not regenerate it: a baseline generated
// after the surfaces had landed would pin the post slice render against itself
// and catch nothing that leaked.
//
// A class string match is a regression pin, not evidence of what a human sees.
// The picture proof is P6d-T19.
import { cleanup } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.stubGlobal(
  "fetch",
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null),
      },
      text: () => Promise.resolve(JSON.stringify({ data: [] })),
      json: () => Promise.resolve({ data: [] }),
    }),
  ),
)

// The dock tab reaches a long way past itself: auth, tabs, message store,
// panel store. These stubs keep the baseline recording the surface's own
// markup and not a network race.

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, userFromToken: () => ({ userId: "u1", name: "Baseline" }) }
})

vi.mock("~/modules/shell/panel-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/shell/panel-store")>()
  return {
    ...actual,
    panelOpen: () => true,
  }
})

import ModelSelector from "~/modules/agent/ModelSelector"
import Login from "~/modules/auth/Login"
import ConversationTab from "~/modules/shell/ConversationTab"
import ComposeBar from "~/modules/threads/ComposeBar"
import ThreadHeader from "~/modules/threads/ThreadHeader"
import { BASELINE_SURFACES, renderBaselineSurface } from "./baseline-render"

const components = {
  ThreadHeader,
  ComposeBar,
  ConversationTab,
  ModelSelector,
  Login,
} as unknown as Parameters<typeof renderBaselineSurface>[1]

describe("browser baseline (P6d-T01, slice head)", () => {
  afterEach(() => cleanup())

  it("browser baseline renders every host surface with no bridge", async () => {
    expect((globalThis as Record<string, unknown>).__LIAISON_DESKTOP__).toBeUndefined()

    const sections: string[] = []
    for (const surface of BASELINE_SURFACES) {
      const outline = await renderBaselineSurface(surface, components)
      expect(outline.length).toBeGreaterThan(0)
      sections.push(`=== ${surface} ===\n${outline}`)
      cleanup()
    }

    await expect(`${sections.join("\n\n")}\n`).toMatchFileSnapshot(
      "./__snapshots__/browser-baseline.snap",
    )
  })
})
