// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The `studio` world's agent native layer: the owner's personal agent, the
// four desks (`desk-prompts.ts`) and the three routines the studio runs, each
// enabled from the product's own template so its text is the product's, not
// the pack's. The pack's layer writes them inside the seed (`runAsSeed`), so
// no event the seed queues ever ticks one.
import type { DemoAgentNativeSpecs } from "~/seed/tiers/demo/seed-agent-native"
import { STUDIO_CHANNEL_TITLES } from "./threads-specs"

/** A routine the studio runs, enabled from a product template. */
export interface StudioRoutineSpec {
  /** The template it is enabled from: an app's, or the kernel's. */
  template: { appName: string; templateKey: string }
  /** The person it runs as: `owner` for the workspace's owner. */
  ownerKey: string
  /**
   * Why that person: the scope check answers the client mail the owner decides on; the client
   * reports run as the project's lead, who opened the client's reports share (as opening it does).
   */
  why: string
}

/** Scope check and Client reports, from their apps' templates. The Morning brief is the kernel's. */
export const STUDIO_ROUTINES: readonly StudioRoutineSpec[] = [
  {
    template: { appName: "agreements", templateKey: "scope-check" },
    ownerKey: "owner",
    why: "a client's mail under a signed agreement is checked for the person who decides on it",
  },
  {
    template: { appName: "projects", templateKey: "client-reports" },
    ownerKey: "bastien",
    why: "the project lead opened the client's reports share",
  },
]

/** The Morning brief, the owner's, on their personal agent, at 07:30 on weekdays. */
export const STUDIO_MORNING_BRIEF = {
  name: "Morning brief",
  template: { appName: "kernel", templateKey: "morning-brief" },
  cron: "30 7 * * 1-5",
} as const

/** The names the routines list shows: the template's own for the apps', the brief's for the kernel's. */
export const STUDIO_ROUTINE_NAMES = [
  ...STUDIO_ROUTINES.map((r) => `${r.template.appName}-${r.template.templateKey}`),
  STUDIO_MORNING_BRIEF.name,
]

export const STUDIO_AGENT_NATIVE_SPECS: DemoAgentNativeSpecs = {
  skills: [],
  routines: [],
  subAgents: [],
  memory: [],
  episodes: [],
  knowledgePointers: [],
  activity: [],
  ownerAgentPurpose:
    "Keeps the owner's day in order: what needs a decision, what is waiting on " +
    "somebody else and what can wait.",
  ownerAgentChannelTitles: [STUDIO_CHANNEL_TITLES.clientWork, STUDIO_CHANNEL_TITLES.delivery],
  scenarioRoutines: false,
  layerRoutineNames: STUDIO_ROUTINE_NAMES,
}
