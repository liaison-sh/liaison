// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import SkillsList from "./SkillsList"
import { resetSkillsStore } from "./skills-store"

vi.mock("~/modules/shell/tab-store", () => ({
  openTab: vi.fn(),
  closeTab: vi.fn(),
  makeTabId: vi.fn(() => "tab-id"),
}))

afterEach(() => {
  resetSkillsStore()
  vi.mocked(openTab).mockClear()
})

function setup(skills: any[] = []) {
  const api = {
    get: vi.fn(async () => skills),
    post: vi.fn(async (_path: string, body: any) => ({ ...body, id: "new-id" })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <SkillsList />
    </ApiContext.Provider>
  ))
  return api
}

describe("SkillsList", () => {
  it("renders three sub-tabs Built-in / Org / Personal", () => {
    setup()
    expect(screen.getByTestId("skills-subtab-built-in")).toBeInTheDocument()
    expect(screen.getByTestId("skills-subtab-org")).toBeInTheDocument()
    expect(screen.getByTestId("skills-subtab-personal")).toBeInTheDocument()
  })

  it("shows empty state with CTA when no skills in the current sub-tab", () => {
    setup()
    expect(screen.getByTestId("skills-empty-state")).toBeInTheDocument()
    expect(screen.getByTestId("skills-empty-cta")).toBeInTheDocument()
  })

  it("renders rows filtered by sub-tab; switches on click", async () => {
    setup([
      {
        id: "u1",
        name: "personal-skill",
        description: "p",
        source: "personal",
        requiredScopes: [],
      },
      {
        id: "o1",
        name: "org-skill",
        description: "o",
        source: "org",
        requiredScopes: [],
      },
      {
        id: "built-in/tickets/sum",
        name: "sum",
        description: "x",
        source: "app",
        appName: "tickets",
        requiredScopes: [],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-row-personal-skill")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("skills-subtab-org"))
    expect(screen.getByTestId("skill-row-org-skill")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("skills-subtab-built-in"))
    expect(screen.getByTestId("skill-row-sum")).toBeInTheDocument()
  })

  it("agent-origin badge surfaces for createdByActorType='agent'", async () => {
    setup([
      {
        id: "u1",
        name: "agent-authored",
        description: "p",
        source: "personal",
        requiredScopes: [],
        createdByActorType: "agent",
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-row-agent-authored")).toBeInTheDocument())
    expect(screen.getByTestId("agent-origin-badge")).toBeInTheDocument()
  })

  it("+ New skill opens a skill create tab, not a modal", () => {
    setup()
    fireEvent.click(screen.getByTestId("skills-new-skill"))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.stringContaining("skill"), entityId: "new" }),
    )
    expect(screen.queryByTestId("skills-new-modal")).toBeNull()
  })

  it("the empty-state CTA also opens the create tab", () => {
    setup()
    fireEvent.click(screen.getByTestId("skills-empty-cta"))
    expect(openTab).toHaveBeenCalledWith(
      expect.objectContaining({ type: expect.stringContaining("skill"), entityId: "new" }),
    )
  })

  it("built-in tab groups app skills by app and shows an enable toggle reflecting disabled state (A10)", async () => {
    const api = setup([
      {
        id: "built-in/social/triage-social-findings",
        name: "triage-social-findings",
        description: "triage",
        source: "app",
        appName: "social",
        requiredScopes: [],
        disabled: true,
      },
    ])
    fireEvent.click(screen.getByTestId("skills-subtab-built-in"))
    await waitFor(() =>
      expect(screen.getByTestId("skill-row-triage-social-findings")).toBeInTheDocument(),
    )
    // App group header present
    expect(screen.getByTestId("app-skill-group-social")).toBeInTheDocument()
    // The toggle reflects disabled state ("Off") and clicking it toggles
    const toggle = screen.getByTestId("app-skill-toggle-social-triage-social-findings")
    expect(toggle).toHaveAttribute("aria-checked", "false")
    fireEvent.click(toggle)
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/app-skills/social/triage-social-findings/toggle",
        { scope: "user" },
      ),
    )
  })
})
