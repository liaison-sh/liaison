// SPDX-License-Identifier: FSL-1.1-ALv2
// The Projects tour asks for the project and its tasks in ONE create call, so
// approving a held create is the whole plan: the approve step needs no
// follow-up turn, and the next steps find tasks in the agent's project. Walk
// D57: the agent created the board, then its tasks; held, the board was
// approved empty and nothing asked the agent for the tasks again.
import { describe, expect, it } from "bun:test"
import en from "../../i18n/locales/en/tours.json"
import fr from "../../i18n/locales/fr/tours.json"
import { projectsBasicsTour } from "./basics"

const beat = (id: string) => projectsBasicsTour.beats.find((b) => b.id === id)

describe("the Projects tour's plan", () => {
  it("asks for the project with its tasks in one call", () => {
    expect(en.projects.basics.askPlan.text).toMatch(/with one task for each step, in one go/)
    expect(fr.projects.basics.askPlan.text).toMatch(/avec une tâche pour chaque étape, en une fois/)
  })

  it("approving the project approves its tasks: the step says so", () => {
    expect(en.projects.basics.approvePlan.body).toMatch(/the project and its tasks/)
    expect(fr.projects.basics.approvePlan.body).toMatch(/le projet et ses tâches/)
  })

  it("the approve step presses Approve and waits for the project, asking the agent nothing more", () => {
    const approve = beat("approve-plan")
    expect(approve?.event).toMatchObject({ app: "projects", entity: "project", action: "created" })
    const steps = approve?.autoplay ?? []
    expect(steps.some((s) => "type" in s)).toBe(false)
    expect(steps.some((s) => "click" in s && s.click === "compose-send")).toBe(false)
    // No step between the approval and the comment on a task asks the agent again.
    const ids = projectsBasicsTour.beats.map((b) => b.id)
    const between = projectsBasicsTour.beats.slice(
      ids.indexOf("approve-plan") + 1,
      ids.indexOf("comment"),
    )
    for (const b of between) expect(b.kind).toBe("show")
  })
})
