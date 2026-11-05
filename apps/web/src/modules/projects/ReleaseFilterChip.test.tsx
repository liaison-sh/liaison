// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectsFilterStore } from "~/modules/projects/projects-filter-store"
import { ReleaseFilterChip, releaseOptions } from "~/modules/projects/ReleaseFilterChip"
import { matchesRelease, RELEASE_NONE } from "~/modules/projects/release-filter"

// Parent 2.1.0 > child (none) > grandchild 2.2.0, plus a loose root task.
const TASKS = [
  { id: "p", parentTaskId: null, release: "2.1.0" },
  { id: "c", parentTaskId: "p", release: null },
  { id: "g", parentTaskId: "c", release: "2.2.0" },
  { id: "l", parentTaskId: null, release: null },
]

function apiReturning(rows: unknown) {
  return { get: vi.fn(async () => rows) } as any
}

async function openMenu() {
  const trigger = screen.getByTestId("project-workspace.release-filter")
  trigger.focus()
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  await screen.findAllByTestId("release-filter.option")
}

function optionByText(text: string): HTMLElement {
  const el = screen
    .getAllByTestId("release-filter.option")
    .find((o) => o.textContent?.includes(text))
  if (!el) throw new Error(`no option ${text}`)
  return el
}

describe("ReleaseFilterChip", () => {
  beforeEach(() => projectsFilterStore.clearAll())
  afterEach(() => cleanup())

  it("projects.release-filter.counts-match-visible-rows-for-each-value", () => {
    // Org-wide counts from /releases (9, 4) must not leak into the board menu:
    // the count beside a value equals the rows that value alone shows.
    const opts = releaseOptions(TASKS, [
      { value: "2.1.0", count: 9 },
      { value: "3.0.0", count: 4 },
    ])
    expect(opts.map((o) => [o.value, o.count])).toEqual([
      ["2.1.0", 2],
      ["2.2.0", 1],
      ["3.0.0", 0],
      [RELEASE_NONE, 1],
    ])
    const byId = new Map(TASKS.map((t) => [t.id, t]))
    for (const o of opts) {
      expect(TASKS.filter((t) => matchesRelease(t, byId, o.value)).length).toBe(o.count)
    }
  })

  it("projects.release-filter.values-dedupe-case-insensitively", () => {
    const opts = releaseOptions(
      [
        { id: "a", parentTaskId: null, release: "v2" },
        { id: "b", parentTaskId: null, release: "V2" },
      ],
      [{ value: "v2", count: 2 }],
    )
    expect(opts.map((o) => [o.value, o.count])).toEqual([
      ["v2", 2],
      [RELEASE_NONE, 0],
    ])
  })

  it("projects.release-filter.chip-menu-selects-and-clears-the-filter", async () => {
    const api = apiReturning([{ value: "3.0.0", count: 4 }])
    render(() => <ReleaseFilterChip api={api} tasks={TASKS} />)
    expect(screen.getByTestId("project-workspace.release-filter").textContent).toBe("Release")
    expect(screen.queryByTestId("project-workspace.release-filter-clear")).toBeNull()

    await openMenu()
    expect(api.get).toHaveBeenCalledWith("/projects/releases")
    await waitFor(() => expect(optionByText("3.0.0").textContent).toContain("0"))
    expect(optionByText("2.1.0").textContent).toContain("2")
    expect(optionByText("2.2.0").textContent).toContain("1")
    expect(optionByText("No release").textContent).toContain("1")

    fireEvent.keyDown(optionByText("2.1.0"), { key: "Enter" })
    await waitFor(() => expect(projectsFilterStore.release).toBe("2.1.0"))
    const chip = screen.getByTestId("project-workspace.release-filter")
    expect(chip.textContent).toContain("2.1.0")
    expect(chip.className).toContain("text-accent")

    fireEvent.click(screen.getByTestId("project-workspace.release-filter-clear"))
    expect(projectsFilterStore.release).toBeNull()
    expect(chip.className).not.toContain("text-accent")
    expect(chip.textContent).toBe("Release")
  })

  it("projects.release-filter.chip-label-follows-each-new-selection", async () => {
    render(() => <ReleaseFilterChip api={apiReturning([])} tasks={TASKS} />)
    const chip = screen.getByTestId("project-workspace.release-filter")
    for (const [pick, stored] of [
      ["2.1.0", "2.1.0"],
      ["2.2.0", "2.2.0"],
      ["No release", RELEASE_NONE],
    ] as const) {
      await openMenu()
      fireEvent.keyDown(optionByText(pick), { key: "Enter" })
      await waitFor(() => expect(projectsFilterStore.release).toBe(stored))
      await waitFor(() => expect(chip.textContent).toBe(`Release: ${pick}`))
    }
  })

  it("projects.release-filter.no-release-option-sets-the-none-value", async () => {
    render(() => <ReleaseFilterChip api={apiReturning([])} tasks={TASKS} />)
    await openMenu()
    fireEvent.keyDown(optionByText("No release"), { key: "Enter" })
    await waitFor(() => expect(projectsFilterStore.release).toBe(RELEASE_NONE))
    expect(screen.getByTestId("project-workspace.release-filter").textContent).toContain(
      "No release",
    )
  })

  it("projects.release-filter.menu-still-lists-board-values-when-releases-fetch-fails", async () => {
    const api = { get: vi.fn(async () => Promise.reject(new Error("boom"))) } as any
    render(() => <ReleaseFilterChip api={api} tasks={TASKS} />)
    await openMenu()
    expect(optionByText("2.1.0").textContent).toContain("2")
  })
})
