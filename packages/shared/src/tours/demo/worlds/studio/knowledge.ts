// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The services world's knowledge scenario: a past project's costs, restricted to
 * finance, beside its notes that everyone reads; a developer asks about both.
 */
import { buildKnowledgeTour, type KnowledgeScenarioCfg } from "../../knowledge"

/** The injector of the scenario's world beat (`modules/demo/worlds/studio/knowledge-asks.ts`). */
export const STUDIO_KNOWLEDGE_ASKS_INJECTOR = "studio-knowledge-asks"

/** The document the visitor opens: shared with finance and admins only (written when the scenario starts). */
export const STUDIO_KNOWLEDGE_DOC_TITLE = "Past project costs: OSIER"

export const STUDIO_KNOWLEDGE_CFG: KnowledgeScenarioCfg = {
  world: "studio",
  copy: "studioKnowledge",
  injector: STUDIO_KNOWLEDGE_ASKS_INJECTOR,
  plTitle: STUDIO_KNOWLEDGE_DOC_TITLE,
  minutes: 3,
}

export const scenarioStudioKnowledgeTour = buildKnowledgeTour(STUDIO_KNOWLEDGE_CFG)
