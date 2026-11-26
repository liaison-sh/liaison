// SPDX-License-Identifier: FSL-1.1-ALv2
//
// EVERY NAME A DEMO ROUTINE'S PROMPT CITES EXISTS IN ITS WORLD'S SEED.
//
// The services sales routine was told to create the deal "in the Sales
// pipeline"; the model passed `projectName: "Sales"`, the world's project is
// "Sales pipeline", the deal step failed "no project with that name" and the
// rest of the request was cancelled (demo walk 2026-11-25). A prompt now cites
// a project by its exact name, from the constant the seed names it with, and
// this file checks each world's prompts against that world's seeded projects.
import { describe, expect, it } from "bun:test"
import { prospectRoutinePrompt as productsProspectPrompt } from "~/seed/tiers/demo/seed-agent-native"
import { SAAS_SUPPORT_SPECS } from "~/seed/worlds/saas/support-specs"
import { studioPlan } from "~/seed/worlds/studio/plan"
import { STUDIO_SUPPORT_SPECS } from "~/seed/worlds/studio/support-specs"
import { prospectRoutinePrompt as saasProspectPrompt } from "./saas/scenario-routines"
import { studioProposalRoutinePrompt } from "./studio/scenario-routines"

const ISSUER = "11111111-2222-4333-8444-555555555555"

/** Every project name a prompt cites (`projectName "<name>"`). */
function citedProjectNames(prompt: string): string[] {
  return [...prompt.matchAll(/projectName "([^"]+)"/g)].map((m) => m[1] as string)
}

const studio = studioPlan(new Date("2026-11-25T12:00:00Z"))
const WORLDS: Array<{ world: string; prompt: string; projects: string[] }> = [
  {
    world: "studio",
    prompt: studioProposalRoutinePrompt(),
    projects: [
      ...studio.projects.map((p) => p.name),
      studio.pipeline.name,
      STUDIO_SUPPORT_SPECS.pipeline.name,
      ...STUDIO_SUPPORT_SPECS.projects.map((p) => p.name),
    ],
  },
  {
    world: "saas",
    prompt: saasProspectPrompt(ISSUER),
    projects: [SAAS_SUPPORT_SPECS.pipeline.name, ...SAAS_SUPPORT_SPECS.projects.map((p) => p.name)],
  },
  { world: "products", prompt: productsProspectPrompt(ISSUER), projects: [] },
]

describe("demo routine prompts cite names their world seeds", () => {
  for (const { world, prompt, projects } of WORLDS) {
    it(`${world}: a deal is created in a project named exactly as seeded`, () => {
      const cited = citedProjectNames(prompt)
      // A prompt that creates a deal says in which project, by its name.
      if (prompt.includes("projects__create")) expect(cited.length).toBeGreaterThan(0)
      for (const name of cited)
        expect({ world, name, seeded: projects.includes(name) }).toEqual({
          world,
          name,
          seeded: true,
        })
    })
  }

  it("the services world's pipeline is not named by a shorter word", () => {
    // The walk's failure: "Sales" is not the services world's project.
    expect(citedProjectNames(studioProposalRoutinePrompt())).toEqual(["Sales pipeline"])
  })
})
