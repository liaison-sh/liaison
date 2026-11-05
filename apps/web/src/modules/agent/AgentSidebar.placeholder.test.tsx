// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The sidebar search box is a narrow field in a narrow rail. A placeholder
 * that enumerates everything the search covers is cut off mid word in the
 * field it sits in, which reads as a broken control rather than a hint, so
 * the copy is kept short enough to render whole.
 */
import { render, screen } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetAgentDirectory } from "~/modules/threads/agent-directory"
import AgentSidebar from "./AgentSidebar"

/** The field's own width in characters at the sidebar's default rail width:
 *  a 13px field roughly 160px wide inside the rail's search shell. Longer
 *  copy than this is clipped rather than shown. */
const MAX_PLACEHOLDER_CHARS = 24

afterEach(() => {
  resetAgentDirectory()
  try {
    resetTabStore()
  } catch {
    /* test isolation */
  }
})

function renderSidebar() {
  const api = {
    get: vi.fn(async () => []),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentSidebar />
    </ApiContext.Provider>
  ))
}

describe("AgentSidebar search placeholder", () => {
  it("fits the field it is rendered in, and names the same thing to a screen reader", () => {
    renderSidebar()
    const field = screen.getByTestId("agent-sidebar-search") as HTMLInputElement
    const placeholder = field.getAttribute("placeholder") ?? ""
    expect(placeholder.length).toBeGreaterThan(0)
    expect(placeholder.length).toBeLessThanOrEqual(MAX_PLACEHOLDER_CHARS)
    expect(field.getAttribute("aria-label")).toBe(placeholder)
  })
})
