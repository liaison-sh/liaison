// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiContext } from "~/modules/shell/ApiContext"
import { openTab } from "~/modules/shell/tab-store"
import SkillCreate from "./SkillCreate"
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

function setup() {
  const api = {
    get: vi.fn(),
    post: vi.fn(async (_p: string, b: any) => ({ ...b, id: "new-skill-id" })),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    rawPost: vi.fn(),
    rawGet: vi.fn(),
    getEnvelope: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <SkillCreate />
    </ApiContext.Provider>
  ))
  return api
}

describe("SkillCreate", () => {
  it("renders a full-surface form, not a modal", () => {
    setup()
    expect(screen.getByTestId("skill-create")).toBeInTheDocument()
    expect(screen.getByTestId("skill-form")).toBeInTheDocument()
    expect(screen.queryByTestId("skills-new-modal")).toBeNull()
  })

  it("ends its scroll in a runway so Create can be scrolled above the desktop dock's bar", () => {
    setup()
    expect(screen.getByTestId("skill-form").className).toContain("pb-dock-runway")
  })

  it("creates a personal skill and settles onto its tab", async () => {
    const api = setup()
    fireEvent.input(screen.getByTestId("skills-new-name"), { target: { value: "Draft Reply" } })
    fireEvent.input(screen.getByTestId("skills-new-description"), {
      target: { value: "Drafts a reply" },
    })
    fireEvent.input(screen.getByTestId("skills-new-body"), { target: { value: "# Draft" } })
    fireEvent.click(screen.getByTestId("skills-new-save"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        "/agent/skills",
        expect.objectContaining({ name: "draft-reply", visibility: "personal" }),
      ),
    )
    await waitFor(() => expect(openTab).toHaveBeenCalled())
  })

  it("surfaces a validation error when the body is empty", async () => {
    setup()
    fireEvent.input(screen.getByTestId("skills-new-name"), { target: { value: "x-skill" } })
    fireEvent.input(screen.getByTestId("skills-new-description"), { target: { value: "desc" } })
    fireEvent.click(screen.getByTestId("skills-new-save"))
    await waitFor(() => expect(screen.getByTestId("skills-new-error")).toBeInTheDocument())
  })
})
