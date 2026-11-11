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
import { scenarioSaasMoneyTour } from "./worlds/saas/money"

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

/**
 * The scenarios of the other demo worlds (`kernel.scenario-<world>-<need>`),
 * each offered only in a workspace of its own world.
 */
export const WORLD_SCENARIO_TOURS = [scenarioSaasMoneyTour] as const

/** Every demo scenario, of every world. */
export const DEMO_SCENARIO_TOURS = [...SCENARIO_TOURS, ...WORLD_SCENARIO_TOURS] as const

/** The builders a world's configuration is built on (`PRODUCTS_CFG` is the products world's). */
export { buildChatTour } from "./chat"
export { buildCommerceTour } from "./commerce"
export { buildDevTour, type DevScenarioCfg, PRODUCTS_DEV_CFG } from "./dev"
export {
  buildKnowledgeTour,
  type KnowledgeScenarioCfg,
  PRODUCTS_KNOWLEDGE_CFG,
} from "./knowledge"
export { buildMoneyTour, MONEY_FIGURES_TOOL, type MoneyScenarioCfg } from "./money"
export { buildProjectsTour } from "./projects"
export { buildSalesTour, PRODUCTS_SALES_CFG, type SalesScenarioCfg } from "./sales"
export { PRODUCTS_CFG, type ScenarioCfg, type ScenarioExtraBeat } from "./shared"
export { buildSupportTour } from "./support"
export {
  SAAS_MONEY_CFG,
  SAAS_PAYMENT_RECOVERED_INJECTOR,
  scenarioSaasMoneyTour,
} from "./worlds/saas/money"
