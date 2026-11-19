// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The services world's client scenario: Pauline Gros asks for single sign-on on
 * the partner portal, outside the signed scope; the reply and the change request
 * wait on Home as one card, and Pauline approves the change request.
 */
import { buildClientTour, type ClientScenarioCfg } from "../../client"

/** The injector of the scenario's world beat (`modules/demo/worlds/studio/cr-accepted.ts`). */
export const STUDIO_CR_ACCEPTED_INJECTOR = "studio-cr-accepted"

/** The fixed-price client's project, whose budget the last beat reads. */
export const STUDIO_CLIENT_PROJECT_NAME = "Partner portal rebuild"

export const STUDIO_CLIENT_CFG: ClientScenarioCfg = {
  world: "studio",
  singleRun: true,
  copy: "studioClient",
  injector: STUDIO_CR_ACCEPTED_INJECTOR,
  cardTitle: "Single sign-on for partners",
  projectName: STUDIO_CLIENT_PROJECT_NAME,
  minutes: 4,
}

export const scenarioStudioClientTour = buildClientTour(STUDIO_CLIENT_CFG)
