// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "vitest"
import { searchFilterChips } from "./search-chips"

const LABELS: Record<string, string> = {
  projects: "Projects",
  tickets: "Tickets",
  mail: "Mail",
  project: "Projects",
  task: "Tasks",
  ticket: "Tickets",
  conversation: "Conversations",
}
const label = (id: string) => LABELS[id] ?? id

const hits = [
  { app: "projects", entity_type: "project" },
  { app: "projects", entity_type: "task" },
  { app: "tickets", entity_type: "ticket" },
  { app: "tickets", entity_type: "ticket" },
  { app: "mail", entity_type: "conversation" },
]

function labelsOf(selectedApps: string[] = []): string[] {
  const chips = searchFilterChips(hits, {
    selectedApps: new Set(selectedApps),
    appLabel: label,
    typeLabel: label,
  })
  return [...chips.apps.map(label), ...chips.types.map(label)]
}

describe("search filter chips", () => {
  it("no two chips read the same: the record type stands for an app of the same name", () => {
    const shown = labelsOf()
    expect(shown.sort()).toEqual(["Conversations", "Mail", "Projects", "Tasks", "Tickets"])
    expect(new Set(shown).size).toBe(shown.length)
  })

  it("an app filter that is on keeps its chip, so it can be turned off", () => {
    const chips = searchFilterChips(hits, {
      selectedApps: new Set(["projects"]),
      appLabel: label,
      typeLabel: label,
    })
    expect(chips.apps).toContain("projects")
  })
})
