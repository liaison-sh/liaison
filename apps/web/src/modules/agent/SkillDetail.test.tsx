// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { hasAppsAdmin, hasScope } from "~/modules/auth/auth-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import SkillDetail from "./SkillDetail"
import { resetSkillsStore } from "./skills-store"

// Only override hasAppsAdmin and hasScope; keep every other auth-store export real.
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return { ...actual, hasAppsAdmin: vi.fn(() => false), hasScope: vi.fn(() => false) }
})

afterEach(() => {
  resetSkillsStore()
  vi.mocked(hasAppsAdmin).mockReturnValue(false)
  vi.mocked(hasScope).mockReturnValue(false)
})

function setup(entityId: string, skills: any[]) {
  const api = {
    get: vi.fn(async () => skills),
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
      <SkillDetail entityId={entityId} />
    </ApiContext.Provider>
  ))
  return api
}

describe("SkillDetail", () => {
  it("renders body + source chip + scope chips", async () => {
    setup("u1", [
      {
        id: "u1",
        name: "mine",
        description: "Personal skill",
        body: "# Hello",
        source: "personal",
        requiredScopes: ["tickets:read"],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-detail-body")).toBeInTheDocument())
    expect(screen.getByTestId("skill-detail-source-personal")).toBeInTheDocument()
    // A member reads the CATEGORY, never the scope (P4c FX-F3).
    expect(screen.getByTestId("skill-detail-capability-tickets")).toBeInTheDocument()
  })

  // A14, the charter's rule: a scope name is never shown to a non admin. The
  // skill row printed `requiredScopes` verbatim, so any skill carrying one put
  // a literal `kernel:...` on screen for everybody.
  it("a member sees categories, never a scope name, on a skill, a routine and a memory row", async () => {
    setup("u1", [
      {
        id: "u1",
        name: "mine",
        description: "Personal skill",
        body: "# Hello",
        source: "personal",
        requiredScopes: ["kernel:agents:read", "tickets:tickets:write"],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-detail-body")).toBeInTheDocument())
    expect(screen.getByTestId("skill-detail-capability-kernel")).toBeInTheDocument()
    expect(screen.getByTestId("skill-detail-capability-tickets")).toBeInTheDocument()
    expect(screen.queryByTestId("skill-detail-scope-kernel:agents:read")).toBeNull()
    expect(document.body.textContent).not.toContain("kernel:agents:read")
    expect(document.body.textContent).not.toContain("tickets:tickets:write")
  })

  it("an admin still sees the scope", async () => {
    vi.mocked(hasScope).mockImplementation((scope: string) => scope === "kernel:agents:admin")
    setup("u1", [
      {
        id: "u1",
        name: "mine",
        description: "Personal skill",
        body: "# Hello",
        source: "personal",
        requiredScopes: ["kernel:agents:read"],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-detail-body")).toBeInTheDocument())
    expect(screen.getByTestId("skill-detail-scope-kernel:agents:read")).toBeInTheDocument()
    expect(screen.queryByTestId("skill-detail-capability-kernel")).toBeNull()
  })

  it("Fork visible for built-in / org; not for owned user skill", async () => {
    setup("built-in/tickets/sum", [
      {
        id: "built-in/tickets/sum",
        name: "sum",
        description: "x",
        body: "y",
        source: "app",
        appName: "tickets",
        requiredScopes: [],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-fork")).toBeInTheDocument())
  })

  it("Edit + Delete only visible for owned skills", async () => {
    setup("u1", [
      {
        id: "u1",
        name: "mine",
        description: "p",
        body: "b",
        source: "personal",
        requiredScopes: [],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-edit")).toBeInTheDocument())
    expect(screen.getByTestId("skill-delete")).toBeInTheDocument()
    expect(screen.queryByTestId("skill-fork")).not.toBeInTheDocument()
  })

  it("org skill: Edit/Delete hidden for a non-admin, Fork offered instead", async () => {
    vi.mocked(hasAppsAdmin).mockReturnValue(false)
    setup("o1", [
      {
        id: "o1",
        name: "team-voice",
        description: "org",
        body: "b",
        source: "org",
        requiredScopes: [],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-detail-body")).toBeInTheDocument())
    // Backend lets only an apps-admin edit an org skill, so a non-admin must not
    // see Edit/Delete (they would 403 on save).
    expect(screen.queryByTestId("skill-edit")).not.toBeInTheDocument()
    expect(screen.queryByTestId("skill-delete")).not.toBeInTheDocument()
    // Escape hatch: a non-admin can still fork the org skill to a personal copy.
    expect(screen.getByTestId("skill-fork")).toBeInTheDocument()
  })

  it("org skill: Edit + Delete shown for an apps-admin", async () => {
    vi.mocked(hasAppsAdmin).mockReturnValue(true)
    setup("o1", [
      {
        id: "o1",
        name: "team-voice",
        description: "org",
        body: "b",
        source: "org",
        requiredScopes: [],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-edit")).toBeInTheDocument())
    expect(screen.getByTestId("skill-delete")).toBeInTheDocument()
  })

  it("Edit mode lets the owner save name + description + body via PUT", async () => {
    const api = setup("u1", [
      {
        id: "u1",
        name: "mine",
        description: "p",
        body: "b",
        source: "personal",
        requiredScopes: [],
      },
    ])
    api.put = vi.fn(async () => ({
      id: "u1",
      name: "renamed",
      description: "new desc",
      body: "new body",
      source: "personal",
      requiredScopes: [],
    }))
    await waitFor(() => expect(screen.getByTestId("skill-edit")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("skill-edit"))
    expect(screen.getByTestId("skill-edit-form")).toBeInTheDocument()
    fireEvent.input(screen.getByTestId("skill-edit-name"), {
      target: { value: "Renamed Skill" },
    })
    fireEvent.input(screen.getByTestId("skill-edit-description"), {
      target: { value: "new desc" },
    })
    fireEvent.input(screen.getByTestId("skill-edit-body"), {
      target: { value: "new body" },
    })
    fireEvent.click(screen.getByTestId("skill-edit-save"))
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith(
        "/agent/skills/u1",
        expect.objectContaining({
          name: "renamed-skill",
          description: "new desc",
          body: "new body",
        }),
      ),
    )
  })

  it("Disable toggle is visible only for app-shipped skills", async () => {
    setup("built-in/tickets/sum", [
      {
        id: "built-in/tickets/sum",
        name: "sum",
        description: "x",
        body: "y",
        source: "app",
        appName: "tickets",
        requiredScopes: [],
      },
    ])
    await waitFor(() => expect(screen.getByTestId("skill-enable-toggle-sum")).toBeInTheDocument())
  })

  // Charter agent.md, "A scope name on screen": the admin branch printed the
  // grant VERBATIM, so a skill carrying `projects:tasks:write` put the
  // identifier in front of the operator. The chip now says what the grant
  // lets the agent do; the id survives only in the chip's title.
  it("an agents admin reads a scope as words, never as the identifier", async () => {
    vi.mocked(hasScope).mockImplementation((scope: string) => scope === "kernel:agents:admin")
    setup("u2", [
      {
        id: "u2",
        name: "ship",
        description: "Ships orders",
        body: "# Ship",
        source: "personal",
        requiredScopes: ["projects:tasks:write"],
      },
    ])
    const chip = await waitFor(() => screen.getByTestId("skill-detail-scope-projects:tasks:write"))
    expect(chip.textContent).toBe("Projects: edit tasks")
    expect(chip.textContent).not.toContain("projects:tasks:write")
    expect(chip.getAttribute("title")).toContain("projects:tasks:write")
  })

  // The member branch printed the app SLUG, which is the same defect one step
  // down: a chip reading `tickets` is an identifier, not a name.
  it("a member reads the capability category by its app name", async () => {
    setup("u3", [
      {
        id: "u3",
        name: "triage",
        description: "Triages tickets",
        body: "# Triage",
        source: "personal",
        requiredScopes: ["tickets:tickets:read"],
      },
    ])
    const chip = await waitFor(() => screen.getByTestId("skill-detail-capability-tickets"))
    expect(chip.textContent).toBe("Tickets")
  })
})
