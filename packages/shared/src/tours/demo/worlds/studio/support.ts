// SPDX-License-Identifier: FSL-1.1-ALv2
/** The services world's support scenario: a client asks for an invoice copy and an empty test supplier list. */
import type { ScenarioCfg } from "../../shared"
import { buildSupportTour } from "../../support"

/** The injector of the scenario's world beat (`modules/demo/worlds/studio/support-ticket.ts`). */
export const STUDIO_SUPPORT_TICKET_INJECTOR = "studio-support-ticket"

export const STUDIO_SUPPORT_CFG: ScenarioCfg = {
  world: "studio",
  copy: "studioSupport",
  injector: STUDIO_SUPPORT_TICKET_INJECTOR,
  minutes: 3,
}

export const scenarioStudioSupportTour = buildSupportTour(STUDIO_SUPPORT_CFG)
