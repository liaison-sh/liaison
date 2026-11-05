// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What a demo visitor says they need, and what each need turns into: the
 * guided scenario that shows it, the apps it installs and the parts of the
 * demo world it seeds. Shared by the signup route, the seeder and the web
 * picker so the three never disagree.
 *
 * The order of `DEMO_NEEDS` is the order the picker lists them in, and the
 * order "Everything" picks them in. A visitor's own picks keep the order they
 * were made in.
 */
import { z } from "zod"

export const DEMO_NEEDS = [
  "support",
  "projects",
  "chat",
  "sales",
  "commerce",
  "dev",
  "knowledge",
] as const

export type DemoNeed = (typeof DEMO_NEEDS)[number]

/** A part of the demo world seeded only when a need asks for it. */
export type DemoSeedPart =
  | "tickets"
  | "support-routine"
  | "projects"
  | "scenario-task"
  | "research-channel"
  | "mail"
  | "crm-fixture"
  | "prospect-routine"
  | "commerce"
  | "warehouse"

export interface DemoNeedSpec {
  /** The guided scenario (a demo-only kernel tour) that shows this need. */
  scenarioTourId: `kernel.scenario-${DemoNeed}`
  /** Apps installed for this need, on top of the baseline apps. */
  apps: readonly string[]
  /** World parts seeded for this need, on top of the baseline world. */
  seedParts: readonly DemoSeedPart[]
}

export const DEMO_NEED_SPECS: Readonly<Record<DemoNeed, DemoNeedSpec>> = {
  support: {
    scenarioTourId: "kernel.scenario-support",
    apps: ["tickets"],
    seedParts: ["tickets", "support-routine"],
  },
  projects: {
    scenarioTourId: "kernel.scenario-projects",
    apps: ["projects"],
    seedParts: ["projects", "scenario-task"],
  },
  chat: {
    scenarioTourId: "kernel.scenario-chat",
    // Its last steps turn the agent's answer into a task: the projects to put
    // it in come with it (the Projects scenario's own task does not).
    apps: ["projects"],
    seedParts: ["research-channel", "projects"],
  },
  sales: {
    scenarioTourId: "kernel.scenario-sales",
    apps: ["mail", "api-connector", "invoicing"],
    seedParts: ["mail", "crm-fixture", "prospect-routine"],
  },
  commerce: {
    scenarioTourId: "kernel.scenario-commerce",
    apps: ["shopify", "invoicing"],
    seedParts: ["commerce", "warehouse"],
  },
  dev: {
    scenarioTourId: "kernel.scenario-dev",
    apps: [],
    seedParts: [],
  },
  knowledge: {
    scenarioTourId: "kernel.scenario-knowledge",
    // Knowledge is a baseline app, and its synced sources and documents are in
    // every demo world: nothing more to install or seed.
    apps: [],
    seedParts: [],
  },
}

export const demoNeedSchema = z.enum(DEMO_NEEDS)

/** One or more distinct needs (at most every need), in pick order. */
export const demoNeedsSchema = z
  .array(demoNeedSchema)
  .min(1)
  .max(DEMO_NEEDS.length)
  .refine((needs) => new Set(needs).size === needs.length, { message: "needs must be distinct" })

export function isDemoNeed(value: unknown): value is DemoNeed {
  return typeof value === "string" && (DEMO_NEEDS as readonly string[]).includes(value)
}

/** The need a demo scenario tour shows (`kernel.scenario-<need>`), or null for any other tour. */
export function scenarioNeedOf(tourId: string): DemoNeed | null {
  for (const need of DEMO_NEEDS) {
    if (DEMO_NEED_SPECS[need].scenarioTourId === tourId) return need
  }
  return null
}

/**
 * The visitor's answer to the demo's welcome popup: they started a scenario
 * from it, or chose to browse on their own (Browse, the close button, Escape,
 * a click outside). Once either is recorded the popup no longer opens by
 * itself; the banner's scenario count still brings it back.
 */
export const DEMO_WELCOME_CHOICES = ["browse", "start"] as const
export type DemoWelcomeChoice = (typeof DEMO_WELCOME_CHOICES)[number]
export const demoWelcomeChoiceSchema = z.enum(DEMO_WELCOME_CHOICES)

/** `GET` and `POST /api/demo/scenarios/welcome`: the recorded answer, or null before any. */
export interface DemoWelcomeState {
  choice: DemoWelcomeChoice | null
}
