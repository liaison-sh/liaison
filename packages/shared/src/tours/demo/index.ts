// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The demo scenarios: one guided tour per need a demo visitor can pick
 * (`DEMO_NEED_SPECS[need].scenarioTourId`), each `demoOnly`, so a regular
 * org's "Show me how" never lists them and their routes answer 404 there.
 */
import { scenarioChatTour } from "./chat"
import { scenarioCommerceTour } from "./commerce"
import { scenarioDevTour } from "./dev"
import { scenarioKnowledgeTour } from "./knowledge"
import { scenarioProjectsTour } from "./projects"
import { scenarioSalesTour } from "./sales"
import { scenarioSupportTour } from "./support"

/** In `DEMO_NEEDS` order (support, projects, chat, sales, commerce, dev, knowledge). */
export const SCENARIO_TOURS = [
  scenarioSupportTour,
  scenarioProjectsTour,
  scenarioChatTour,
  scenarioSalesTour,
  scenarioCommerceTour,
  scenarioDevTour,
  scenarioKnowledgeTour,
] as const
